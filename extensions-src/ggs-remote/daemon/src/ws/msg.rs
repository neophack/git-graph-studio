//! The MessagePack control messages of the browser link (docs/ggs-remote-plan.md §6.2). Field
//! names are camelCase on the wire — the browser decodes them into plain objects — and every
//! optional field may be absent, so an older peer's message still decodes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Caps {
    pub deflate: bool,
    pub sw: bool,
    pub clipboard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub sid: String,
    pub last_seq: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hello {
    pub proto: u32,
    pub client: String,
    pub ver: String,
    pub caps: Caps,
    pub form_factor: String,
    pub data_saver: bool,
    pub resume: Option<Resume>,
    pub csrf: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAck {
    pub sid: String,
    pub server_time: u64,
    pub heartbeat_ms: u32,
    pub max_frame: u32,
    pub credit: u32,
    pub resumed: bool,
    /// The proxied base path this connection arrived under (`/` on the LAN, `/u/<uuid>/`
    /// through a Hub) — the browser builds every URL relative to it.
    pub base_path: String,
}

/// One open editor of an instance's content summary (R21).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SummaryTab {
    pub path: String,
    pub dirty: bool,
    pub active: bool,
}

/// What an instance shows, pushed by the instance (R21): the window picker's card body.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub tabs: Vec<SummaryTab>,
    pub terminals: u32,
    pub dirty: u32,
    pub scm_changes: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Busy {
    pub terminals: u32,
    pub dirty: u32,
}

/// One GGS instance as the window picker and the switcher show it (§7.8).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceInfo {
    pub id: String,
    pub title: String,
    pub folders: Vec<String>,
    pub version: String,
    pub visible: bool,
    pub remote_sessions: u32,
    pub started_at: u64,
    pub busy: Busy,
    /// `ok` or `unresponsive` (the two-level heartbeat, §7.8).
    pub state: String,
    pub last_seen: u64,
    pub summary: Summary,
    /// Spawned by the daemon (`--remote-host`), not by a desktop launch.
    pub spawned: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Windows {
    pub instances: Vec<InstanceInfo>,
    /// The recently opened folders (the picker's "recent paths" list, most recent first) —
    /// what a `SPAWN` with that folder reopens. May be absent from an older daemon.
    pub recent_folders: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Attach {
    pub instance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub instance: String,
    pub version: String,
    pub asset_base: String,
    pub ggs_base: String,
    pub frontend_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Spawn {
    pub folder: Option<String>,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    pub instance: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceClose {
    pub instance: String,
    pub force: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceRestart {
    pub instance: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Credit {
    pub bytes: u32,
    pub ack_seq: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pong {
    pub ack_seq: u32,
}

/// A NOTICE (§6.2): `kind` plus whatever the kind carries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notice {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dirty: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Notice {
    pub fn kind(kind: &str) -> Notice {
        Notice {
            kind: kind.to_owned(),
            ..Notice::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Close {
    pub code: u16,
    pub reason: String,
}

/// Close codes (§6.2).
pub mod code {
    pub const CREDENTIALS: u16 = 4401;
    pub const ORIGIN: u16 = 4403;
    pub const VERSION: u16 = 4409;
    pub const INSTANCE_GONE: u16 = 4410;
    pub const RATE: u16 = 4429;
}

/// The protocol's major version (`HELLO.proto`, §6.6).
pub const PROTO: u32 = 1;
/// The initial credit window and the heartbeat interval (§6.4, §6.2).
pub const INITIAL_CREDIT: u32 = 1 << 20;
pub const HEARTBEAT_MS: u32 = 20_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_decodes_from_a_partial_object() {
        let bytes =
            rmp_serde::to_vec_named(&serde_json::json!({ "proto": 1, "csrf": "abc" })).unwrap();
        let hello: Hello = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(hello.proto, 1);
        assert_eq!(hello.csrf, "abc");
        assert!(hello.resume.is_none());
    }

    #[test]
    fn instance_info_is_camel_case_on_the_wire() {
        let info = InstanceInfo {
            id: "ggs-1".into(),
            remote_sessions: 2,
            ..InstanceInfo::default()
        };
        let value: serde_json::Value =
            rmp_serde::from_slice(&rmp_serde::to_vec_named(&info).unwrap()).unwrap();
        assert_eq!(value["remoteSessions"], 2);
        assert!(value.get("scmChanges").is_none());
        assert_eq!(value["summary"]["scmChanges"], 0);
    }

    #[test]
    fn notice_omits_empty_fields() {
        let value: serde_json::Value = rmp_serde::from_slice(
            &rmp_serde::to_vec_named(&Notice::kind("relay-restarted")).unwrap(),
        )
        .unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "relay-restarted" }));
    }

    #[test]
    fn windows_carries_the_recent_folders_camel_cased_and_decodes_without_them() {
        let value: serde_json::Value = rmp_serde::from_slice(
            &rmp_serde::to_vec_named(&Windows {
                instances: Vec::new(),
                recent_folders: vec!["C:/repo".into()],
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["recentFolders"][0], "C:/repo");
        // An older daemon's frame (no field) still decodes into an empty list.
        let legacy = rmp_serde::to_vec_named(&serde_json::json!({ "instances": [] })).unwrap();
        let windows: Windows = rmp_serde::from_slice(&legacy).unwrap();
        assert!(windows.recent_folders.is_empty());
    }
}
