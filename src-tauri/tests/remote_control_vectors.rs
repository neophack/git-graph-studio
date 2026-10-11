//! The app's copy of the Remote Access control messages (`remote_host.rs`) against the
//! daemon's test vectors (docs/ggs-remote-plan.md §6.7): the two sides share no crate, so
//! these bytes are the contract. A vector change on the daemon side fails here until the
//! app's copy follows.

#![cfg(feature = "desktop")]

use git_graph_studio_lib::remote_host::{decode, encode, FromInstance, ToInstance};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn control_messages_match_the_daemon_vectors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../extensions-src/ggs-remote/daemon/tests/vectors/control.json"
    );
    let raw = std::fs::read_to_string(path).expect("the daemon's control vectors");
    let vectors: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
    assert!(vectors.len() >= 10);
    for v in vectors {
        let name = v["name"].as_str().unwrap();
        let message = v["message"].clone();
        let bytes = if v["direction"] == "from" {
            let parsed: FromInstance = serde_json::from_value(message).unwrap();
            let framed = encode(&parsed);
            assert_eq!(
                decode::<FromInstance>(&framed[4..]).unwrap(),
                parsed,
                "{name}"
            );
            framed
        } else {
            let parsed: ToInstance = serde_json::from_value(message).unwrap();
            let framed = encode(&parsed);
            assert_eq!(
                decode::<ToInstance>(&framed[4..]).unwrap(),
                parsed,
                "{name}"
            );
            framed
        };
        assert_eq!(hex(&bytes), v["hex"].as_str().unwrap(), "{name}");
    }
}
