//! The relay binary: `serve` by default, plus the operator commands (user management,
//! gc) over the same store.

use claude_remote_server::{api, config, store};
use config::{Command, Config};
use tokio::sync::watch;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn open_store(config: &Config) -> store::Store {
    store::Store::open(config.data_dir.as_deref()).unwrap_or_else(|e| {
        eprintln!("cannot open the data directory {:?}: {e}", config.data_dir);
        std::process::exit(1);
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = Config::parse_command(args, env).unwrap_or_else(|message| {
        print!("{message}");
        std::process::exit(if message.trim() == config::USAGE { 0 } else { 2 });
    });
    match command {
        Command::Serve(config) => serve(config),
        Command::UserList(config) => {
            let store = open_store(&config);
            for id in store.user_ids() {
                let user = store.get(&id).expect("just listed");
                let devices = store.devices_of(&id);
                println!(
                    "{}\tepoch {}\t{}{}{}\t{} phone{}\tcreated {}",
                    user.id,
                    user.epoch,
                    if user.disabled { "DISABLED " } else { "" },
                    if user.password.is_some() { "password " } else { "" },
                    if devices.iter().any(|d| d.last_seen + 30_000 > store::now_ms()) { "online " } else { "" },
                    devices.len(),
                    if devices.len() == 1 { "" } else { "s" },
                    user.created,
                );
            }
        }
        Command::UserSet(config, id, disabled) => {
            let store = open_store(&config);
            match store.set_disabled(&id, disabled) {
                Ok(true) => println!("{} {}", id, if disabled { "disabled (phones kicked)" } else { "enabled" }),
                Ok(false) => println!("{id} already {}", if disabled { "disabled" } else { "enabled" }),
                Err(e) => {
                    eprintln!("{}: {}", id, e.message());
                    std::process::exit(1);
                }
            }
        }
        Command::UserDelete(config, id) => {
            let store = open_store(&config);
            match store.delete(&id) {
                Ok(()) => println!("{id} deleted"),
                Err(e) => {
                    eprintln!("{}: {}", id, e.message());
                    std::process::exit(1);
                }
            }
        }
        Command::Gc(config, days) => {
            let store = open_store(&config);
            let ms = days.saturating_mul(24 * 3600 * 1000);
            let dropped = store.gc_devices(ms);
            println!("dropped {dropped} phone(s) unseen for {days} day(s)");
        }
    }
}

fn serve(config: config::Config) {
    if let Err(message) = config.validate() {
        eprintln!("{message}");
        std::process::exit(2);
    }
    let listen = config.listen;
    let app = api::App::new(config);
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("a tokio runtime");
    runtime.block_on(async move {
        let (stop_tx, stop_rx) = watch::channel(false);
        let addr = app
            .clone()
            .serve(listen, stop_rx)
            .await
            .unwrap_or_else(|e| {
                eprintln!("cannot listen on {listen}: {e}");
                std::process::exit(1);
            });
        println!(
            "claude-remote-server listening on {addr} ({} user(s) registered)",
            app.store().user_count(),
        );
        let _ = tokio::signal::ctrl_c().await;
        println!("shutting down");
        let _ = stop_tx.send(true);
        // The graceful shutdown drains in-flight requests; give it a beat.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    });
}
