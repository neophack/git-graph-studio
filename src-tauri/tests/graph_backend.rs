//! The generic engine-node host's integration test: a VSIX whose backend declares the
//! real engine `.node` (`kind: "node"`) is installed the way the app installs one, then
//! spoken to over a real child process and a real pipe — the `initialize` handshake, the
//! launcher convention (`{openPage}`), and the one crossing that is the whole design: a
//! page message forwarded to the engine verbatim and the engine's own JSON answer back,
//! with nothing of any package's protocol in the host. The same `.node` the editor's Node
//! runtime loads, served over its C ABI.

#![cfg(feature = "desktop")]

use std::io::Write;

use git_graph_studio_lib::cmd_ext;
use git_graph_studio_lib::ext_process::ProcessHostState;
use git_graph_studio_lib::git::Git;
use serde_json::{json, Value};

const ID: &str = "acme.engine-demo";

/// A minimal scratch repository — `test_support::Scratch` is `#[cfg(test)]` on the library
/// itself, so it does not link into an integration test binary; this replicates just enough
/// of it (a scratch global git config, commits on `main`) inline.
fn scratch_repo(tmp: &std::path::Path) -> Git {
    std::fs::create_dir_all(tmp).unwrap();
    std::fs::write(tmp.join("gitconfig"), "[init]\n\tdefaultBranch = main\n").unwrap();
    let repo = tmp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let mut git = Git::new(&repo);
    git.env = vec![
        (
            "GIT_CONFIG_GLOBAL".into(),
            tmp.join("gitconfig").display().to_string(),
        ),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("HOME".into(), tmp.display().to_string()),
        ("GIT_AUTHOR_NAME".into(), "Test".into()),
        ("GIT_AUTHOR_EMAIL".into(), "test@example.com".into()),
        ("GIT_COMMITTER_NAME".into(), "Test".into()),
        ("GIT_COMMITTER_EMAIL".into(), "test@example.com".into()),
    ];
    git.run(&["init", "-q", "-b", "main"]).unwrap();
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    git.run(&["add", "README.md"]).unwrap();
    git.run(&["commit", "-q", "-m", "first"]).unwrap();
    std::fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    git.run(&["add", "a.rs"]).unwrap();
    git.run(&["commit", "-q", "-m", "second"]).unwrap();
    git
}

/// The engine `.node` the package's backend points at — the submodule's addon output, the
/// same single engine binary the editor's Node runtime loads. `prepare.mjs` builds it; a
/// bare `cargo test` may not have it, so the whole test skips (with the reason) rather
/// than fails.
fn engine_node() -> Option<std::path::PathBuf> {
    let key = cmd_ext::host_platform_key();
    let directory = match key.as_str() {
        "win32-x64" => "win32-x64-msvc",
        "win32-arm64" => "win32-arm64-msvc",
        "linux-x64" => "linux-x64-gnu",
        "linux-arm64" => "linux-arm64-gnu",
        "darwin-x64" => "darwin-x64",
        "darwin-arm64" => "darwin-arm64",
        _ => &key,
    };
    let node = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vscode-git-graph-rs")
        .join("native")
        .join(directory)
        .join("git-graph.node");
    node.is_file().then_some(node)
}

/// Install a VSIX declaring the engine `.node` and an activity-bar launcher whose `page`
/// is the host's one command convention. Returns the install directory.
fn install_package(exts: &std::path::Path, node: &std::path::Path) {
    std::fs::create_dir_all(exts).unwrap();
    let vsix = exts.parent().unwrap().join("engine-demo.vsix");
    let file = std::fs::File::create(&vsix).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("extension/package.json", options).unwrap();
    zip.write_all(
        format!(
            r#"{{"name":"engine-demo","publisher":"acme","version":"1.0.0","ggs":{{"format":"ggs/2","id":"{ID}","version":"1.0.0","pages":{{"view":{{"page":"web/view.html"}}}},"activitybar":{{"command":"acme.engine-demo.view","page":"view"}},"backend":{{"kind":"node","host":"git-graph-backend","command":"native/win32-x64/git-graph.node"}}}}}}"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.start_file("extension/web/view.html", options).unwrap();
    zip.write_all(b"<html><body></body></html>").unwrap();
    zip.start_file(
        format!(
            "extension/native/{}/git-graph.node",
            cmd_ext::host_platform_key()
        ),
        options,
    )
    .unwrap();
    zip.write_all(&std::fs::read(node).unwrap()).unwrap();
    zip.finish().unwrap();
    cmd_ext::install_from_vsix_into(exts, &vsix, false).unwrap();
}

#[test]
fn the_generic_host_forwards_messages_verbatim_and_answers_the_launcher_convention() {
    let Some(node) = engine_node() else {
        eprintln!(
            "skipping: no engine .node under vscode-git-graph-rs/native (prepare.mjs builds it)"
        );
        return;
    };
    // The engine host the `node` backend names, resolved the way `resolve_engine_host`
    // looks: `GGS_ENGINE_HOST` names its directory (in a real install it sits beside the
    // app's binary). `CARGO_BIN_EXE_…` makes cargo build the host for this test.
    let host = std::path::Path::new(env!("CARGO_BIN_EXE_git-graph-backend")).to_path_buf();
    std::env::set_var("GGS_ENGINE_HOST", host.parent().unwrap());

    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    install_package(&exts, &node);

    let repo_tmp = tempfile::tempdir().unwrap();
    let git = scratch_repo(repo_tmp.path());
    let root = git.repo.display().to_string();

    let state = ProcessHostState::default();
    let info = state.start(&exts, ID).unwrap();
    // The handshake: the one protocol, and the manifest's launcher command — nothing else
    // is the host's to declare.
    assert_eq!(info.protocol_version, "ggs-ext/1");
    assert_eq!(
        info.commands,
        vec!["acme.engine-demo.view".to_owned()],
        "{info:?}"
    );

    // The launcher convention: the manifest's command answers openPage for its page, with
    // the command's first argument as the params (the repository a view opens on).
    let opened = state
        .run(
            &exts,
            ID,
            "acme.engine-demo.view",
            json!([{ "repo": root }]),
        )
        .unwrap();
    assert_eq!(opened["openPage"], json!("view"));
    assert_eq!(opened["params"]["repo"], json!(root));

    // The one crossing: a page message is the engine call (method = the command, params =
    // the message) and the engine's own JSON answers — the repo info is the engine's
    // shape, not an envelope some host wrapped.
    let info_answer = state
        .run(
            &exts,
            ID,
            "loadRepoInfo",
            json!([{ "command": "loadRepoInfo", "repo": root, "showRemoteBranches": true }]),
        )
        .unwrap();
    assert_eq!(info_answer["branches"], json!(["main"]));
    assert_eq!(info_answer["head"], json!("main"));
    assert_eq!(info_answer["error"], Value::Null);
    // No host-added envelope: the engine's field set is exactly what crossed back.
    for absent in ["command", "isRepo", "operationState"] {
        assert!(info_answer.get(absent).is_none(), "no {absent} envelope");
    }

    // A graph page, and a count, both the engine's own answers.
    let page = state
        .run(
            &exts,
            ID,
            "loadCommits",
            json!([{ "command": "loadCommits", "repo": root, "maxCommits": 300 }]),
        )
        .unwrap();
    assert_eq!(page["commits"].as_array().unwrap().len(), 2);
    let count = state
        .run(
            &exts,
            ID,
            "countUncommittedChanges",
            json!([{ "command": "countUncommittedChanges", "repo": root, "includeUntracked": true }]),
        )
        .unwrap();
    assert_eq!(count, json!(0));

    // What the engine does not serve is the message-shaped error a page can show — never
    // a thrown wire, never a silent hole.
    let unsupported = state
        .run(
            &exts,
            ID,
            "checkoutBranch",
            json!([{ "command": "checkoutBranch", "repo": root }]),
        )
        .unwrap();
    assert_eq!(unsupported["command"], json!("checkoutBranch"));
    assert!(unsupported["error"].as_str().is_some_and(|e| !e.is_empty()));

    // The workspace push (a notification) and a further read: the lifecycle holds.
    state.notify_workspace(&[]);
    std::thread::sleep(std::time::Duration::from_millis(200));
    let reopened = state
        .run(
            &exts,
            ID,
            "loadRepoInfo",
            json!([{ "command": "loadRepoInfo", "repo": root }]),
        )
        .unwrap();
    assert_eq!(reopened["branches"], json!(["main"]));

    state.stop(ID).unwrap();
    assert_eq!(state.status()[0].pid, 0);
}
