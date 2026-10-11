//! `ggs-remote-hub` — the relay's entry (docs/ggs-remote-plan.md §20.8).
//!
//! ```text
//! ggs-remote-hub [--config hub.toml] [--example-config] [--verbose]
//! ```
//!
//! Nothing is stored anywhere: a restart loses only the online tunnels, and every PC
//! reconnects on its own backoff with the same link as before.

use ggs_remote_hub::config::Config;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--example-config") {
        println!("{}", Config::example());
        return;
    }
    if args.iter().any(|a| a == "--verbose" || a == "-v") {
        ggs_remote_hub::util::set_verbose();
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("ggs-remote-hub [--config hub.toml] [--example-config] [--verbose]");
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("ggs-remote-hub {VERSION}");
        return;
    }
    let path = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or("hub.toml");
    let config = match Config::load(path) {
        Ok(config) => config,
        Err(e) => {
            eprintln!("ggs-remote-hub: {e}");
            eprintln!("start with --example-config for a commented hub.toml");
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime");
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    runtime.spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop_tx.send(());
    });
    ggs_remote_hub::info!(
        "ggs-remote-hub {VERSION} starting (pid {})",
        std::process::id()
    );
    if let Err(e) = runtime.block_on(ggs_remote_hub::serve(config, stop_rx)) {
        eprintln!("ggs-remote-hub: {e}");
        std::process::exit(1);
    }
    ggs_remote_hub::info!("bye");
}
