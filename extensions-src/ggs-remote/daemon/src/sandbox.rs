//! The security sandbox (module 19, docs/ggs-remote-plan.md §23): when it is enabled, every
//! instance a remote session opens runs inside an OS-level sandbox instead of as the user.
//!
//! The engine is the Microsoft eXecution Container (`mxc-sdk`, MIT) — the runtime behind
//! GitHub Copilot's local sandboxing: policy-driven containment over the host's native
//! process sandbox (ProcessContainer on Windows, bubblewrap on Linux, Seatbelt on macOS),
//! applied to the spawned process **and its whole tree**. The daemon enforces nothing of
//! its own; it only authors the policy:
//!
//! - **Filesystem**: deny-by-default. The sandbox root is the instance's whole world —
//!   read-write inside it, nothing of `~/.ggs`, the user's home or the rest of the disk
//!   readable (plus the read-only grants an app needs to run: the install directory and
//!   the system trees).
//! - **Network**: `off` (nothing — the deny-by-default), `intranet` (the private ranges;
//!   only expressible on hosts whose sandbox tier carries CIDR rules), or `internet`
//!   (egress allowed). The sandbox's own loopback always works — an agent's local
//!   servers keep running at every level.
//! - **State relocation**: the instance's `GGS_HOME` points inside the sandbox root, so
//!   settings, extensions, provider keys and Claude state start empty in the sandbox and
//!   never touch the real `~/.ggs`. The daemon's control channel is reached through a
//!   dedicated sandbox endpoint (env `GGS_REMOTE_CONTROL`), registered with a one-shot
//!   token the daemon issues per spawn.
//!
//! What the OS sandbox does not promise, stated honestly: environment variables are
//! inherited (the confinement is files and network, not the environment), and the GUI
//! process keeps windowing (a workbench the remote drives needs its webview). Both are
//! written on the Remote Access page next to the switch.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mxc_sdk::mxc_common::cmdline::{cmdline_from_argv_for_context, CommandLineContext};
use mxc_sdk::v1::{
    self, ContainerRequest, Containment, FilesystemPolicy, NetworkAction, NetworkEgressPolicy,
    NetworkPeerPolicy, NetworkPolicy, NetworkRulePolicy, UiPolicy,
};

use crate::config::Config;
use crate::control_msg::LaunchSpec;
use crate::paths::Paths;
use crate::state::Daemon;

/// The private ranges `intranet` allows (sandbox-runtime's own list, inverted: it blocks
/// these as SSRF defence; an intranet sandbox is the same list allowed).
pub const INTRANET_CIDRS: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "169.254.0.0/16",
    "127.0.0.0/8",
];

/// What the host can actually enforce, probed once and cached (the probe touches no
/// system state — `platform_support` reads versions and binary presence).
pub struct SandboxSupport {
    pub supported: bool,
    pub reason: Option<String>,
    /// The backend the host resolves `Containment::Process` to (`processcontainer`,
    /// `bubblewrap`, `seatbelt`).
    pub backend: String,
    /// The backend's tier, when it has one (Windows: `basecontainer` = PSEC,
    /// `appcontainer-dacl` = the AppContainer fallback).
    pub tier: Option<String>,
    /// Whether CIDR egress rules can be expressed — the `intranet` level needs them.
    pub intranet_supported: bool,
}

pub fn support() -> SandboxSupport {
    let probe = v1::platform_support();
    let mut backend = String::new();
    let mut tier = None;
    for available in v1::available_backends() {
        if available.backend == "processcontainer"
            || available.backend == "bubblewrap"
            || available.backend == "seatbelt"
        {
            backend = available.backend.clone();
            tier = available.tier.clone();
            break;
        }
    }
    // Seatbelt has an on/off network switch only; the AppContainer tier of the Windows
    // ProcessContainer refuses CIDR rules outright (verified against mxc 1.0.0: the
    // spawn fails `policy_validation` rather than approximating).
    let intranet_supported = match backend.as_str() {
        "bubblewrap" => true,
        "processcontainer" => tier.as_deref() != Some("appcontainer-dacl"),
        _ => false,
    };
    SandboxSupport {
        supported: probe.is_supported,
        reason: probe.reason,
        backend,
        tier,
        intranet_supported,
    }
}

/// The effective sandbox root: the configured path, or `<remote root>/sandbox`.
pub fn effective_root(config: &Config, paths: &Paths) -> PathBuf {
    match config.sandbox.root.as_deref() {
        Some(root) if !root.trim().is_empty() => PathBuf::from(root),
        _ => paths.root.join("sandbox"),
    }
}

/// The resolved plan for sandboxed spawns: the root plus the network level this host can
/// actually enforce (`intranet` on a host without CIDR rules degrades to `off`, flagged).
pub struct SandboxPlan {
    pub root: PathBuf,
    pub net: crate::config::SandboxNetwork,
    /// `intranet` was asked for and degraded to `off` — surfaced in the status JSON.
    pub degraded: bool,
}

pub fn plan(config: &Config, paths: &Paths) -> SandboxPlan {
    let root = effective_root(config, paths);
    let asked = config.sandbox.network;
    let supported = support().intranet_supported;
    let (net, degraded) = match asked {
        crate::config::SandboxNetwork::Intranet if !supported => {
            (crate::config::SandboxNetwork::Off, true)
        }
        other => (other, false),
    };
    SandboxPlan {
        root,
        net,
        degraded,
    }
}

/// Whether `folder` lies inside the sandbox root (both canonicalised leniently, so a
/// not-yet-existing path still resolves through its nearest existing ancestor).
pub fn folder_in_root(folder: &Path, root: &Path) -> bool {
    match (canonicalize_lenient(folder), canonicalize_lenient(root)) {
        (Some(folder), Some(root)) => folder.starts_with(root),
        _ => false,
    }
}

fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        match std::fs::canonicalize(cursor) {
            Ok(mut canonical) => {
                for part in missing.iter().rev() {
                    canonical.push(part);
                }
                return Some(canonical);
            }
            Err(_) => {
                missing.push(cursor.file_name()?.to_os_string());
                cursor = cursor.parent()?;
            }
        }
    }
}

/// Create the sandbox root's layout: `home` (the relocated `~/.ggs` and `$HOME`), its
/// `tmp`, and the default `workspace` a folder-less SPAWN opens.
pub fn prepare_root(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root.join("home").join("tmp"))?;
    std::fs::create_dir_all(root.join("workspace"))?;
    Ok(())
}

/// The sandbox control endpoint a sandboxed instance connects to instead of the main one
/// (env `GGS_REMOTE_CONTROL`): a second pipe granted to AppContainer tokens on Windows,
/// a socket in its own directory (granted rw by the sandbox policy, holding nothing else)
/// elsewhere.
pub fn control_endpoint(paths: &Paths) -> String {
    #[cfg(windows)]
    {
        // The main endpoint's derivation with a distinct tag, so the two never collide.
        use sha2::{Digest, Sha256};
        let user = std::env::var("USERNAME").unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(user.as_bytes());
        hasher.update([0u8]);
        hasher.update(b"sandbox");
        hasher.update([0u8]);
        hasher.update(paths.root.to_string_lossy().as_bytes());
        let hex: String = hasher
            .finalize()
            .iter()
            .take(6)
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("ggsr1-sbx-{hex}")
    }
    #[cfg(not(windows))]
    {
        paths
            .root
            .join("sandbox-sock")
            .join("control.sock")
            .to_string_lossy()
            .into_owned()
    }
}

/// The directory the sandbox policy grants rw so the instance can reach the sandbox
/// endpoint — the endpoint's parent, which holds nothing but the socket.
pub fn control_grant_dir(paths: &Paths) -> PathBuf {
    #[cfg(windows)]
    {
        // The Windows pipe lives in the namespace, not the filesystem; no grant needed.
        paths.root.join("sandbox-sock")
    }
    #[cfg(not(windows))]
    {
        paths.root.join("sandbox-sock")
    }
}

/// The SDDL the sandbox pipe is created with: the owner keeps full control, and ALL
/// APPLICATION PACKAGES (every AppContainer token — the Windows sandbox tier's identity)
/// may connect. Nothing else changes: non-sandboxed processes are unaffected.
#[cfg(windows)]
pub const CONTROL_PIPE_SDDL: &str = "D:P(A;;GA;;;S-1-15-2-1)(A;;GA;;;OW)";

/// Issue a one-shot registration token for a sandboxed spawn and record it. The instance
/// must present it in its Register; the daemon consumes it on first use, so a token leak
/// buys exactly one registration race the leaker would lose anyway.
pub fn issue_token(daemon: &Daemon) -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness");
    let token = hex(&bytes);
    daemon.sandbox_tokens.lock().unwrap().insert(token.clone());
    token
}

/// Consume a token: `true` when it was one the daemon issued and had not been used.
pub fn take_token(daemon: &Daemon, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    daemon.sandbox_tokens.lock().unwrap().remove(token)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the program a sandboxed launch runs: a macOS bundle's `open -n <bundle>
/// --args …` form must become the bundle's own executable (an `open` inside the sandbox
/// would hand the launch straight back out of it), anything else runs as recorded.
pub fn resolve_program(spec: &LaunchSpec) -> (String, Vec<String>) {
    let is_open = spec.program.ends_with("open")
        && spec.args_prefix.first().map(String::as_str) == Some("-n");
    if !is_open {
        return (spec.program.clone(), spec.args_prefix.clone());
    }
    let Some(bundle) = spec.args_prefix.get(1) else {
        return (spec.program.clone(), spec.args_prefix.clone());
    };
    let bundle = Path::new(bundle);
    if !bundle.is_dir() {
        return (spec.program.clone(), spec.args_prefix.clone());
    }
    let macos = bundle.join("Contents").join("MacOS");
    let mut args: Vec<String> = Vec::new();
    // `--args` separates the launch flags; what follows belongs to the app.
    if let Some(position) = spec.args_prefix.iter().position(|a| a == "--args") {
        args.extend(spec.args_prefix[position + 1..].iter().cloned());
    }
    // The bundle's executable: CFBundleExecutable, which is the app's `mainBinaryName`.
    let binary = macos.join("ggs");
    if binary.is_file() {
        return (binary.to_string_lossy().into_owned(), args);
    }
    // Fall back to the first executable-looking file in Contents/MacOS.
    if let Ok(entries) = std::fs::read_dir(&macos) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                return (path.to_string_lossy().into_owned(), args);
            }
        }
    }
    (spec.program.clone(), spec.args_prefix.clone())
}

/// The filesystem grants a sandboxed GGS needs beyond the sandbox root: the app's own
/// install directory, read-execute. The system trees need no grant on any backend —
/// Windows' system and Program Files directories carry the ALL APPLICATION PACKAGES
/// read ACE the AppContainer token reads through (mxc's own grant filter skips them;
/// granting them explicitly would demand write-DACL the user does not have), and the
/// other backends bind the system read-only themselves. A per-user install directory
/// (`LOCALAPPDATA\Programs`) is the canonical grant: user-owned, write-DAC-able, and
/// without the inherited ACE.
fn readonly_grants(program: &str, root: &Path) -> Vec<String> {
    let mut grants = Vec::new();
    if let Some(dir) = Path::new(program).parent() {
        grants.push(dir.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    {
        let _ = root;
    }
    #[cfg(not(windows))]
    {
        // The seatbelt baseline grants the system trees read-only; bubblewrap binds
        // them itself. What remains is the display socket a GUI app needs on Linux —
        // the undocumented half, granted best-effort.
        #[cfg(target_os = "linux")]
        {
            let _ = root;
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                grants.push(PathBuf::from(&runtime).to_string_lossy().into_owned());
            }
            if Path::new("/tmp/.X11-unix").exists() {
                grants.push("/tmp/.X11-unix".into());
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = root;
        }
    }
    grants
}

/// The environment a sandboxed instance runs with, layered over the inherited default:
/// the relocations that keep every write inside the sandbox root, and the control
/// channel's endpoint and token.
pub fn child_env(plan: &SandboxPlan, endpoint: &str, token: &str) -> Vec<(String, String)> {
    let root = &plan.root;
    let home = root.join("home");
    let mut env = vec![
        ("GGS_HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("GGS_REMOTE_CONTROL".to_owned(), endpoint.to_owned()),
        ("GGS_REMOTE_CONTROL_TOKEN".to_owned(), token.to_owned()),
        ("GGS_SANDBOX".to_owned(), "1".to_owned()),
    ];
    let home_str = home.to_string_lossy().into_owned();
    env.push(("HOME".to_owned(), home_str.clone()));
    #[cfg(windows)]
    {
        env.push(("USERPROFILE".to_owned(), home_str.clone()));
        env.push((
            "LOCALAPPDATA".to_owned(),
            home.join("localappdata").to_string_lossy().into_owned(),
        ));
        env.push((
            "APPDATA".to_owned(),
            home.join("appdata").to_string_lossy().into_owned(),
        ));
        env.push((
            "WEBVIEW2_USER_DATA_FOLDER".to_owned(),
            home.join("webview2").to_string_lossy().into_owned(),
        ));
    }
    #[cfg(not(windows))]
    {
        let _ = &home_str;
        env.push((
            "XDG_CACHE_HOME".to_owned(),
            home.join(".cache").to_string_lossy().into_owned(),
        ));
        env.push((
            "XDG_CONFIG_HOME".to_owned(),
            home.join(".config").to_string_lossy().into_owned(),
        ));
        env.push((
            "XDG_DATA_HOME".to_owned(),
            home.join(".local")
                .join("share")
                .to_string_lossy()
                .into_owned(),
        ));
    }
    let tmp = home.join("tmp").to_string_lossy().into_owned();
    env.push(("TMP".to_owned(), tmp.clone()));
    env.push(("TEMP".to_owned(), tmp.clone()));
    env.push(("TMPDIR".to_owned(), tmp));
    env
}

fn network_policy(net: crate::config::SandboxNetwork) -> Option<NetworkPolicy> {
    match net {
        crate::config::SandboxNetwork::Off => None,
        crate::config::SandboxNetwork::Internet => Some(NetworkPolicy {
            egress: Some(NetworkEgressPolicy {
                default: Some(NetworkAction::Allow),
                ..Default::default()
            }),
            ..Default::default()
        }),
        crate::config::SandboxNetwork::Intranet => Some(NetworkPolicy {
            egress: Some(NetworkEgressPolicy {
                default: Some(NetworkAction::Deny),
                allow: Some(
                    INTRANET_CIDRS
                        .iter()
                        .map(|cidr| NetworkRulePolicy {
                            to: Some(vec![NetworkPeerPolicy::new((*cidr).to_owned())]),
                            ..Default::default()
                        })
                        .collect(),
                ),
                ..Default::default()
            }),
            ..Default::default()
        }),
    }
}

/// Start a sandboxed instance through the sandbox runtime. The child is detached in the
/// daemon's sense — reaped on a spare thread, its registration awaited by the caller the
/// ordinary way — and the OS sandbox outlives this call with the process it wraps.
pub fn launch(
    daemon: &Arc<Daemon>,
    plan: &SandboxPlan,
    spec: &LaunchSpec,
    folder: Option<&str>,
    visible: bool,
) -> Result<(), String> {
    let support = support();
    if !support.supported {
        return Err(format!(
            "this computer cannot run the sandbox: {}",
            support.reason.unwrap_or_else(|| "unsupported host".into())
        ));
    }
    prepare_root(&plan.root).map_err(|e| format!("create the sandbox root: {e}"))?;
    note_fresh_root(&plan.root);
    // The control grant directory must exist before the request is built: the Windows
    // AppContainer tier checks write-DACL on every granted path while authoring its
    // ACEs, and a not-yet-created directory reads as a refusal.
    std::fs::create_dir_all(control_grant_dir(&daemon.paths))
        .map_err(|e| format!("create the sandbox control directory: {e}"))?;

    let folder = folder
        .filter(|f| !f.trim().is_empty())
        .map(|f| f.to_owned())
        .unwrap_or_else(|| plan.root.join("workspace").to_string_lossy().into_owned());
    if !folder_in_root(Path::new(&folder), &plan.root) {
        return Err(format!(
            "{folder}: the sandbox opens folders inside its root only"
        ));
    }

    let (program, prefix) = resolve_program(spec);
    let mut argv = vec![program.clone()];
    argv.extend(prefix);
    if !visible {
        argv.push("--remote-host".into());
    }
    argv.push(folder.clone());

    // The command line is serialised with the backend's own quoting rules (Windows
    // CreateProcess, a POSIX shell elsewhere) — the same helper the SDK uses.
    let context = if cfg!(windows) {
        CommandLineContext::WindowsCreateProcess
    } else {
        CommandLineContext::PosixShell
    };
    let command = cmdline_from_argv_for_context(&argv, context)
        .map_err(|e| format!("the launch command cannot be quoted for the sandbox: {e}"))?;

    let endpoint = control_endpoint(&daemon.paths);
    let token = issue_token(daemon);
    let environment = child_env(plan, &endpoint, &token);

    let request = ContainerRequest {
        command,
        filesystem: Some(FilesystemPolicy {
            readwrite_paths: vec![
                plan.root.to_string_lossy().into_owned(),
                control_grant_dir(&daemon.paths)
                    .to_string_lossy()
                    .into_owned(),
            ],
            readonly_paths: readonly_grants(&program, &plan.root),
            denied_paths: vec![],
            clear_policy_on_exit: None,
        }),
        network: network_policy(plan.net),
        ui: Some(UiPolicy {
            disable: false,
            ..UiPolicy::default()
        }),
        containment: containment_for_backend(),
        working_directory: Some(plan.root.join("workspace").to_string_lossy().into_owned()),
        environment: Some(environment),
        inherit_default_environment: Some(true),
        timeout_ms: None,
        container_name: Some(format!("ggs-{}", hex(&daemon.secret[..8]))),
    };

    let mut child = v1::spawn(request, Default::default())
        .map_err(|e| format!("the sandbox runtime refused the launch: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    crate::info!(
        "spawned a sandboxed instance (network: {}, root: {})",
        plan.net.as_str(),
        plan.root.display()
    );
    Ok(())
}

/// `Containment::Process` resolves to the host's native backend on its own; Windows names
/// the ProcessContainer explicitly so the capability-free default (no internet, no
/// private network — everything rides the cross-platform network policy) holds.
fn containment_for_backend() -> Containment {
    #[cfg(windows)]
    {
        Containment::ProcessContainer(mxc_sdk::v1::configs::ProcessContainerConfig::default())
    }
    #[cfg(not(windows))]
    {
        Containment::Process
    }
}

/// The state the Remote Access page and the admin status carry: what is configured, what
/// this host can enforce, and what a degraded level actually does.
pub fn status_json(config: &Config, paths: &Paths) -> serde_json::Value {
    let support = support();
    let plan = plan(config, paths);
    serde_json::json!({
        "enabled": config.sandbox.enabled,
        "network": config.sandbox.network.as_str(),
        "effectiveNetwork": plan.net.as_str(),
        "degraded": plan.degraded,
        "root": effective_root(config, paths).to_string_lossy(),
        "supported": support.supported,
        "reason": support.reason,
        "backend": support.backend,
        "tier": support.tier,
        "intranetSupported": support.intranet_supported,
    })
}

/// Bind the sandbox control endpoint. Always called at boot when the sandbox is enabled —
/// and by the first sandboxed spawn if it was switched on later (see `ensure_listener`).
#[cfg(windows)]
pub fn bind_sandbox_endpoint(
    endpoint: &str,
) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{GenericNamespaced, ListenerOptions, ToNsName};
    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    // The GGS-patch setter (../vendor/interprocess): instances an OS sandbox wrapped
    // run under an AppContainer token, which the default DACL excludes.
    ListenerOptions::new()
        .name(name)
        .security_descriptor_sddl(CONTROL_PIPE_SDDL)?
        .create_tokio()
}

#[cfg(not(windows))]
pub fn bind_sandbox_endpoint(
    endpoint: &str,
) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{GenericFilePath, ToFsName};
    let dir = Path::new(endpoint)
        .parent()
        .ok_or_else(|| std::io::Error::other("no sandbox socket directory"))?;
    std::fs::create_dir_all(dir)?;
    let _ = std::fs::remove_file(endpoint);
    let name = endpoint.to_fs_name::<GenericFilePath>()?;
    let listener = interprocess::local_socket::ListenerOptions::new()
        .name(name)
        .create_tokio()?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(listener)
}

/// Serve the sandbox endpoint: every connection is an instance the daemon itself spawned
/// into a sandbox, so a Register without a valid one-shot token is refused. Mirrors
/// `control::serve` otherwise.
pub async fn serve(daemon: Arc<Daemon>) -> std::io::Result<()> {
    use interprocess::local_socket::traits::tokio::Listener;
    let endpoint = control_endpoint(&daemon.paths);
    let listener = bind_sandbox_endpoint(&endpoint)?;
    crate::info!("sandbox control channel listening at {endpoint}");
    loop {
        let stream = match listener.accept().await {
            Ok(stream) => stream,
            Err(e) => {
                crate::warn!("sandbox control accept: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
        };
        let daemon = daemon.clone();
        tokio::spawn(async move {
            use interprocess::local_socket::tokio::prelude::*;
            let (rx, tx) = stream.split();
            if let Err(e) = crate::control::serve_instance(daemon, rx, tx, true).await {
                crate::warn!("sandbox control connection ended: {e}");
            }
        });
    }
}

/// Start the sandbox listener once per daemon (idempotent across config flips): the
/// endpoint is harmless when unused — registrations are one-shot-token gated.
pub fn ensure_listener(daemon: &Arc<Daemon>) {
    let daemon = daemon.clone();
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = serve(daemon).await {
            crate::warn!("the sandbox control channel could not start: {e}");
        }
    });
}

/// Best-effort note into the log when the sandbox root is created fresh (the first
/// enable): nothing sensitive is written, only the directories.
pub fn note_fresh_root(root: &Path) {
    let marker = root.join(".ggs-sandbox-root");
    if !marker.exists() {
        if let Ok(mut file) = std::fs::File::create(&marker) {
            let _ = writeln!(
                file,
                "This directory is the GGS Remote sandbox root. Everything a sandboxed \
                 window writes lives here; delete it to reset the sandbox."
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_with(net: crate::config::SandboxNetwork) -> SandboxPlan {
        SandboxPlan {
            root: PathBuf::from(if cfg!(windows) { "C:\\sb" } else { "/sb" }),
            net,
            degraded: false,
        }
    }

    #[test]
    fn folder_confinement_is_prefix_after_canonicalisation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sandbox");
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        assert!(folder_in_root(&root.join("workspace"), &root));
        assert!(folder_in_root(&root.join("workspace").join("repo"), &root));
        assert!(folder_in_root(
            &root.join("workspace").join("a").join("..").join("repo"),
            &root
        ));
        assert!(!folder_in_root(&dir.path().join("elsewhere"), &root));
        assert!(!folder_in_root(
            &root.join("workspace").join("..").join("..").join("escape"),
            &root
        ));
    }

    #[test]
    fn macos_open_spec_resolves_to_the_bundle_binary() {
        let spec = LaunchSpec {
            program: "/usr/bin/open".into(),
            args_prefix: vec![
                "-n".into(),
                "/Applications/GGS.app".into(),
                "--args".into(),
                "--flag".into(),
            ],
        };
        // The bundle does not exist here, so the spec passes through unchanged.
        let (program, _) = resolve_program(&spec);
        assert_eq!(program, "/usr/bin/open");
    }

    #[test]
    fn env_relocates_everything_into_the_root() {
        let plan = plan_with(crate::config::SandboxNetwork::Off);
        let env = child_env(&plan, "endpoint-name", "token-value");
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap()
        };
        assert_eq!(get("GGS_HOME"), plan.root.join("home").to_string_lossy());
        assert_eq!(get("GGS_REMOTE_CONTROL"), "endpoint-name");
        assert_eq!(get("GGS_REMOTE_CONTROL_TOKEN"), "token-value");
        assert_eq!(get("GGS_SANDBOX"), "1");
        assert_eq!(get("HOME"), plan.root.join("home").to_string_lossy());
        assert!(get("TMP").starts_with(plan.root.to_string_lossy().as_ref()));
    }

    #[test]
    fn network_levels_map_onto_the_policy() {
        assert!(network_policy(crate::config::SandboxNetwork::Off).is_none());
        let internet = network_policy(crate::config::SandboxNetwork::Internet).unwrap();
        assert_eq!(internet.egress.unwrap().default, Some(NetworkAction::Allow));
        let intranet = network_policy(crate::config::SandboxNetwork::Intranet).unwrap();
        let egress = intranet.egress.unwrap();
        assert_eq!(egress.default, Some(NetworkAction::Deny));
        let cidrs: Vec<String> = egress
            .allow
            .unwrap()
            .iter()
            .filter_map(|rule| {
                rule.to
                    .as_ref()
                    .and_then(|peers| peers.first())
                    .map(|peer| peer.cidr.clone())
            })
            .collect();
        assert!(cidrs.contains(&"10.0.0.0/8".to_owned()));
        assert!(cidrs.contains(&"127.0.0.0/8".to_owned()));
    }

    #[test]
    fn readonly_grants_include_the_program_directory() {
        let grants = readonly_grants(
            if cfg!(windows) {
                "C:\\Program Files\\GGS\\ggs.exe"
            } else {
                "/opt/ggs/ggs"
            },
            Path::new(if cfg!(windows) { "C:\\sb" } else { "/sb" }),
        );
        assert!(grants
            .iter()
            .any(|g| g.contains(if cfg!(windows) { "GGS" } else { "ggs" })));
    }
}
