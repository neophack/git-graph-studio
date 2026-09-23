//! The engine half of the Git Graph view: every read that touches `git-graph-core` directly,
//! plus the handful of reads that legitimately go through the `git` CLI (working-tree config,
//! the rebase/merge/cherry-pick operation state) exactly as the extension's own data source
//! reads them. A module of `git-graph-backend` (the plugin's own binary) — the app never
//! links `git-graph-core` and never names this file.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use git_graph_core::types::{GerritChangeState, LogOptions};
use git_graph_core::{config, details, diff, graph, log, stats, RepoManager};

use git_graph_studio_lib::git::Git;

use crate::gerrit::GerritStatusFilter;

/* ---------- The shared wire helpers (the app's cmd_graph.rs used to own them) ---------- */

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

/// Only this module's read dispatch parses list-shaped request fields this way.
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

/* ---------- The always-present wrappers' real implementations ---------- */

pub fn engine_version() -> &'static str {
    git_graph_core::VERSION
}

/// The roots of the repository's initialised submodules (absolute paths) — the view page's
/// repository dropdown asks for them alongside the open repository.
pub fn submodule_roots(repo_path: &str) -> Vec<String> {
    RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)
        .and_then(|repo| config::submodules(&repo).map_err(|e| e.message))
        .unwrap_or_default()
}

/// A file's raw bytes at one revision (`:index` reads the staged copy): `Ok(None)` when the
/// path does not exist there. The compare pages' hex machinery reads revision sides through
/// this — binary content included, undecoded.
pub fn revision_file_bytes(
    repo_path: &str,
    revision: &str,
    file_path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    if revision == ":index" {
        git_graph_core::blob::index_file_bytes(&repo, file_path).map_err(|e| e.message)
    } else {
        git_graph_core::blob::commit_file_bytes(&repo, revision, file_path).map_err(|e| e.message)
    }
}

pub fn close_engine_repos() {
    drop_warm_responses();
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
    RepoManager::global().close_all();
}

/// Drop the caches a write invalidates for one repository (refs, HEAD or the working tree may
/// have changed): the warm launch answers and the engine's own warm handle. Distinct from
/// [`close_engine_repos`] (a folder close/switch), which also clears every repository's Gerrit
/// cache — a write does not make Gerrit data stale, only its own repository's warm state.
pub fn close_after_write(repo_path: &str) {
    drop_warm_responses();
    RepoManager::global().close(repo_path);
}

/* ---------- The graph view's read dispatch ---------- */

/// Every read-only message the Git Graph view can send, once the write dispatch
/// (`cmd_graph::handle`) and the two special-cased host-only commands
/// (`openExternalDirDiff`, `gerritRefresh`) have already been ruled out.
pub fn engine_read(
    repo_path: &str,
    command: &str,
    message: &Value,
    git: &Git,
) -> Result<Value, String> {
    let open = || RepoManager::global().get(repo_path).map_err(|e| e.message);

    match command {
        "loadRepoInfo" | "loadCommits" => {
            // The launch warm-up computed these two with the view's default options before
            // the window existed; a first request with the same options takes that answer.
            let mut response = match take_warm_response(repo_path, command, message) {
                Some(warm) => warm,
                None => {
                    let repo = open()?;
                    if command == "loadRepoInfo" {
                        repo_info_response(&repo, git, message)?
                    } else {
                        load_commits_response(repo_path, &repo, message)?
                    }
                }
            };
            response["refreshId"] = message.get("refreshId").cloned().unwrap_or(json!(0));
            Ok(response)
        }
        "loadConfig" => {
            let repo = open()?;
            let snapshot = config::read_config(&repo).map_err(|e| e.message)?;
            Ok(json!({
                "command": "loadConfig", "repo": repo_path,
                "config": view_config(git, &snapshot), "error": null
            }))
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
            Ok(
                json!({ "command": "getCommitComparison", "fileChanges": file_changes, "error": null }),
            )
        }
        "getCommitSummaries" => {
            let repo = open()?;
            let hashes = string_list(message.get("commitHashes"))
                .into_iter()
                .filter(|hash| !hash.is_empty() && hash != git_graph_core::types::UNCOMMITTED)
                .collect::<Vec<_>>();
            let summaries = details::commit_summaries(&repo, &hashes).map_err(|e| e.message)?;
            Ok(json!({ "command": "getCommitSummaries", "summaries": summaries, "error": null }))
        }
        "getCommitFileDiff" => {
            // The same `git diff` the extension's data source runs for the comparison view (the
            // working tree stands in for the to-side when it is the uncommitted sentinel). A
            // host-side git-CLI read, not an engine one — kept beside the rest of the dispatch
            // since it answers the same `RequestMessage` the view sends.
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
        // The "Uncommitted Changes" row's count, asked for on its own: a load pipeline that
        // deferred the row (see `log_options_from_request`) delivers its first page without the
        // working-tree scan and completes the row from this answer afterwards - the scan is the
        // better part of the load time on a large working tree.
        "countUncommittedChanges" => {
            let repo = open()?;
            let include_untracked = message
                .get("includeUntracked")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let count = git_graph_core::status::count_changes(&repo, include_untracked)
                .map_err(|e| e.message)?;
            Ok(json!({ "command": "countUncommittedChanges", "count": count, "error": null }))
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
                Ok(details) => json!({
                    "command": "tagDetails", "tagName": tag_name, "commitHash": commit_hash,
                    "details": details, "error": null
                }),
                Err(e) => json!({
                    "command": "tagDetails", "tagName": tag_name, "commitHash": commit_hash,
                    "details": null, "error": e.message
                }),
            })
        }
        "repoStatistics" => {
            let repo = open()?;
            let authors = stats::author_stats(&repo).map_err(|e| e.message)?;
            let activity = stats::activity_heatmap(&repo).map_err(|e| e.message)?;
            Ok(json!({ "command": "repoStatistics", "authors": authors, "activity": activity }))
        }
        _ => Ok(error_response(
            command,
            &format!("Git Graph Studio does not support the \"{command}\" request."),
            message,
        )),
    }
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
        let filter = crate::gerrit::gerrit_status_filter(message);
        let fetch_limit = crate::gerrit::gerrit_fetch_limit(message);
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
    if options.defer_uncommitted_changes {
        // The response deliberately carries no "Uncommitted Changes" row: the caller asked for
        // the page without the working-tree scan and completes the row from
        // `countUncommittedChanges` - the flag tells the view to keep whatever row it already
        // rendered until that count arrives (the same protocol the extension host used).
        response["uncommittedPending"] = json!(true);
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
        // The deferred uncommitted scan is what the view's first request asks for (graphHost.ts
        // injects the flag): the warm page must be built under the same options, or its key
        // stops matching and the view pays the cold load anyway.
        json!({ "command": "loadCommits", "maxCommits": 300, "showTags": true, "showRemoteBranches": true, "remotes": remotes, "deferUncommittedChanges": true }),
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
static WARM_RESPONSES: Mutex<Vec<WarmResponse>> = Mutex::new(Vec::new());

pub fn take_warm_response(repo_path: &str, command: &str, message: &Value) -> Option<Value> {
    let key = request_key(message);
    let mut warm = WARM_RESPONSES.lock().unwrap_or_else(|p| p.into_inner());
    let at = warm
        .iter()
        .position(|w| w.repo == repo_path && w.request["command"] == command && w.request == key)?;
    Some(warm.remove(at).response)
}

pub fn drop_warm_responses() {
    WARM_RESPONSES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

/// Translate a `loadCommits` request into the engine's `LogOptions`.
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
        defer_uncommitted_changes: bool_of("deferUncommittedChanges", false),
        show_uncommitted_changes: bool_of("showUncommittedChanges", true),
        show_untracked_files: bool_of("showUntrackedFiles", true),
        show_commits_only_referenced_by_tags: false,
        use_mailmap: false,
    }
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

/// What merge/rebase/cherry-pick/revert operation is in progress, and its conflicted files and
/// progress — a host-side git-CLI read of the plumbing files under `.git/` (rebase-merge,
/// CHERRY_PICK_HEAD, …), not an engine one.
fn operation_state(git: &Git) -> Value {
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

/* ---------- Gerrit change states (the review badges): the cache half ----------
 *
 * The network half (`git ls-remote` / `git fetch`, and the change-ref/URL string parsing) has
 * no engine dependency and stays host-side in `cmd_graph.rs`'s `gerrit_refresh` — it calls the
 * functions below (in this process today; over `plugin_host` once the seam is cut) for the
 * pieces that do touch the engine: parsing NoteDb metas, listing locally fetched change refs,
 * and the cache itself.
 */

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

static GERRIT_CACHE: std::sync::LazyLock<Mutex<std::collections::HashMap<String, GerritRepo>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// Mark a repository's Gerrit data stale: the next `loadCommits` answers from the locally
/// fetched refs and flags itself pending, and the host then runs the refresh pipeline.
pub fn mark_gerrit_stale(repo_path: &str) {
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

pub fn clear_gerrit_cache(repo_path: &str) {
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(repo_path);
}

/// The cache half of a Gerrit load (gitGraphView.ts `loadGerritData`): keep the cached entry
/// when it is fresh under the request's fetch limit; otherwise rebuild the entry from the
/// locally fetched change refs, which also replaces an entry built under another limit. `hard`
/// always rebuilds, observing a repository that changed behind the cache's back. The network
/// half is `gerrit_refresh` (host-side), which the host runs while the pending response is on
/// screen.
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
                crate::gerrit::gerrit_change_shard(state.change),
                state.change,
                latest
            ))
        })
        .collect()
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
    let mut changes: BTreeMap<u64, Vec<u32>> = BTreeMap::new();
    for (refname, _) in refs {
        if let Some((change, Some(patchset))) = crate::gerrit::gerrit_parse_change_ref(&refname) {
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
        .and_then(|url| crate::gerrit::gerrit_url_base(&url));
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

/* ---------- Gerrit refresh: the pieces the host-side network pipeline calls ---------- */

/// The "remote answered nothing" fallback: how many changes a purely local rebuild would show,
/// without touching the cache (`gerrit_refresh` uses this only to answer the response's
/// `changes` count; the previously cached data, if any, is left exactly as it was).
pub fn gerrit_local_rebuild_count(
    repo_path: &str,
    remote: &str,
    fetch_limit: u32,
) -> Result<Option<usize>, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    Ok(build_local_gerrit_entry(&repo, remote, fetch_limit).map(|entry| entry.states.len()))
}

/// The remote's web-link base for change URLs (`gerrit_refresh`'s own `config::remote_url`
/// call) — a plain engine config read.
pub fn gerrit_remote_url(repo_path: &str, remote: &str) -> Result<Option<String>, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    git_graph_core::config::remote_url(&repo, remote).map_err(|e| e.message)
}

/// One parsed change, ready to serialize back to the host: the change number, the patchsets it
/// was fetched under, and its NoteDb state (`None` when the meta could not be parsed — the
/// engine's own `parse_gerrit_metas` contract).
#[derive(serde::Serialize)]
pub struct GerritParsedChange {
    pub change: u64,
    pub patchsets: Vec<u32>,
    pub state: Option<GerritChangeState>,
}

/// Parse the NoteDb metas of exactly the given changes — the engine half of one window-growth
/// iteration of `gerrit_refresh`'s adaptive sampling loop. Reopens the repository first: the
/// refs the caller just fetched (over the CLI, host-side) predate the engine's warm handle.
pub fn gerrit_parse_changes(
    repo_path: &str,
    remote: &str,
    changes: &[(u64, Vec<u32>)],
    url_base: Option<&str>,
) -> Result<Vec<GerritParsedChange>, String> {
    RepoManager::global().close(repo_path);
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    let numbers: Vec<i64> = changes.iter().map(|(change, _)| *change as i64).collect();
    let parsed = git_graph_core::gerrit::parse_gerrit_metas(&repo, remote, &numbers, url_base)
        .map_err(|e| e.message)?;
    Ok(changes
        .iter()
        .cloned()
        .zip(parsed)
        .map(|((change, patchsets), state)| GerritParsedChange {
            change,
            patchsets,
            state,
        })
        .collect())
}

/// The change refs the repository has locally fetched from `remote` right now — the prune
/// step's "what exists" read (`gerrit_refresh` compares this against what it wants to keep and
/// deletes the rest over the CLI, host-side).
pub fn gerrit_local_change_refs(repo_path: &str, remote: &str) -> Result<Vec<String>, String> {
    let repo = RepoManager::global()
        .get(repo_path)
        .map_err(|e| e.message)?;
    Ok(git_graph_core::gerrit::list_change_refs(&repo, remote)
        .map_err(|e| e.message)?
        .into_iter()
        .map(|(refname, _)| refname)
        .collect())
}

/// The refresh pipeline's finish: cache the accumulated states (sorted, newest change first) as
/// the repository's fresh Gerrit entry, and drop the caches the fetch invalidated — exactly
/// `gerrit_refresh`'s original tail. `states` is the plain JSON `gerrit_parse_changes` returned
/// (the host cannot name `GerritChangeState`, so it only ever carries this data, never
/// constructs it); deserialization happens here, the one place allowed to name the type.
/// Returns the final state count.
pub fn gerrit_cache_finalize(
    repo_path: &str,
    states: Vec<Value>,
    patchsets: std::collections::HashMap<u64, Vec<u32>>,
    fetch_limit: u32,
) -> Result<usize, String> {
    let mut states: Vec<GerritChangeState> = states
        .into_iter()
        .filter_map(|state| serde_json::from_value(state).ok())
        .collect();
    states.sort_by_key(|state| std::cmp::Reverse(state.change));
    let count = states.len();
    GERRIT_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            repo_path.to_owned(),
            GerritRepo {
                entry: Some(GerritEntry {
                    states,
                    patchsets,
                    fetch_limit,
                }),
                stale: false,
            },
        );
    // The fetches wrote refs the engine's caches predate.
    close_after_write(repo_path);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::view_config;
    use git_graph_core::{config, RepoManager};
    use git_graph_studio_lib::test_support::Scratch;

    /// The Path filter sends comma-separated paths: a commit shows when it changes any one
    /// of them, not only when it changes the literal comma-joined string.
    #[test]
    fn comma_separated_path_filter_matches_any_file() {
        let scratch = Scratch::new("path-filter");
        let git = scratch.repo("repo");
        git_graph_studio_lib::test_support::commit(&git, "src/a.txt", "a\n", "touch a");
        git_graph_studio_lib::test_support::commit(&git, "docs/b.txt", "b\n", "touch b");
        git_graph_studio_lib::test_support::commit(&git, "other/c.txt", "c\n", "touch c");
        let root = git.repo.display().to_string();
        let request = json!({
            "command": "loadCommits", "repo": root, "refreshId": 1,
            "filterPath": "src/a.txt, docs/b.txt",
        });
        let git = git_graph_studio_lib::git::Git::new(&root);
        let response = super::engine_read(&root, "loadCommits", &request, &git).unwrap();
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
        git_graph_studio_lib::test_support::commit(&git, "README.md", "hello\n", "Initial commit");
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
