//! `ggs-remote` — the GGS Remote daemon and its command line (docs/ggs-remote-plan.md §7.1).
//!
//! ```text
//! ggs-remote [run] [--no-tray]      run the daemon in this process (the default)
//! ggs-remote start                  start the installed daemon detached, wait until it answers
//! ggs-remote install [--ggs-exe P] [--extension-dir D] [--no-start]
//!                                   copy this binary into ~/.ggs/remote/bin (forward-only),
//!                                   upgrade a running older daemon, record the GGS executable
//!                                   and the extension directory, then start it
//! ggs-remote admin METHOD PATH [JSON|-]
//!                                   one call to the running daemon's admin API (the extension's
//!                                   client; `-` reads the body from stdin), the body on stdout
//! ggs-remote status                 the running daemon's status as JSON
//! ggs-remote stop                   ask the running daemon to exit
//! ggs-remote set-password [PW]      set the access password (prompted from stdin when omitted)
//! ggs-remote print-link             this PC's access links
//! ggs-remote pair                   open the pairing page in the browser
//! ggs-remote autostart on|off       start at login (and restart after a crash)
//! ggs-remote --version
//! ```
//!
//! One daemon per OS user: a second `run` finds the lock held and exits; every other command
//! talks to the running daemon over its loopback admin API.

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use ggs_remote::client;
use ggs_remote::config::Config;
use ggs_remote::paths::Paths;
use ggs_remote::state::Daemon;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("run");
    let paths = match Paths::resolve() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ggs-remote: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = match command {
        "run" | "--no-tray" => run(&paths, args.iter().any(|a| a == "--no-tray")),
        "start" => start(&paths),
        "install" => install(&paths, &args),
        "admin" => admin_call(&paths, &args),
        "status" => {
            client::admin(&paths, "GET", "/admin/status", None).map(|body| println!("{body}"))
        }
        "stop" => client::admin(&paths, "POST", "/admin/shutdown", Some("{}"))
            .map(|_| println!("stopping")),
        "set-password" => set_password(&paths, args.get(1).cloned()),
        "print-link" => print_link(&paths),
        "pair" => pair(&paths),
        "autostart" => match args.get(1).map(String::as_str) {
            Some("on") => ggs_remote::autostart::apply(true),
            Some("off") => ggs_remote::autostart::apply(false),
            _ => Err("usage: ggs-remote autostart on|off".into()),
        },
        "--version" | "-V" | "version" => {
            println!("ggs-remote {VERSION}");
            Ok(())
        }
        "--help" | "-h" | "help" => {
            println!("ggs-remote [run|start|install|admin|status|stop|set-password|print-link|pair|autostart on|off|--version]");
            Ok(())
        }
        other => Err(format!("unknown command: {other} (try --help)")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ggs-remote: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(paths: &Paths, no_tray: bool) -> Result<(), String> {
    paths.ensure().map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())
        .map_err(|e| e.to_string())?;
    if lock.try_lock().is_err() {
        println!("GGS Remote is already running.");
        return Ok(());
    }
    ggs_remote::log::init(paths.log());
    let config = Config::load_or_init(paths).map_err(|e| e.to_string())?;
    let daemon = Daemon::new(paths.clone(), config).map_err(|e| e.to_string())?;
    ggs_remote::info!("GGS Remote {VERSION} starting (pid {})", std::process::id());

    let server_daemon = daemon.clone();
    let server = std::thread::Builder::new()
        .name("ggs-remote-io".into())
        .stack_size(1 << 20)
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a tokio runtime");
            runtime.block_on(async move {
                let shutdown_daemon = server_daemon.clone();
                tokio::spawn(async move {
                    if tokio::signal::ctrl_c().await.is_ok() {
                        shutdown_daemon.shutdown.notify_one();
                    }
                });
                ggs_remote::server::run(server_daemon).await
            })
        })
        .map_err(|e| e.to_string())?;

    run_tray(daemon.clone(), no_tray);
    let result = server
        .join()
        .map_err(|_| "the server thread panicked".to_string())?;
    drop(lock);
    result.map_err(|e| e.to_string())
}

/// The tray owns the main thread (macOS requires it); without one, the main thread simply
/// waits for the server thread.
fn run_tray(daemon: Arc<Daemon>, no_tray: bool) {
    #[cfg(feature = "tray")]
    if !no_tray {
        ggs_remote::tray::run(daemon);
        return;
    }
    let _ = (daemon, no_tray);
}

/// Start the installed copy (or this binary when nothing is installed yet).
fn start(paths: &Paths) -> Result<(), String> {
    let installed = client::installed_binary(paths);
    let exe = if installed.exists() {
        installed
    } else {
        std::env::current_exe().map_err(|e| e.to_string())?
    };
    client::start(paths, &exe)?;
    println!("running");
    Ok(())
}

fn install(paths: &Paths, args: &[String]) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let outcome = client::install(paths, &me, VERSION)?;
    // What the extension knows and the daemon needs: the GGS executable (the launch fallback
    // when no window ever registered) and the extension's directory (the uninstall check).
    let mut config = Config::load_or_init(paths).map_err(|e| e.to_string())?;
    let mut changed = false;
    if let Some(exe) = flag(args, "--ggs-exe").filter(|p| !p.is_empty()) {
        changed |= config.ggs_exe.as_deref() != Some(exe.as_str());
        config.ggs_exe = Some(exe);
    }
    if let Some(dir) = flag(args, "--extension-dir").filter(|p| !p.is_empty()) {
        changed |= config.extension_dir.as_deref() != Some(dir.as_str());
        config.extension_dir = Some(dir);
        config.extension_missing_since = None;
    }
    if changed {
        match client::admin(
            paths,
            "PUT",
            "/admin/config",
            Some(
                &serde_json::json!({
                    "ggsExe": config.ggs_exe,
                    "extensionDir": config.extension_dir,
                    "extensionMissingSince": null,
                })
                .to_string(),
            ),
        ) {
            Ok(_) => {}
            Err(_) => config.save(paths).map_err(|e| e.to_string())?,
        }
    }
    if config.autostart {
        let _ = ggs_remote::autostart::apply(true);
    }
    if !args.iter().any(|a| a == "--no-start") {
        client::start(paths, &client::installed_binary(paths))?;
    }
    println!(
        "{}",
        serde_json::json!({ "outcome": format!("{outcome:?}").to_lowercase(), "version": VERSION })
    );
    Ok(())
}

fn admin_call(paths: &Paths, args: &[String]) -> Result<(), String> {
    let (Some(method), Some(path)) = (args.get(1), args.get(2)) else {
        return Err("usage: ggs-remote admin METHOD PATH [JSON]".into());
    };
    if !path.starts_with("/admin/") {
        return Err("admin calls address /admin/… paths".into());
    }
    // `-` reads the body from stdin: a password never shows in a process listing's argv.
    let body = match args.get(3).map(String::as_str) {
        Some("-") => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
                .map_err(|e| e.to_string())?;
            Some(text)
        }
        other => other.map(str::to_owned),
    };
    let body = client::admin(paths, &method.to_uppercase(), path, body.as_deref())?;
    print!("{body}");
    let _ = std::io::stdout().flush();
    Ok(())
}

fn set_password(paths: &Paths, given: Option<String>) -> Result<(), String> {
    let password = match given {
        Some(p) => p,
        None => {
            print!("New access password: ");
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            line.trim_end_matches(['\r', '\n']).to_owned()
        }
    };
    let body = serde_json::json!({ "password": password }).to_string();
    match client::admin(paths, "POST", "/admin/password", Some(&body)) {
        Ok(_) => {
            println!("Password updated; every remote device must sign in again.");
            Ok(())
        }
        Err(e) if e.contains("not running") => {
            paths.ensure().map_err(|e| e.to_string())?;
            let auth = ggs_remote::auth::Auth::load(paths);
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            runtime
                .block_on(auth.set_password(&password))
                .map_err(|e| e.to_string())?;
            println!("Password set.");
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn print_link(paths: &Paths) -> Result<(), String> {
    // A connected Hub adds its server link — the same bookmark works away from home (§20.5).
    if let Ok(body) = client::admin(paths, "GET", "/admin/hub/status", None) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
            if value["state"] == "online" {
                if let Some(base) = value["publicBase"].as_str() {
                    println!("{base}");
                }
            }
        }
    }
    let config = Config::load_or_init(paths).map_err(|e| e.to_string())?;
    let scheme = if config.tls.mode == ggs_remote::config::TlsMode::None {
        "http"
    } else {
        "https"
    };
    let mut any = false;
    for addr in ggs_remote::tls::lan_addresses() {
        println!("{}", ggs_remote::tls::link_for(scheme, &addr, config.port));
        any = true;
    }
    if let Some(host) = ggs_remote::tls::hostname_local() {
        println!("{}", ggs_remote::tls::link_for(scheme, &host, config.port));
        any = true;
    }
    if !any {
        println!(
            "{}",
            ggs_remote::tls::link_for(scheme, "127.0.0.1", config.port)
        );
    }
    Ok(())
}

fn pair(paths: &Paths) -> Result<(), String> {
    let body = client::admin(paths, "POST", "/admin/pair-ticket", Some("{}"))?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let url = value["url"].as_str().ok_or("no pair url")?;
    ggs_remote::desk::open_url(url)
}
