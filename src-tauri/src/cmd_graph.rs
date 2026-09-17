//! The Git Graph view's message protocol — and the app's seam onto the extension's Rust
//! code.
//!
//! The webview UI (`media/out.min.js`) speaks the same request/response protocol it uses inside
//! VS Code; this module plays the role the extension host played there. Reads go to
//! `git-graph-core`, linked into this process; writes (branches, tags, stashes, merges,
//! remotes, …) run the `git` CLI, mirroring the extension's data source (the write-path
//! section below). The requests the shell serves itself (files, diffs, terminal, dialogs, view
//! state) are intercepted in `graphHost.ts` before they get here, and the host-only arms
//! (clipboard, URLs) in the app's `graph_request`.

use serde_json::{json, Value};

use git_graph_core::types::{GerritChangeState, LogOptions};
use git_graph_core::{config, details, diff, graph, log, stats, RepoManager};

use crate::git::Git;

/* ---------- The engine seam (the only git-graph-core calls) ---------- */

/// Resolve a path onto its repository's root directory — `None` when the path is not inside a
/// Git repository (`open_folder` keeps the folder itself then).
pub fn resolve_repo_root(path: &str) -> Option<String> {
    git_graph_core::repository::repo_root(path).ok()
}

/// The version of the engine this process links — the version the built-in git-graph-rs
/// entry in the Extensions view shows.
pub fn engine_version() -> &'static str {
    git_graph_core::VERSION
}

/// The roots of the repository's initialised submodules (absolute paths), for the view's
/// repository dropdown: the open repository plus these are the repository set it offers.
pub fn submodule_roots(repo_path: &str) -> Vec<String> {
    RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)
        .and_then(|repo| config::submodules(&repo).map_err(|e| e.message))
        .unwrap_or_default()
}

/// Drop every cached engine repository: the folder was closed or switched.
pub fn close_engine_repos() {
    drop_warm_responses();
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
    RepoManager::global().close_all();
}

/// The working tree's changes, staged and unstaged halves kept apart, as the Source Control
/// view's two sections list them.
pub fn scm_changes(repo_path: &str) -> Result<Value, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    let changes = git_graph_core::status::scm_changes(&repo).map_err(|e| e.message)?;
    serde_json::to_value(changes).map_err(|e| format!("Could not encode the status: {e}"))
}

/// A file at one revision: `:index` reads the staged copy, anything else is a commit-ish.
/// Binary files come back with `contents: None`, as the webview expects.
pub fn revision_file(
    repo_path: &str,
    revision: &str,
    file_path: &str,
) -> Result<RevisionFile, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    let file = if revision == ":index" {
        git_graph_core::blob::index_file(&repo, file_path).map_err(|e| e.message)?
    } else {
        git_graph_core::blob::commit_file(&repo, revision, file_path).map_err(|e| e.message)?
    };
    Ok(RevisionFile {
        binary: file.binary,
        contents: file.contents,
    })
}

/// A file as the diff editors read it: `binary` says whether `contents` (UTF-8 text) is there.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionFile {
    pub binary: bool,
    pub contents: Option<String>,
}

/// Handle one `RequestMessage` from the Git Graph view, returning its `ResponseMessage`
/// (or `null` for the requests the protocol defines no response for).
///
/// The host-only arms (clipboard, opening URLs, the requests without a repository) are
/// answered here; everything that touches a repository goes to [`handle_repo_request`],
/// served by the engine linked into this process.
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn graph_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    message: Value,
    settings: Option<ActionSettings>,
) -> Result<Value, String> {
    let command = message
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let repo = message
        .get("repo")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| state.first_repo());

    // The commands that carry no repository and no engine work.
    match command.as_str() {
        "setRepoState" | "endCodeReview" | "updateCodeReview" | "fetchAvatar"
        | "fetchPullRequest" => return Ok(Value::Null),
        "setInterfaceLanguage" => return Ok(json!({ "command": command, "error": null })),
        "copyToClipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let data = message
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let error = app
                .clipboard()
                .write_text(data)
                .err()
                .map(|e| e.to_string());
            return Ok(
                json!({ "command": "copyToClipboard", "type": message.get("type").cloned().unwrap_or(Value::Null), "error": error }),
            );
        }
        "openExternalUrl" => {
            use tauri_plugin_opener::OpenerExt;
            let url = message
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let error = app
                .opener()
                .open_url(url, None::<&str>)
                .err()
                .map(|e| e.to_string());
            return Ok(json!({ "command": "openExternalUrl", "error": error }));
        }
        _ => {}
    }

    let Some(repo_path) = repo else {
        return Ok(error_response(&command, "No repository is open", &message));
    };
    if command == "copyFilePath" {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let file = message
            .get("filePath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let absolute = message
            .get("absolute")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = if absolute {
            std::path::Path::new(&repo_path)
                .join(file)
                .display()
                .to_string()
        } else {
            file.to_owned()
        };
        let error = app
            .clipboard()
            .write_text(text)
            .err()
            .map(|e| e.to_string());
        return Ok(json!({ "command": "copyFilePath", "error": error }));
    }
    let request_echo = message.clone();
    let settings = settings.unwrap_or_default();
    // The engine is linked into this process: the request is served by the same seam the
    // graph's reads have always run through, with no process and no wire protocol between it
    // and the view.
    let result = tauri::async_runtime::spawn_blocking(move || {
        handle_repo_request(&repo_path, &message, settings)
    })
    .await
    .map_err(|e| format!("The request thread failed: {e}"))?;
    match result {
        Ok(response) => Ok(response),
        Err(error) => Ok(error_response(&command, &error, &request_echo)),
    }
}

/// Every request that concerns one repository: the write operations (`handle`, over the git
/// CLI) and the engine's read arms.
pub fn handle_repo_request(
    repo_path: &str,
    message: &Value,
    settings: ActionSettings,
) -> Result<Value, String> {
    let command = message
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let message = message.clone();
    let repo_path = repo_path.to_owned();
    let git = Git::new(&repo_path);

    if command == "openExternalDirDiff" {
        // A GUI diff tool is launched detached; a terminal one is run by the shell in its
        // terminal panel (graphHost.ts intercepts that case).
        return Ok(
            json!({ "command": "openExternalDirDiff", "error": external_dir_diff(&git, &message).err() }),
        );
    }

    // The Gerrit refresh pipeline (the host's follow-up to a `gerritPending` load): a fetch of
    // the remote's change refs and a parse of their NoteDb metas — a write, so the engine's
    // caches are dropped after it, exactly as for every write request.
    if command == "gerritRefresh" {
        let remote = message
            .get("gerritRemote")
            .and_then(Value::as_str)
            .unwrap_or("origin");
        let response = match gerrit_refresh(
            &repo_path,
            remote,
            gerrit_fetch_limit(&message),
            gerrit_status_filter(&message),
        ) {
            Ok((changes, refreshed)) => json!({
                "command": "gerritRefresh", "error": null, "changes": changes, "refreshed": refreshed
            }),
            Err(error) => json!({ "command": "gerritRefresh", "error": error }),
        };
        drop_warm_responses();
        RepoManager::global().close(&repo_path);
        return Ok(response);
    }

    // Every write operation: the engine's caches are dropped afterwards, since refs, HEAD or the
    // working tree may have changed.
    if let Some(response) = handle(&git, &message, settings) {
        drop_warm_responses();
        RepoManager::global().close(&repo_path);
        // A fetch the user ran may have moved the remote's change refs: the next load re-runs
        // the Gerrit pipeline (the extension marks its cache stale the same way).
        if command == "fetch" && response.get("error").is_some_and(Value::is_null) {
            mark_gerrit_stale(&repo_path);
        }
        return Ok(response);
    }

    let open = || RepoManager::global().get(&repo_path).map_err(|e| e.message);

    match command.as_str() {
        "loadRepoInfo" | "loadCommits" => {
            // The launch warm-up computed these two with the view's default options before
            // the window existed; a first request with the same options takes that answer.
            let mut response = match take_warm_response(&repo_path, &command, &message) {
                Some(warm) => warm,
                None => {
                    let repo = open()?;
                    if command == "loadRepoInfo" {
                        repo_info_response(&repo, &git, &message)?
                    } else {
                        load_commits_response(&repo_path, &repo, &message)?
                    }
                }
            };
            response["refreshId"] = message.get("refreshId").cloned().unwrap_or(json!(0));
            Ok(response)
        }
        "loadConfig" => {
            let repo = open()?;
            let snapshot = config::read_config(&repo).map_err(|e| e.message)?;
            Ok(
                json!({ "command": "loadConfig", "repo": repo_path, "config": view_config(&Git::new(&repo_path), &snapshot), "error": null }),
            )
        }
        "commitDetails" => {
            let repo = open()?;
            let hash = message
                .get("commitHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let stash = message.get("stash").filter(|s| !s.is_null());
            let details_value = if hash == git_graph_core::types::UNCOMMITTED {
                details::uncommitted_details(&repo)
            } else if let Some(stash) = stash {
                let commit_stash = serde_json::from_value(stash.clone())
                    .map_err(|e| format!("Could not decode the stash: {e}"))?;
                details::stash_details(&repo, hash, &commit_stash)
            } else {
                details::commit_details(&repo, hash)
            };
            let refresh = message
                .get("refresh")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(match details_value {
                Ok(commit_details) => json!({
                    "command": "commitDetails", "commitDetails": commit_details,
                    "avatar": null, "codeReview": null, "refresh": refresh, "error": null
                }),
                Err(e) => json!({
                    "command": "commitDetails", "commitDetails": null,
                    "avatar": null, "codeReview": null, "refresh": refresh, "error": e.message
                }),
            })
        }
        "commitFileCounts" => {
            let repo = open()?;
            let from = message
                .get("from")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let to = message
                .get("to")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let paths = string_list(message.get("paths"));
            let counts =
                diff::line_counts(&repo, from.as_deref(), to, &paths).map_err(|e| e.message)?;
            Ok(json!({
                "command": "commitFileCounts",
                "commitHash": message.get("commitHash").cloned().unwrap_or(Value::Null),
                "compareWithHash": message.get("compareWithHash").cloned().unwrap_or(Value::Null),
                "counts": counts, "error": null
            }))
        }
        "commitBodies" => {
            let repo = open()?;
            let hashes = string_list(message.get("commitHashes"));
            let bodies = details::commit_bodies(&repo, &hashes).map_err(|e| e.message)?;
            Ok(json!({ "command": "commitBodies", "bodies": bodies }))
        }
        "compareCommits" => {
            let repo = open()?;
            let from = message
                .get("fromHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let to = message
                .get("toHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let file_changes = diff::diff_revisions(&repo, from, to).map_err(|e| e.message)?;
            Ok(json!({
                "command": "compareCommits",
                "commitHash": message.get("commitHash").cloned().unwrap_or(Value::Null),
                "compareWithHash": message.get("compareWithHash").cloned().unwrap_or(Value::Null),
                "fileChanges": file_changes, "codeReview": null,
                "refresh": message.get("refresh").and_then(Value::as_bool).unwrap_or(false),
                "error": null
            }))
        }
        // The Commit Comparison View's own reads: the file list of the range, the summary cards
        // of its two ends, and the unified diff of one selected file.
        "getCommitComparison" => {
            let repo = open()?;
            let from = message
                .get("fromHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let to = message
                .get("toHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let file_changes = diff::diff_revisions(&repo, from, to).map_err(|e| e.message)?;
            Ok(json!({
                "command": "getCommitComparison",
                "fileChanges": file_changes, "error": null
            }))
        }
        "getCommitSummaries" => {
            let repo = open()?;
            let hashes = string_list(message.get("commitHashes"))
                .into_iter()
                .filter(|hash| !hash.is_empty() && hash != git_graph_core::types::UNCOMMITTED)
                .collect::<Vec<_>>();
            let summaries = details::commit_summaries(&repo, &hashes).map_err(|e| e.message)?;
            Ok(json!({
                "command": "getCommitSummaries",
                "summaries": summaries, "error": null
            }))
        }
        "getCommitFileDiff" => {
            // The same `git diff` the extension's data source runs for the comparison view (the
            // working tree stands in for the to-side when it is the uncommitted sentinel).
            let from = message
                .get("fromHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let to = message
                .get("toHash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let old_path = message
                .get("oldFilePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let new_path = message
                .get("newFilePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let to = if to == git_graph_core::types::UNCOMMITTED {
                ""
            } else {
                to
            };
            let mut args: Vec<&str> = vec!["diff", "--no-color", "--find-renames", from];
            if !to.is_empty() {
                args.push(to);
            }
            args.push("--");
            if old_path != new_path {
                args.push(old_path);
            }
            args.push(new_path);
            let diff = git.output(&args);
            Ok(match diff {
                Ok(diff) => json!({ "command": "getCommitFileDiff", "diff": diff, "error": null }),
                Err(error) => {
                    json!({ "command": "getCommitFileDiff", "diff": null, "error": error })
                }
            })
        }
        "countCommitsBefore" => {
            let repo = open()?;
            let hash = message
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let branches = message.get("branches").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            });
            let count = log::count_commits_before(
                &repo,
                branches.as_deref(),
                hash,
                message
                    .get("showRemoteBranches")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                message
                    .get("includeCommitsMentionedByReflogs")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
            .map_err(|e| e.message)?;
            Ok(json!({ "command": "countCommitsBefore", "hash": hash, "count": count }))
        }
        "tagDetails" => {
            let repo = open()?;
            let tag_name = message
                .get("tagName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let commit_hash = message.get("commitHash").cloned().unwrap_or(Value::Null);
            Ok(match details::tag_details(&repo, tag_name) {
                Ok(details) => {
                    json!({ "command": "tagDetails", "tagName": tag_name, "commitHash": commit_hash, "details": details, "error": null })
                }
                Err(e) => {
                    json!({ "command": "tagDetails", "tagName": tag_name, "commitHash": commit_hash, "details": null, "error": e.message })
                }
            })
        }
        "repoStatistics" => {
            let repo = open()?;
            let authors = stats::author_stats(&repo).map_err(|e| e.message)?;
            let activity = stats::activity_heatmap(&repo).map_err(|e| e.message)?;
            Ok(json!({ "command": "repoStatistics", "authors": authors, "activity": activity }))
        }
        _ => Ok(error_response(
            &command,
            &format!("Git Graph Studio does not support the \"{command}\" request."),
            &message,
        )),
    }
}

/// `git difftool --dir-diff`, launched detached for a GUI tool. A terminal tool is the shell's
/// job (it types the command into the terminal panel), so this only handles `isGui`.
fn external_dir_diff(git: &Git, message: &Value) -> Result<(), String> {
    let from = message
        .get("fromHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let to = message
        .get("toHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let is_gui = message
        .get("isGui")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for (name, hash) in [("fromHash", from), ("toHash", to)] {
        if hash != UNCOMMITTED && !is_valid_commit_hash(hash) {
            return Err(format!("Invalid commit hash was provided for \"{name}\""));
        }
    }
    let mut args: Vec<String> = vec!["difftool".into(), "--dir-diff".into()];
    if is_gui {
        args.push("-g".into());
    }
    args.extend(dir_diff_range(from, to));
    let mut command = git.command();
    command
        .args(&args)
        .env_remove("GIT_EDITOR")
        .env_remove("GIT_SEQUENCE_EDITOR");
    if !is_gui {
        return Err("A terminal diff tool needs the built-in terminal.".to_owned());
    }
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start git difftool: {e}"))
}

/// The revision arguments the extension builds for `difftool --dir-diff`.
pub fn dir_diff_range(from: &str, to: &str) -> Vec<String> {
    if from == to {
        if to == UNCOMMITTED {
            vec!["HEAD".into()]
        } else {
            vec![format!("{to}^..{to}")]
        }
    } else if to == UNCOMMITTED {
        vec![from.to_owned()]
    } else {
        vec![format!("{from}..{to}")]
    }
}

/// The shared "refused" response: both error shapes (`error` and `errors`) are included since
/// the view reads one or the other per command, and a superset keeps this branch-free.
fn error_response(command: &str, message_text: &str, request: &Value) -> Value {
    let mut response = json!({
        "command": command,
        "error": message_text,
        "errors": [message_text]
    });
    // The view keys some responses by the request's echoed fields even on failure.
    for key in [
        "repo",
        "branchName",
        "tagName",
        "commitHash",
        "actionOn",
        "interactive",
    ] {
        if let Some(value) = request.get(key) {
            response
                .as_object_mut()
                .unwrap()
                .insert(key.to_owned(), value.clone());
        }
    }
    response
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The repository configuration in the shape the view's Settings Widget renders
/// (`GG.GitRepoConfig`): the snapshot the engine reads, plus the branch, user and author
/// configuration the extension's data source composes from the CLI. An incomplete shape here
/// makes the widget's render throw, which empties the panel as soon as the response arrives.
fn view_config(git: &Git, snapshot: &git_graph_core::types::ConfigSnapshot) -> Value {
    let config_list = |scope: &str| -> std::collections::BTreeMap<String, String> {
        git.output(&["config", scope, "--list"])
            .map(|out| {
                out.lines()
                    .filter_map(|line| line.split_once('='))
                    .map(|(k, v)| (k.to_lowercase(), v.to_owned()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let local = config_list("--local");
    let global = config_list("--global");

    // branch.<name>.remote / .pushRemote, as the settings widget's branch section lists them.
    let mut branches = serde_json::Map::new();
    for (key, value) in &local {
        let name = if let Some(name) = key
            .strip_prefix("branch.")
            .and_then(|k| k.strip_suffix(".remote"))
        {
            name
        } else if let Some(name) = key
            .strip_prefix("branch.")
            .and_then(|k| k.strip_suffix(".pushremote"))
        {
            name
        } else {
            continue;
        };
        let entry = branches
            .entry(name.to_owned())
            .or_insert_with(|| json!({ "pushRemote": null, "remote": null }));
        let field = if key.ends_with(".pushremote") {
            "pushRemote"
        } else {
            "remote"
        };
        entry
            .as_object_mut()
            .unwrap()
            .insert(field.to_owned(), json!(value));
    }

    // The author list: per (name, email) spellings of HEAD's history, de-duplicated by name
    // keeping the most-prolific spelling, then sorted by name — the extension's own reduce.
    let mut counts: Vec<(String, String, usize)> = Vec::new();
    if let Ok(out) = git.output(&["log", "--format=%an%x1f%ae", "HEAD"]) {
        for line in out.lines() {
            let Some((name, email)) = line.split_once('\x1f') else {
                continue;
            };
            if let Some(entry) = counts.iter_mut().find(|(n, e, _)| n == name && e == email) {
                entry.2 += 1;
            } else {
                counts.push((name.to_owned(), email.to_owned(), 1));
            }
        }
    }
    counts.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    let mut seen = std::collections::BTreeSet::new();
    let mut authors: Vec<Value> = Vec::new();
    for (name, email, _) in counts {
        if seen.insert(name.clone()) {
            authors.push(json!({ "name": name, "email": email }));
        }
    }
    authors.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["name"].as_str().unwrap_or_default())
    });

    let user = |key: &str| {
        json!({
            "local": local.get(key).map(|v| json!(v)).unwrap_or(Value::Null),
            "global": global.get(key).map(|v| json!(v)).unwrap_or(Value::Null),
        })
    };
    json!({
        "branches": Value::Object(branches),
        "authors": authors,
        "diffTool": snapshot.diff_tool,
        "guiDiffTool": snapshot.diff_gui_tool,
        "pushDefault": snapshot.push_default,
        "remotes": snapshot.remotes.iter().map(|remote| json!({
            "name": remote.name, "url": remote.url, "pushUrl": remote.push_url
        })).collect::<Vec<Value>>(),
        "user": { "name": user("user.name"), "email": user("user.email") }
    })
}

/// The `loadRepoInfo` response for a request (its `refreshId` is filled in by the caller).
fn repo_info_response(
    repo: &git_graph_core::Repo,
    git: &Git,
    message: &Value,
) -> Result<Value, String> {
    let show_stashes = message
        .get("showStashes")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let options = git_graph_core::types::RefReadOptions {
        show_remote_branches: message
            .get("showRemoteBranches")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        show_remote_heads: false,
        hide_remotes: string_list(message.get("hideRemotes")),
        show_change_refs: false,
    };
    let info = graph::repo_info(repo, &options, show_stashes).map_err(|e| e.message)?;
    Ok(json!({
        "command": "loadRepoInfo",
        "branches": info.branches, "head": info.head, "remotes": info.remotes,
        "stashes": info.stashes, "isRepo": true, "remoteRefsPending": false,
        "operationState": operation_state(git),
        "error": null
    }))
}

/// The `loadCommits` response for a request (its `refreshId` is filled in by the caller).
fn load_commits_response(
    repo_path: &str,
    repo: &git_graph_core::Repo,
    message: &Value,
) -> Result<Value, String> {
    let mut options = log_options_from_request(message);
    // The Gerrit integration: the page loads with the cached changes' latest patchset refs
    // pinned onto it (the engine gives each change's commit a row, whatever its age) and their
    // states riding along. A cache that is missing, stale or built under another fetch limit
    // answers from the locally fetched refs and marks the response `gerritPending` — the host
    // then runs the refresh pipeline (`gerritRefresh`) and delivers the fresh states as further
    // `loadCommits` responses under the same refresh id.
    let mut gerrit_states = Value::Null;
    let mut gerrit_pending = false;
    if options.gerrit_refs.is_some() {
        let remote = message
            .get("gerritRemote")
            .and_then(Value::as_str)
            .unwrap_or("origin");
        let filter = gerrit_status_filter(message);
        let fetch_limit = gerrit_fetch_limit(message);
        gerrit_cached_entry(
            repo_path,
            repo,
            remote,
            fetch_limit,
            message
                .get("hard")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        let entry = GERRIT_CACHE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(repo_path)
            .and_then(|state| state.entry.clone());
        if let Some(entry) = entry {
            options.gerrit_refs = Some(gerrit_change_refs(&entry, remote, filter, fetch_limit));
            gerrit_states = serde_json::to_value(&entry.states).unwrap_or(Value::Null);
        }
        gerrit_pending = gerrit_needs_refresh(repo_path, fetch_limit);
    }
    let data = graph::load_commits(repo, &options).map_err(|e| e.message)?;
    let mut response = json!({
        "command": "loadCommits",
        "commits": data.commits, "head": data.head, "tags": data.tags,
        "moreCommitsAvailable": data.more_commits_available,
        "onlyFollowFirstParent": options.only_follow_first_parent,
        "gerritStates": gerrit_states,
        "error": null
    });
    if gerrit_pending {
        response["gerritPending"] = json!(true);
    }
    Ok(response)
}

/// The requests the view sends first, with the options it sends when nothing is configured
/// away from the defaults: what the launch warm-up computes ahead of the window. The view
/// names the repository's remotes in its `loadCommits` (it learnt them from `loadRepoInfo`),
/// so the warm-up's page names them too.
fn default_first_requests(remotes: &[String]) -> [Value; 2] {
    [
        json!({ "command": "loadRepoInfo", "showRemoteBranches": true, "showStashes": true, "hideRemotes": [] }),
        json!({ "command": "loadCommits", "maxCommits": 300, "showTags": true, "showRemoteBranches": true, "remotes": remotes }),
    ]
}

/// What decides a first request's answer: the engine options it translates to (the view's
/// message carries more - the refresh id, the stashes it knows - that changes nothing).
fn request_key(message: &Value) -> Value {
    match message.get("command").and_then(Value::as_str) {
        Some("loadCommits") => json!({
            "command": "loadCommits",
            "options": serde_json::to_value(log_options_from_request(message)).unwrap_or(Value::Null)
        }),
        _ => json!({
            "command": "loadRepoInfo",
            "showRemoteBranches": message.get("showRemoteBranches").and_then(Value::as_bool).unwrap_or(true),
            "showStashes": message.get("showStashes").and_then(Value::as_bool).unwrap_or(true),
            "hideRemotes": string_list(message.get("hideRemotes"))
        }),
    }
}

/// One warm response: the repository and request it answers, and the answer itself.
struct WarmResponse {
    repo: String,
    request: Value,
    response: Value,
}

/// The responses the launch warm-up computed. Each serves one request (the view's first),
/// then is gone; every later refresh goes to the engine, and a write or a folder switch
/// drops them unserved.
static WARM_RESPONSES: std::sync::Mutex<Vec<WarmResponse>> = std::sync::Mutex::new(Vec::new());

fn take_warm_response(repo_path: &str, command: &str, message: &Value) -> Option<Value> {
    let key = request_key(message);
    let mut warm = WARM_RESPONSES.lock().unwrap_or_else(|p| p.into_inner());
    let at = warm
        .iter()
        .position(|w| w.repo == repo_path && w.request["command"] == command && w.request == key)?;
    Some(warm.remove(at).response)
}

fn drop_warm_responses() {
    WARM_RESPONSES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

/// Translate a `loadCommits` request into the engine's `LogOptions`.
/// The graph's first page (the view's default `loadCommits` request: every branch, 300
/// commits, date order), returning how many commits it holds. The `--measure` run times it
/// exactly as the view experiences it.
pub fn load_first_page(repo_path: &str) -> Result<usize, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    let [_, commits] = default_first_requests(&[]);
    let options = log_options_from_request(&commits);
    let data = graph::load_commits(&repo, &options).map_err(|e| e.message)?;
    Ok(data.commits.len())
}

/// The launch warm-up: open the repository and answer the view's two first requests -
/// `loadRepoInfo` and the first page of `loadCommits` - with their default options, keeping
/// the answers for the requests themselves. Returns the page's commit count.
pub fn warm_first_page(repo_path: &str) -> Result<usize, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    let git = Git::new(repo_path);
    let [info, _] = default_first_requests(&[]);
    let info_response = repo_info_response(&repo, &git, &info)?;
    let remotes: Vec<String> = info_response["remotes"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let [_, commits] = default_first_requests(&remotes);
    let commits_response = load_commits_response(repo_path, &repo, &commits)?;
    let count = commits_response["commits"].as_array().map_or(0, Vec::len);
    let mut warm = WARM_RESPONSES.lock().unwrap_or_else(|p| p.into_inner());
    warm.retain(|w| w.repo != repo_path);
    warm.push(WarmResponse {
        repo: repo_path.to_owned(),
        request: request_key(&info),
        response: info_response,
    });
    warm.push(WarmResponse {
        repo: repo_path.to_owned(),
        request: request_key(&commits),
        response: commits_response,
    });
    Ok(count)
}

fn log_options_from_request(message: &Value) -> LogOptions {
    let bool_of =
        |key: &str, default: bool| message.get(key).and_then(Value::as_bool).unwrap_or(default);
    let opt_list = |key: &str| {
        message.get(key).and_then(Value::as_array).and_then(|a| {
            if a.iter().all(Value::is_null) {
                None
            } else {
                Some(
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>(),
                )
            }
        })
    };
    let ordering = match message.get("commitOrdering").and_then(Value::as_str) {
        Some("author-date") => git_graph_core::types::CommitOrdering::AuthorDate,
        Some("topo") => git_graph_core::types::CommitOrdering::Topo,
        _ => git_graph_core::types::CommitOrdering::Date,
    };
    LogOptions {
        branches: opt_list("branches"),
        authors: opt_list("authors"),
        max_commits: message
            .get("maxCommits")
            .and_then(Value::as_u64)
            .unwrap_or(500) as u32,
        show_tags: bool_of("showTags", true),
        show_remote_branches: bool_of("showRemoteBranches", true),
        show_remote_heads: false,
        defer_remote_refs: false,
        include_commits_mentioned_by_reflogs: bool_of("includeCommitsMentionedByReflogs", false),
        only_follow_first_parent: bool_of("onlyFollowFirstParent", false),
        commit_ordering: ordering,
        remotes: string_list(message.get("remotes")),
        hide_remotes: string_list(message.get("hideRemotes")),
        gerrit_refs: if bool_of("gerritFetchRefs", false) {
            Some(Vec::new())
        } else {
            None
        },
        gerrit_show_change_refs: false,
        // The view sends comma-joined paths (web/main.ts showPathFilterDialog): split
        // them so each becomes its own pathspec and a commit touching any one shows.
        filter_paths: message
            .get("filterPath")
            .and_then(Value::as_str)
            .map(|p| {
                p.split(',')
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        defer_uncommitted_changes: false,
        show_uncommitted_changes: bool_of("showUncommittedChanges", true),
        show_untracked_files: bool_of("showUntrackedFiles", true),
        show_commits_only_referenced_by_tags: false,
        use_mailmap: false,
    }
}

/* ---------- Gerrit change states (the review badges) ---------- */

/// One repository's cached Gerrit data: the parsed NoteDb states of every change the last fetch
/// sampled, their locally fetched patchsets, and the fetch limit that fetch ran under.
#[derive(Clone)]
struct GerritEntry {
    states: Vec<GerritChangeState>,
    patchsets: std::collections::HashMap<u64, Vec<u32>>,
    fetch_limit: u32,
}

/// The Gerrit data of every repository the view has loaded: its cache entry, and whether the
/// next load must re-run the fetch pipeline (the integration was just enabled, or the view
/// fetched from the remote).
struct GerritRepo {
    entry: Option<GerritEntry>,
    stale: bool,
}

static GERRIT_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, GerritRepo>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Mark a repository's Gerrit data stale: the next `loadCommits` answers from the locally
/// fetched refs and flags itself pending, and the host then runs the refresh pipeline.
fn mark_gerrit_stale(repo_path: &str) {
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(repo_path.to_owned())
        .or_insert(GerritRepo {
            entry: None,
            stale: false,
        })
        .stale = true;
}

/// Drop a repository's Gerrit cache entirely (the integration was disabled: the change refs the
/// entry was built from are gone).
fn clear_gerrit_cache(repo_path: &str) {
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(repo_path);
}

/// The status filter of a `loadCommits` request (the Repository Settings checkboxes): a WIP
/// change passes through its own flag, any other through its status.
#[derive(Clone, Copy)]
struct GerritStatusFilter {
    new_change: bool,
    merged: bool,
    abandoned: bool,
    wip: bool,
}

fn gerrit_status_filter(message: &Value) -> GerritStatusFilter {
    let filter = message.get("gerritStatusFilter");
    let flag = |key: &str| {
        filter
            .and_then(|f| f.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    GerritStatusFilter {
        new_change: flag("new"),
        merged: flag("merged"),
        abandoned: flag("abandoned"),
        wip: flag("wip"),
    }
}

/// The fetch limit a request displays the Gerrit changes under: the repository's own limit, or
/// the extension's default of 20 when it carries none (the host resolves the configuration's
/// limit into the request; gitGraphView.ts `gerritFetchLimitOf`).
fn gerrit_fetch_limit(message: &Value) -> u32 {
    message
        .get("gerritFetchLimit")
        .and_then(Value::as_u64)
        .filter(|limit| (1..=10000).contains(limit))
        .map_or(20, |limit| limit as u32)
}

fn gerrit_state_passes(state: &GerritChangeState, filter: GerritStatusFilter) -> bool {
    if state.wip {
        return filter.wip;
    }
    match state.status.as_str() {
        "new" => filter.new_change,
        "merged" => filter.merged,
        _ => filter.abandoned,
    }
}

/// The `limit` most recent changes (by change number) passing the status filter — the set whose
/// latest patchset refs are injected into the graph, one badge per change (src/gerrit.ts
/// `limitChangeStates`).
fn gerrit_limit_states(
    states: &[GerritChangeState],
    filter: GerritStatusFilter,
    limit: u32,
) -> Vec<&GerritChangeState> {
    let mut passing: Vec<&GerritChangeState> = states
        .iter()
        .filter(|state| gerrit_state_passes(state, filter))
        .collect();
    passing.sort_by_key(|state| std::cmp::Reverse(state.change));
    if limit > 0 {
        passing.truncate(limit as usize);
    }
    passing
}

/// The Gerrit change refs injected into the commit graph: the latest locally fetched patchset
/// ref of every change the fetch limit selects (gitGraphView.ts `gerritChangeRefs`). The engine
/// walks and pins them, so each change's commit carries its badge whatever its age.
fn gerrit_change_refs(
    entry: &GerritEntry,
    remote: &str,
    filter: GerritStatusFilter,
    limit: u32,
) -> Vec<String> {
    gerrit_limit_states(&entry.states, filter, limit)
        .iter()
        .filter_map(|state| {
            let patchsets = entry.patchsets.get(&state.change)?;
            let latest = *patchsets.last()?;
            Some(format!(
                "refs/remotes/{remote}/changes/{}/{}/{}",
                gerrit_change_shard(state.change),
                state.change,
                latest
            ))
        })
        .collect()
}

/// The two-digit shard of a change number (`41466` → `"66"`, `5` → `"05"`).
fn gerrit_change_shard(change: u64) -> String {
    format!("{:02}", change % 100)
}

/// The change a change ref names — `refs/[remotes/<remote>/]changes/NN/<change>/(meta|<patchset>)`
/// (src/gerrit.ts `parseChangeRef`): the change number, and its patchset (`None` for a NoteDb
/// meta ref). `None` when the ref is not a change ref.
fn gerrit_parse_change_ref(refname: &str) -> Option<(u64, Option<u32>)> {
    let parts: Vec<&str> = refname.split('/').collect();
    let index = parts.iter().position(|part| *part == "changes")?;
    if parts.len() != index + 4 {
        return None;
    }
    let change: u64 = parts[index + 2].parse().ok()?;
    if change == 0 {
        return None;
    }
    match parts[index + 3] {
        "meta" => Some((change, None)),
        patchset => Some((change, Some(patchset.parse().ok()?))),
    }
}

/// `git ls-remote <remote> 'refs/changes/*'` parsed into change number → patchset numbers
/// (ascending), the non-meta refs only (src/gerrit.ts `parseLsRemoteChanges`).
fn gerrit_parse_ls_remote(output: &str) -> std::collections::BTreeMap<u64, Vec<u32>> {
    let mut changes: std::collections::BTreeMap<u64, Vec<u32>> = std::collections::BTreeMap::new();
    for line in output.lines() {
        let Some((_, refname)) = line.split_once([' ', '\t']) else {
            continue;
        };
        if let Some((change, Some(patchset))) = gerrit_parse_change_ref(refname.trim()) {
            let patchsets = changes.entry(change).or_default();
            if !patchsets.contains(&patchset) {
                patchsets.push(patchset);
            }
        }
    }
    for patchsets in changes.values_mut() {
        patchsets.sort_unstable();
    }
    changes
}

/// The fetch refspecs of a set of changes — the latest patchset and the NoteDb meta ref of
/// each, written into `refs/remotes/<remote>/changes/` (src/gerrit.ts `buildFetchRefspecs`).
fn gerrit_fetch_refspecs(
    changes: &std::collections::BTreeMap<u64, Vec<u32>>,
    remote: &str,
) -> Vec<String> {
    let mut refspecs = Vec::new();
    for (change, patchsets) in changes {
        let Some(latest) = patchsets.last() else {
            continue;
        };
        let shard = gerrit_change_shard(*change);
        refspecs.push(format!(
            "+refs/changes/{shard}/{change}/{latest}:refs/remotes/{remote}/changes/{shard}/{change}/{latest}"
        ));
        refspecs.push(format!(
            "+refs/changes/{shard}/{change}/meta:refs/remotes/{remote}/changes/{shard}/{change}/meta"
        ));
    }
    refspecs
}

/// The refspec budget of one `git fetch` command line: Windows caps a process command line at
/// ~32k characters, which a few hundred change refspecs exceed (src/gerrit.ts
/// `FETCH_REFSPEC_BUDGET`), so large fetches are split into batches inside every limit.
const GERRIT_FETCH_REFSPEC_BUDGET: usize = 8000;

fn gerrit_chunk_refspecs(refspecs: &[String]) -> Vec<Vec<String>> {
    let mut batches = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut length = 0;
    for refspec in refspecs {
        if !current.is_empty() && length + refspec.len() + 1 > GERRIT_FETCH_REFSPEC_BUDGET {
            batches.push(std::mem::take(&mut current));
            length = 0;
        }
        current.push(refspec.clone());
        length += refspec.len() + 1;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

/// The initial and maximum over-sampling factors of the Gerrit fetch (src/gerrit.ts): a
/// change's status is only known once its NoteDb meta has been fetched and parsed, so the fetch
/// samples the most recent changes starting at `fetch_limit * 4` and doubles the window (up to
/// ×16) while fewer than `fetch_limit` of them pass the status filter.
const GERRIT_FETCH_WINDOW_FACTOR: usize = 4;
const GERRIT_FETCH_WINDOW_FACTOR_MAX: usize = 16;

/// The next window of the adaptive Gerrit sampling, or `None` when sampling is complete —
/// enough passing changes collected, the remote exhausted, or the cap reached (src/gerrit.ts
/// `nextGerritSampleWindow`).
fn gerrit_next_sample_window(
    window: usize,
    passing: usize,
    fetch_limit: u32,
    remote_count: usize,
) -> Option<usize> {
    let limit = fetch_limit as usize;
    if limit > 0 && passing >= limit {
        return None;
    }
    if window >= remote_count {
        return None;
    }
    let cap = if limit > 0 {
        limit * GERRIT_FETCH_WINDOW_FACTOR_MAX
    } else {
        GERRIT_FETCH_WINDOW_FACTOR_MAX
    };
    if window >= cap {
        return None;
    }
    Some(remote_count.min(cap.min(window.max(1) * 2)))
}

/// The credentials of a remote URL, dropped: they belong to the Git transport, not to a web
/// link (`user:pass@host`, `user@host`).
fn gerrit_without_credentials(rest: &str) -> &str {
    match rest.find('@') {
        Some(at) if !rest[..at].contains('/') && !rest[..at].contains('@') => &rest[at + 1..],
        _ => rest,
    }
}

/// The Gerrit web-URL base of a remote URL (src/gerrit.ts `getChangeUrlBase`), or `None` when
/// the remote names no server (a local path) or no project.
fn gerrit_url_base(remote_url: &str) -> Option<String> {
    let (scheme, host, project) = gerrit_remote_server(remote_url)?;
    let project = project.strip_prefix("a/").unwrap_or(&project);
    if project.is_empty() {
        return None;
    }
    Some(format!(
        "{}://{host}/c/{project}/+/",
        scheme.unwrap_or("http")
    ))
}

/// The Gerrit server a remote's URL names: the scheme its web interface is served over (`None`
/// when the remote itself doesn't say — both ssh forms), the host, and the project path. Both
/// of Git's ssh forms and the scp-style shorthand are understood; credentials belong to the Git
/// transport and are dropped. (src/gerrit.ts `gerritRemoteServer`, case for case.)
fn gerrit_remote_server(remote_url: &str) -> Option<(Option<&str>, &str, String)> {
    let url = remote_url.trim();
    let lower = url.to_ascii_lowercase();
    for scheme in ["https", "http"] {
        if lower.starts_with(&format!("{scheme}://")) {
            let rest = gerrit_without_credentials(&url[scheme.len() + 3..]);
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            if host.is_empty() {
                return None;
            }
            return Some((Some(scheme), host, gerrit_project_path(path)));
        }
    }
    if lower.starts_with("ssh://") {
        let rest = gerrit_without_credentials(&url[6..]);
        let host_end = rest.find(['/', ':']).unwrap_or(rest.len());
        let host = &rest[..host_end];
        if host.is_empty() {
            return None;
        }
        let after_host = &rest[host_end..];
        let path = match after_host.strip_prefix(':') {
            // An ssh port is digits up to the project path; anything else is not this form.
            Some(tail) => match tail.find('/') {
                Some(slash)
                    if !tail[..slash].is_empty()
                        && tail[..slash].bytes().all(|b| b.is_ascii_digit()) =>
                {
                    &tail[slash + 1..]
                }
                None if tail.bytes().all(|b| b.is_ascii_digit()) => "",
                _ => return None,
            },
            None => after_host.strip_prefix('/').unwrap_or(""),
        };
        return Some((None, host, gerrit_project_path(path)));
    }
    // The scp-style form has no port, and a single-letter host is a Windows drive, not a host.
    if let Some((host, path)) = gerrit_without_credentials(url).split_once(':') {
        let host_ok = host.len() > 1
            && host.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        if host_ok && !path.starts_with('/') {
            return Some((None, host, gerrit_project_path(path)));
        }
    }
    None
}

/// The project a remote URL's path names, without the surrounding slashes or the `.git` suffix.
fn gerrit_project_path(path: &str) -> String {
    let mut project = path.trim_matches('/').to_owned();
    if project.len() >= 4 && project.as_bytes()[project.len() - 4..].eq_ignore_ascii_case(b".git") {
        project.truncate(project.len() - 4);
    }
    project
}

/// Build a cache entry from the locally fetched change refs (`refs/remotes/<remote>/changes/*`)
/// without any network access — the Gerrit data of a previous session shows instantly (and
/// offline) until the refresh pipeline lands (gitGraphView.ts `buildLocalGerritEntry`).
fn build_local_gerrit_entry(
    repo: &git_graph_core::Repo,
    remote: &str,
    fetch_limit: u32,
) -> Option<GerritEntry> {
    let refs = git_graph_core::gerrit::list_change_refs(repo, remote).ok()?;
    let mut changes: std::collections::BTreeMap<u64, Vec<u32>> = std::collections::BTreeMap::new();
    for (refname, _) in refs {
        if let Some((change, Some(patchset))) = gerrit_parse_change_ref(&refname) {
            let patchsets = changes.entry(change).or_default();
            if !patchsets.contains(&patchset) {
                patchsets.push(patchset);
            }
        }
    }
    if changes.is_empty() {
        return None;
    }
    let url_base = git_graph_core::config::remote_url(repo, remote)
        .ok()
        .flatten()
        .and_then(|url| gerrit_url_base(&url));
    let numbers: Vec<i64> = changes.keys().map(|change| *change as i64).collect();
    let parsed =
        git_graph_core::gerrit::parse_gerrit_metas(repo, remote, &numbers, url_base.as_deref())
            .ok()?;
    let mut entry = GerritEntry {
        states: Vec::new(),
        patchsets: std::collections::HashMap::new(),
        fetch_limit,
    };
    for ((change, patchsets), state) in changes.into_iter().zip(parsed) {
        if let Some(state) = state {
            entry.states.push(state);
            entry.patchsets.insert(change, patchsets);
        }
    }
    entry
        .states
        .sort_by_key(|state| std::cmp::Reverse(state.change));
    (!entry.states.is_empty()).then_some(entry)
}

/// The cache half of a Gerrit load (gitGraphView.ts `loadGerritData`): keep the cached entry
/// when it is fresh under the request's fetch limit; otherwise rebuild the entry from the
/// locally fetched change refs, which also replaces an entry built under another limit. `hard`
/// always rebuilds, observing a repository that changed behind the cache's back. The network
/// half is `gerrit_refresh`, which the host runs while the pending response is on screen.
fn gerrit_cached_entry(
    repo_path: &str,
    repo: &git_graph_core::Repo,
    remote: &str,
    fetch_limit: u32,
    hard: bool,
) {
    let fresh = !hard
        && {
            let cache = GERRIT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
            matches!(cache.get(repo_path), Some(state)
            if !state.stale && state.entry.as_ref().is_some_and(|entry| entry.fetch_limit == fetch_limit))
        };
    if fresh {
        return;
    }
    let local = build_local_gerrit_entry(repo, remote, fetch_limit);
    let mut cache = GERRIT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let state = cache.entry(repo_path.to_owned()).or_insert(GerritRepo {
        entry: None,
        stale: false,
    });
    if let Some(local) = local {
        state.entry = Some(local);
    }
}

/// Whether a repository's Gerrit data still needs the refresh pipeline: it was marked stale,
/// has no entry at all, or its entry was built under another fetch limit.
fn gerrit_needs_refresh(repo_path: &str, fetch_limit: u32) -> bool {
    let cache = GERRIT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    match cache.get(repo_path) {
        Some(state) => {
            state.stale
                || state
                    .entry
                    .as_ref()
                    .is_none_or(|entry| entry.fetch_limit != fetch_limit)
        }
        None => true,
    }
}

/// Run the Gerrit refresh pipeline of a repository (gitGraphView.ts `fetchGerritChanges`):
/// list the remote's open change refs, fetch the latest patchset and NoteDb meta of the changes
/// the sampling window selects, parse the metas, and prune the locally fetched refs the new set
/// no longer keeps. The result becomes the repository's cache entry; a failure keeps the
/// previous entry and its stale flag, so the next load retries.
///
/// Returns the number of changes in the new entry, and whether the remote was actually reached
/// (`false`: ls-remote answered nothing while local change refs exist — the remote is treated
/// as unreachable, and the previously cached data stays).
fn gerrit_refresh(
    repo_path: &str,
    remote: &str,
    fetch_limit: u32,
    filter: GerritStatusFilter,
) -> Result<(usize, bool), String> {
    let git = Git::new(repo_path);
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    let listing = git
        .output(&["ls-remote", remote, "refs/changes/*"])
        .map_err(|e| {
            format!("Could not list the Gerrit changes of the remote \"{remote}\": {e}")
        })?;
    let remote_changes = gerrit_parse_ls_remote(&listing);
    if remote_changes.is_empty() {
        if let Some(local) = build_local_gerrit_entry(&repo, remote, fetch_limit) {
            return Ok((local.states.len(), false));
        }
    }
    let url_base = git_graph_core::config::remote_url(&repo, remote)
        .ok()
        .flatten()
        .and_then(|url| gerrit_url_base(&url));

    let mut entry = GerritEntry {
        states: Vec::new(),
        patchsets: std::collections::HashMap::new(),
        fetch_limit,
    };
    if !remote_changes.is_empty() {
        let remote_count = remote_changes.len();
        let mut window = remote_count
            .min((fetch_limit as usize).saturating_mul(GERRIT_FETCH_WINDOW_FACTOR))
            .max(1);
        let filter_passes_anything =
            filter.new_change || filter.merged || filter.abandoned || filter.wip;
        loop {
            // The delta: the changes newly inside the window (already-sampled changes are
            // neither re-fetched nor re-parsed).
            let delta: Vec<(u64, Vec<u32>)> = remote_changes
                .iter()
                .rev()
                .take(window)
                .filter(|(change, _)| !entry.patchsets.contains_key(change))
                .map(|(change, patchsets)| (*change, patchsets.clone()))
                .collect();
            if !delta.is_empty() {
                let numbers: std::collections::BTreeMap<u64, Vec<u32>> =
                    delta.iter().cloned().collect();
                for batch in gerrit_chunk_refspecs(&gerrit_fetch_refspecs(&numbers, remote)) {
                    let mut args = vec!["fetch", "--no-tags", remote];
                    args.extend(batch.iter().map(String::as_str));
                    git.run(&args).map_err(|e| {
                        format!(
                            "Fetching the Gerrit changes from the remote \"{remote}\" failed: {e}"
                        )
                    })?;
                }
                // The engine's warm repository handle predates the fetched refs: reopen it so
                // the meta parse reads the fresh ref store.
                RepoManager::global().close(repo_path);
                let repo = RepoManager::global()
                    .get(repo_path)
                    .map_err(|e| e.message)?;
                let changes: Vec<i64> = delta.iter().map(|(change, _)| *change as i64).collect();
                let parsed = git_graph_core::gerrit::parse_gerrit_metas(
                    &repo,
                    remote,
                    &changes,
                    url_base.as_deref(),
                )
                .map_err(|e| e.message)?;
                for ((change, patchsets), state) in delta.into_iter().zip(parsed) {
                    if let Some(state) = state {
                        entry.states.push(state);
                        entry.patchsets.insert(change, patchsets);
                    }
                }
            }
            let passing = entry
                .states
                .iter()
                .filter(|state| gerrit_state_passes(state, filter))
                .count();
            match filter_passes_anything
                .then(|| gerrit_next_sample_window(window, passing, fetch_limit, remote_count))
            {
                Some(Some(next)) => window = next,
                _ => break,
            }
        }
        // Prune the locally fetched change refs the new set no longer keeps (the repository
        // stays a constant size across refreshes); best-effort — a failure only leaves stale
        // refs behind. One batched update-ref, as the extension deletes them.
        let keep: Vec<String> = entry
            .patchsets
            .keys()
            .map(|change| {
                format!(
                    "refs/remotes/{remote}/changes/{}/{change}/",
                    gerrit_change_shard(*change)
                )
            })
            .collect();
        if let Ok(repo) = RepoManager::global().get(repo_path) {
            if let Ok(refs) = git_graph_core::gerrit::list_change_refs(&repo, remote) {
                let deletions: String = refs
                    .into_iter()
                    .filter(|(refname, _)| !keep.iter().any(|prefix| refname.starts_with(prefix)))
                    .map(|(refname, _)| format!("delete {refname}\n"))
                    .collect();
                if !deletions.is_empty() {
                    let _ = git.output_with_input(&["update-ref", "--stdin"], &deletions);
                }
            }
        }
    }
    entry
        .states
        .sort_by_key(|state| std::cmp::Reverse(state.change));
    let count = entry.states.len();
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            repo_path.to_owned(),
            GerritRepo {
                entry: Some(entry),
                stale: false,
            },
        );
    // The fetches wrote refs the engine's caches predate.
    drop_warm_responses();
    RepoManager::global().close(repo_path);
    Ok((count, true))
}

#[cfg(test)]
mod warm_tests {
    use super::*;

    #[test]
    fn the_warm_up_answers_the_first_default_requests_once() {
        let scratch = crate::test_support::Scratch::new("warm");
        let git = scratch.repo("repo");
        crate::test_support::commit(&git, "a.rs", "fn a() {}\n", "second");
        let root = git.repo.display().to_string();
        assert_eq!(warm_first_page(&root).unwrap(), 2);

        // The view's messages carry more than the options (a refresh id, the stashes it
        // knows, the repo) and name the remotes it learnt: still the warm answer.
        let info = json!({ "command": "loadRepoInfo", "repo": root, "refreshId": 3, "showRemoteBranches": true, "showStashes": true, "hideRemotes": [] });
        let answered = handle_repo_request(&root, &info, ActionSettings::default()).unwrap();
        assert_eq!(answered["refreshId"], 3);
        assert_eq!(answered["isRepo"], true);
        let commits = json!({ "command": "loadCommits", "repo": root, "refreshId": 4, "branches": null, "authors": null, "maxCommits": 300, "showTags": true, "showRemoteBranches": true, "includeCommitsMentionedByReflogs": false, "onlyFollowFirstParent": false, "commitOrdering": "date", "remotes": [], "hideRemotes": [], "stashes": [] });
        assert!(take_warm_response(&root, "loadCommits", &commits).is_some());
        // Served once: the next identical request goes to the engine (and still answers).
        assert!(take_warm_response(&root, "loadCommits", &commits).is_none());
        let fresh = handle_repo_request(&root, &commits, ActionSettings::default()).unwrap();
        assert_eq!(fresh["refreshId"], 4);
        assert_eq!(fresh["commits"].as_array().unwrap().len(), 2);

        // Different options never take a warm answer, and a folder switch drops them all.
        assert_eq!(warm_first_page(&root).unwrap(), 2);
        let other = json!({ "command": "loadCommits", "maxCommits": 50 });
        assert!(take_warm_response(&root, "loadCommits", &other).is_none());
        close_engine_repos();
        assert!(take_warm_response(&root, "loadRepoInfo", &info).is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::dir_diff_range;

    #[test]
    fn dir_diff_ranges_match_the_extension() {
        assert_eq!(dir_diff_range("*", "*"), vec!["HEAD"]);
        assert_eq!(dir_diff_range("abc", "abc"), vec!["abc^..abc"]);
        assert_eq!(dir_diff_range("abc", "*"), vec!["abc"]);
        assert_eq!(dir_diff_range("abc", "def"), vec!["abc..def"]);
    }
}

#[cfg(test)]
mod engine_tests {
    use serde_json::{json, Value};

    use super::{submodule_roots, view_config};
    use crate::test_support::Scratch;
    use git_graph_core::{config, RepoManager};

    /// The repository dropdown offers the main repository plus its initialised submodules: a
    /// `.gitmodules` entry whose path holds a `.git` counts, one that was never initialised
    /// (cloned without `--recurse-submodules`) does not.
    #[test]
    fn submodule_roots_list_only_initialised_submodules() {
        let scratch = Scratch::new("submodules");
        let git = scratch.repo("main");
        crate::test_support::commit(&git, "README.md", "hi\n", "Initial commit");
        let root = git.repo.display().to_string();
        std::fs::write(
            std::path::Path::new(&root).join(".gitmodules"),
            "[submodule \"dep\"]\n\tpath = dep\n\turl = ../dep.git\n[submodule \"missing\"]\n\tpath = missing\n\turl = ../missing.git\n",
        )
        .unwrap();
        // An initialised submodule: a .git below its path (a directory, like a real checkout's
        // gitfile-based one would also be found).
        std::fs::create_dir_all(std::path::Path::new(&root).join("dep").join(".git")).unwrap();
        let dep = std::fs::canonicalize(std::path::Path::new(&root).join("dep"))
            .unwrap()
            .display()
            .to_string()
            .trim_start_matches(r"\\?\")
            .to_owned();
        assert_eq!(submodule_roots(&root), vec![dep]);
        RepoManager::global().close(&root);
    }

    /// The Path filter sends comma-separated paths: a commit shows when it changes any one
    /// of them, not only when it changes the literal comma-joined string.
    #[test]
    fn comma_separated_path_filter_matches_any_file() {
        let scratch = Scratch::new("path-filter");
        let git = scratch.repo("repo");
        crate::test_support::commit(&git, "src/a.txt", "a\n", "touch a");
        crate::test_support::commit(&git, "docs/b.txt", "b\n", "touch b");
        crate::test_support::commit(&git, "other/c.txt", "c\n", "touch c");
        let root = git.repo.display().to_string();
        let request = json!({
            "command": "loadCommits", "repo": root, "refreshId": 1,
            "filterPath": "src/a.txt, docs/b.txt",
        });
        let response =
            super::handle_repo_request(&root, &request, super::ActionSettings::default()).unwrap();
        let subjects: Vec<&str> = response["commits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["message"].as_str().unwrap())
            .collect();
        assert_eq!(subjects, vec!["touch b", "touch a"]);
        RepoManager::global().close(&root);
    }

    /// The Settings Widget renders `GG.GitRepoConfig`: the branch map, the author list and the
    /// split local/global user identity must all be present alongside the snapshot's own fields
    /// (an incomplete shape makes the widget's render throw and empty the panel).
    #[test]
    fn view_config_matches_the_webview_shape() {
        let scratch = Scratch::new("view-config");
        let path = scratch.path("cfg");
        std::fs::create_dir_all(&path).unwrap();
        let git = scratch.git(&path);
        git.run(&["init", "-q", "-b", "main"]).unwrap();
        crate::test_support::commit(&git, "README.md", "hello\n", "Initial commit");
        git.run(&["config", "--local", "user.name", "Local Me"])
            .unwrap();
        git.run(&["config", "--global", "user.name", "Global Me"])
            .unwrap();
        git.run(&["config", "--local", "user.email", "local@example.com"])
            .unwrap();
        git.run(&["remote", "add", "origin", "https://example.com/repo.git"])
            .unwrap();
        git.run(&["config", "--local", "branch.main.remote", "origin"])
            .unwrap();
        git.run(&["config", "--local", "branch.main.pushRemote", "origin"])
            .unwrap();

        let repo = RepoManager::global().get(&path).unwrap();
        let snapshot = config::read_config(&repo).unwrap();
        RepoManager::global().close(&path);
        let cfg = view_config(&git, &snapshot);

        assert_eq!(cfg["branches"]["main"]["remote"], json!("origin"));
        assert_eq!(cfg["branches"]["main"]["pushRemote"], json!("origin"));
        assert_eq!(cfg["remotes"][0]["name"], json!("origin"));
        assert_eq!(
            cfg["remotes"][0]["url"],
            json!("https://example.com/repo.git")
        );
        assert_eq!(cfg["user"]["name"]["local"], json!("Local Me"));
        assert_eq!(cfg["user"]["name"]["global"], json!("Global Me"));
        assert_eq!(cfg["user"]["email"]["local"], json!("local@example.com"));
        assert_eq!(cfg["user"]["email"]["global"], Value::Null);
        // The commit's author, deduplicated by name and sorted.
        assert_eq!(
            cfg["authors"],
            json!([{ "name": "Test", "email": "test@example.com" }])
        );
    }
}

/* ======================================================================
The Git Graph view's write operations, served through the `git` CLI.

Each arm mirrors the corresponding method of the extension's `DataSource`
(src/dataSource.ts) and the response shape `GitGraphView.handleMessage`
(src/gitGraphView.ts) sends back, so the unmodified webview behaves exactly
as it does inside VS Code: the same arguments reach git, the same data-loss
warnings come back for confirmation, the same error strings are shown.
====================================================================== */

use std::path::Path;

use serde::Deserialize;

/// The extension settings the write path consults (the view's Settings Widget can change them,
/// so the frontend sends the current values along with each request).
#[derive(Clone, Copy, Debug, Default, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActionSettings {
    pub sign_commits: bool,
    pub sign_tags: bool,
    /// `SquashMessageFormat`: 0 = Default ("Merge branch 'x'"), 1 = git's own SQUASH_MSG.
    pub squash_merge_message_format: u8,
    pub squash_pull_message_format: u8,
}

/// The sentinel the view uses for the uncommitted changes "commit".
pub const UNCOMMITTED: &str = "*";

/// The error prefix the view recognises on a `pushTag` response for the "commit is not on the
/// remote" case (src/types/messages.ts, `ErrorInfoExtensionPrefix`).
const PUSH_TAG_COMMIT_NOT_ON_REMOTE: &str = "VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:";

/// What a handled action produced: an ordinary response for the view, or a data-loss warning
/// the view must confirm before the request is retried with `confirmed: true`.
enum Outcome {
    /// `Ok(())` = success (`error: null`), `Err(message)` = git's complaint.
    Status(Result<(), String>),
    /// A list of statuses, for the commands whose response carries `errors: [...]`.
    Statuses(Vec<Result<(), String>>),
    Warning(String),
}

type Status = Result<(), String>;

/* ---------- Dispatch ---------- */

/// Handle one write request. `None` when the command is not a write operation (the caller
/// serves it from the engine instead).
pub fn handle(git: &Git, message: &Value, settings: ActionSettings) -> Option<Value> {
    let command = message.get("command")?.as_str()?;
    let str_of = |key: &str| message.get(key).and_then(Value::as_str);
    let bool_of = |key: &str| message.get(key).and_then(Value::as_bool).unwrap_or(false);
    let list_of = |key: &str| -> Vec<String> {
        message
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let confirmed = bool_of("confirmed");

    let outcome = match command {
        "abortOperation" => Outcome::Status(abort_or_continue(
            git,
            str_of("type").unwrap_or_default(),
            "--abort",
        )),
        "continueOperation" => Outcome::Status(abort_or_continue(
            git,
            str_of("type").unwrap_or_default(),
            "--continue",
        )),
        "addRemote" => Outcome::Status(add_remote(
            git,
            str_of("name").unwrap_or_default(),
            str_of("url").unwrap_or_default(),
            str_of("pushUrl"),
            bool_of("fetch"),
        )),
        "deleteRemote" => Outcome::Status(
            check(&[("name", str_of("name"), Kind::Ref)])
                .and_then(|_| git.run(&["remote", "remove", str_of("name").unwrap_or_default()])),
        ),
        "editRemote" => Outcome::Status(edit_remote(
            git,
            str_of("nameOld").unwrap_or_default(),
            str_of("nameNew").unwrap_or_default(),
            str_of("urlOld"),
            str_of("urlNew"),
            str_of("pushUrlOld"),
            str_of("pushUrlNew"),
        )),
        "pruneRemote" => Outcome::Status(
            check(&[("name", str_of("name"), Kind::Ref)])
                .and_then(|_| git.run(&["remote", "prune", str_of("name").unwrap_or_default()])),
        ),
        "addTag" => {
            let tag_name = str_of("tagName").unwrap_or_default();
            let commit_hash = str_of("commitHash").unwrap_or_default();
            let mut statuses = vec![add_tag(
                git,
                tag_name,
                commit_hash,
                message.get("type").and_then(Value::as_u64).unwrap_or(0),
                str_of("message").unwrap_or_default(),
                bool_of("force"),
                settings,
            )];
            if statuses[0].is_ok() {
                if let Some(remote) = str_of("pushToRemote") {
                    statuses.extend(push_tag(
                        git,
                        tag_name,
                        &[remote.to_owned()],
                        commit_hash,
                        bool_of("pushSkipRemoteCheck"),
                    ));
                }
            }
            return Some(with_echo(
                json!({ "command": "addTag", "errors": errors_of(statuses) }),
                message,
                &["repo", "tagName", "pushToRemote", "commitHash"],
            ));
        }
        "deleteTag" => Outcome::Status(delete_tag(
            git,
            str_of("tagName").unwrap_or_default(),
            str_of("deleteOnRemote"),
        )),
        "pushTag" => {
            let statuses = push_tag(
                git,
                str_of("tagName").unwrap_or_default(),
                &list_of("remotes"),
                str_of("commitHash").unwrap_or_default(),
                bool_of("skipRemoteCheck"),
            );
            return Some(with_echo(
                json!({ "command": "pushTag", "errors": errors_of(statuses) }),
                message,
                &["repo", "tagName", "remotes", "commitHash"],
            ));
        }
        "fetch" => Outcome::Status(fetch(
            git,
            str_of("name"),
            bool_of("prune"),
            bool_of("pruneTags"),
        )),
        "fetchIntoLocalBranch" => Outcome::Status(fetch_into_local_branch(
            git,
            str_of("remote").unwrap_or_default(),
            str_of("remoteBranch").unwrap_or_default(),
            str_of("localBranch").unwrap_or_default(),
            bool_of("force"),
        )),
        "pushBranch" => {
            let result = push_branch_to_remotes(
                git,
                str_of("branchName").unwrap_or_default(),
                &list_of("remotes"),
                bool_of("setUpstream"),
                str_of("mode").unwrap_or(""),
                confirmed,
            );
            match result {
                Err(warning) => Outcome::Warning(warning),
                Ok(statuses) => {
                    return Some(with_echo(
                        json!({ "command": "pushBranch", "errors": errors_of(statuses) }),
                        message,
                        &["willUpdateBranchConfig"],
                    ))
                }
            }
        }
        "pullBranch" => Outcome::Status(pull_branch(
            git,
            str_of("branchName").unwrap_or_default(),
            str_of("remote").unwrap_or_default(),
            bool_of("createNewCommit"),
            bool_of("squash"),
            settings,
        )),
        "checkoutBranch" => {
            let branch = str_of("branchName").unwrap_or_default();
            match checkout_branch(git, branch, str_of("remoteBranch"), confirmed) {
                Err(warning) => Outcome::Warning(warning),
                Ok(status) => {
                    let mut statuses = vec![status];
                    if statuses[0].is_ok() {
                        if let Some(pull) = message.get("pullAfterwards").filter(|p| !p.is_null()) {
                            let field = |key: &str| {
                                pull.get(key).and_then(Value::as_str).unwrap_or_default()
                            };
                            let flag =
                                |key: &str| pull.get(key).and_then(Value::as_bool).unwrap_or(false);
                            statuses.push(pull_branch(
                                git,
                                field("branchName"),
                                field("remote"),
                                flag("createNewCommit"),
                                flag("squash"),
                                settings,
                            ));
                        }
                    }
                    return Some(with_echo(
                        json!({ "command": "checkoutBranch", "errors": errors_of(statuses) }),
                        message,
                        &["pullAfterwards"],
                    ));
                }
            }
        }
        "checkoutCommit" => {
            let hash = str_of("commitHash").unwrap_or_default();
            match check(&[("commitHash", Some(hash), Kind::Hash)]) {
                Err(e) => Outcome::Status(Err(e)),
                Ok(()) => match loss_warning_if_detached(git, confirmed, None) {
                    Some(warning) => Outcome::Warning(warning),
                    None => Outcome::Status(git.run(&["checkout", hash])),
                },
            }
        }
        "createBranch" => match create_branch(
            git,
            str_of("branchName").unwrap_or_default(),
            str_of("commitHash").unwrap_or_default(),
            bool_of("checkout"),
            bool_of("force"),
            confirmed,
        ) {
            Err(warning) => Outcome::Warning(warning),
            Ok(statuses) => Outcome::Statuses(statuses),
        },
        "deleteBranch" => {
            let branch = str_of("branchName").unwrap_or_default();
            let mut statuses =
                vec![
                    check(&[("branchName", Some(branch), Kind::Ref)]).and_then(|_| {
                        git.run(&[
                            "branch",
                            if bool_of("forceDelete") { "-D" } else { "-d" },
                            branch,
                        ])
                    }),
                ];
            if statuses[0].is_ok() {
                for remote in list_of("deleteOnRemotes") {
                    statuses.push(delete_remote_branch(git, branch, &remote));
                }
            }
            return Some(with_echo(
                json!({ "command": "deleteBranch", "errors": errors_of(statuses) }),
                message,
                &["repo", "branchName", "deleteOnRemotes"],
            ));
        }
        "deleteRemoteBranch" => Outcome::Status(delete_remote_branch(
            git,
            str_of("branchName").unwrap_or_default(),
            str_of("remote").unwrap_or_default(),
        )),
        "renameBranch" => {
            let old = str_of("oldName").unwrap_or_default();
            let new = str_of("newName").unwrap_or_default();
            Outcome::Status(
                check(&[
                    ("oldName", Some(old), Kind::Ref),
                    ("newName", Some(new), Kind::Ref),
                ])
                .and_then(|_| git.run(&["branch", "-m", old, new])),
            )
        }
        "merge" => {
            let action_on = str_of("actionOn").unwrap_or("Branch");
            return Some(with_echo(
                json!({
                    "command": "merge",
                    "error": error_of(merge(
                        git,
                        str_of("obj").unwrap_or_default(),
                        action_on,
                        bool_of("createNewCommit"),
                        bool_of("squash"),
                        bool_of("noCommit"),
                        settings,
                    ))
                }),
                message,
                &["actionOn"],
            ));
        }
        "rebase" => {
            let action_on = str_of("actionOn").unwrap_or("Branch");
            let obj = str_of("obj").unwrap_or_default();
            let kind = if action_on == "Branch" {
                Kind::Ref
            } else {
                Kind::Hash
            };
            let status = check(&[("obj", Some(obj), kind)]).and_then(|_| {
                if bool_of("interactive") {
                    // The shell runs interactive rebases in its terminal (see graphHost.ts);
                    // reaching here means it did not intercept the request.
                    Err("An interactive rebase needs the built-in terminal.".to_owned())
                } else {
                    let mut args = vec!["rebase", obj];
                    if bool_of("ignoreDate") {
                        args.push("--ignore-date");
                    }
                    if settings.sign_commits {
                        args.push("-S");
                    }
                    git.run(&args)
                }
            });
            return Some(with_echo(
                json!({ "command": "rebase", "error": error_of(status) }),
                message,
                &["actionOn", "interactive"],
            ));
        }
        "cherrypickCommit" => {
            let hash = str_of("commitHash").unwrap_or_default();
            let parent_index = message
                .get("parentIndex")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let status = check(&[("commitHash", Some(hash), Kind::Hash)]).and_then(|_| {
                let parent = parent_index.to_string();
                let mut args = vec!["cherry-pick"];
                if bool_of("noCommit") {
                    args.push("--no-commit");
                }
                if bool_of("recordOrigin") {
                    args.push("-x");
                }
                if settings.sign_commits {
                    args.push("-S");
                }
                if parent_index > 0 {
                    args.push("-m");
                    args.push(&parent);
                }
                args.push(hash);
                git.run(&args)
            });
            // With --no-commit the extension then reveals the SCM view; the shell does that on
            // seeing this response (graphHost.ts).
            Outcome::Statuses(vec![status])
        }
        "revertCommit" => {
            let hash = str_of("commitHash").unwrap_or_default();
            let parent_index = message
                .get("parentIndex")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            Outcome::Status(
                check(&[("commitHash", Some(hash), Kind::Hash)]).and_then(|_| {
                    let parent = parent_index.to_string();
                    let mut args = vec!["revert", "--no-edit"];
                    if settings.sign_commits {
                        args.push("-S");
                    }
                    if parent_index > 0 {
                        args.push("-m");
                        args.push(&parent);
                    }
                    args.push(hash);
                    git.run(&args)
                }),
            )
        }
        "commitFixup" | "commitSquash" => {
            let hash = str_of("commitHash").unwrap_or_default();
            let flag = if command == "commitFixup" {
                "--fixup"
            } else {
                "--squash"
            };
            Outcome::Status(
                check(&[("commitHash", Some(hash), Kind::Hash)]).and_then(|_| {
                    let mut args = vec!["commit", flag, hash];
                    if settings.sign_commits {
                        args.push("-S");
                    }
                    git.run(&args)
                }),
            )
        }
        "dropCommit" => {
            let hash = str_of("commitHash").unwrap_or_default();
            Outcome::Status(
                check(&[("commitHash", Some(hash), Kind::Hash)]).and_then(|_| {
                    let parent = format!("{hash}^");
                    let mut args = vec!["rebase"];
                    if settings.sign_commits {
                        args.push("-S");
                    }
                    args.extend(["--onto", &parent, hash]);
                    git.run(&args)
                }),
            )
        }
        "resetToCommit" => {
            let commit = str_of("commit").unwrap_or("HEAD");
            let mode = str_of("resetMode").unwrap_or("mixed");
            if commit != "HEAD" {
                if let Err(e) = check(&[("commit", Some(commit), Kind::Hash)]) {
                    return Some(json!({ "command": "resetToCommit", "error": e }));
                }
                if mode == "hard" && !confirmed {
                    if let Some(warning) = hard_reset_loss_warning(git) {
                        return Some(loss_warning(message, warning));
                    }
                }
            }
            Outcome::Status(git.run(&["reset", &format!("--{mode}"), commit]))
        }
        "undoLastCommit" => Outcome::Status(git.run(&["reset", "--soft", "HEAD^"])),
        "editCommitMessage" => Outcome::Status(edit_commit_message(
            git,
            str_of("commitHash").unwrap_or_default(),
            str_of("message").unwrap_or_default(),
            settings,
        )),
        "editUserDetails" => {
            let location = str_of("location").unwrap_or("local");
            let mut statuses = Vec::new();
            // Absent fields mean "leave unchanged", not "set to empty": git rejects commits
            // with an empty ident, so only write the values that were actually provided.
            for (key, value) in [
                ("user.name", str_of("name")),
                ("user.email", str_of("email")),
            ] {
                if let Some(value) = value.filter(|v| !v.is_empty()) {
                    statuses.push(git.run(&["config", &format!("--{location}"), key, value]));
                }
            }
            if statuses.iter().all(Result::is_ok) {
                if bool_of("deleteLocalName") {
                    statuses.push(git.run(&["config", "--local", "--unset-all", "user.name"]));
                }
                if bool_of("deleteLocalEmail") {
                    statuses.push(git.run(&["config", "--local", "--unset-all", "user.email"]));
                }
            }
            Outcome::Statuses(statuses)
        }
        "deleteUserDetails" => {
            let location = str_of("location").unwrap_or("local");
            let mut statuses = Vec::new();
            if bool_of("name") {
                statuses.push(git.run(&[
                    "config",
                    &format!("--{location}"),
                    "--unset-all",
                    "user.name",
                ]));
            }
            if bool_of("email") {
                statuses.push(git.run(&[
                    "config",
                    &format!("--{location}"),
                    "--unset-all",
                    "user.email",
                ]));
            }
            Outcome::Statuses(statuses)
        }
        "cleanUntrackedFiles" => {
            Outcome::Status(git.run(&["clean", if bool_of("directories") { "-fd" } else { "-f" }]))
        }
        "resetFileToRevision" => {
            let hash = str_of("commitHash").unwrap_or_default();
            Outcome::Status(
                check(&[("commitHash", Some(hash), Kind::Hash)]).and_then(|_| {
                    git.run(&[
                        "checkout",
                        hash,
                        "--",
                        str_of("filePath").unwrap_or_default(),
                    ])
                }),
            )
        }
        "applyStash" | "popStash" => {
            let selector = str_of("selector").unwrap_or_default();
            let verb = if command == "applyStash" {
                "apply"
            } else {
                "pop"
            };
            Outcome::Status(
                check(&[("selector", Some(selector), Kind::Stash)]).and_then(|_| {
                    let mut args = vec!["stash", verb];
                    if bool_of("reinstateIndex") {
                        args.push("--index");
                    }
                    args.push(selector);
                    git.run(&args)
                }),
            )
        }
        "dropStash" => {
            let selector = str_of("selector").unwrap_or_default();
            Outcome::Status(
                check(&[("selector", Some(selector), Kind::Stash)])
                    .and_then(|_| git.run(&["stash", "drop", selector])),
            )
        }
        "branchFromStash" => {
            let selector = str_of("selector").unwrap_or_default();
            let branch = str_of("branchName").unwrap_or_default();
            match check(&[
                ("selector", Some(selector), Kind::Stash),
                ("branchName", Some(branch), Kind::Ref),
            ]) {
                Err(e) => Outcome::Status(Err(e)),
                Ok(()) => match loss_warning_if_detached(git, confirmed, None) {
                    Some(warning) => Outcome::Warning(warning),
                    None => Outcome::Status(git.run(&["stash", "branch", branch, selector])),
                },
            }
        }
        "pushStash" => {
            let mut args = vec!["stash", "push"];
            if bool_of("includeUntracked") {
                args.push("--include-untracked");
            }
            let text = str_of("message").unwrap_or_default();
            if !text.is_empty() {
                args.push("--message");
                args.push(text);
            }
            Outcome::Status(git.run(&args))
        }
        "worktreeAdd" => {
            let path = str_of("path").unwrap_or_default();
            let branch = str_of("branch");
            let new_branch = str_of("newBranch");
            Outcome::Status(
                check(&[
                    ("path", Some(path), Kind::Url),
                    ("branch", branch, Kind::Ref),
                    ("newBranch", new_branch, Kind::Ref),
                ])
                .and_then(|_| {
                    let mut args = vec!["worktree", "add"];
                    if let Some(new_branch) = new_branch {
                        args.extend(["-b", new_branch]);
                    }
                    args.push(path);
                    if let Some(branch) = branch {
                        args.push(branch);
                    }
                    git.run(&args)
                }),
            )
        }
        "worktreeRemove" => {
            let path = str_of("path").unwrap_or_default();
            Outcome::Status(check(&[("path", Some(path), Kind::Url)]).and_then(|_| {
                let mut args = vec!["worktree", "remove"];
                if bool_of("force") {
                    args.push("--force");
                }
                args.push(path);
                git.run(&args)
            }))
        }
        "worktreePrune" => Outcome::Status(git.run(&["worktree", "prune"])),
        "worktreeList" => {
            return Some(json!({ "command": "worktreeList", "worktrees": worktrees(git) }));
        }
        "reflog" => {
            let reference = str_of("ref").unwrap_or("HEAD");
            let limit = message.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            let mut response = reflog(git, reference, limit);
            response["command"] = json!("reflog");
            response["ref"] = json!(reference);
            return Some(response);
        }
        "predictConflicts" => {
            return Some(with_echo(
                json!({
                    "command": "predictConflicts",
                    "prediction": predict_conflicts(
                        git,
                        str_of("ours").unwrap_or_default(),
                        str_of("theirs").unwrap_or_default(),
                    )
                }),
                message,
                &["ours", "theirs"],
            ));
        }
        "gerritSetFetchRefs" => {
            let enabled = bool_of("enabled");
            let remote = str_of("gerritRemote")
                .or_else(|| str_of("remote"))
                .unwrap_or("origin")
                .to_owned();
            let mut response = json!({ "command": "gerritSetFetchRefs", "enabled": enabled, "cleared": 0, "error": null });
            if enabled {
                // Enabling marks the repository's Gerrit data stale: the very next load runs the
                // fetch pipeline (its response stays pending until the host's refresh lands).
                mark_gerrit_stale(&git.repo.display().to_string());
            } else {
                let (status, cleared) = gerrit_set_fetch_refs(git, &remote, enabled);
                response["cleared"] = json!(cleared);
                match status {
                    Ok(()) => {
                        // The change refs are gone: drop everything derived from them.
                        clear_gerrit_cache(&git.repo.display().to_string());
                    }
                    Err(error) => {
                        response["error"] = json!(error);
                    }
                }
            }
            return Some(response);
        }
        "createPullRequest" => {
            // The push half; the shell then opens the provider's "new pull request" page.
            let statuses = if bool_of("push") {
                match push_branch(
                    git,
                    str_of("sourceBranch").unwrap_or_default(),
                    str_of("sourceRemote").unwrap_or_default(),
                    true,
                    "",
                    true,
                ) {
                    Ok(status) => vec![status],
                    Err(warning) => vec![Err(warning)],
                }
            } else {
                vec![Ok(())]
            };
            return Some(with_echo(
                json!({ "command": "createPullRequest", "errors": errors_of(statuses) }),
                message,
                &["push"],
            ));
        }
        "createArchive" => {
            // The shell asked where to save (see graphHost.ts) and appended `outputFilePath`.
            let reference = str_of("ref").unwrap_or_default();
            let path = str_of("outputFilePath").unwrap_or_default();
            let kind = if path.to_ascii_lowercase().ends_with(".zip") {
                "zip"
            } else {
                "tar"
            };
            Outcome::Status(check(&[("ref", Some(reference), Kind::Ref)]).and_then(|_| {
                if path.is_empty() {
                    return Err("No file was chosen for the archive.".to_owned());
                }
                git.run(&[
                    "archive",
                    &format!("--format={kind}"),
                    "-o",
                    path,
                    reference,
                ])
            }))
        }
        _ => return None,
    };

    Some(match outcome {
        Outcome::Status(status) => json!({ "command": command, "error": error_of(status) }),
        Outcome::Statuses(statuses) => json!({ "command": command, "errors": errors_of(statuses) }),
        Outcome::Warning(warning) => loss_warning(message, warning),
    })
}

/// The `lossWarning` response: the view shows `message` and, if the user insists, re-sends
/// `retry` (the original request with `confirmed: true`).
fn loss_warning(request: &Value, warning: String) -> Value {
    let mut retry = request.clone();
    retry["confirmed"] = json!(true);
    json!({ "command": "lossWarning", "message": warning, "retry": retry })
}

/// Copy the request fields a response must echo (the view keys some responses by them).
fn with_echo(mut response: Value, request: &Value, keys: &[&str]) -> Value {
    for key in keys {
        if let Some(value) = request.get(key) {
            response[*key] = value.clone();
        }
    }
    response
}

fn error_of(status: Status) -> Value {
    match status {
        Ok(()) => Value::Null,
        Err(message) => json!(message),
    }
}

fn errors_of(statuses: Vec<Status>) -> Value {
    Value::Array(statuses.into_iter().map(error_of).collect())
}

/* ---------- Argument validation (src/utils.ts: isSafeRefName & co.) ---------- */

#[derive(Clone, Copy)]
enum Kind {
    Hash,
    Ref,
    Stash,
    Url,
}

/// Reject values that git would read as options (or that are not what the view claims), with
/// the extension's own wording. `None` values are skipped, like the extension's null checks.
fn check(checks: &[(&str, Option<&str>, Kind)]) -> Status {
    for (name, value, kind) in checks {
        let Some(value) = value else { continue };
        let (valid, what) = match kind {
            Kind::Hash => (is_valid_commit_hash(value), "commit hash"),
            Kind::Ref => (is_safe_ref_name(value), "reference name"),
            Kind::Stash => (is_safe_stash_selector(value), "stash selector"),
            Kind::Url => (!value.starts_with('-'), "URL"),
        };
        if !valid {
            return Err(format!("Invalid {what} was provided for \"{name}\""));
        }
    }
    Ok(())
}

pub fn is_valid_commit_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn is_safe_ref_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('-') || name.starts_with('.') {
        return false;
    }
    if name.ends_with('/') || name.ends_with('.') || name.ends_with(".lock") {
        return false;
    }
    if name.chars().any(|c| c.is_control()) {
        return false;
    }
    !["..", "@{", "\\", "^", ":", "?", "[", "*"]
        .iter()
        .any(|seq| name.contains(seq))
}

pub fn is_safe_stash_selector(selector: &str) -> bool {
    selector
        .strip_prefix("refs/stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .map(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

/* ---------- Data-loss warnings ---------- */

/// Commits reachable only from a detached HEAD: leaving them behind loses them (reflog aside).
fn count_detached_only_commits(git: &Git) -> usize {
    let stash_roots: Vec<String> = git
        .output(&["stash", "list", "--format=%H"])
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut args = vec![
        "rev-list",
        "HEAD",
        "--not",
        "--branches",
        "--tags",
        "--remotes",
    ];
    args.extend(stash_roots.iter().map(String::as_str));
    args.push("--count");
    git.output(&args)
        .ok()
        .and_then(|out| out.trim().parse().ok())
        .unwrap_or(0)
}

fn loss_warning_if_detached(
    git: &Git,
    confirmed: bool,
    anchored_at: Option<&str>,
) -> Option<String> {
    if confirmed {
        return None;
    }
    if let Some(anchor) = anchored_at {
        let head = git
            .output(&["rev-parse", "HEAD"])
            .map(|h| h.trim().to_owned())
            .unwrap_or_default();
        if !head.is_empty() && head == anchor {
            return None;
        }
    }
    let count = count_detached_only_commits(git);
    if count == 0 {
        return None;
    }
    Some(format!(
        "Data loss risk: HEAD is currently detached with {count} commit(s) that no branch, tag, \
         remote or stash keeps reachable. Switching now leaves them behind, recoverable from the \
         local reflog only until git gc prunes them. Create a branch at HEAD to keep them (a stash \
         made on them keeps them too)."
    ))
}

fn hard_reset_loss_warning(git: &Git) -> Option<String> {
    let dirty = git
        .output(&["status", "--porcelain"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false);
    dirty.then(|| {
        "Data loss risk: a hard reset discards all uncommitted changes in the working tree, and \
         they cannot be recovered — uncommitted contents are recorded in no reflog, and at most \
         previously staged versions might be found with git fsck."
            .to_owned()
    })
}

/* ---------- Operations ---------- */

fn abort_or_continue(git: &Git, operation: &str, flag: &str) -> Status {
    if !["merge", "rebase", "cherry-pick", "revert"].contains(&operation) {
        return Err(format!("Unknown operation \"{operation}\""));
    }
    git.run(&[operation, flag])
}

fn add_remote(
    git: &Git,
    name: &str,
    url: &str,
    push_url: Option<&str>,
    fetch_after: bool,
) -> Status {
    check(&[
        ("name", Some(name), Kind::Ref),
        ("url", Some(url), Kind::Url),
        ("pushUrl", push_url, Kind::Url),
    ])?;
    git.run(&["remote", "add", name, url])?;
    if let Some(push_url) = push_url {
        git.run(&["remote", "set-url", name, "--push", push_url])?;
    }
    if fetch_after {
        fetch(git, Some(name), false, false)?;
    }
    Ok(())
}

fn edit_remote(
    git: &Git,
    name_old: &str,
    name_new: &str,
    url_old: Option<&str>,
    url_new: Option<&str>,
    push_url_old: Option<&str>,
    push_url_new: Option<&str>,
) -> Status {
    check(&[
        ("nameOld", Some(name_old), Kind::Ref),
        ("nameNew", Some(name_new), Kind::Ref),
        ("urlOld", url_old, Kind::Url),
        ("urlNew", url_new, Kind::Url),
        ("pushUrlOld", push_url_old, Kind::Url),
        ("pushUrlNew", push_url_new, Kind::Url),
    ])?;
    if name_old != name_new {
        git.run(&["remote", "rename", name_old, name_new])?;
    }
    if url_old != url_new {
        let mut args = vec!["remote", "set-url", name_new];
        match (url_old, url_new) {
            (Some(old), None) => args.extend(["--delete", old]),
            (None, Some(new)) => args.extend(["--add", new]),
            (Some(old), Some(new)) => args.extend([new, old]),
            (None, None) => {}
        }
        git.run(&args)?;
    }
    if push_url_old != push_url_new {
        let mut args = vec!["remote", "set-url", "--push", name_new];
        match (push_url_old, push_url_new) {
            (Some(old), None) => args.extend(["--delete", old]),
            (None, Some(new)) => args.extend(["--add", new]),
            (Some(old), Some(new)) => args.extend([new, old]),
            (None, None) => {}
        }
        git.run(&args)?;
    }
    Ok(())
}

/// `TagType`: 0 = annotated, 1 = lightweight (src/types/git.ts).
fn add_tag(
    git: &Git,
    tag_name: &str,
    commit_hash: &str,
    kind: u64,
    message: &str,
    force: bool,
    settings: ActionSettings,
) -> Status {
    check(&[
        ("tagName", Some(tag_name), Kind::Ref),
        ("commitHash", Some(commit_hash), Kind::Hash),
    ])?;
    let mut args = vec!["tag"];
    if force {
        args.push("-f");
    }
    if kind == 1 {
        args.push(tag_name);
    } else {
        args.extend([
            if settings.sign_tags { "-s" } else { "-a" },
            tag_name,
            "-m",
            message,
        ]);
    }
    args.push(commit_hash);
    git.run(&args)
}

fn remotes(git: &Git) -> Vec<String> {
    git.output(&["remote"])
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn delete_tag(git: &Git, tag_name: &str, delete_on_remote: Option<&str>) -> Status {
    check(&[
        ("tagName", Some(tag_name), Kind::Ref),
        ("deleteOnRemote", delete_on_remote, Kind::Ref),
    ])?;
    if let Some(remote) = delete_on_remote {
        if let Err(status) = git.run(&["push", remote, "--delete", tag_name]) {
            if !status.contains("remote ref does not exist") {
                return Err(status);
            }
        }
        git.run_quietly(&[
            "update-ref",
            "-d",
            &format!("refs/remotes/{remote}/tags/{tag_name}"),
        ]);
    }
    let status = git.run(&["tag", "-d", tag_name]);
    for remote in remotes(git) {
        if Some(remote.as_str()) != delete_on_remote {
            git.run_quietly(&[
                "update-ref",
                "-d",
                &format!("refs/remotes/{remote}/tags/{tag_name}"),
            ]);
        }
    }
    match status {
        Err(text) if text.contains("not found") => Ok(()),
        other => other,
    }
}

/// The remotes (of `known`) with at least one remote-tracking branch containing `commit`.
fn remotes_containing_commit(
    git: &Git,
    commit: &str,
    known: &[String],
) -> Result<Vec<String>, String> {
    let out = git.output(&[
        "branch",
        "-r",
        "--no-color",
        &format!("--contains={commit}"),
    ])?;
    let branches: Vec<String> = out
        .lines()
        .filter(|line| line.len() > 2)
        .map(|line| line[2..].split(" -> ").next().unwrap_or("").to_owned())
        .collect();
    Ok(known
        .iter()
        .filter(|remote| {
            let prefix = format!("{remote}/");
            branches.iter().any(|b| b.starts_with(&prefix))
        })
        .cloned()
        .collect())
}

fn push_tag(
    git: &Git,
    tag_name: &str,
    remotes: &[String],
    commit_hash: &str,
    skip_remote_check: bool,
) -> Vec<Status> {
    if let Err(e) = check(&[
        ("tagName", Some(tag_name), Kind::Ref),
        ("commitHash", Some(commit_hash), Kind::Hash),
    ]) {
        return vec![Err(e)];
    }
    if remotes.is_empty() {
        return vec![Err(format!(
            "No remote(s) were specified to push the tag {tag_name} to."
        ))];
    }
    if remotes.iter().any(|r| !is_safe_ref_name(r)) {
        return vec![Err(
            "Invalid reference name was provided for \"remotes\"".to_owned()
        )];
    }
    if !skip_remote_check {
        let containing = remotes_containing_commit(git, commit_hash, remotes)
            .unwrap_or_else(|_| remotes.to_vec());
        let missing: Vec<&String> = remotes.iter().filter(|r| !containing.contains(r)).collect();
        if !missing.is_empty() {
            return vec![Err(format!(
                "{PUSH_TAG_COMMIT_NOT_ON_REMOTE}{}",
                serde_json::to_string(&missing).unwrap_or_default()
            ))];
        }
    }
    let mut results = Vec::new();
    for remote in remotes {
        let result = git.run(&["push", remote, tag_name]);
        let failed = result.is_err();
        results.push(result);
        if failed {
            break;
        }
    }
    results
}

pub(crate) fn fetch(git: &Git, remote: Option<&str>, prune: bool, prune_tags: bool) -> Status {
    check(&[("remote", remote, Kind::Ref)])?;
    let mut args = vec!["fetch", remote.unwrap_or("--all")];
    if prune {
        args.push("--prune");
    }
    if prune_tags {
        if !prune {
            return Err("In order to Prune Tags, pruning must also be enabled when fetching from remote(s).".to_owned());
        }
        args.push("--prune-tags");
    }
    git.run(&args)
}

fn current_branch(git: &Git) -> Option<String> {
    git.output(&["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

fn fetch_into_local_branch(
    git: &Git,
    remote: &str,
    remote_branch: &str,
    local_branch: &str,
    force: bool,
) -> Status {
    check(&[
        ("remote", Some(remote), Kind::Ref),
        ("remoteBranch", Some(remote_branch), Kind::Ref),
        ("localBranch", Some(local_branch), Kind::Ref),
    ])?;
    if current_branch(git).as_deref() == Some(local_branch) {
        if !force {
            return git.run(&["pull", remote, remote_branch]);
        }
        git.run(&["fetch", remote, remote_branch])?;
        return git.run(&["reset", "--hard", &format!("{remote}/{remote_branch}")]);
    }
    let mut args = vec!["fetch"];
    if force {
        args.push("-f");
    }
    let refspec = format!("{remote_branch}:{local_branch}");
    args.extend([remote, &refspec]);
    git.run(&args)
}

/// `Err(warning)` when a force push still needs confirming; `Ok(status)` otherwise.
fn push_branch(
    git: &Git,
    branch: &str,
    remote: &str,
    set_upstream: bool,
    mode: &str,
    confirmed: bool,
) -> Result<Status, String> {
    if let Err(e) = check(&[
        ("branchName", Some(branch), Kind::Ref),
        ("remote", Some(remote), Kind::Ref),
    ]) {
        return Ok(Err(e));
    }
    if mode == "force" && !confirmed {
        return Err(format!(
            "Data loss risk: force pushing \"{branch}\" rewrites the branch's history on \"{remote}\"; \
             commits the remote has that this push does not contain become unreachable there. Whether \
             they can be recovered depends on the remote — hosted services usually only keep them \
             accessible by hash, for a while."
        ));
    }
    let mut args = vec!["push", remote, branch];
    if set_upstream {
        args.push("--set-upstream");
    }
    // `GitPushBranchMode`: "" (normal), "force" or "force-with-lease".
    let mode_flag = format!("--{mode}");
    if !mode.is_empty() {
        args.push(&mode_flag);
    }
    Ok(git.run(&args))
}

fn push_branch_to_remotes(
    git: &Git,
    branch: &str,
    remotes: &[String],
    set_upstream: bool,
    mode: &str,
    confirmed: bool,
) -> Result<Vec<Status>, String> {
    if remotes.is_empty() {
        return Ok(vec![Err(format!(
            "No remote(s) were specified to push the branch {branch} to."
        ))]);
    }
    let mut results = Vec::new();
    for remote in remotes {
        let result = push_branch(git, branch, remote, set_upstream, mode, confirmed)?;
        let failed = result.is_err();
        results.push(result);
        if failed {
            break;
        }
    }
    Ok(results)
}

fn staged_changes_exist(git: &Git) -> bool {
    git.output(&["diff-index", "HEAD"])
        .map(|out| !out.is_empty())
        .unwrap_or(false)
}

/// After a `--squash` merge/pull: commit what was staged, with the extension's default message
/// or git's own SQUASH_MSG (`--no-edit`).
fn commit_squash_if_staged(
    git: &Git,
    obj: &str,
    action_on: &str,
    format: u8,
    sign: bool,
) -> Status {
    if !staged_changes_exist(git) {
        return Ok(());
    }
    let mut args = vec!["commit"];
    if sign {
        args.push("-S");
    }
    let message = format!("Merge {} '{obj}'", action_on.to_lowercase());
    if format == 0 {
        args.extend(["-m", &message]);
    } else {
        args.push("--no-edit");
    }
    git.run(&args)
}

fn pull_branch(
    git: &Git,
    branch: &str,
    remote: &str,
    create_new_commit: bool,
    squash: bool,
    settings: ActionSettings,
) -> Status {
    check(&[
        ("branchName", Some(branch), Kind::Ref),
        ("remote", Some(remote), Kind::Ref),
    ])?;
    let mut args = vec!["pull", remote, branch];
    if squash {
        args.push("--squash");
    } else if create_new_commit {
        args.push("--no-ff");
    }
    if settings.sign_commits {
        args.push("-S");
    }
    git.run(&args)?;
    if squash {
        commit_squash_if_staged(
            git,
            &format!("{remote}/{branch}"),
            "Branch",
            settings.squash_pull_message_format,
            settings.sign_commits,
        )?;
    }
    Ok(())
}

fn checkout_branch(
    git: &Git,
    branch: &str,
    remote_branch: Option<&str>,
    confirmed: bool,
) -> Result<Status, String> {
    if let Err(e) = check(&[
        ("branchName", Some(branch), Kind::Ref),
        ("remoteBranch", remote_branch, Kind::Ref),
    ]) {
        return Ok(Err(e));
    }
    if let Some(warning) = loss_warning_if_detached(git, confirmed, None) {
        return Err(warning);
    }
    Ok(match remote_branch {
        None => git.run(&["checkout", branch]),
        Some(remote_branch) => git.run(&["checkout", "-b", branch, remote_branch]),
    })
}

fn create_branch(
    git: &Git,
    branch: &str,
    commit_hash: &str,
    checkout: bool,
    force: bool,
    confirmed: bool,
) -> Result<Vec<Status>, String> {
    if let Err(e) = check(&[
        ("branchName", Some(branch), Kind::Ref),
        ("commitHash", Some(commit_hash), Kind::Hash),
    ]) {
        return Ok(vec![Err(e)]);
    }
    if checkout {
        if let Some(warning) = loss_warning_if_detached(git, confirmed, Some(commit_hash)) {
            return Err(warning);
        }
    }
    let mut args = Vec::new();
    if checkout && !force {
        args.extend(["checkout", "-b"]);
    } else {
        args.push("branch");
        if force {
            args.push("-f");
        }
    }
    args.extend([branch, commit_hash]);
    let mut statuses = vec![git.run(&args)];
    if statuses[0].is_ok() && checkout && force {
        statuses.push(checkout_branch(git, branch, None, true)?);
    }
    Ok(statuses)
}

fn delete_remote_branch(git: &Git, branch: &str, remote: &str) -> Status {
    check(&[
        ("branchName", Some(branch), Kind::Ref),
        ("remote", Some(remote), Kind::Ref),
    ])?;
    match git.run(&["push", remote, "--delete", branch]) {
        Err(status) if status.to_lowercase().contains("remote ref does not exist") => {
            let tracking = format!("{remote}/{branch}");
            git.run(&["branch", "-d", "-r", &tracking]).map_err(|e| {
                format!("Branch does not exist on the remote, deleting the remote tracking branch {tracking}.\n{e}")
            })
        }
        other => other,
    }
}

fn merge(
    git: &Git,
    obj: &str,
    action_on: &str,
    create_new_commit: bool,
    squash: bool,
    no_commit: bool,
    settings: ActionSettings,
) -> Status {
    let kind = if action_on == "Commit" {
        Kind::Hash
    } else {
        Kind::Ref
    };
    check(&[("obj", Some(obj), kind)])?;
    let mut args = vec!["merge", obj];
    if squash {
        args.push("--squash");
    } else if create_new_commit {
        args.push("--no-ff");
    }
    if no_commit {
        args.push("--no-commit");
    }
    if settings.sign_commits {
        args.push("-S");
    }
    git.run(&args)?;
    if squash && !no_commit {
        commit_squash_if_staged(
            git,
            obj,
            action_on,
            settings.squash_merge_message_format,
            settings.sign_commits,
        )?;
    }
    Ok(())
}

/// Reword a commit. HEAD is amended in place; an older commit of the current branch is reworded
/// through an "amend!" commit folded in by an autosquashing rebase (git 2.32+) — the very
/// commit `git commit --fixup=reword:<hash>` would create, built directly so the new message
/// can be passed instead of typed into an editor. `Git` disables both editors, so nothing here
/// can hang a GUI app.
fn edit_commit_message(git: &Git, hash: &str, message: &str, settings: ActionSettings) -> Status {
    check(&[("commitHash", Some(hash), Kind::Hash)])?;
    let head = git.output(&["rev-parse", "HEAD"])?.trim().to_owned();
    if head == hash || head.starts_with(hash) {
        let mut args = vec!["commit", "--amend", "-m", message];
        if settings.sign_commits {
            args.push("-S");
        }
        return git.run(&args);
    }
    if git
        .run(&["merge-base", "--is-ancestor", hash, "HEAD"])
        .is_err()
    {
        return Err(
            "Only commits in the current branch's history can have their message edited. \
                    Checkout a branch containing this commit and try again."
                .to_owned(),
        );
    }
    let parents: Vec<String> = git
        .output(&["rev-list", "--parents", "-n", "1", hash])?
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    if parents.len() > 2 {
        return Err("The commit message of a merge commit cannot be edited.".to_owned());
    }
    let known = remotes(git);
    let containing = remotes_containing_commit(git, hash, &known).unwrap_or_default();
    if !containing.is_empty() {
        return Err(format!(
            "This commit has already been pushed to the following remotes and can therefore not be edited: {}",
            containing.join(", ")
        ));
    }

    // The reword is staged as an "amend!" commit carrying the new message, then folded in. The
    // hash form of the subject pins the target exactly (autosquash also matches by hash).
    let amend_subject = format!("amend! {hash}");
    let mut args = vec![
        "commit",
        "--allow-empty",
        "-m",
        &amend_subject,
        "-m",
        message,
    ];
    if settings.sign_commits {
        args.push("-S");
    }
    git.run(&args)?;
    let base = format!("{hash}^");
    let mut rebase = vec!["rebase", "--autosquash", "--autostash", "--interactive"];
    if parents.len() == 1 {
        rebase.push("--root");
    } else {
        rebase.push(&base);
    }
    if let Err(e) = git.run(&rebase) {
        git.run_quietly(&["rebase", "--abort"]);
        // Drop the staged "amend!" commit again so the branch is exactly as before.
        git.run_quietly(&["reset", "--soft", "HEAD^"]);
        return Err(e);
    }
    Ok(())
}

/// Enabling only records the choice (the view passes `gerritFetchRefs` with each load, and the
/// fetch refspec rides along the load); disabling deletes the locally cached change refs.
/// Returns the status and the number of refs deleted.
fn gerrit_set_fetch_refs(git: &Git, remote: &str, enabled: bool) -> (Status, usize) {
    if enabled {
        return (Ok(()), 0);
    }
    if let Err(e) = check(&[("remote", Some(remote), Kind::Ref)]) {
        return (Err(e), 0);
    }
    let prefix = format!("refs/remotes/{remote}/changes/");
    let refs: Vec<String> = match git.output(&["for-each-ref", "--format=%(refname)", &prefix]) {
        Ok(out) => out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect(),
        Err(e) => return (Err(e), 0),
    };
    let mut cleared = 0;
    for reference in &refs {
        match git.run(&["update-ref", "-d", reference]) {
            Ok(()) => cleared += 1,
            Err(e) => return (Err(e), cleared),
        }
    }
    (Ok(()), cleared)
}

/* ---------- Reads served through the CLI ---------- */

/// `GitOperationState`: which of merge/rebase/cherry-pick/revert is in progress, from the
/// marker files git keeps in the git dir, plus the conflicted paths.
pub fn operation_state(git: &Git) -> Value {
    let none = json!({ "type": null, "conflictedFiles": [], "progress": null });
    let Ok(git_dir) = git.git_dir() else {
        return none;
    };
    let read_number = |path: &Path| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok())
    };
    let progress = |step: &Path, total: &Path| match (read_number(step), read_number(total)) {
        (Some(step), Some(total)) => json!({ "step": step, "total": total }),
        _ => Value::Null,
    };
    let (kind, progress) = if git_dir.join("rebase-merge").is_dir() {
        let dir = git_dir.join("rebase-merge");
        ("rebase", progress(&dir.join("msgnum"), &dir.join("end")))
    } else if git_dir.join("rebase-apply").is_dir() {
        let dir = git_dir.join("rebase-apply");
        ("rebase", progress(&dir.join("next"), &dir.join("last")))
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        ("cherry-pick", Value::Null)
    } else if git_dir.join("REVERT_HEAD").exists() {
        ("revert", Value::Null)
    } else if git_dir.join("MERGE_HEAD").exists() {
        ("merge", Value::Null)
    } else {
        return none;
    };
    let conflicted: Vec<String> = git
        .output(&["diff", "--name-only", "--diff-filter=U"])
        .map(|out| {
            out.lines()
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    json!({ "type": kind, "conflictedFiles": conflicted, "progress": progress })
}

fn worktrees(git: &Git) -> Value {
    let Ok(out) = git.output(&["worktree", "list", "--porcelain"]) else {
        return json!([]);
    };
    let mut list: Vec<Value> = Vec::new();
    let mut current: Option<Value> = None;
    let flush = |current: &mut Option<Value>, list: &mut Vec<Value>| {
        if let Some(mut entry) = current.take() {
            entry["isMain"] = json!(list.is_empty());
            list.push(entry);
        }
    };
    for line in out.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut current, &mut list);
            current = Some(
                json!({ "path": path, "hash": "", "branch": null, "detached": false, "locked": false, "prunable": false }),
            );
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(hash) = line.strip_prefix("HEAD ") {
            entry["hash"] = json!(hash);
        } else if let Some(reference) = line.strip_prefix("branch ") {
            entry["branch"] = json!(reference.strip_prefix("refs/heads/").unwrap_or(reference));
        } else if line == "detached" {
            entry["detached"] = json!(true);
        } else if line == "locked" || line.starts_with("locked ") {
            entry["locked"] = json!(true);
        } else if line == "prunable" || line.starts_with("prunable ") {
            entry["prunable"] = json!(true);
        }
    }
    flush(&mut current, &mut list);
    Value::Array(list)
}

fn reflog(git: &Git, reference: &str, limit: usize) -> Value {
    if let Err(e) = check(&[("ref", Some(reference), Kind::Ref)]) {
        return json!({ "entries": [], "moreAvailable": false, "error": e });
    }
    let count = (limit + 1).to_string();
    let out = match git.output(&[
        "reflog",
        "show",
        reference,
        "--format=%H\x1f%h\x1f%gd\x1f%gs",
        "--date=unix",
        "-n",
        &count,
    ]) {
        Ok(out) => out,
        Err(e) => return json!({ "entries": [], "moreAvailable": false, "error": e }),
    };
    let mut lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
    let more_available = lines.len() > limit;
    lines.truncate(limit);

    struct Entry {
        hash: String,
        abbrev: String,
        date: u64,
        message: String,
    }
    let parsed: Vec<Entry> = lines
        .iter()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() != 4 {
                return None;
            }
            let date = parts[2]
                .rsplit_once('{')
                .and_then(|(_, rest)| rest.strip_suffix('}'))
                .and_then(|d| d.parse::<u64>().ok())?;
            Some(Entry {
                hash: parts[0].to_owned(),
                abbrev: parts[1].to_owned(),
                date,
                message: parts[3].to_owned(),
            })
        })
        .collect();

    // Entries whose commit has since been pruned are flagged as dangling.
    let mut unique: Vec<&str> = Vec::new();
    for entry in &parsed {
        if !unique.contains(&entry.hash.as_str()) {
            unique.push(&entry.hash);
        }
    }
    let mut dangling = std::collections::HashSet::new();
    if !unique.is_empty() {
        let input = format!("{}\n", unique.join("\n"));
        if let Ok(out) = git.output_with_input(&["cat-file", "--batch-check"], &input) {
            for line in out.lines() {
                if let Some((hash, rest)) = line.split_once(' ') {
                    if rest.starts_with("missing") {
                        dangling.insert(hash.to_owned());
                    }
                }
            }
        }
    }

    let entries: Vec<Value> = parsed
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            json!({
                "hash": entry.hash,
                "abbrevHash": entry.abbrev,
                "selector": format!("{reference}@{{{index}}}"),
                "date": entry.date,
                "message": entry.message,
                "dangling": dangling.contains(&entry.hash)
            })
        })
        .collect();
    json!({ "entries": entries, "moreAvailable": more_available, "error": null })
}

/// `git merge-tree --write-tree` (git 2.40+) predicts a merge without touching the worktree.
/// `null` when the prediction cannot be made (older git).
fn predict_conflicts(git: &Git, ours: &str, theirs: &str) -> Value {
    if check(&[
        ("ours", Some(ours), Kind::Ref),
        ("theirs", Some(theirs), Kind::Ref),
    ])
    .is_err()
    {
        return Value::Null;
    }
    let output = match git
        .command()
        .args(["merge-tree", "--write-tree", ours, theirs])
        .output()
    {
        Ok(output) => output,
        Err(_) => return Value::Null,
    };
    match output.status.code() {
        Some(0) => json!({ "conflicted": false, "files": [] }),
        Some(1) => {
            // The conflicted-file lines have the fixed shape `<mode> <oid> <stage>	<path>`
            // (up to three per path, one per stage); the free-text messages after them cannot
            // match it, so the section boundaries need not be relied upon.
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut files: Vec<String> = Vec::new();
            for line in stdout.lines() {
                let Some((info, path)) = line.split_once('\t') else {
                    continue;
                };
                let parts: Vec<&str> = info.split(' ').collect();
                let shaped = parts.len() == 3
                    && parts[0].len() == 6
                    && parts[0].chars().all(|c| ('0'..='7').contains(&c))
                    && parts[1].chars().all(|c| c.is_ascii_hexdigit())
                    && matches!(parts[2], "1" | "2" | "3");
                if shaped && !files.iter().any(|f| f == path) {
                    files.push(path.to_owned());
                }
            }
            if files.is_empty() {
                Value::Null
            } else {
                json!({ "conflicted": true, "files": files })
            }
        }
        _ => Value::Null,
    }
}

#[cfg(test)]
mod write_tests;

#[cfg(test)]
mod gerrit_tests {
    use super::*;

    /// A scratch repository whose `origin` is a bare remote playing a Gerrit server: one change
    /// with two patchsets, its NoteDb `meta` chain recording the creation and a Code-Review +2
    /// on the second patchset — everything the refresh pipeline must discover on its own.
    fn gerrit_repo(name: &str, change: u64) -> (crate::test_support::Scratch, Git, String) {
        let scratch = crate::test_support::Scratch::new(name);
        let server = scratch.bare("server.git");
        let git = scratch.repo("repo");
        git.run(&["remote", "add", "origin", &server.display().to_string()])
            .unwrap();

        let ps1 = crate::test_support::commit(&git, "a.txt", "v1\n", "patchset 1");
        let ps2 = crate::test_support::commit(&git, "a.txt", "v2\n", "patchset 2");
        let meta1 = crate::test_support::commit(
            &git,
            "meta.txt",
            "1\n",
            &format!("Create change\n\nPatch-set: 1\nCommit: {ps1}\nStatus: new\n"),
        );
        let meta2 = crate::test_support::commit(
            &git,
            "meta.txt",
            "2\n",
            &format!("Patch Set 2: Code-Review+2\n\nPatch-set: 2\nCommit: {ps2}\nLabel: Code-Review=+2\n"),
        );
        assert_ne!(meta1, meta2);
        let shard = gerrit_change_shard(change);
        git.run(&[
            "push",
            "-q",
            "origin",
            &format!("{ps1}:refs/changes/{shard}/{change}/1"),
            &format!("{ps2}:refs/changes/{shard}/{change}/2"),
            &format!("{meta2}:refs/changes/{shard}/{change}/meta"),
        ])
        .unwrap();
        (scratch, git, ps2)
    }

    fn load_commits(root: &str) -> Value {
        handle_repo_request(
            root,
            &json!({
                "command": "loadCommits", "repo": root, "maxCommits": 300, "showTags": true,
                "showRemoteBranches": true, "gerritFetchRefs": true, "gerritFetchLimit": 20,
                "gerritStatusFilter": { "new": true, "merged": true, "abandoned": true, "wip": true }
            }),
            ActionSettings::default(),
        )
        .unwrap()
    }

    #[test]
    fn the_refresh_pipeline_fetches_and_parses_the_remote_changes() {
        let (_scratch, git, ps2) = gerrit_repo("gerrit-refresh", 41466);
        let root = git.repo.display().to_string();

        // The first load of a just-enabled repository: nothing is fetched yet, so it pends.
        let first = load_commits(&root);
        assert_eq!(first["error"], json!(null));
        assert_eq!(first["gerritPending"], json!(true));
        assert_eq!(first["gerritStates"], json!(null));

        // The host's follow-up refresh: ls-remote, the targeted fetch, the NoteDb parse.
        let refresh = handle_repo_request(
            &root,
            &json!({ "command": "gerritRefresh", "repo": root, "gerritRemote": "origin", "gerritFetchLimit": 20 }),
            ActionSettings::default(),
        )
        .unwrap();
        assert_eq!(refresh["error"], json!(null));
        assert_eq!(refresh["refreshed"], json!(true));
        assert_eq!(refresh["changes"], json!(1));

        // The reloaded page carries the parsed state and its change commit, and no longer pends.
        let second = load_commits(&root);
        assert_eq!(second.get("gerritPending"), None);
        let states = second["gerritStates"].as_array().unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0]["change"], json!(41466));
        assert_eq!(states[0]["patchset"], json!(2));
        assert_eq!(states[0]["codeReview"], json!(2));
        assert_eq!(states[0]["status"], json!("new"));
        assert_eq!(states[0]["headHash"], json!(ps2));
        let hashes: Vec<&str> = second["commits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|commit| commit["hash"].as_str().unwrap())
            .collect();
        assert!(hashes.contains(&ps2.as_str()));
    }

    #[test]
    fn an_unreachable_remote_keeps_the_locally_cached_states() {
        let (_scratch, git, _ps2) = gerrit_repo("gerrit-unreachable", 41466);
        let root = git.repo.display().to_string();
        handle_repo_request(
            &root,
            &json!({ "command": "gerritRefresh", "repo": root, "gerritRemote": "origin", "gerritFetchLimit": 20 }),
            ActionSettings::default(),
        )
        .unwrap();

        // The remote loses its change refs: ls-remote answers nothing while local change refs
        // exist — the remote is treated as unreachable, the cached data stays.
        let shard = gerrit_change_shard(41466);
        git.run(&[
            "push",
            "-q",
            "origin",
            "--delete",
            &format!("refs/changes/{shard}/41466/1"),
            &format!("refs/changes/{shard}/41466/2"),
            &format!("refs/changes/{shard}/41466/meta"),
        ])
        .unwrap();
        let refresh = handle_repo_request(
            &root,
            &json!({ "command": "gerritRefresh", "repo": root, "gerritRemote": "origin", "gerritFetchLimit": 20 }),
            ActionSettings::default(),
        )
        .unwrap();
        assert_eq!(refresh["error"], json!(null));
        assert_eq!(refresh["refreshed"], json!(false));
        assert_eq!(refresh["changes"], json!(1));

        // The next load still serves the cached states.
        let load = load_commits(&root);
        assert_eq!(load["error"], json!(null));
        assert_eq!(load["gerritStates"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn enabling_pends_and_disabling_deletes_the_fetched_refs() {
        let (_scratch, git, _ps2) = gerrit_repo("gerrit-toggle", 41466);
        let root = git.repo.display().to_string();

        let enable = handle_repo_request(
            &root,
            &json!({ "command": "gerritSetFetchRefs", "repo": root, "enabled": true, "gerritRemote": "origin" }),
            ActionSettings::default(),
        )
        .unwrap();
        assert_eq!(enable["error"], json!(null));
        assert_eq!(load_commits(&root)["gerritPending"], json!(true));

        handle_repo_request(
            &root,
            &json!({ "command": "gerritRefresh", "repo": root, "gerritRemote": "origin", "gerritFetchLimit": 20 }),
            ActionSettings::default(),
        )
        .unwrap();
        let disable = handle_repo_request(
            &root,
            &json!({ "command": "gerritSetFetchRefs", "repo": root, "enabled": false, "gerritRemote": "origin" }),
            ActionSettings::default(),
        )
        .unwrap();
        assert_eq!(disable["error"], json!(null));
        assert_eq!(disable["enabled"], json!(false));
        assert!(disable["cleared"].as_u64().unwrap() >= 2);
        assert!(git
            .output(&[
                "rev-parse",
                "--verify",
                "-q",
                "refs/remotes/origin/changes/66/41466/meta"
            ])
            .is_err());
    }

    #[test]
    fn change_refs_are_parsed_from_every_form() {
        assert_eq!(
            gerrit_parse_change_ref("refs/changes/66/41466/2"),
            Some((41466, Some(2)))
        );
        assert_eq!(
            gerrit_parse_change_ref("refs/remotes/origin/changes/05/5/meta"),
            Some((5, None))
        );
        assert_eq!(gerrit_parse_change_ref("refs/heads/main"), None);
        assert_eq!(gerrit_parse_change_ref("refs/changes/66/41466"), None);
    }

    #[test]
    fn ls_remote_output_becomes_changes_with_sorted_patchsets() {
        let changes = gerrit_parse_ls_remote(
            "hash\trefs/changes/66/41466/2\nhash2\trefs/changes/66/41466/1\nhash3\trefs/changes/66/41466/meta\nhash4\trefs/heads/main\n",
        );
        assert_eq!(changes.get(&41466).unwrap(), &vec![1, 2]);
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn remote_urls_derive_the_change_link_base() {
        assert_eq!(
            gerrit_url_base("https://user@gerrit.example.com:8443/a/project/repo.git").as_deref(),
            Some("https://gerrit.example.com:8443/c/project/repo/+/")
        );
        assert_eq!(
            gerrit_url_base("ssh://gerrit.example.com:29418/project/repo").as_deref(),
            Some("http://gerrit.example.com/c/project/repo/+/")
        );
        assert_eq!(
            gerrit_url_base("gerrit.example.com:project/repo").as_deref(),
            Some("http://gerrit.example.com/c/project/repo/+/")
        );
        assert_eq!(gerrit_url_base("D:/repos/repo"), None);
        assert_eq!(gerrit_url_base("https://gerrit.example.com"), None);
    }

    #[test]
    fn the_sample_window_deepens_until_the_limit_is_filled() {
        assert_eq!(gerrit_next_sample_window(80, 20, 20, 1000), None); // enough pass already
        assert_eq!(gerrit_next_sample_window(80, 5, 20, 1000), Some(160));
        assert_eq!(gerrit_next_sample_window(80, 5, 20, 90), Some(90)); // the remote's end
        assert_eq!(gerrit_next_sample_window(320, 5, 20, 1000), None); // the ×16 cap
    }

    #[test]
    fn fetch_refspecs_are_chunked_inside_the_command_line_budget() {
        let refspecs: Vec<String> = (0..300)
            .map(|patchset| {
                format!("+refs/changes/01/1/{patchset}:refs/remotes/origin/changes/01/1/{patchset}")
            })
            .collect();
        let batches = gerrit_chunk_refspecs(&refspecs);
        assert!(batches.len() >= 2);
        assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), 300);
    }

    #[test]
    fn the_fetch_limit_falls_back_to_the_extension_default() {
        assert_eq!(gerrit_fetch_limit(&json!({})), 20);
        assert_eq!(gerrit_fetch_limit(&json!({ "gerritFetchLimit": 50 })), 50);
        assert_eq!(gerrit_fetch_limit(&json!({ "gerritFetchLimit": 0 })), 20);
        assert_eq!(
            gerrit_fetch_limit(&json!({ "gerritFetchLimit": 10001 })),
            20
        );
    }
}
