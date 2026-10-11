//! The tunnel's MessagePack messages (docs/ggs-remote-plan.md §20.4). The daemon has its own
//! copy (`daemon/src/hub/msg.rs`); field names are the contract.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTO: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct THello {
    #[serde(with = "serde_bytes")]
    pub pubkey: Vec<u8>,
    #[serde(default)]
    pub join_key: Option<String>,
    #[serde(default)]
    pub daemon_version: String,
    #[serde(default)]
    pub proto: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TChallenge {
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    /// The host name the signature must bind (the Hub's public host).
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TAuth {
    #[serde(with = "serde_bytes")]
    pub sig: Vec<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub sessions: u32,
    pub bytes_per_day: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TReady {
    pub uuid: String,
    pub public_base: String,
    pub base_path: String,
    pub limits: Limits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TRejected {
    /// `join-key` | `capacity` | `version` | `banned` | `auth`
    pub reason: String,
}

/// A browser connection (or an HTTP request) the Hub opened toward the PC.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnOpen {
    pub session: u32,
    /// `ws` or `http`.
    pub kind: String,
    pub ip: String,
    pub ua: String,
    pub base_path: String,
    /// The request headers the daemon's checks read (cookie, origin, host, …).
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ConnClose {
    pub session: u32,
    pub code: u16,
    pub reason: String,
}

/// The head of a proxied HTTP request (its body follows as RAW frames on the same session).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HttpReq {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: BTreeMap<String, String>,
    pub ip: String,
    pub base_path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HttpRes {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}
