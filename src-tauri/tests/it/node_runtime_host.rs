//! The ggs-node sidecar driven exactly as the app drives it: a VSIX installed through
//! cmd_ext, the backend spawned by ext_process's ProcessHostState, the ggs-ext/1
//! handshake and a command round trip. The runtime's own protocol tests live in the
//! ggs-node package (crates/ggs-node/tests/it); this is the app's half of the seam.


use std::io::Write;

use ggs_ext::process::ExtHost;
use serde_json::json;

const ID: &str = "acme.js-demo";

/// The whole chain as the app drives it: install a VSIX whose JS entry and native binary
/// derive a backend, let the process host spawn the bundled sidecar, shake hands, run a command, stop.
#[test]
fn the_process_host_runs_a_ggs_node_backend_end_to_end() {
    // The ggs-node package's binary, built by the same `cargo test --workspace` pass that
    // builds this suite (its own integration tests keep CARGO_BIN_EXE_ggs-node honest):
    // the test binary runs from <target>/debug/deps, the sidecar sits one directory up.
    let exe = std::env::current_exe().expect("the test binary's path");
    let profile_dir = exe.parent().and_then(|deps| deps.parent()).expect("the target profile directory");
    let sidecar_name = if cfg!(windows) { "ggs-node.exe" } else { "ggs-node" };
    let sidecar = profile_dir.join(sidecar_name);
    assert!(sidecar.is_file(), "the ggs-node sidecar is missing beside the test binaries: {}", sidecar.display());
    std::env::set_var("GGS_ENGINE_HOST", profile_dir);

    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    let vsix = tmp.path().join("js-demo.vsix");
    let file = std::fs::File::create(&vsix).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("extension/package.json", options).unwrap();
    zip.write_all(br#"{"name":"js-demo","publisher":"acme","version":"1.0.0","main":"out/main.js","native":{"win32-x64-msvc":"engine.node"},"contributes":{"commands":[{"command":"acme.js-demo.view","title":"View"}]}}"#).unwrap();
    zip.start_file("extension/engine.node", options).unwrap();
    zip.write_all(b"engine-node-fixture").unwrap();
    zip.start_file("extension/out/main.js", options).unwrap();
    zip.write_all(
        br#"
const fs = require('fs');
const path = require('path');
ggs.onRequest((command, args) => {
    if (command === 'acme.js-demo.view') return { opened: true, params: args[0] };
    if (command === 'readSelf') {
        return { text: fs.readFileSync(path.join(__dirname, 'note.txt'), 'utf8') };
    }
    return { unknown: command };
});
"#,
    )
    .unwrap();
    zip.start_file("extension/out/note.txt", options).unwrap();
    zip.write_all(b"served by the pretend runtime").unwrap();
    zip.start_file("extension/web/view.html", options).unwrap();
    zip.write_all(b"<html><body></body></html>").unwrap();
    zip.finish().unwrap();
    let info = ggs_ext::install_from_vsix_into(&exts, &vsix, false).unwrap();

    let state = ExtHost::default();
    let started = state.start(&exts, ID).unwrap();
    assert_eq!(started.protocol_version, "ggs-ext/1");
    // No special manifest fields any more: the backend's command list comes from the
    // package's standard `contributes.commands`.
    assert_eq!(
        started.commands,
        vec!["acme.js-demo.view".to_owned()],
        "{started:?}"
    );
    let _ = info;

    // The package's own handler answers its declared commands.
    let read = state.run(&exts, ID, "readSelf", json!([])).unwrap();
    assert_eq!(read["text"], json!("served by the pretend runtime"));

    state.stop(ID).unwrap();
}
