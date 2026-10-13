//! `ggs-config` (module 19): the one-command Remote Access setup — the SSH-and-then-a-
//! single-word flow the owner asked for (2026-10-13): install the tray daemon, set the
//! access password, optionally connect a relay, print the links. No window ever opens.
//!
//! The same code answers as `ggs config` / `ggs-config` (lib.rs's `run()` dispatches the
//! subcommand), and — the classic single-binary trick — under whichever name a symlink
//! or copy points at this executable.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(git_graph_studio_lib::remote_config::run(&args));
}
