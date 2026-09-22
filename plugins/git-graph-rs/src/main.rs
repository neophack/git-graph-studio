//! The git-graph-rs engine backend: the `ggx/2` process backend `git-graph-rs.ggx` packages
//! (this plugin's own packer, `plugins/git-graph-rs/build.mjs --backend`), speaking
//! `ggx-rpc/1` (`backend_rpc.rs`) over stdin and
//! stdout to `plugin_host.rs`. Every read of the Git Graph view, the Source Control status, and
//! file-at-revision content answers here — this is the only binary in the tree that links the
//! engine (the `engine` feature; `cmd_graph::engine_impl` is the seam). Read-only: it never
//! writes to a repository and never runs the `git` CLI for anything but the handful of
//! plumbing-file reads the extension's own data source also reads that way (working-tree
//! config, the rebase/merge/cherry-pick operation state) — every write stays in the app, over
//! `cmd_graph.rs`'s `handle`.

use std::collections::HashMap;

use git_graph_studio_lib::backend_rpc;
use git_graph_studio_lib::cmd_graph::engine_impl;
use git_graph_studio_lib::git::Git;
use serde_json::{json, Value};

fn main() {
    // Parity with `ggs-ext/1`'s convention (`ext_process.rs`): a plugin that keeps
    // per-instance state can tell two concurrently running windows apart. This backend keeps
    // none, but the variable is read so a future one can.
    let instance = std::env::var("GGS_INSTANCE_ID").unwrap_or_default();
    eprintln!("[git-graph-backend] starting (pid {}, instance {instance})", std::process::id());
    backend_rpc::serve_backend(handle);
    eprintln!("[git-graph-backend] stopped");
}

fn handle(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "hello" => Ok(json!(engine_impl::engine_version())),
        "closeRepos" => {
            engine_impl::close_engine_repos();
            Ok(Value::Null)
        }
        "request" => {
            let repo = params.get("repo").and_then(Value::as_str).unwrap_or_default();
            let message = params.get("message").cloned().unwrap_or(Value::Null);
            let command = message.get("command").and_then(Value::as_str).unwrap_or_default().to_owned();
            let git = Git::new(repo);
            dispatch(repo, &command, &message, &git)
        }
        other => Err(format!("unsupported method: {other}")),
    }
}

/// The `request` verb's dispatch: the internal-only commands `cmd_graph.rs`'s non-view callers
/// (`cmd_fs.rs`, `cmd_scm.rs`, `lib.rs`, the Gerrit refresh pipeline) send, prefixed `__` so
/// they cannot collide with the view's own protocol — anything else is a message of the Git
/// Graph view itself, answered by [`engine_impl::engine_read`].
fn dispatch(repo: &str, command: &str, message: &Value, git: &Git) -> Result<Value, String> {
    match command {
        "__repoRoot" => {
            let path = message.get("path").and_then(Value::as_str).unwrap_or(repo);
            Ok(json!({ "root": engine_impl::resolve_repo_root(path) }))
        }
        "__submoduleRoots" => Ok(json!({ "roots": engine_impl::submodule_roots(repo) })),
        "__scmChanges" => engine_impl::scm_changes(repo),
        "__revisionFile" => {
            let revision = message.get("revision").and_then(Value::as_str).unwrap_or_default();
            let path = message.get("path").and_then(Value::as_str).unwrap_or_default();
            let file = engine_impl::revision_file(repo, revision, path)?;
            Ok(json!({ "binary": file.binary, "contents": file.contents }))
        }
        "__revisionFileBytes" => {
            let revision = message.get("revision").and_then(Value::as_str).unwrap_or_default();
            let path = message.get("path").and_then(Value::as_str).unwrap_or_default();
            let bytes = engine_impl::revision_file_bytes(repo, revision, path)?;
            use base64::Engine;
            Ok(json!({ "bytes": bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b)) }))
        }
        "__loadFirstPage" => Ok(json!({ "count": engine_impl::load_first_page(repo)? })),
        "__warmFirstPage" => Ok(json!({ "count": engine_impl::warm_first_page(repo)? })),
        "__closeAfterWrite" => {
            engine_impl::close_after_write(repo);
            Ok(Value::Null)
        }
        "__gerritMarkStale" => {
            engine_impl::mark_gerrit_stale(repo);
            Ok(Value::Null)
        }
        "__gerritClearCache" => {
            engine_impl::clear_gerrit_cache(repo);
            Ok(Value::Null)
        }
        "__gerritLocalRebuildCount" => {
            let remote = message.get("remote").and_then(Value::as_str).unwrap_or("origin");
            let fetch_limit = message.get("fetchLimit").and_then(Value::as_u64).unwrap_or(20) as u32;
            Ok(json!({ "count": engine_impl::gerrit_local_rebuild_count(repo, remote, fetch_limit)? }))
        }
        "__gerritRemoteUrl" => {
            let remote = message.get("remote").and_then(Value::as_str).unwrap_or("origin");
            Ok(json!({ "url": engine_impl::gerrit_remote_url(repo, remote)? }))
        }
        "__gerritParseChanges" => {
            let remote = message.get("remote").and_then(Value::as_str).unwrap_or("origin");
            let url_base = message.get("urlBase").and_then(Value::as_str);
            let changes = parse_change_list(message.get("changes"));
            let parsed = engine_impl::gerrit_parse_changes(repo, remote, &changes, url_base)?;
            Ok(json!({ "parsed": parsed }))
        }
        "__gerritLocalChangeRefs" => {
            let remote = message.get("remote").and_then(Value::as_str).unwrap_or("origin");
            Ok(json!({ "refs": engine_impl::gerrit_local_change_refs(repo, remote)? }))
        }
        "__gerritCacheFinalize" => {
            let states = message.get("states").and_then(Value::as_array).cloned().unwrap_or_default();
            let patchsets = parse_patchset_map(message.get("patchsets"));
            let fetch_limit = message.get("fetchLimit").and_then(Value::as_u64).unwrap_or(20) as u32;
            Ok(json!({ "count": engine_impl::gerrit_cache_finalize(repo, states, patchsets, fetch_limit)? }))
        }
        // Everything else is the view's own protocol.
        _ => engine_impl::engine_read(repo, command, message, git),
    }
}

/// `[[change, [patchset, ...]], ...]` (`gerrit_refresh`'s wire shape for a delta).
fn parse_change_list(value: Option<&Value>) -> Vec<(u64, Vec<u32>)> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let item = item.as_array()?;
                    let change = item.first()?.as_u64()?;
                    let patchsets = item
                        .get(1)?
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_u64)
                        .map(|n| n as u32)
                        .collect();
                    Some((change, patchsets))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `{"<change>": [patchset, ...], ...}` (JSON object keys are strings; the change numbers are
/// parsed back out).
fn parse_patchset_map(value: Option<&Value>) -> HashMap<u64, Vec<u32>> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    let change: u64 = key.parse().ok()?;
                    let patchsets = value.as_array()?.iter().filter_map(Value::as_u64).map(|n| n as u32).collect();
                    Some((change, patchsets))
                })
                .collect()
        })
        .unwrap_or_default()
}
