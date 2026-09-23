//! The Gerrit change-state pipeline of the Git Graph view: the pure change-ref / remote-URL
//! formats and fetch-window arithmetic (always compiled, unit-tested here), and the refresh
//! pipeline itself (ls-remote, the batched patchset fetches, the NoteDb meta parse) — moved
//! out of the app's `cmd_graph.rs` into the backend that owns the engine's Gerrit cache.

#[cfg(test)]
use serde_json::json;
use serde_json::Value;

use git_graph_studio_lib::git::Git;

use crate::engine_impl;

/* ---------- Gerrit change states (the review badges) ----------
 *
 * The cache itself (parsed NoteDb states, keyed by repository) lives in the backend
 * (`cmd_graph/engine_impl.rs`'s `GERRIT_CACHE`) — it stores the engine's own `GerritChangeState`
 * type, which only compiles under the `engine` feature. The pure string/number parsing below
 * (the change-ref and remote-URL formats, the fetch-window arithmetic) has no engine dependency
 * and stays always compiled — `engine_impl` calls into some of it too (`super::`). The host-side
 * network half of the refresh pipeline (`refresh`) runs the `git` CLI from this
 * backend process and caches its results in `engine_impl`'s Gerrit cache.
 */

/// The status filter of a `loadCommits` request (the Repository Settings checkboxes): a WIP
/// change passes through its own flag, any other through its status.
#[derive(Clone, Copy)]
pub(crate) struct GerritStatusFilter {
    pub(crate) new_change: bool,
    pub(crate) merged: bool,
    pub(crate) abandoned: bool,
    pub(crate) wip: bool,
}

pub(crate) fn gerrit_status_filter(message: &Value) -> GerritStatusFilter {
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
pub(crate) fn gerrit_fetch_limit(message: &Value) -> u32 {
    message
        .get("gerritFetchLimit")
        .and_then(Value::as_u64)
        .filter(|limit| (1..=10000).contains(limit))
        .map_or(20, |limit| limit as u32)
}

/// [`gerrit_refresh`]'s own pass-count check, against the plain JSON a parsed change comes back
/// as over the wire (the same three fields `engine_impl`'s typed `gerrit_state_passes` reads).
fn gerrit_state_passes_json(state: &Value, filter: GerritStatusFilter) -> bool {
    if state.get("wip").and_then(Value::as_bool).unwrap_or(false) {
        return filter.wip;
    }
    match state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "new" => filter.new_change,
        "merged" => filter.merged,
        _ => filter.abandoned,
    }
}

/// The two-digit shard of a change number (`41466` → `"66"`, `5` → `"05"`).
pub(crate) fn gerrit_change_shard(change: u64) -> String {
    format!("{:02}", change % 100)
}

/// The change a change ref names — `refs/[remotes/<remote>/]changes/NN/<change>/(meta|<patchset>)`
/// (src/gerrit.ts `parseChangeRef`): the change number, and its patchset (`None` for a NoteDb
/// meta ref). `None` when the ref is not a change ref.
pub(crate) fn gerrit_parse_change_ref(refname: &str) -> Option<(u64, Option<u32>)> {
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
pub(crate) fn gerrit_url_base(remote_url: &str) -> Option<String> {
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

/// Run the Gerrit refresh pipeline of a repository (gitGraphView.ts `fetchGerritChanges`):
/// list the remote's open change refs, fetch the latest patchset and NoteDb meta of the changes
/// the sampling window selects, parse the metas, and prune the locally fetched refs the new set
/// no longer keeps. The result becomes the repository's cache entry; a failure keeps the
/// previous entry and its stale flag, so the next load retries.
///
/// Returns the number of changes in the new entry, and whether the remote was actually reached
/// (`false`: ls-remote answered nothing while local change refs exist — the remote is treated
/// as unreachable, and the previously cached data stays).
pub(crate) fn refresh(
    repo_path: &str,
    remote: &str,
    fetch_limit: u32,
    filter: GerritStatusFilter,
) -> Result<(usize, bool), String> {
    let git = Git::new(repo_path);
    let listing = git
        .output(&["ls-remote", remote, "refs/changes/*"])
        .map_err(|e| {
            format!("Could not list the Gerrit changes of the remote \"{remote}\": {e}")
        })?;
    let remote_changes = gerrit_parse_ls_remote(&listing);
    if remote_changes.is_empty() {
        if let Some(count) =
            engine_impl::gerrit_local_rebuild_count(repo_path, remote, fetch_limit)?
        {
            return Ok((count, false));
        }
    }
    let url_base = engine_impl::gerrit_remote_url(repo_path, remote)?
        .as_deref()
        .and_then(gerrit_url_base);

    // The accumulated cache entry, built up over the adaptive sampling loop below: every
    // parsed state (opaque JSON — its shape is the engine's `GerritChangeState`, which this
    // process cannot name) and the patchsets it was parsed from.
    let mut states: Vec<Value> = Vec::new();
    let mut patchsets: std::collections::BTreeMap<u64, Vec<u32>> =
        std::collections::BTreeMap::new();
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
                .filter(|(change, _)| !patchsets.contains_key(change))
                .map(|(change, ps)| (*change, ps.clone()))
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
                // The engine's warm repository handle predates the fetches just run: the
                // backend reopens it before parsing (`gerrit_parse_changes`).

                let parsed_changes = engine_impl::gerrit_parse_changes(
                    repo_path,
                    remote,
                    &delta,
                    url_base.as_deref(),
                )?;
                for parsed in parsed_changes {
                    if let Some(state) = parsed.state {
                        if let Ok(state) = serde_json::to_value(state) {
                            states.push(state);
                            patchsets.insert(parsed.change, parsed.patchsets);
                        }
                    }
                }
            }
            let passing = states
                .iter()
                .filter(|state| gerrit_state_passes_json(state, filter))
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
        let keep: Vec<String> = patchsets
            .keys()
            .map(|change| {
                format!(
                    "refs/remotes/{remote}/changes/{}/{change}/",
                    gerrit_change_shard(*change)
                )
            })
            .collect();
        if let Ok(refs) = engine_impl::gerrit_local_change_refs(repo_path, remote) {
            let deletions: String = refs
                .iter()
                .filter(|refname| {
                    !keep
                        .iter()
                        .any(|prefix| refname.starts_with(prefix.as_str()))
                })
                .map(|refname| format!("delete {refname}\n"))
                .collect();
            if !deletions.is_empty() {
                let _ = git.output_with_input(&["update-ref", "--stdin"], &deletions);
            }
        }
    }
    // Caches the accumulated states as the repository's fresh Gerrit entry and drops the
    // caches the fetches invalidated (the fetches wrote refs the engine's caches predate).
    let patchsets: std::collections::HashMap<u64, Vec<u32>> = patchsets.into_iter().collect();
    let count = engine_impl::gerrit_cache_finalize(repo_path, states, patchsets, fetch_limit)?;
    Ok((count, true))
}

#[cfg(test)]
mod gerrit_tests {
    use super::*;

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
