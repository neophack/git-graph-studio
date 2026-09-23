//! The git-graph-rs engine backend: the `ggx/2` process backend `git-graph-rs.ggx` packages
//! (this plugin's own packer, `plugins/git-graph-rs/build.mjs --backend`), speaking
//! `ggx-rpc/1` (`backend_rpc.rs`) over stdin and stdout to the app's process host. This is
//! the only binary in the tree that links the engine (the `engine` Cargo feature), and it owns
//! the view's whole protocol: the engine's reads (`engine_impl`), the write operations over
//! the `git` CLI (`writes.rs` — exactly the DataSource role the extension plays inside VS
//! Code), and the Gerrit refresh pipeline (`gerrit.rs`).

use git_graph_studio_lib::backend_rpc;
use git_graph_studio_lib::git::Git;
use serde_json::{json, Value};

mod engine_impl;
mod gerrit;
mod writes;

fn main() {
    // Parity with `ggs-ext/1`'s convention (`ext_process.rs`): a plugin that keeps
    // per-instance state can tell two concurrently running windows apart. This backend keeps
    // none, but the variable is read so a future one can.
    let instance = std::env::var("GGS_INSTANCE_ID").unwrap_or_default();
    eprintln!(
        "[git-graph-backend] starting (pid {}, instance {instance})",
        std::process::id()
    );
    backend_rpc::serve_backend(handle);
    eprintln!("[git-graph-backend] stopped");
}

fn handle(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "hello" => {
            // The start handshake carries the app's open folders: a backend that comes up
            // lazily (after the folder opened) learns its workspace here, warm-up included.
            workspace_changed(
                params
                    .get("workspaceFolders")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            );
            Ok(json!(engine_impl::engine_version()))
        }
        "closeRepos" => {
            engine_impl::close_engine_repos();
            Ok(Value::Null)
        }
        // The app's process-command dispatch (a manifest command from the palette or a menu).
        "runCommand" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            run_command(command, &args)
        }
        // The app's report of its open folders (boot, folder open/switch/close): the backend
        // drops its caches and warms the new first repository.
        "workspaceChanged" => {
            workspace_changed(
                params
                    .get("folders")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            );
            Ok(Value::Null)
        }
        "request" => {
            let message = params.get("message").cloned().unwrap_or(Value::Null);
            // The envelope's repo (the host's own knowledge) wins; the host's page bridge does
            // not interpret the message, so it sends the empty string and the message's own
            // `repo` — every view-protocol message carries one — is the fallback.
            let repo = params
                .get("repo")
                .and_then(Value::as_str)
                .filter(|named| !named.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    message
                        .get("repo")
                        .and_then(Value::as_str)
                        .filter(|named| !named.is_empty())
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            let settings = params.get("settings").cloned().unwrap_or(Value::Null);
            let settings: writes::ActionSettings =
                serde_json::from_value(settings).unwrap_or_default();
            let command = message
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let git = Git::new(&repo);
            dispatch(&repo, &command, &message, &settings, &git)
        }
        other => Err(format!("unsupported method: {other}")),
    }
}

/// The `request` verb's dispatch: the write operations first (their caches dropped after,
/// exactly as the app used to do around its own write path), then the Gerrit refresh pipeline
/// and the boot warm-up's internal commands, and everything else is a read of the view's own
/// protocol, answered by [`engine_impl::engine_read`].
fn dispatch(
    repo: &str,
    command: &str,
    message: &Value,
    settings: &writes::ActionSettings,
    git: &Git,
) -> Result<Value, String> {
    // A GUI diff tool is launched detached; a terminal one is the shell's job (the page's
    // bridge types the command into the app's terminal panel instead of sending it here).
    if command == "openExternalDirDiff" {
        return Ok(json!({
            "command": "openExternalDirDiff",
            "error": writes::external_dir_diff(git, message).err()
        }));
    }

    // Every write operation: the engine's caches are dropped afterwards, since refs, HEAD or
    // the working tree may have changed. A fetch the user ran may have moved the remote's
    // change refs: the next load re-runs the Gerrit pipeline (the extension marks its cache
    // stale the same way).
    if let Some(response) = writes::handle(git, message, *settings) {
        engine_impl::close_after_write(repo);
        if command == "fetch" && response.get("error").is_some_and(Value::is_null) {
            engine_impl::mark_gerrit_stale(repo);
        }
        return Ok(response);
    }

    // The Gerrit refresh pipeline (the host's follow-up to a `gerritPending` load): a fetch of
    // the remote's change refs and a parse of their NoteDb metas — itself a write, so the
    // engine's caches are dropped after it, exactly as for every write request.
    if command == "gerritRefresh" {
        let remote = message
            .get("gerritRemote")
            .and_then(Value::as_str)
            .unwrap_or("origin")
            .to_owned();
        let response = match gerrit::refresh(
            repo,
            &remote,
            gerrit::gerrit_fetch_limit(message),
            gerrit::gerrit_status_filter(message),
        ) {
            Ok((changes, refreshed)) => json!({
                "command": "gerritRefresh", "error": null, "changes": changes, "refreshed": refreshed
            }),
            Err(error) => json!({ "command": "gerritRefresh", "error": error }),
        };
        return Ok(response);
    }

    match command {
        // The page bridge's own internal reads (the `__` prefix keeps them out of the view's
        // protocol namespace): the repository dropdown's submodule set, revision bytes for the
        // compare pages' hex machinery, windowed working-tree reads for the same, and the
        // engine version the view page's Settings backend section reports.
        "__submoduleRoots" => Ok(json!({ "roots": engine_impl::submodule_roots(repo) })),
        "__revisionFileBytes" => {
            let revision = message
                .get("revision")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let path = message
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let bytes = engine_impl::revision_file_bytes(repo, revision, path)?;
            use base64::Engine;
            Ok(
                json!({ "bytes": bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b)) }),
            )
        }
        "__fileChunk" => {
            let path = message
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let offset = message.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let len = message.get("len").and_then(Value::as_u64).unwrap_or(0);
            file_chunk(repo, path, offset, len)
        }
        "__engineVersion" => Ok(json!(engine_impl::engine_version())),
        // Everything else is the view's own protocol.
        _ => engine_impl::engine_read(repo, command, message, git),
    }
}

/// One windowed read of a working-tree file under the repository, for the compare pages' hex
/// machinery: `{size, base64}` of the requested window (`size` is the whole file's). The path
/// is confined under the repository root — the page cannot point this at anything else.
fn file_chunk(repo: &str, path: &str, offset: u64, len: u64) -> Result<Value, String> {
    use base64::Engine;
    use std::io::{Read, Seek, SeekFrom};
    let root = std::path::Path::new(repo)
        .canonicalize()
        .map_err(|e| format!("the repository is not readable: {e}"))?;
    let full = root.join(path);
    let canonical = full
        .canonicalize()
        .map_err(|_| format!("\"{path}\" does not exist in the working tree"))?;
    if !canonical.starts_with(&root) {
        return Err(format!("\"{path}\" is outside the repository"));
    }
    let meta = std::fs::metadata(&canonical).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("\"{path}\" is not a file"));
    }
    let mut file = std::fs::File::open(&canonical).map_err(|e| format!("{path}: {e}"))?;
    let take = len.min(32 * 1024 * 1024) as usize;
    let mut bytes = vec![0u8; take];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read(&mut bytes))
        .map_err(|e| format!("{path}: {e}"))?;
    bytes.truncate(take);
    Ok(json!({
        "size": meta.len(),
        "base64": base64::engine::general_purpose::STANDARD.encode(&bytes)
    }))
}

/* ---------- The manifest's declared commands (the app's process-command dispatch) ---------- */

/// One `runCommand` of the manifest's `contributes.commands` — the app's palette and menus
/// dispatch these here (a process-backed package's whole command surface). A result naming a
/// page opens it (\`openPage\`); a result naming a notification shows it (\`notify\`) — the ggx/2
/// result convention.
fn run_command(command: &str, args: &[Value]) -> Result<Value, String> {
    let base = command.strip_suffix(".zhCn").unwrap_or(command);
    let repo = workspace().unwrap_or_default();
    match base {
        // The view itself: open (or reveal) the view page, on the open repository — or the one
        // the command's argument names (a submodule section's own graph button passes it).
        "git-graph-rs.view" => {
            let repo = args
                .first()
                .and_then(Value::as_str)
                .filter(|named| !named.is_empty())
                .unwrap_or(&repo);
            Ok(json!({ "openPage": "view", "params": { "repo": repo } }))
        }
        // "Show File History in Git Graph": the view filtered to the command's file argument
        // (the Source Control view's resource context menu passes the path).
        "git-graph-rs.filterByFile" => {
            let filter = args.first().and_then(Value::as_str).unwrap_or_default();
            let mut params = json!({ "repo": repo });
            if !filter.is_empty() {
                params["filterPath"] = json!(filter);
            }
            Ok(json!({ "openPage": "view", "params": params }))
        }
        "git-graph-rs.searchCommits" => {
            Ok(json!({ "openPage": "view", "params": { "repo": repo } }))
        }
        "git-graph-rs.version" => {
            Ok(json!({ "notify": { "kind": "info", "message": engine_impl::engine_version() } }))
        }
        "git-graph-rs.fetch" => {
            let git = Git::new(&repo);
            git_graph_studio_lib::git::fetch(&git, None, false, false)?;
            Ok(json!({ "notify": { "kind": "info", "message": "Fetched every remote." } }))
        }
        "git-graph-rs.amendLastCommit" => {
            let git = Git::new(&repo);
            git.run(&["commit", "--amend", "--no-edit"])?;
            Ok(
                json!({ "notify": { "kind": "info", "message": "The last commit was amended with the staged changes." } }),
            )
        }
        "git-graph-rs.resetCurrentBranchToRemote" => {
            let git = Git::new(&repo);
            let upstream = git_graph_studio_lib::scm_ops::reset_to_remote(&git)?;
            Ok(
                json!({ "notify": { "kind": "info", "message": format!("The current branch was reset to {upstream}; its changes are staged.") } }),
            )
        }
        "git-graph-rs.gerritPushRef" => {
            let git = Git::new(&repo);
            let remote = message_remote(args);
            let url = git_graph_studio_lib::scm_ops::gerrit_push_ref(&git, &remote)?;
            Ok(json!({
                "notify": { "kind": "info",
                    "message": url.clone().unwrap_or_else(|| format!("Pushed the current branch to {remote} for review.")) },
                "url": url
            }))
        }
        "git-graph-rs.gerritFetchCommitMsgHook" => {
            let git = Git::new(&repo);
            let remote = message_remote(args);
            let installed =
                git_graph_studio_lib::scm_ops::gerrit_install_hook(&git, &remote, "commit-msg")?;
            Ok(json!({ "notify": { "kind": "info",
                "message": if installed { "The Gerrit commit-msg hook was installed." } else { "The Gerrit commit-msg hook is already installed." } } }))
        }
        // VS Code workspace surfaces GGS does not host: quiet no-ops, never errors.
        "git-graph-rs.addGitRepository"
        | "git-graph-rs.removeGitRepository"
        | "git-graph-rs.clearAvatarCache"
        | "git-graph-rs.endAllWorkspaceCodeReviews"
        | "git-graph-rs.resumeWorkspaceCodeReview"
        | "git-graph-rs.endSpecificWorkspaceCodeReview" => Ok(Value::Null),
        other => Err(format!("unknown command: {other}")),
    }
}

/// The remote a Gerrit command names, defaulting to origin (the extension's own default).
fn message_remote(args: &[Value]) -> String {
    args.iter()
        .find_map(Value::as_str)
        .filter(|remote| !remote.is_empty())
        .unwrap_or("origin")
        .to_owned()
}

/* ---------- The workspace the app reports ---------- */

/// The folders the app has open, as the last `workspaceChanged` reported — the backend's own
/// view of what the view page should show.
static WORKSPACE: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn workspace() -> Option<String> {
    WORKSPACE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .first()
        .cloned()
}

/// Record the app's open folders and warm the first repository: a fresh folder is exactly the
/// cue the old app-side boot warm-up acted on, and dropping the caches of the previous
/// repository set is the backend's own hygiene (the app no longer asks).
fn workspace_changed(folders: &[Value]) {
    let roots: Vec<String> = folders
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    engine_impl::close_engine_repos();
    if let Some(root) = roots.first() {
        let root = root.clone();
        std::thread::spawn(move || {
            let _ = engine_impl::warm_first_page(&root);
        });
    }
    *WORKSPACE.lock().unwrap_or_else(|p| p.into_inner()) = roots;
}
