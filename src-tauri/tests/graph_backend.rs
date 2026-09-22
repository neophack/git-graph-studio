//! The `ggx-rpc/1` process backend's integration test: a real `git-graph-rs`-shaped `ggx/2`
//! package (backend command pointing at the just-built engine backend,
//! `plugins/git-graph-rs/src/main.rs`, `protocol: "ggx-rpc/1"`) is installed the way the app
//! installs one, then spoken to over a real child process and a real pipe — `hello`, the
//! view's own `loadRepoInfo`/`loadCommits` messages (through `request`), a synthetic
//! `__scmChanges` command, `closeRepos`, and `stop`. Mirrors `ext_process_host.rs`'s shape for
//! the general `ggs-ext/1` host; this one exercises `ProcKind::GgxRpc1` end to end.

#![cfg(feature = "desktop")]

use std::io::Write;
use std::path::Path;

use git_graph_studio_lib::cmd_ext;
use git_graph_studio_lib::ext_process::ProcessHostState;
use git_graph_studio_lib::git::Git;
use serde_json::{json, Value};

const ID: &str = "neophack.git-graph-rs";

/// A minimal scratch repository — `test_support::Scratch` is `#[cfg(test)]` on the library
/// itself, so it does not link into an integration test binary; this replicates just enough of
/// it (a scratch global git config, one commit on `main`) inline.
fn scratch_repo(tmp: &Path) -> Git {
    std::fs::create_dir_all(tmp).unwrap();
    std::fs::write(tmp.join("gitconfig"), "[init]\n\tdefaultBranch = main\n").unwrap();
    let repo = tmp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let mut git = Git::new(&repo);
    git.env = vec![
        ("GIT_CONFIG_GLOBAL".into(), tmp.join("gitconfig").display().to_string()),
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
    git.run(&["commit", "-q", "-m", "Initial commit"]).unwrap();
    std::fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    git.run(&["add", "a.rs"]).unwrap();
    git.run(&["commit", "-q", "-m", "second"]).unwrap();
    git
}

/// A `ggx/2` package whose backend is the real engine backend binary, `ggx-rpc/1`, installed
/// into `exts`.
fn install_backend_package(exts: &Path, version: &str) {
    let ggx = exts.parent().unwrap().join(format!("git-graph-rs-{version}.ggx"));
    let file = std::fs::File::create(&ggx).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(
        format!(
            r#"{{"format":"ggx/2","id":"{ID}","version":"{version}","pages":{{"view":{{"page":"web/view.html"}}}},"backend":{{"kind":"process","command":{},"protocol":"ggx-rpc/1"}}}}"#,
            serde_json::to_string(env!("CARGO_BIN_EXE_git-graph-backend")).unwrap()
        )
        .as_bytes(),
    )
    .unwrap();
    zip.start_file("package.json", options).unwrap();
    zip.write_all(
        format!(r#"{{"name":"git-graph-rs","publisher":"neophack","version":"{version}"}}"#).as_bytes(),
    )
    .unwrap();
    zip.start_file("web/view.html", options).unwrap();
    zip.write_all(b"<html><body></body></html>").unwrap();
    zip.finish().unwrap();

    cmd_ext::install_from_ggx_into(exts, &ggx, false).unwrap();
}

#[test]
fn the_engine_backend_answers_hello_and_the_views_own_messages() {
    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    install_backend_package(&exts, "1.0.0");

    let repo_tmp = tempfile::tempdir().unwrap();
    let git = scratch_repo(repo_tmp.path());
    let root = git.repo.display().to_string();

    let state = ProcessHostState::default();
    let info = state.start(&exts, ID).unwrap();
    assert_eq!(info.protocol_version, "ggx-rpc/1");
    assert_eq!(state.status().len(), 1);

    // `hello`: the engine's own version string.
    let hello = state.call(&exts, ID, "hello", Value::Null).unwrap();
    assert!(!hello.as_str().unwrap_or_default().is_empty(), "{hello:?}");

    // `request`: the view's own `loadRepoInfo` message, answered by `engine_impl::engine_read`.
    let info_response = state
        .call(
            &exts,
            ID,
            "request",
            json!({
                "repo": root, "settings": null,
                "message": { "command": "loadRepoInfo", "showRemoteBranches": true, "showStashes": true, "hideRemotes": [] }
            }),
        )
        .unwrap();
    assert_eq!(info_response["command"], json!("loadRepoInfo"));
    assert_eq!(info_response["isRepo"], json!(true));
    assert_eq!(info_response["error"], Value::Null);

    // `request`: a synthetic, non-view command (`cmd_scm.rs`'s shape for `scm_changes`).
    let scm = state
        .call(&exts, ID, "request", json!({ "repo": root, "settings": null, "message": { "command": "__scmChanges" } }))
        .unwrap();
    assert!(scm.is_array(), "{scm:?}");

    // Two concurrent `loadCommits` reads answer independently (the thread-per-request design
    // `backend_rpc.rs` exists for) rather than one blocking the other.
    let commits_request = json!({
        "repo": root, "settings": null,
        "message": { "command": "loadCommits", "maxCommits": 300, "showTags": true, "showRemoteBranches": true }
    });
    let (a, b) = std::thread::scope(|scope| {
        let state = &state;
        let exts = &exts;
        let commits_request = &commits_request;
        let a = scope.spawn(move || state.call(exts, ID, "request", commits_request.clone()));
        let b = scope.spawn(move || state.call(exts, ID, "request", commits_request.clone()));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(a.unwrap()["commits"].as_array().unwrap().len(), 2);
    assert_eq!(b.unwrap()["commits"].as_array().unwrap().len(), 2);

    // `closeRepos`: drops the backend's warm handle; a further read still answers correctly.
    state.call(&exts, ID, "closeRepos", Value::Null).unwrap();
    let reopened = state
        .call(&exts, ID, "request", json!({ "repo": root, "settings": null, "message": { "command": "__scmChanges" } }))
        .unwrap();
    assert!(reopened.is_array(), "{reopened:?}");

    state.stop(ID).unwrap();
    assert_eq!(state.status()[0].pid, 0);
}
