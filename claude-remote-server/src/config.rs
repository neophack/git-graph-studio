//! The relay's configuration: command-line flags over environment variables over defaults.
//! No config file — a relay is one listen address, one data directory and a few limits.

use std::net::SocketAddr;
use std::path::PathBuf;

/// Whether a new PC may register, and what it takes (plan §3.6's `registration`):
/// `open` (anyone), `token` (the `--invite` value, the default) or `closed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Registration {
    Open,
    Token,
    Closed,
}

impl Registration {
    fn parse(text: &str) -> Option<Registration> {
        match text {
            "open" => Some(Registration::Open),
            "token" => Some(Registration::Token),
            "closed" => Some(Registration::Closed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    /// Where `users.json` lives; `None` keeps everything in memory (tests, throwaway relays).
    pub data_dir: Option<PathBuf>,
    pub registration: Registration,
    /// When set and `registration` is `token`, registering a new PC requires this value —
    /// a public relay is not an open signup page.
    pub invite: Option<String>,
    pub max_users: usize,
    pub max_windows: usize,
    pub max_devices: usize,
    /// The largest WebSocket message either side may send (an opaque encrypted frame).
    pub max_frame: usize,
    /// Frames per window a slow connection may bank before the oldest drop (a `gap`
    /// marker tells the client to resync).
    pub queue_frames: usize,
    /// Bytes per connection a banked queue may hold, alongside the frame count.
    pub queue_bytes: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            listen: "0.0.0.0:8787".parse().expect("static address"),
            data_dir: Some(PathBuf::from("claude-remote-data")),
            registration: Registration::Token,
            invite: None,
            max_users: 1000,
            max_windows: 16,
            max_devices: 10,
            max_frame: 1024 * 1024,
            queue_frames: 256,
            queue_bytes: 4 * 1024 * 1024,
        }
    }
}

pub const USAGE: &str = "claude-remote-server — the Claude Remote relay

USAGE:
    claude-remote-server serve [OPTIONS]   run the relay (the default command)
    claude-remote-server user list         list registered PCs
    claude-remote-server user disable <id> block a PC and kick its phones
    claude-remote-server user enable <id>
    claude-remote-server user delete <id>
    claude-remote-server gc [--days <n>]   drop phones unseen for n days (default 90)

    serve OPTIONS:
    --listen <addr>        listen address              [env CLAUDE_REMOTE_LISTEN, default 0.0.0.0:8787]
    --data <dir>           data directory              [env CLAUDE_REMOTE_DATA, default ./claude-remote-data]
    --memory               keep users in memory only (nothing written)
    --registration <mode>  open | token | closed       [default token]
    --invite <token>       the token a PC needs under registration=token
                                                                   [env CLAUDE_REMOTE_INVITE]
    --max-users <n>        registered PCs              [default 1000]
    --max-windows <n>      online windows per PC       [default 16]
    --max-devices <n>      paired phones per PC        [default 10]
    --max-frame <bytes>    largest message             [default 1048576]
    -h, --help             this text
";

#[derive(Debug)]
pub enum Command {
    Serve(Config),
    UserList(Config),
    UserSet(Config, String, bool), // id, disabled
    UserDelete(Config, String),
    Gc(Config, u64), // days
}

impl Config {
    /// Parse `args` (without the program name), reading the environment for the
    /// variables `USAGE` names. `Err` carries the message to print (usage included).
    pub fn from_args<I: IntoIterator<Item = String>>(
        args: I,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Config, String> {
        let mut config = Config::default();
        if let Some(listen) = env("CLAUDE_REMOTE_LISTEN") {
            config.listen = parse_addr(&listen)?;
        }
        if let Some(dir) = env("CLAUDE_REMOTE_DATA") {
            config.data_dir = Some(PathBuf::from(dir));
        }
        config.invite = env("CLAUDE_REMOTE_INVITE").filter(|t| !t.is_empty());
        let mut args = args.into_iter().peekable();
        while let Some(arg) = args.next() {
            let mut value = |name: &str| {
                args.next()
                    .ok_or_else(|| format!("{name} needs a value\n\n{USAGE}"))
            };
            match arg.as_str() {
                "-h" | "--help" => return Err(USAGE.to_string()),
                "--listen" => config.listen = parse_addr(&value("--listen")?)?,
                "--data" => config.data_dir = Some(PathBuf::from(value("--data")?)),
                "--memory" => config.data_dir = None,
                "--registration" => {
                    let mode = value("--registration")?;
                    config.registration =
                        Registration::parse(&mode).ok_or_else(|| format!("not a registration mode (open|token|closed): {mode}"))?;
                }
                "--invite" => config.invite = Some(value("--invite")?).filter(|t| !t.is_empty()),
                "--max-users" => config.max_users = parse_count(&value("--max-users")?)?,
                "--max-windows" => config.max_windows = parse_count(&value("--max-windows")?)?,
                "--max-devices" => config.max_devices = parse_count(&value("--max-devices")?)?,
                "--max-frame" => config.max_frame = parse_count(&value("--max-frame")?)?,
                other => return Err(format!("unknown option {other}\n\n{USAGE}")),
            }
        }
        Ok(config)
    }

    /// The full command line: a subcommand over serve's flags (serve is the default).
    pub fn parse_command<I: IntoIterator<Item = String>>(
        args: I,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Command, String> {
        let mut args: Vec<String> = args.into_iter().collect();
        let first = args.first().map(|s| s.as_str());
        match first {
            Some("serve") => {
                args.remove(0);
                Ok(Command::Serve(Self::from_args(args, env)?))
            }
            Some("user") => {
                args.remove(0);
                let sub = args.first().cloned();
                match sub.as_deref() {
                    Some("list") => {
                        args.remove(0);
                        Ok(Command::UserList(Self::from_args(args, env)?))
                    }
                    Some("disable") | Some("enable") => {
                        let disabled = sub.as_deref() == Some("disable");
                        args.remove(0); // the subcommand word; "user" is already gone
                        let id = args
                            .first()
                            .cloned()
                            .ok_or_else(|| format!("user {} needs an id\n\n{USAGE}", if disabled { "disable" } else { "enable" }))?;
                        args.remove(0);
                        Ok(Command::UserSet(Self::from_args(args, env)?, id, disabled))
                    }
                    Some("delete") => {
                        args.remove(0); // the subcommand word; "user" is already gone
                        let id = args
                            .first()
                            .cloned()
                            .ok_or_else(|| format!("user delete needs an id\n\n{USAGE}"))?;
                        args.remove(0);
                        Ok(Command::UserDelete(Self::from_args(args, env)?, id))
                    }
                    _ => Err(format!("user needs list | disable <id> | enable <id> | delete <id>\n\n{USAGE}")),
                }
            }
            Some("gc") => {
                args.remove(0);
                let mut days = 90u64;
                if args.first().map(|s| s.as_str()) == Some("--days") {
                    args.remove(0);
                    days = args
                        .remove(0)
                        .parse()
                        .map_err(|_| "not a day count".to_string())?;
                }
                Ok(Command::Gc(Self::from_args(args, env)?, days))
            }
            Some("-h") | Some("--help") => Err(USAGE.to_string()),
            _ => Ok(Command::Serve(Self::from_args(args, env)?)),
        }
    }

    /// A token-gated relay needs its token before it can serve anything.
    pub fn validate(&self) -> Result<(), String> {
        if self.registration == Registration::Token
            && self.invite.as_deref().map(str::is_empty).unwrap_or(true)
        {
            return Err(
                "registration is `token` but no --invite is set: pass --invite <value> (or \
                 --registration open) — a public relay without a gate accepts any PC"
                    .into(),
            );
        }
        Ok(())
    }
}

fn parse_addr(text: &str) -> Result<SocketAddr, String> {
    text.parse()
        .map_err(|_| format!("not a listen address (host:port): {text}"))
}

fn parse_count(text: &str) -> Result<usize, String> {
    match text.parse::<usize>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(format!("not a positive number: {text}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Config, String> {
        Config::from_args(args.iter().map(|s| s.to_string()), |_| None)
    }

    #[test]
    fn flags_override_defaults() {
        let config = parse(&[
            "--listen", "127.0.0.1:9000", "--memory", "--invite", "abc", "--max-windows", "4", "--registration", "open",
        ])
        .unwrap();
        assert_eq!(config.listen.port(), 9000);
        assert!(config.data_dir.is_none());
        assert_eq!(config.invite.as_deref(), Some("abc"));
        assert_eq!(config.max_windows, 4);
        assert_eq!(config.registration, Registration::Open);
    }

    #[test]
    fn plan_defaults_hold() {
        let config = parse(&["--invite", "x"]).unwrap();
        assert_eq!((config.max_windows, config.max_devices, config.max_frame), (16, 10, 1024 * 1024));
        assert_eq!(config.registration, Registration::Token);
    }

    #[test]
    fn environment_fills_in_and_flags_win() {
        let env = |name: &str| match name {
            "CLAUDE_REMOTE_LISTEN" => Some("127.0.0.1:7000".to_string()),
            "CLAUDE_REMOTE_INVITE" => Some("from-env".to_string()),
            _ => None,
        };
        let config = Config::from_args(["--listen".to_string(), "127.0.0.1:7001".to_string()], env).unwrap();
        assert_eq!(config.listen.port(), 7001);
        assert_eq!(config.invite.as_deref(), Some("from-env"));
    }

    #[test]
    fn bad_input_is_reported() {
        assert!(parse(&["--max-users", "0"]).is_err());
        assert!(parse(&["--listen"]).is_err());
        assert!(parse(&["--nope"]).unwrap_err().contains("unknown option"));
        assert!(parse(&["--registration", "sometimes"]).is_err());
    }

    #[test]
    fn token_registration_needs_a_token() {
        assert!(parse(&[]).unwrap().validate().is_err());
        assert!(parse(&["--invite", "s3cret"]).unwrap().validate().is_ok());
        assert!(parse(&["--registration", "open"]).unwrap().validate().is_ok());
        assert!(parse(&["--registration", "closed"]).unwrap().validate().is_ok());
    }

    #[test]
    fn subcommands_parse() {
        let cmd = |args: &[&str]| Config::parse_command(args.iter().map(|s| s.to_string()), |_| None);
        assert!(matches!(cmd(&["serve", "--memory"]).unwrap(), Command::Serve(_)));
        assert!(matches!(cmd(&[]).unwrap(), Command::Serve(_)));
        assert!(matches!(cmd(&["user", "list"]).unwrap(), Command::UserList(_)));
        let parsed = cmd(&["user", "disable", "u_x"]).unwrap();
        assert!(matches!(parsed, Command::UserSet(_, id, true) if id == "u_x"));
        assert!(matches!(cmd(&["gc", "--days", "7"]).unwrap(), Command::Gc(_, 7)));
        assert!(cmd(&["user", "kick", "u_x"]).is_err());
        assert!(cmd(&["user", "disable"]).is_err());
    }
}
