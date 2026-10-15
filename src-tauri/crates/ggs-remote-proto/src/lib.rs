//! ggs-remote-proto (L0, module 19): the local control channel's messages — the ONE
//! copy both sides link (docs/ggs-remote-plan.md §7.8). Every GGS instance keeps one
//! connection to the daemon over a named pipe (Windows) or a Unix domain socket; a
//! message is a little-endian `u32` length plus a MessagePack body (externally tagged
//! enums, named fields). The bytes stay the contract: the daemon's
//! tests/vectors/control.json pins them (this crate's own test reads the vectors), so
//! the app and the daemon can never drift apart again.
//!
//! Zero platform dependencies by design: the daemon (its own workspace) links this
//! crate by path without inheriting anything of the app.

use serde::{Deserialize, Serialize};

/// The largest control message either side accepts (an asset reply chunk plus headroom).
pub const MAX_CONTROL_MESSAGE: usize = 4 << 20;

/// How the daemon starts another instance of the same GGS: the program plus the arguments
/// before the folder (`cmd_app::instance_argv` on the app side; `open -n <bundle> --args` on
/// a packaged macOS build).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchSpec {
    pub program: String,
    pub args_prefix: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SummaryTab {
    pub path: String,
    pub dirty: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub tabs: Vec<SummaryTab>,
    pub terminals: u32,
    pub dirty: u32,
    pub scm_changes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssetKind {
    /// The remote workbench build (`remote/…` inside the instance's embedded assets).
    App,
    /// An installed package's file (the `ggs://` protocol's own serving path).
    Ext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FromInstance {
    Register {
        instance_id: String,
        pid: u32,
        version: String,
        title: String,
        folders: Vec<String>,
        visible: bool,
        remote_host: bool,
        launch: LaunchSpec,
        /// This instance runs inside the security sandbox (§23) — an app half a
        /// version behind may not say, so the daemon believes its own channel, not
        /// this flag.
        #[serde(default)]
        sandboxed: bool,
        /// The one-shot token a sandboxed spawn was issued; empty for ordinary
        /// registrations (§23).
        #[serde(default)]
        control_token: String,
    },
    Update {
        title: Option<String>,
        folders: Option<Vec<String>>,
        visible: Option<bool>,
        summary: Option<Summary>,
    },
    Pong {
        nonce: u64,
    },
    /// The answer to a non-forced `Quit`: unsaved files, the instance stays up.
    CloseBlocked {
        dirty: Vec<String>,
    },
    /// One chunk of an asset; `done` closes the reply.
    AssetReply {
        req: u32,
        status: u16,
        content_type: String,
        etag: String,
        #[serde(with = "serde_bytes")]
        body: Vec<u8>,
        done: bool,
    },
    /// One chunk of a download.
    FileReply {
        req: u32,
        status: u16,
        name: String,
        total: u64,
        #[serde(with = "serde_bytes")]
        chunk: Vec<u8>,
        done: bool,
    },
    RelayReady,
    Bye,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ToInstance {
    Welcome {
        daemon_version: String,
        relay_url: String,
    },
    FetchAsset {
        req: u32,
        kind: AssetKind,
        path: String,
    },
    FetchFile {
        req: u32,
        path: String,
        zip: bool,
    },
    EnsureRelay {
        token: String,
    },
    DropRelay,
    Ping {
        nonce: u64,
    },
    Show,
    /// Graceful exit; `force` skips the unsaved-files check. `idle` marks the idle exit's
    /// ask (§7.10), which an instance running the replica (§22) declines — a browser that
    /// went away must not end the work it left running on the PC.
    Quit {
        force: bool,
        #[serde(default)]
        idle: bool,
    },
}

pub fn encode<T: Serialize>(message: &T) -> Vec<u8> {
    let body = rmp_serde::to_vec_named(message).expect("control messages always serialize");
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

pub fn decode<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    rmp_serde::from_slice(body).map_err(|e| format!("control message: {e}"))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The vectors the app's `remote_host.rs` copy is tested against too: each entry is a
    /// message in JSON form (the serde shape) and the exact framed bytes.
    #[test]
    fn matches_the_shared_control_vectors() {
        let raw = include_str!("../../../../extensions-src/ggs-remote/daemon/tests/vectors/control.json");
        let mut vectors: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        // `GGS_BLESS=1 cargo test` rewrites the expected bytes after a deliberate change.
        let bless = std::env::var_os("GGS_BLESS").is_some();
        for v in vectors.iter_mut() {
            let name = v["name"].as_str().unwrap().to_owned();
            let json = v["message"].clone();
            let bytes = match v["direction"].as_str().unwrap() {
                "from" => {
                    let message: FromInstance = serde_json::from_value(json).unwrap();
                    let framed = encode(&message);
                    let back: FromInstance = decode(&framed[4..]).unwrap();
                    assert_eq!(back, message, "{name}");
                    framed
                }
                _ => {
                    let message: ToInstance = serde_json::from_value(json).unwrap();
                    let framed = encode(&message);
                    let back: ToInstance = decode(&framed[4..]).unwrap();
                    assert_eq!(back, message, "{name}");
                    framed
                }
            };
            if bless {
                v["hex"] = hex(&bytes).into();
            } else {
                assert_eq!(hex(&bytes), v["hex"].as_str().unwrap(), "{name}");
            }
        }
        if bless {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/control.json");
            std::fs::write(
                path,
                serde_json::to_string_pretty(&vectors).unwrap()
                    + "
",
            )
            .unwrap();
        }
    }

    #[test]
    fn asset_bodies_cross_as_binary() {
        let reply = FromInstance::AssetReply {
            req: 1,
            status: 200,
            content_type: "text/plain".into(),
            etag: String::new(),
            body: vec![0u8; 1000],
            done: true,
        };
        // A byte array of 1000 zeros, not 1000 msgpack integers: well under 2× the body.
        assert!(encode(&reply).len() < 1100);
    }
}
