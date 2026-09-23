//! The process extension host's integration test: a real `ggx/2` package (backend command
//! pointing at the just-built reference plugin binary, `plugins/ggs-ext-demo/src/main.rs`) is
//! installed the way the app installs one, then activated, spoken to and stopped — the
//! whole "install a plugin and it works" chain, over a real child process and a real pipe.

#![cfg(feature = "desktop")]

use std::io::Write;
use std::path::Path;

use git_graph_studio_lib::cmd_ext;
use git_graph_studio_lib::ext_process::ProcessHostState;

/// A `ggx/2` package whose backend is the reference demo binary, installed into `exts`.
fn install_demo_package(exts: &Path, version: &str) {
    let ggx = exts
        .parent()
        .unwrap()
        .join(format!("ggs-ext-demo-{version}.ggx"));
    let file = std::fs::File::create(&ggx).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(
        format!(
            r#"{{"format":"ggx/2","id":"ggs.ext-demo","version":"{version}","pages":{{"main":{{"page":"web/view.html","title":"GGX Demo"}}}},"backend":{{"kind":"process","command":{}}}}}"#,
            serde_json::to_string(env!("CARGO_BIN_EXE_ggs-ext-demo")).unwrap()
        )
        .as_bytes(),
    )
    .unwrap();
    zip.start_file("package.json", options).unwrap();
    zip.write_all(
        format!(
            r#"{{"name":"ext-demo","publisher":"ggs","version":"{version}","contributes":{{"commands":[
            {{"command":"ggs.ext-demo.hello","title":"GGX Demo: Hello (process backend)"}},
            {{"command":"ggs.ext-demo.openPage","title":"GGX Demo: Open the page"}}]}}}}"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.start_file("web/view.html", options).unwrap();
    zip.write_all(b"<html><body><h1>GGX Demo</h1></body></html>")
        .unwrap();
    zip.finish().unwrap();

    cmd_ext::install_from_ggx_into(exts, &ggx, false).unwrap();
}

#[test]
fn a_ggx2_backend_activates_answers_and_stops() {
    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    install_demo_package(&exts, "1.0.0");

    let state = ProcessHostState::default();
    // Starting is what the first command execution does (lazy activation).
    let info = state.start(&exts, "ggs.ext-demo").unwrap();
    assert_eq!(info.extension_id, "ggs.ext-demo");
    assert_eq!(info.protocol_version, "ggs-ext/1");
    assert!(
        info.commands.contains(&"ggs.ext-demo.hello".to_owned()),
        "{:?}",
        info.commands
    );
    assert_eq!(state.status().len(), 1);

    // A command round-trips to the plugin and back. hello answers through the page-open
    // convention: the greeting and the package's own file inventory travel as params —
    // a palette click on it visibly opens the Files page.
    let answer = state
        .run(
            &exts,
            "ggs.ext-demo",
            "ggs.ext-demo.hello",
            serde_json::json!(["integration test"]),
        )
        .unwrap();
    assert_eq!(
        answer.get("openPage").and_then(|value| value.as_str()),
        Some("files")
    );
    let greeting = answer
        .pointer("/params/greeting")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    assert!(greeting.contains("Hello, integration test!"), "{greeting}");
    assert!(greeting.contains("process backend"), "{greeting}");
    let files = answer
        .pointer("/params/files")
        .and_then(|value| value.as_array())
        .expect("the file inventory is an array");
    assert!(!files.is_empty(), "the install directory was walked");
    assert!(
        files.iter().any(
            |file| file.pointer("/path").and_then(|value| value.as_str()) == Some("package.json")
        ),
        "{files:?}"
    );

    // The page-open convention: a command result that names a page.
    let opened = state
        .run(
            &exts,
            "ggs.ext-demo",
            "ggs.ext-demo.openPage",
            serde_json::json!([]),
        )
        .unwrap();
    assert_eq!(
        opened.get("openPage").and_then(|value| value.as_str()),
        Some("main")
    );

    // The context-menu command: the workbench hands it the clicked path and the selection
    // (VS Code's pair, as paths); each selected path comes back with its metadata, and the
    // result names the Files page with a tab title.
    let picked = tmp.path().join("notes.txt");
    std::fs::write(&picked, b"twelve bytes").unwrap();
    let folder = tmp.path().join("folder");
    std::fs::create_dir_all(folder.join("inside")).unwrap();
    let details = state
        .run(
            &exts,
            "ggs.ext-demo",
            "ggs.ext-demo.fileDetails",
            serde_json::json!([picked, [picked, folder]]),
        )
        .unwrap();
    assert_eq!(
        details.get("openPage").and_then(|value| value.as_str()),
        Some("files")
    );
    assert_eq!(
        details.get("title").and_then(|value| value.as_str()),
        Some("File Details — 2 items")
    );
    let rows = details
        .pointer("/params/details")
        .and_then(|value| value.as_array())
        .expect("one details row per selected path");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["name"], "notes.txt");
    assert_eq!(rows[0]["kind"], "file");
    assert_eq!(rows[0]["extension"], "txt");
    assert_eq!(rows[0]["bytes"], 12);
    assert!(rows[0]["modifiedMs"].is_u64(), "{:?}", rows[0]);
    assert_eq!(rows[1]["kind"], "folder");
    assert_eq!(rows[1]["entries"], 1);
    // The palette passes no path: a clear error, not an empty page.
    let bare = state
        .run(
            &exts,
            "ggs.ext-demo",
            "ggs.ext-demo.fileDetails",
            serde_json::json!([]),
        )
        .unwrap_err();
    assert!(bare.contains("context menu"), "{bare}");

    // An unknown command is the plugin's error, surfaced as-is.
    let error = state
        .run(
            &exts,
            "ggs.ext-demo",
            "no.such.command",
            serde_json::json!([]),
        )
        .unwrap_err();
    assert!(error.contains("unknown command"), "{error}");

    state.stop("ggs.ext-demo").unwrap();
    // A deliberate stop is remembered, not an error: the entry stays with pid 0 and a clean
    // history (one start, no last error).
    let dead = &state.status();
    assert_eq!(dead.len(), 1);
    assert_eq!(dead[0].extension_id, "ggs.ext-demo");
    assert_eq!(dead[0].pid, 0);
    assert_eq!(dead[0].start_count, 1);
    assert_eq!(dead[0].last_error, None);
    // Stopping again is an error — there is nothing running.
    assert!(state.stop("ggs.ext-demo").is_err());
}

#[test]
fn run_starts_the_backend_lazily() {
    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    install_demo_package(&exts, "1.0.0");

    let state = ProcessHostState::default();
    // No start() first: the first run() brings the backend up. The default name (no args)
    // still names the Files page, and the inventory came along.
    let answer = state
        .run(
            &exts,
            "ggs.ext-demo",
            "ggs.ext-demo.hello",
            serde_json::json!([]),
        )
        .unwrap();
    assert_eq!(
        answer.get("openPage").and_then(|value| value.as_str()),
        Some("files")
    );
    assert!(answer
        .pointer("/params/greeting")
        .and_then(|value| value.as_str())
        .is_some_and(|greeting| greeting.contains("Hello, Git Graph Studio!")));
    assert!(answer
        .pointer("/params/files")
        .and_then(|value| value.as_array())
        .is_some_and(|files| !files.is_empty()));
    assert_eq!(state.status().len(), 1);
    state.stop("ggs.ext-demo").unwrap();
}

#[test]
fn an_extension_without_a_backend_is_a_clear_error() {
    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    // A ggx/1 package: a frontend page but no backend.
    let ggx = tmp.path().join("frontend-only.ggx");
    let file = std::fs::File::create(&ggx).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(
        br#"{"format":"ggx/1","id":"acme.frontend","version":"1.0.0","frontend":{"page":"web/view.html"}}"#,
    )
    .unwrap();
    zip.start_file("package.json", options).unwrap();
    zip.write_all(br#"{"name":"frontend","publisher":"acme","version":"1.0.0"}"#)
        .unwrap();
    zip.start_file("web/view.html", options).unwrap();
    zip.write_all(b"<html></html>").unwrap();
    zip.finish().unwrap();
    cmd_ext::install_from_ggx_into(&exts, &ggx, false).unwrap();

    let state = ProcessHostState::default();
    let error = state.start(&exts, "acme.frontend").unwrap_err();
    assert!(error.contains("declares no backend"), "{error}");
    let missing = state.start(&exts, "not.installed").unwrap_err();
    assert!(missing.contains("not installed"), "{missing}");
}

/// A `ggx/2` package whose backend command points at a file that does not exist — startable,
/// failing, and remembered in the status as the reason it is not running.
fn install_broken_package(exts: &Path) {
    let ggx = exts.parent().unwrap().join("broken-backend.ggx");
    let file = std::fs::File::create(&ggx).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(
        br#"{"format":"ggx/2","id":"acme.broken","version":"1.0.0","backend":{"kind":"process","command":"bin/missing.exe"}}"#,
    )
    .unwrap();
    zip.start_file("package.json", options).unwrap();
    zip.write_all(br#"{"name":"broken","publisher":"acme","version":"1.0.0"}"#)
        .unwrap();
    zip.finish().unwrap();
    cmd_ext::install_from_ggx_into(exts, &ggx, false).unwrap();
}

#[test]
fn the_boot_pass_starts_every_declaring_install_and_only_those() {
    // "Detect and run": the installed packages that declare a process backend come up; a
    // frontend-only install is skipped, and one package's failure to start holds its error
    // in the status without holding the others back.
    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    install_demo_package(&exts, "1.0.0");
    install_broken_package(&exts);

    let state = ProcessHostState::default();
    assert_eq!(cmd_ext::process_backed_ids(&exts).len(), 2);
    let results = state.start_all_installed(&exts);
    assert_eq!(results.len(), 2);
    assert!(
        results.iter().any(|r| r.is_ok()),
        "the demo package started"
    );

    let status = state.status();
    let demo = status
        .iter()
        .find(|i| i.extension_id == "ggs.ext-demo")
        .unwrap();
    assert!(demo.pid > 0, "the demo backend is running");
    assert_eq!(demo.start_count, 1);
    let broken = status
        .iter()
        .find(|i| i.extension_id == "acme.broken")
        .unwrap();
    assert_eq!(broken.pid, 0);
    assert!(
        broken
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("not found"),
        "{:?}",
        broken.last_error
    );
    assert!(status.iter().all(|i| i.extension_id != "acme.frontend"));

    // App exit: every backend this instance spawned is stopped, and the history stays.
    state.stop_all();
    let stopped = state.status();
    assert!(stopped.iter().all(|i| i.pid == 0), "{stopped:?}");
    assert_eq!(
        stopped
            .iter()
            .find(|i| i.extension_id == "ggs.ext-demo")
            .unwrap()
            .start_count,
        1
    );
}

#[test]
fn uninstall_stops_the_backend_before_removing_its_directory() {
    // The uninstall order every caller runs: a running backend's exe lives inside the
    // directory being removed, and on Windows a running binary cannot be deleted — the stop
    // must come first or the uninstall fails while the plugin runs.
    let tmp = tempfile::tempdir().unwrap();
    let exts = tmp.path().join("extensions");
    std::fs::create_dir_all(&exts).unwrap();
    install_demo_package(&exts, "1.0.0");

    let state = ProcessHostState::default();
    state.start(&exts, "ggs.ext-demo").unwrap();
    cmd_ext::uninstall_stopping(&exts, "ggs.ext-demo", &state).unwrap();

    let status = state.status();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].pid, 0, "the backend is down");
    assert!(
        !cmd_ext::installed_dir(&exts, "ggs.ext-demo").is_ok(),
        "the install directory is gone"
    );
    // With nothing running and nothing installed, a reinstall lands cleanly.
    install_demo_package(&exts, "1.1.0");
    let info = state.start(&exts, "ggs.ext-demo").unwrap();
    assert!(info.pid > 0);
    assert_eq!(state.status()[0].start_count, 2, "the restart is counted");
    state.stop("ggs.ext-demo").unwrap();
}
