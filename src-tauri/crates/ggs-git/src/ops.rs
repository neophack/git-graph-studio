//! The operations behind the Source Control view's "..." menu — the same set VS Code's Git
//! extension offers (pull, push, sync, clone, checkout, branches, remotes, stashes, tags) plus
//! the extension's own contributions (amend the last commit, soft-reset to the remote, the
//! Gerrit commit-msg hook and `refs/for/` push). Everything runs through `git`, like the view's
//! other writes; the read helpers feed the quick picks.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::runner::has_undecodable_name;
use crate::runner::is_safe_ref_name;
use crate::runner::is_valid_commit_hash;
use crate::runner::run_chunked;
use crate::runner::Git;

type Status = Result<(), String>;

/* ---------- Reads for the quick picks ---------- */

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
}

/// Local branches first (the checked-out one flagged), then remote-tracking ones.
pub fn branches(git: &Git) -> Result<Vec<BranchInfo>, String> {
    let out = git.output(&[
        "for-each-ref",
        "--format=%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(refname)",
        "refs/heads",
        "refs/remotes",
    ])?;
    let mut list = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() != 4 || parts[1].ends_with("/HEAD") {
            continue;
        }
        list.push(BranchInfo {
            name: parts[1].to_owned(),
            remote: parts[3].starts_with("refs/remotes/"),
            current: parts[0] == "*",
            upstream: Some(parts[2]).filter(|u| !u.is_empty()).map(str::to_owned),
        });
    }
    Ok(list)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

pub fn remotes(git: &Git) -> Result<Vec<RemoteInfo>, String> {
    let out = git.output(&["remote", "-v"])?;
    let mut list: Vec<RemoteInfo> = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else {
            continue;
        };
        if list.iter().any(|r| r.name == name) {
            continue; // the (push) line of the same remote
        }
        list.push(RemoteInfo {
            name: name.to_owned(),
            url: url.to_owned(),
        });
    }
    Ok(list)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// The entry's own commit hash — the selector the stash actions take. Git accepts the
    /// hash for apply/pop/drop, and an index (`refs/stash@{n}`) would race any other
    /// window that pushed or dropped a stash meanwhile: the wrong entry goes.
    pub selector: String,
    pub index: usize,
    pub message: String,
    pub hash: String,
}

pub fn stashes(git: &Git) -> Result<Vec<StashInfo>, String> {
    let out = git.output(&["stash", "list", "--format=%H\x1f%s"])?;
    Ok(out
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let (hash, message) = line.split_once('\x1f')?;
            Some(StashInfo {
                selector: hash.to_owned(),
                index,
                message: message.to_owned(),
                hash: hash.to_owned(),
            })
        })
        .collect())
}

pub fn tags(git: &Git) -> Result<Vec<String>, String> {
    let out = git.output(&["tag", "--list", "--sort=-creatordate"])?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect())
}

/* ---------- The working-tree status ---------- */

/// One path's change as the Source Control view lists it — the staged and unstaged halves kept
/// apart on one entry, the same shape the view has always consumed (camelCase on the wire).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScmStatusChange {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: Option<&'static str>,
    pub unstaged: Option<&'static str>,
    pub untracked: bool,
    pub conflicted: bool,
}

/// One porcelain status letter as the view's status word. `T` (type change) reads as a
/// modification — the view has no separate state for it; `C` (copied) reads as added.
fn status_word(letter: u8) -> Option<&'static str> {
    match letter {
        b'A' | b'C' => Some("added"),
        b'M' | b'T' => Some("modified"),
        b'D' => Some("deleted"),
        b'R' => Some("renamed"),
        _ => None,
    }
}

/// Parse `git status --porcelain=v1 -z --untracked-files=all` output into the view's change
/// list. The `-z` form is NUL-separated — `XY <path>\0`, with the original path as a second
/// NUL-terminated field after a renamed (`R`/`C`) entry — so paths with spaces or quotes pass
/// through without quoting.
pub fn parse_status_z(output: &str) -> Vec<ScmStatusChange> {
    let mut changes = Vec::new();
    let mut fields = output.split('\0');
    while let Some(entry) = fields.next() {
        // "XY <path>" — at least three prefix bytes and a non-empty path.
        if entry.len() < 4 || !entry.is_char_boundary(3) {
            continue;
        }
        let letters = entry.as_bytes();
        let (x, y) = (letters[0], letters[1]);
        let path = entry[3..].to_owned();
        let old_path = if x == b'R' || x == b'C' {
            fields.next().map(str::to_owned)
        } else {
            None
        };
        if x == b'?' && y == b'?' {
            changes.push(ScmStatusChange {
                path,
                old_path: None,
                staged: None,
                unstaged: None,
                untracked: true,
                conflicted: false,
            });
        } else if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
            // An unmerged path shows in the Merge Changes section; which side staged what is
            // not a useful distinction there.
            changes.push(ScmStatusChange {
                path,
                old_path,
                staged: None,
                unstaged: None,
                untracked: false,
                conflicted: true,
            });
        } else {
            changes.push(ScmStatusChange {
                path,
                old_path,
                staged: status_word(x),
                unstaged: status_word(y),
                untracked: false,
                conflicted: false,
            });
        }
    }
    changes
}

/// The working tree's changes, staged and unstaged halves kept apart, as the Source Control
/// view's two sections list them.
pub fn status(git: &Git) -> Result<Vec<ScmStatusChange>, String> {
    let output = git.output(&[
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    ])?;
    Ok(parse_status_z(&output))
}

/// `git add --update` — stage every change to tracked files (modifications and deletions,
/// across the whole tree), never the untracked ones ("Stage All Tracked Changes").
pub fn stage_all_tracked(git: &Git) -> Status {
    git.run(&["add", "--update"])
}

/// Stage only the untracked files — `git ls-files --others --exclude-standard` listed
/// NUL-separated (quotepath off, so non-ASCII names pass through unquoted), then
/// `git add --all --` over them in byte-bounded chunks ([`run_chunked`]: a directory of
/// hundreds of untracked files keeps every spawn's command line under the Windows
/// ceiling); the tracked files' changes stay unstaged ("Stage All Untracked Changes").
/// A path carrying the decode-replacement character cannot be addressed by any pathspec
/// ([`has_undecodable_name`]) — not by this batch, not by anyone — so it is left out of
/// the listing rather than failing the whole command with git's unhelpful complaint; its
/// row stays in the view, and acting on that row alone carries the explanation.
pub fn stage_all_untracked(git: &Git) -> Status {
    let listing = git.output(&[
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    ])?;
    let paths: Vec<&str> = listing
        .split('\0')
        .filter(|p| !p.is_empty() && !has_undecodable_name(p))
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    run_chunked(git, &["add", "--all", "--"], &paths)
}

/// One commit of a file's history, as the Timeline lists it (camelCase on the wire).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileLogEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Seconds since the epoch.
    pub date: i64,
    /// The subject line.
    pub message: String,
    /// The path the file carried at this commit — under `--follow`, the name it had
    /// before a rename, which the row's diff and revision reads must open.
    pub path: String,
}

/// The commits that touched `path`, newest first, following the path across renames — the
/// Timeline of a file. The subject only (`%s`): the engine's history listed subjects too.
pub fn file_log(git: &Git, path: &str, limit: usize) -> Result<Vec<FileLogEntry>, String> {
    let output = git.output(&[
        "-c",
        "core.quotepath=false",
        "log",
        &format!("-n{limit}"),
        "--follow",
        // `--name-only` under `--follow` names the file as each commit has it: the
        // commits before a rename report the path the file carried then, which is the
        // one their revision side must read.
        "--name-only",
        "--format=%H%x00%P%x00%an%x00%at%x00%s%x1e",
        "--",
        path,
    ])?;
    let mut entries: Vec<FileLogEntry> = Vec::new();
    // `--format=` is tformat, so every record is `<fields>\x1e` followed by the
    // tformat newline and the `--name-only` lines — which land at the START of the
    // next `\x1e` piece. Each piece therefore carries the previous record's listing
    // (a path never carries a NUL) and this record's fields, which begin at the
    // first line holding one.
    for piece in output.split('\x1e') {
        let (listed, fields) = match piece.find('\0') {
            Some(nul) => piece.split_at(piece[..nul].rfind('\n').map_or(0, |i| i + 1)),
            None => (piece, ""),
        };
        // The lines in front of this record's fields are the previous record's
        // listing; they name the path that record had the file under.
        if let Some(entry) = entries.last_mut() {
            if let Some(path) = listed.lines().map(str::trim).find(|line| !line.is_empty()) {
                entry.path = path.to_owned();
            }
        }
        if fields.is_empty() {
            continue;
        }
        let mut fields = fields.splitn(5, '\0');
        let (Some(hash), Some(parents), Some(author), Some(date), Some(message)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        entries.push(FileLogEntry {
            hash: hash.to_owned(),
            parents: parents.split_whitespace().map(str::to_owned).collect(),
            author: author.to_owned(),
            date: date.trim().parse().unwrap_or(0),
            message: message.trim_end().to_owned(),
            path: path.to_owned(),
        });
    }
    Ok(entries)
}

/* ---------- The palette's mutations (branch/remote/stash/tag) ---------- */

pub fn rename_branch(git: &Git, old: &str, new: &str) -> Status {
    check_ref("oldName", old)
        .and_then(|_| check_ref("newName", new))
        .and_then(|_| git.run(&["branch", "-m", old, new]))
}

pub fn delete_branch(git: &Git, name: &str, force: bool) -> Status {
    check_ref("branchName", name)
        .and_then(|_| git.run(&["branch", if force { "-D" } else { "-d" }, name]))
}

/// `git push <remote> --delete <branch>` — delete the branch on the remote. The local
/// branch is untouched; whether its commits are lost is the remote's own GC's business,
/// which is why the confirmation carries the irreversible wording.
pub fn delete_remote_branch(git: &Git, remote: &str, branch: &str) -> Status {
    check_ref("remote", remote)?;
    check_ref("branch", branch)?;
    git.run(&["push", remote, "--delete", branch])
}

/// `git push <remote> --delete <tag>` — delete the tag on the remote; the local tag stays.
pub fn delete_remote_tag(git: &Git, remote: &str, tag: &str) -> Status {
    check_ref("remote", remote)?;
    check_ref("tagName", tag)?;
    git.run(&["push", remote, "--delete", tag])
}

/// Whether `name`'s tip is reachable from HEAD (`git merge-base --is-ancestor`): the fact
/// the delete confirmation words itself by. Exit 0 answers merged, exit 1 answers not —
/// git's documented codes for exactly this query; anything else (an unknown ref, not a
/// repository) is the error git printed.
pub fn branch_merged(git: &Git, name: &str) -> Result<bool, String> {
    check_ref("branchName", name)?;
    let output = git.raw_output(&["merge-base", "--is-ancestor", name, "HEAD"])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let text = text.trim();
            if text.is_empty() {
                Err(format!(
                    "Could not tell whether \"{name}\" is merged into HEAD."
                ))
            } else {
                Err(text.to_owned())
            }
        }
    }
}

/// Merge `name` into the current branch, fast-forwarding when possible (the palette's choice:
/// the "create a merge commit" variant is the Git Graph view's own dialog).
pub fn merge(git: &Git, name: &str) -> Status {
    check_ref("obj", name).and_then(|_| git.run(&["merge", "--no-edit", name]))
}

pub fn rebase(git: &Git, name: &str) -> Status {
    check_ref("obj", name).and_then(|_| git.run(&["rebase", name]))
}

/// Whether a stopped merge (`MERGE_HEAD` present) or a stopped rebase is pending — the fact
/// the view's abort entries word themselves by, and the same probe VS Code's own Git
/// extension answers its "Abort Merge" / "Abort Rebase" affordances with (camelCase on the
/// wire).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub merge: bool,
    pub rebase: bool,
}

pub fn operation_state(git: &Git) -> Result<OperationState, String> {
    Ok(OperationState {
        merge: merge_in_progress(git),
        rebase: rebase_in_progress(git),
    })
}

/// `git rev-parse -q --verify MERGE_HEAD` succeeding: a merge left its state in the index.
pub fn merge_in_progress(git: &Git) -> bool {
    git.output(&["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .is_ok()
}

/// The rebase's own state directories present in the git dir: `rebase-merge` (the merge
/// backend every modern rebase runs, interactive or not) or `rebase-apply` (the old plain
/// form, which `git am` also parks in).
pub fn rebase_in_progress(git: &Git) -> bool {
    git.git_dir()
        .map(|dir| dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir())
        .unwrap_or(false)
}

/// `git merge --abort` — back out of a stopped merge, the working tree restored to its
/// pre-merge state. Refuses with the plain answer when nothing is pending, instead of
/// git's fatal that would read like a failure.
pub fn abort_merge(git: &Git) -> Status {
    if !merge_in_progress(git) {
        return Err("There is no merge in progress to abort.".to_owned());
    }
    git.run(&["merge", "--abort"])
}

/// `git rebase --abort` — back out of a stopped rebase, the branch restored to where it
/// stood before it started. The same idle guard as [`abort_merge`].
pub fn abort_rebase(git: &Git) -> Status {
    if !rebase_in_progress(git) {
        return Err("There is no rebase in progress to abort.".to_owned());
    }
    git.run(&["rebase", "--abort"])
}

pub fn add_remote(git: &Git, name: &str, url: &str, fetch: bool) -> Status {
    check_ref("name", name).and_then(|_| git.run(&["remote", "add", name, url]))?;
    if fetch {
        git.run(&["fetch", name])
    } else {
        Ok(())
    }
}

pub fn delete_remote(git: &Git, name: &str) -> Status {
    check_ref("name", name).and_then(|_| git.run(&["remote", "remove", name]))
}

pub fn push_stash(git: &Git, message: &str, include_untracked: bool) -> Status {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if !message.trim().is_empty() {
        args.extend(["--message", message]);
    }
    git.run(&args)
}

pub fn apply_stash(git: &Git, selector: &str, reinstate_index: bool) -> Status {
    let mut args = vec!["stash", "apply"];
    if reinstate_index {
        args.push("--index");
    }
    args.push(selector);
    git.run(&args)
}

/// `git stash pop` — apply, then remove the entry. Git refuses a bare commit hash for
/// `stash pop` (only `apply` takes the stash-like commit), so the removal rides
/// [`drop_stash`]'s hash-to-position resolution: the entry is dropped where the list
/// holds it now, not where some earlier listing did.
pub fn pop_stash(git: &Git, selector: &str, reinstate_index: bool) -> Status {
    apply_stash(git, selector, reinstate_index)?;
    drop_stash(git, selector)
}

/// `git stash drop` the entry `selector` names. Git refuses a bare commit hash here
/// (and `stash@{<hash>}` silently drops the wrong entry — it reads the braces as a
/// date), so a hash selector resolves to the entry's CURRENT reflog position over a
/// fresh `stash list`: the index a minutes-old listing carried would drop whatever
/// sits there once any other window pushed or dropped meanwhile. A reflog-shaped
/// selector (`stash@{n}`, the "latest stash" actions') passes through as-is.
pub fn drop_stash(git: &Git, selector: &str) -> Status {
    let position = stash_drop_position(git, selector)?;
    git.run(&["stash", "drop", &position])
}

/// The reflog reference `selector` names right now — the `refs/stash@{n}` a numeric
/// reflog selector already carries, or the position a hash lookup finds.
fn stash_drop_position(git: &Git, selector: &str) -> Result<String, String> {
    for prefix in ["refs/stash@{", "stash@{"] {
        if let Some(rest) = selector.strip_prefix(prefix) {
            if let Some(digits) = rest.strip_suffix('}') {
                if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                    return Ok(selector.to_owned());
                }
            }
        }
    }
    stashes(git)?
        .iter()
        .find(|entry| entry.hash == selector)
        .map(|entry| format!("refs/stash@{{{}}}", entry.index))
        .ok_or_else(|| format!("'{selector}' is not a stash reference"))
}

/// Create a tag at `hash` — annotated when `message` names one, lightweight otherwise. An
/// empty `hash` tags HEAD.
pub fn add_tag(git: &Git, name: &str, hash: &str, message: &str, force: bool) -> Status {
    check_ref("tagName", name)?;
    let mut args = vec!["tag"];
    if !message.trim().is_empty() {
        args.extend(["--annotate", "--message", message]);
    }
    if force {
        args.push("--force");
    }
    args.push(name);
    if !hash.is_empty() {
        args.push(hash);
    }
    git.run(&args)
}

pub fn delete_tag(git: &Git, name: &str) -> Status {
    check_ref("tagName", name).and_then(|_| git.run(&["tag", "--delete", name]))
}

pub fn undo_last_commit(git: &Git) -> Status {
    git.run(&["reset", "--soft", "HEAD^"])
}

fn current_branch(git: &Git) -> Option<String> {
    git.output(&["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

fn upstream(git: &Git) -> Option<String> {
    git.output(&[
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    ])
    .ok()
    .map(|u| u.trim().to_owned())
    .filter(|u| !u.is_empty())
}

fn check_ref(name: &str, value: &str) -> Status {
    if is_safe_ref_name(value) {
        Ok(())
    } else {
        Err(format!(
            "Invalid reference name was provided for \"{name}\""
        ))
    }
}

/* ---------- Sync ---------- */

/// `git pull` from the upstream, or from an explicit remote/branch; `--rebase` on request.
pub fn pull(git: &Git, remote: Option<&str>, branch: Option<&str>, rebase: bool) -> Status {
    let mut args = vec!["pull"];
    if rebase {
        args.push("--rebase");
    }
    if let Some(remote) = remote {
        check_ref("remote", remote)?;
        args.push(remote);
        if let Some(branch) = branch {
            check_ref("branch", branch)?;
            args.push(branch);
        }
    }
    git.run(&args)
}

/// `git push`: the current branch to its upstream, or to `remote` (setting the upstream when
/// asked, which is what VS Code does for a branch that has none yet).
pub fn push(git: &Git, remote: Option<&str>, set_upstream: bool, force: bool) -> Status {
    let mut args = vec!["push".to_owned()];
    if force {
        args.push("--force-with-lease".to_owned());
    }
    if let Some(remote) = remote {
        check_ref("remote", remote)?;
        let branch = current_branch(git)
            .ok_or_else(|| "HEAD is detached: check out a branch to push.".to_owned())?;
        if set_upstream {
            args.push("--set-upstream".to_owned());
        }
        args.push(remote.to_owned());
        args.push(branch);
    } else if upstream(git).is_none() {
        // No upstream: a single remote publishes to it (and records the upstream, as VS
        // Code offers to); several remotes refuse silently picking one — the frontend
        // asks which server the branch belongs on and passes the name down.
        let mut remotes = remotes(git)?.into_iter();
        let Some(remote) = remotes.next() else {
            return Err("The repository has no remotes to push to.".to_owned());
        };
        if remotes.next().is_some() {
            return Err(
                "The current branch has no upstream and the repository has several remotes; pick the remote to publish to.".to_owned(),
            );
        }
        return push(git, Some(&remote.name), true, force);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git.run(&refs)
}

/// VS Code's "Sync Changes": pull, then push.
pub fn sync(git: &Git, rebase: bool) -> Status {
    pull(git, None, None, rebase)?;
    push(git, None, false, false)
}

/// `git push <remote> refs/heads/<branch>:refs/heads/<branch>` — publish the local branch of
/// the chosen name to the remote (the "Push to..." second step): it works from any checkout,
/// and the checked-out branch's own upstream is not touched.
pub fn push_branch(git: &Git, remote: &str, branch: &str, force: bool) -> Status {
    check_ref("remote", remote)?;
    check_ref("branch", branch)?;
    let mut args = vec!["push".to_owned()];
    if force {
        args.push("--force-with-lease".to_owned());
    }
    args.push(remote.to_owned());
    args.push(format!("refs/heads/{branch}:refs/heads/{branch}"));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git.run(&refs)
}

/// `git push <remote> --tags` — push every local tag to the remote ("Push Tags" after a
/// run of local `git tag` writes; the remote's own tags are never touched unless a local
/// one of the same name exists).
pub fn push_tags(git: &Git, remote: &str) -> Status {
    check_ref("remote", remote).and_then(|_| git.run(&["push", remote, "--tags"]))
}

pub fn fetch(git: &Git, remote: Option<&str>, prune: bool) -> Status {
    crate::runner::fetch(git, remote, prune, false)
}

/// `git clone <url>` into `parent/<name>` (the name derived from the URL when not given);
/// returns the new repository's path.
pub fn clone(
    url: &str,
    parent: &Path,
    name: Option<&str>,
    env: &[(String, String)],
) -> Result<PathBuf, String> {
    if url.trim().is_empty() || url.starts_with('-') {
        return Err("Invalid URL was provided for \"url\"".to_owned());
    }
    let name = match name {
        Some(name) if !name.trim().is_empty() => name.trim().to_owned(),
        _ => {
            let trimmed = url.trim_end_matches('/').trim_end_matches(".git");
            trimmed
                .rsplit(['/', ':', '\\'])
                .next()
                .filter(|n| !n.is_empty())
                .ok_or_else(|| "Could not derive a folder name from the URL.".to_owned())?
                .to_owned()
        }
    };
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("{} already exists.", target.display()));
    }
    let git = Git {
        repo: parent.to_path_buf(),
        env: env.to_vec(),
    };
    git.run(&["clone", "--", url, &name])?;
    Ok(target)
}

/* ---------- Branches, remotes, stashes, tags (the simple forms the menu uses) ---------- */

pub fn checkout(git: &Git, name: &str) -> Status {
    // A commit hash (4-64 hex digits) checks out detached: plain `git checkout <hash>` is
    // the detached form, and git resolves a refname first when one collides with the hash,
    // so the same call stays correct for a branch whose name reads like a hash prefix.
    if is_valid_commit_hash(name) {
        return git.run(&["checkout", name]);
    }
    check_ref("branch", name)?;
    // A remote-tracking branch is checked out as a new local branch of the same short name.
    let is_remote = git
        .output(&[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{name}"),
        ])
        .is_ok();
    if is_remote {
        let local = name.split_once('/').map(|(_, b)| b).unwrap_or(name);
        let exists = git
            .output(&[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{local}"),
            ])
            .is_ok();
        if exists {
            return git.run(&["checkout", local]);
        }
        return git.run(&["checkout", "-b", local, "--track", name]);
    }
    git.run(&["checkout", name])
}

pub fn create_branch(git: &Git, name: &str, from: Option<&str>) -> Status {
    check_ref("branch", name)?;
    let mut args = vec!["checkout", "-b", name];
    if let Some(from) = from {
        check_ref("from", from)?;
        args.push(from);
    }
    git.run(&args)
}

pub fn amend_last_commit(git: &Git) -> Status {
    git.run(&["commit", "--amend", "--no-edit"])
}

/// The extension's "Reset Current Branch to Remote (Soft)": `git reset --soft @{upstream}`,
/// keeping every change staged. Returns the upstream that was reset to.
pub fn reset_to_remote(git: &Git) -> Result<String, String> {
    let upstream = upstream(git)
        .ok_or_else(|| "The current branch has no upstream to reset to.".to_owned())?;
    git.run(&["reset", "--soft", "@{upstream}"])?;
    Ok(upstream)
}

/* ---------- Commits: cherry-pick, revert, reset ---------- */

/// The conflicted paths a stopped merge-shaped operation left in the index — `None` when
/// there are none, so a failure without a conflict carries no hint.
fn conflicted_paths(git: &Git) -> Option<String> {
    let conflicted: Vec<String> = status(git)
        .ok()?
        .into_iter()
        .filter(|change| change.conflicted)
        .map(|change| change.path)
        .collect();
    if conflicted.is_empty() {
        None
    } else {
        Some(conflicted.join(", "))
    }
}

/// Run one of the merge-shaped operations that stops on a conflict, and name the conflicted
/// paths in the failure when git left any: git's own complaint says nothing about which
/// files to resolve, and the view's Merge Changes group is where the user goes next.
fn conflict_aware_op(git: &Git, args: &[&str]) -> Status {
    if let Err(error) = git.run(args) {
        return Err(match conflicted_paths(git) {
            Some(paths) => format!("{error}\nConflicted paths: {paths}"),
            None => error,
        });
    }
    Ok(())
}

/// The subject of HEAD — what the write notifications name as the result.
fn head_subject(git: &Git) -> String {
    git.output(&["log", "-1", "--format=%s"])
        .map(|subject| subject.trim().to_owned())
        .unwrap_or_default()
}

/// A commit-ish the cherry-pick / revert / reset inputs take: a hash, a ref, or a revision
/// expression ("HEAD~1", "HEAD^", "main@{yesterday}") — everything `git rev-parse`
/// resolves to a commit, and what VS Code's own "Reset Current Branch to Commit" accepts.
/// The ref-name validator cannot judge these (the expressions' `~`/`^`/`@{` parts are not
/// ref-name legal), so a target is verified by asking git: `rev-parse --verify
/// <expr>^{commit}` answers whether it names a commit, and git's own complaint travels
/// back as the error when it names nothing. Only the shapes that could never be a
/// revision are refused here without a spawn: an empty target, or a leading dash that
/// would ride the spawn as git's own option.
pub fn verify_commitish(git: &Git, target: &str) -> Status {
    if target.trim().is_empty() {
        return Err("A commit hash, branch or tag is required.".to_owned());
    }
    if target.starts_with('-') {
        return Err(format!(
            "Invalid revision expression was provided for \"target\" ({target})"
        ));
    }
    let commitish = format!("{target}^{{commit}}");
    git.run(&["rev-parse", "-q", "--verify", &commitish])
}

/// `git cherry-pick <ref>` — apply an existing commit's change as a new commit on top of
/// HEAD. Returns the new HEAD's subject for the notification.
pub fn cherry_pick(git: &Git, target: &str) -> Result<String, String> {
    verify_commitish(git, target)?;
    conflict_aware_op(git, &["cherry-pick", target])?;
    Ok(head_subject(git))
}

/// `git revert --no-edit <ref>` — undo an existing commit with a new inverse commit.
/// Returns the new HEAD's subject for the notification.
pub fn revert_commit(git: &Git, target: &str) -> Result<String, String> {
    verify_commitish(git, target)?;
    conflict_aware_op(git, &["revert", "--no-edit", target])?;
    Ok(head_subject(git))
}

/// The reset modes the picker offers — git's own three; every other spelling is rejected
/// here rather than reaching git.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    /// Move HEAD only: the index and the working tree stay as they are.
    Soft,
    /// Move HEAD and the index; the working tree keeps its files.
    Mixed,
    /// Move everything: the working tree resets too, and uncommitted changes are gone.
    Hard,
}

impl ResetMode {
    pub fn parse(mode: &str) -> Result<ResetMode, String> {
        match mode {
            "soft" => Ok(ResetMode::Soft),
            "mixed" => Ok(ResetMode::Mixed),
            "hard" => Ok(ResetMode::Hard),
            other => Err(format!(
                "Invalid reset mode \"{other}\" was provided (expected soft, mixed or hard)."
            )),
        }
    }

    fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        }
    }
}

/// `git reset --<mode> <ref>` — move the current branch to `target` at the chosen depth.
/// The target is a commit-ish a revision expression may spell ("HEAD~1"), resolved and
/// verified against git ([`verify_commitish`]) before the reset runs.
pub fn reset_ref(git: &Git, target: &str, mode: ResetMode) -> Status {
    verify_commitish(git, target)?;
    git.run(&["reset", mode.flag(), target])
}

/* ---------- Gerrit ---------- */

/// The web origin of the Gerrit server a remote URL points at (`https://host[:port]`), or None
/// for a URL that is neither http(s) nor ssh. An ssh remote says nothing about the web
/// interface's scheme, so https is assumed: a hook is an executable script, never fetched in
/// the clear.
pub fn gerrit_server_url(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    let strip_user = |authority: &str| authority.rsplit('@').next().unwrap_or(authority).to_owned();
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        let scheme = if url.starts_with("https") {
            "https"
        } else {
            "http"
        };
        let authority = rest.split('/').next()?;
        return Some(format!("{scheme}://{}", strip_user(authority)));
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let authority = strip_user(rest.split('/').next()?);
        let host = authority.split(':').next()?;
        return Some(format!("https://{host}"));
    }
    // scp-style: [user@]host:project — a single-letter "host" is a Windows drive.
    if let Some((authority, _)) = url.split_once(':') {
        let host = strip_user(authority);
        if host.len() > 1
            && !host.contains('/')
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Some(format!("https://{host}"));
        }
    }
    None
}

/// The Gerrit hook download's URL — the DOWNLOAD itself stays app-side (ggs-git is
/// network-free by design); the app fetches and hands the bytes to
/// [`gerrit_install_hook_with`].
pub fn gerrit_hook_url(git: &Git, remote: &str, hook: &str) -> Result<String, String> {
    check_ref("remote", remote)?;
    if hook != "commit-msg" {
        return Err(format!(
            "The hook \"{hook}\" cannot be downloaded from the Gerrit server."
        ));
    }
    let remote_url = git.output(&["remote", "get-url", remote])?;
    let origin = gerrit_server_url(&remote_url).ok_or_else(|| {
        format!("Unable to derive the Gerrit server URL from the remote \"{remote}\" (only http(s) and ssh remotes are supported).")
    })?;
    Ok(format!("{origin}/tools/hooks/{hook}"))
}

/// Install a downloaded hook's content. Returns whether a hook was written (false when
/// the identical hook was already installed).
pub fn gerrit_install_hook_with(git: &Git, hook: &str, content: &str) -> Result<bool, String> {
    if !content.trim_start().starts_with("#!") {
        return Err("the downloaded file is not a valid hook script.".to_string());
    }
    let hooks_dir = git.git_dir()?.join("hooks");
    let hook_path = hooks_dir.join(hook);
    if std::fs::read_to_string(&hook_path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("Unable to create {}: {e}", hooks_dir.display()))?;
    std::fs::write(&hook_path, content).map_err(|e| {
        format!(
            "Unable to write the {hook} hook to {}: {e}",
            hook_path.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o755));
    }
    Ok(true)
}

/// The Change-Id Gerrit's commit-msg hook would assign to a commit.
pub fn generate_change_id(
    tree: &str,
    parent: &str,
    author: &str,
    committer: &str,
    message: &str,
    nonce: &str,
) -> String {
    use sha1::{Digest, Sha1};
    let data = format!("tree {tree}\nparent {parent}\nauthor {author}\ncommitter {committer}\n\n{message}\n\n{nonce}\n");
    format!("I{}", hex::encode(Sha1::digest(data.as_bytes())))
}

pub fn extract_change_id(message: &str) -> Option<String> {
    message.lines().find_map(|line| {
        let id = line.strip_prefix("Change-Id: ")?.trim();
        (id.len() == 41 && id.starts_with('I') && id[1..].chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| id.to_owned())
    })
}

/// Make sure HEAD carries a Change-Id footer, amending one in when it is missing (only for a
/// commit no remote has yet). Returns the Change-Id and whether HEAD was amended.
pub fn ensure_head_change_id(git: &Git) -> Result<(String, bool), String> {
    let message = git.output(&["log", "-1", "--format=%B", "HEAD", "--"])?;
    if let Some(existing) = extract_change_id(&message) {
        return Ok((existing, false));
    }
    let containing = git.output(&["branch", "-r", "--no-color", "--contains=HEAD"])?;
    if let Some(remote) = containing.lines().map(str::trim).find(|l| !l.is_empty()) {
        return Err(format!(
            "HEAD has no Change-Id and has already been pushed to {remote}, so it cannot be amended."
        ));
    }
    let raw = git.output(&[
        "show",
        "-s",
        "--format=%T%n%P%n%an <%ae> %at%n%cn <%ce> %ct%n%B",
        "HEAD",
    ])?;
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() < 4 {
        return Err("Could not read HEAD to derive a Change-Id.".to_owned());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    let change_id = generate_change_id(
        lines[0],
        lines[1],
        lines[2],
        lines[3],
        &lines[4..].join("\n"),
        &nonce,
    );
    let amended = format!("{}\n\nChange-Id: {change_id}", message.trim_end());
    // The whole amended message rides stdin: the original can be any length a commit
    // message is, and a command line caps at 32 767 characters on Windows.
    git.run_input(&["commit", "--amend", "-F", "-"], amended.as_bytes())?;
    Ok((change_id, true))
}

/// Push HEAD to `refs/for/<current branch>` on the Gerrit remote for review. Returns the
/// change URL git printed, when the server printed one.
pub fn gerrit_push_ref(git: &Git, remote: &str) -> Result<Option<String>, String> {
    check_ref("remote", remote)?;
    let branch = current_branch(git)
        .ok_or_else(|| "HEAD is detached: check out a branch to push it for review.".to_owned())?;
    ensure_head_change_id(git)?;
    let target = format!("HEAD:refs/for/{branch}");
    // The change URL arrives on stderr (git's remote messages), so the combined text is scanned.
    let output = git.raw_output(&["push", remote, &target])?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(text.trim().to_owned());
    }
    Ok(text
        .split_whitespace()
        .find(|word| {
            word.starts_with("http")
                && word.contains("/c/")
                && word
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .map(|n| n.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false)
        })
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::testkit_ext::*;
    use ggs_testkit::Scratch;

    #[test]
    fn lists_branches_remotes_stashes_and_tags() {
        let scratch = Scratch::new("scm-lists");
        let git = scratch.repo("repo");
        let bare = scratch.bare("origin.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();
        git.run(&["push", "-q", "-u", "origin", "main"]).unwrap();
        git.run(&["branch", "topic"]).unwrap();
        git.run(&["tag", "v1"]).unwrap();
        write(&git, "README.md", "stashed\n");
        git.run(&["stash", "push", "-m", "WIP"]).unwrap();

        let list = branches(&git).unwrap();
        assert_eq!(
            list,
            vec![
                BranchInfo {
                    name: "main".into(),
                    remote: false,
                    current: true,
                    upstream: Some("origin/main".into())
                },
                BranchInfo {
                    name: "topic".into(),
                    remote: false,
                    current: false,
                    upstream: None
                },
                BranchInfo {
                    name: "origin/main".into(),
                    remote: true,
                    current: false,
                    upstream: None
                },
            ]
        );
        assert_eq!(
            remotes(&git).unwrap(),
            vec![RemoteInfo {
                name: "origin".into(),
                url: bare.display().to_string()
            }]
        );
        let stashes = stashes(&git).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(
            stashes[0].selector, stashes[0].hash,
            "the hash is the selector"
        );
        assert!(stashes[0].message.contains("WIP"));
        assert_eq!(tags(&git).unwrap(), vec!["v1".to_owned()]);
    }

    #[test]
    fn pull_push_sync_and_fetch() {
        let scratch = Scratch::new("scm-sync");
        let git = scratch.repo("repo");
        let bare = scratch.bare("origin.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();

        // No upstream yet: push picks the first remote and records the upstream.
        push(&git, None, false, false).unwrap();
        assert_eq!(upstream(&git).as_deref(), Some("origin/main"));

        let other = scratch.path("other");
        scratch
            .git(&scratch.root)
            .run(&[
                "clone",
                "-q",
                &bare.display().to_string(),
                &other.display().to_string(),
            ])
            .unwrap();
        let other_git = scratch.git(&other);
        let theirs = commit(&other_git, "theirs.txt", "t\n", "Theirs");
        other_git.run(&["push", "-q", "origin", "main"]).unwrap();

        fetch(&git, Some("origin"), true).unwrap();
        assert_eq!(rev(&git, "origin/main"), theirs);
        commit(&git, "ours.txt", "o\n", "Ours");
        sync(&git, true).unwrap();
        assert_eq!(rev(&git, "HEAD^"), theirs, "rebased on top of theirs");
        assert_eq!(
            scratch
                .git(&bare)
                .output(&["rev-parse", "main"])
                .unwrap()
                .trim(),
            head(&git)
        );

        pull(&git, Some("origin"), Some("main"), false).unwrap();
        fetch(&git, None, false).unwrap();
        assert!(push(&git, Some("--evil"), false, false).is_err());
    }

    #[test]
    fn clone_derives_the_folder_name() {
        let scratch = Scratch::new("scm-clone");
        let git = scratch.repo("source");
        let clones = scratch.path("clones");
        fs::create_dir_all(&clones).unwrap();
        let target = clone(&git.repo.display().to_string(), &clones, None, &git.env).unwrap();
        assert_eq!(target.file_name().unwrap(), "source");
        assert!(target.join("README.md").exists());
        assert!(
            clone(&git.repo.display().to_string(), &clones, None, &git.env).is_err(),
            "exists"
        );
        let named = clone(
            &git.repo.display().to_string(),
            &clones,
            Some("copy"),
            &git.env,
        )
        .unwrap();
        assert!(named.join(".git").exists());
        assert!(clone("--upload-pack=x", &clones, None, &git.env).is_err());
    }

    #[test]
    fn checkout_create_amend_and_reset_to_remote() {
        let scratch = Scratch::new("scm-branches");
        let git = scratch.repo("repo");
        let bare = scratch.bare("origin.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();
        git.run(&["push", "-q", "-u", "origin", "main"]).unwrap();

        create_branch(&git, "feature", None).unwrap();
        assert_eq!(scratch_current_branch(&git).as_deref(), Some("feature"));
        checkout(&git, "main").unwrap();
        assert_eq!(scratch_current_branch(&git).as_deref(), Some("main"));
        // A remote-tracking branch becomes a tracking local branch.
        git.run(&["push", "-q", "origin", "feature"]).unwrap();
        git.run(&["branch", "-D", "feature"]).unwrap();
        checkout(&git, "origin/feature").unwrap();
        assert_eq!(scratch_current_branch(&git).as_deref(), Some("feature"));
        assert_eq!(upstream(&git).as_deref(), Some("origin/feature"));

        checkout(&git, "main").unwrap();
        write(&git, "README.md", "amended\n");
        git.run(&["add", "README.md"]).unwrap();
        let before = head(&git);
        amend_last_commit(&git).unwrap();
        assert_ne!(head(&git), before);
        assert_eq!(subject(&git, "HEAD"), "Initial commit");
        assert_eq!(
            git.output(&["rev-list", "--count", "HEAD"]).unwrap().trim(),
            "1"
        );

        // Two local commits ahead: the soft reset keeps their changes staged.
        git.run(&["fetch", "-q", "origin"]).unwrap();
        git.run(&["reset", "-q", "--hard", "origin/main"]).unwrap();
        commit(&git, "a.txt", "a\n", "A");
        commit(&git, "b.txt", "b\n", "B");
        assert_eq!(reset_to_remote(&git).unwrap(), "origin/main");
        assert_eq!(head(&git), rev(&git, "origin/main"));
        let staged = git.output(&["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains("a.txt") && staged.contains("b.txt"));
    }

    #[test]
    fn gerrit_urls_change_ids_and_push_for_review() {
        assert_eq!(
            gerrit_server_url("https://user@gerrit.example.com:8443/a/project.git").as_deref(),
            Some("https://gerrit.example.com:8443")
        );
        assert_eq!(
            gerrit_server_url("http://gerrit.example.com/project").as_deref(),
            Some("http://gerrit.example.com")
        );
        assert_eq!(
            gerrit_server_url("ssh://user@gerrit.example.com:29418/project").as_deref(),
            Some("https://gerrit.example.com")
        );
        assert_eq!(
            gerrit_server_url("user@gerrit.example.com:project").as_deref(),
            Some("https://gerrit.example.com")
        );
        assert_eq!(gerrit_server_url("C:/repos/project"), None);
        assert_eq!(gerrit_server_url("/srv/git/project"), None);

        let id = generate_change_id("t", "p", "A <a@x> 1", "C <c@x> 2", "msg", "nonce");
        assert_eq!(id.len(), 41);
        assert!(id.starts_with('I'));
        assert_eq!(
            id,
            generate_change_id("t", "p", "A <a@x> 1", "C <c@x> 2", "msg", "nonce")
        );
        assert_eq!(
            extract_change_id(&format!("Subject\n\nChange-Id: {id}\n")).as_deref(),
            Some(id.as_str())
        );
        assert_eq!(extract_change_id("Subject\n\nChange-Id: nope"), None);

        let scratch = Scratch::new("gerrit");
        let git = scratch.repo("repo");
        let bare = scratch.bare("gerrit.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();
        commit(&git, "change.txt", "c\n", "A change for review");
        let (change_id, amended) = ensure_head_change_id(&git).unwrap();
        assert!(amended);
        assert!(git
            .output(&["log", "-1", "--format=%B"])
            .unwrap()
            .contains(&format!("Change-Id: {change_id}")));
        let (again, amended_again) = ensure_head_change_id(&git).unwrap();
        assert_eq!(again, change_id);
        assert!(!amended_again);

        let url = gerrit_push_ref(&git, "origin").unwrap();
        assert_eq!(url, None, "a bare repository prints no change URL");
        assert_eq!(
            scratch
                .git(&bare)
                .output(&["rev-parse", "refs/for/main"])
                .unwrap()
                .trim(),
            head(&git)
        );

        // A hook cannot come from a file remote; the error names the remote.
        let error = gerrit_hook_url(&git, "origin", "commit-msg").unwrap_err();
        assert!(
            error.contains("Unable to derive the Gerrit server URL"),
            "{error}"
        );
        assert!(gerrit_hook_url(&git, "origin", "pre-commit").is_err());
        assert!(
            !fs::exists(git.git_dir().unwrap().join("hooks").join("commit-msg")).unwrap_or(false)
        );
    }

    #[test]
    fn parse_status_z_covers_every_entry_shape() {
        // `XY <path>\0`, the rename's original path as the next field; untracked `??`, an
        // unmerged `UU`, both-sides `AA`, and a dual `MM` entry.
        let output = concat!(
            "R  renamed.txt\0old.txt\0",
            " M c.txt\0",
            "?? deep/nested.txt\0",
            "UU conf.txt\0",
            "AA both.txt\0",
            "MM half.txt\0",
            "A  added.bin\0",
        );
        let changes = parse_status_z(output);
        assert_eq!(changes.len(), 7);
        assert_eq!(
            changes[0],
            ScmStatusChange {
                path: "renamed.txt".into(),
                old_path: Some("old.txt".into()),
                staged: Some("renamed"),
                unstaged: None,
                untracked: false,
                conflicted: false,
            }
        );
        assert_eq!(changes[1].staged, None);
        assert_eq!(changes[1].unstaged, Some("modified"));
        assert!(changes[2].untracked);
        assert!(changes[3].conflicted);
        assert!(changes[4].conflicted, "added on both sides is a conflict");
        assert_eq!(changes[5].staged, Some("modified"));
        assert_eq!(changes[5].unstaged, Some("modified"));
        assert_eq!(changes[6].staged, Some("added"));
    }

    #[test]
    fn status_lists_staged_unstaged_untracked_and_conflicted_paths() {
        let scratch = Scratch::new("scm-status");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "one\n", "init");
        commit(&git, "c.txt", "base\n", "base");
        git.run(&["mv", "a.txt", "renamed.txt"]).unwrap();
        write(&git, "c.txt", "edited\n");
        write(&git, "deep/entry.txt", "new\n");

        let changes = status(&git).unwrap();
        assert!(changes.iter().any(|c| {
            c.path == "renamed.txt"
                && c.old_path.as_deref() == Some("a.txt")
                && c.staged == Some("renamed")
        }));
        assert!(changes
            .iter()
            .any(|c| c.path == "c.txt" && c.unstaged == Some("modified")));
        assert!(changes
            .iter()
            .any(|c| c.path == "deep/entry.txt" && c.untracked));

        // A content conflict: both sides of the merge changed c.txt differently.
        git.run(&["checkout", "-q", "--", "."]).unwrap();
        git.run(&["stash", "push", "-q", "-u"]).unwrap();
        git.run(&["checkout", "-q", "-b", "side"]).unwrap();
        commit(&git, "c.txt", "side\n", "side");
        git.run(&["checkout", "-q", "main"]).unwrap();
        commit(&git, "c.txt", "main\n", "main");
        assert!(git.run(&["merge", "side"]).is_err());
        let changes = status(&git).unwrap();
        let conflict = changes
            .iter()
            .find(|c| c.path == "c.txt")
            .expect("the conflicted path is listed");
        assert!(conflict.conflicted);
    }

    #[test]
    fn file_log_follows_renames_and_reports_parents() {
        let scratch = Scratch::new("file-log");
        let git = scratch.repo("repo");
        // Multi-line, mostly-identical contents: `--follow`'s rename detection is
        // similarity-based, and a one-character file never looks like a rename.
        let five =
            |third: &str, fifth: &str| format!("line one\nline two\n{third}\nline four\n{fifth}\n");
        commit(&git, "a.txt", &five("line three", "line five"), "first");
        commit(
            &git,
            "a.txt",
            &five("line three changed", "line five"),
            "second",
        );
        git.run(&["mv", "a.txt", "b.txt"]).unwrap();
        commit(
            &git,
            "b.txt",
            &five("line three changed", "line five edited"),
            "third",
        );

        let log = file_log(&git, "b.txt", 100).unwrap();
        assert_eq!(log.len(), 3, "{log:?}");
        assert_eq!(log[0].message, "third");
        assert_eq!(log[0].hash.len(), 40);
        assert_eq!(log[0].parents, vec![log[1].hash.clone()]);
        // The scratch's identity comes from its environment (GIT_AUTHOR_NAME), not config.
        assert_eq!(log[0].author, "Test");
        assert!(
            log.iter().any(|entry| entry.message == "first"),
            "--follow reaches the commits before the rename"
        );
        // Every entry names the path the file had at its own commit: the commits before
        // the rename carry a.txt, so the row's diff reads that side at a.txt.
        assert_eq!(log[0].path, "b.txt");
        assert_eq!(log[1].path, "a.txt");
        assert_eq!(log[2].path, "a.txt");
    }

    #[test]
    fn stash_apply_pop_and_drop_take_the_entry_hash_as_the_selector() {
        let scratch = Scratch::new("scm-stash-hash");
        let git = scratch.repo("repo");
        write(&git, "README.md", "older\n");
        push_stash(&git, "the older stash", false).unwrap();
        write(&git, "README.md", "newer\n");
        push_stash(&git, "the newer stash", false).unwrap();

        let list = stashes(&git).unwrap();
        assert_eq!(list.len(), 2);
        // The list's selector is the entry's own commit hash: an index races any other
        // window that pushes or drops a stash meanwhile.
        assert_eq!(list[0].selector, list[0].hash);
        assert_eq!(list[1].selector, list[1].hash);
        assert!(list[0].message.contains("newer"));
        assert!(list[1].message.contains("older"));
        let older = list[1].hash.clone();

        // A push after the listing shifts every index — a stale listing's index would
        // now name the newer entry, the hash still names its own.
        write(&git, "README.md", "third\n");
        push_stash(&git, "the third stash", false).unwrap();

        // Applying the older entry by its hash restores its content, however far the
        // list has shifted.
        apply_stash(&git, &older, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.repo.join("README.md")).unwrap(),
            "older\n"
        );
        // The tree returns to clean first: git refuses to overwrite a locally modified
        // file with another stash entry's content.
        git.run(&["checkout", "-q", "--", "README.md"]).unwrap();

        // Dropping the older entry by hash removes exactly that one; the third and the
        // newer survive.
        drop_stash(&git, &older).unwrap();
        let left = stashes(&git).unwrap();
        assert_eq!(left.len(), 2);
        assert!(left[0].message.contains("third"));
        assert!(left[1].message.contains("newer"));

        // Popping the newer by hash empties its place and restores its content.
        pop_stash(&git, &left[1].selector, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.repo.join("README.md")).unwrap(),
            "newer\n"
        );
        let last = stashes(&git).unwrap();
        assert_eq!(last.len(), 1);
        assert!(last[0].message.contains("third"));

        // An unknown hash refuses instead of dropping whatever sits at some index.
        let error = drop_stash(&git, &"9".repeat(40)).unwrap_err();
        assert!(error.contains("not a stash reference"), "{error}");
        assert_eq!(stashes(&git).unwrap().len(), 1);
    }

    #[test]
    fn push_without_an_upstream_refuses_to_pick_among_several_remotes() {
        let scratch = Scratch::new("scm-push-multi-remote");
        let git = scratch.repo("repo");
        let origin = scratch.bare("origin.git");
        let mirror = scratch.bare("mirror.git");
        git.run(&["remote", "add", "origin", &origin.display().to_string()])
            .unwrap();
        git.run(&["remote", "add", "mirror", &mirror.display().to_string()])
            .unwrap();

        // The silent "first remote" guess published the branch to the wrong server;
        // choosing the remote is the frontend's pick, so several remotes fail loudly.
        let error = push(&git, None, false, false).unwrap_err();
        assert!(error.contains("several remotes"), "{error}");
        assert!(
            scratch
                .git(&origin)
                .output(&["rev-parse", "--verify", "main"])
                .is_err(),
            "nothing was pushed to the first remote"
        );

        // The chosen remote publishes and records the upstream, exactly as the single
        // remote's own path does (the publish passes set_upstream).
        push(&git, Some("mirror"), true, false).unwrap();
        assert_eq!(upstream(&git).as_deref(), Some("mirror/main"));
        assert_eq!(
            scratch
                .git(&mirror)
                .output(&["rev-parse", "main"])
                .unwrap()
                .trim(),
            head(&git)
        );
    }

    #[test]
    fn tag_stash_and_branch_operations_run() {
        let scratch = Scratch::new("scm-ops");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "one\n", "init");

        add_tag(&git, "light", "", "", false).unwrap();
        add_tag(&git, "v1", "", "release one", false).unwrap();
        assert_eq!(git.output(&["tag", "--list"]).unwrap().lines().count(), 2);
        assert!(
            git.output(&["cat-file", "-t", "v1"]).unwrap().trim() == "tag",
            "a message makes an annotated tag object"
        );
        delete_tag(&git, "v1").unwrap();

        git.run(&["branch", "topic"]).unwrap();
        rename_branch(&git, "topic", "feature").unwrap();
        delete_branch(&git, "feature", true).unwrap();
        assert_eq!(
            git.output(&["branch", "--list", "feature"]).unwrap().trim(),
            ""
        );

        write(&git, "a.txt", "wip\n");
        push_stash(&git, "mine", true).unwrap();
        assert!(stashes(&git).unwrap()[0].message.contains("mine"));
        git.run(&["stash", "pop", "-q"]).unwrap();

        git.run(&["branch", "side"]).unwrap();
        merge(&git, "side").unwrap();
        undo_last_commit(&git).unwrap();
        // `repo()` made the initial commit before the test's own "init" one; undo drops the
        // latter (its changes stay staged).
        assert_eq!(subject(&git, "HEAD"), "Initial commit");
        assert!(!git
            .output(&["diff", "--name-only", "--cached"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn cherry_pick_revert_and_the_reset_modes_run() {
        let scratch = Scratch::new("scm-rewrite");
        let mut git = scratch.repo("repo");
        let base = commit(&git, "a.txt", "one\n", "base");
        git.run(&["checkout", "-q", "-b", "side"]).unwrap();
        // The cherry-pick keeps the author stamp and takes the committer stamp from the
        // clock, whose second resolution a fast runner can land inside the picked
        // commit's own second — the replay onto this commit's parent would then mint a
        // byte-identical object and hash. Pinning this commit's committer date keeps the
        // pick's fresh stamp from ever matching it.
        git.env.push((
            "GIT_COMMITTER_DATE".into(),
            "2020-01-01T00:00:00 +0000".into(),
        ));
        let picked = commit(&git, "picked.txt", "picked\n", "The picked change");
        git.env.pop();
        git.run(&["checkout", "-q", "main"]).unwrap();
        assert!(!git.repo.join("picked.txt").exists());

        // The cherry-pick lands the side commit's change as a NEW commit on main.
        let picked_subject = cherry_pick(&git, &picked).unwrap();
        assert_eq!(picked_subject, "The picked change");
        assert_eq!(subject(&git, "HEAD"), "The picked change");
        assert_ne!(rev(&git, "HEAD"), picked);
        assert!(git.repo.join("picked.txt").exists());

        // The revert undoes it with a new inverse commit; the file is gone again.
        let reverted = revert_commit(&git, "HEAD").unwrap();
        assert!(reverted.starts_with("Revert"), "{reverted}");
        assert!(!git.repo.join("picked.txt").exists());
        assert_eq!(rev(&git, "HEAD^^"), base);

        // An unknown ref fails with git's own complaint and no conflict hint.
        let error = cherry_pick(&git, "does-not-exist").unwrap_err();
        assert!(!error.contains("Conflicted paths"), "{error}");
        assert!(revert_commit(&git, "does-not-exist").is_err());

        // The reset modes: two commits and a staged, dirty file against `base`.
        commit(&git, "b.txt", "b\n", "second");
        commit(&git, "c.txt", "c\n", "third");
        write(&git, "a.txt", "dirty\n");
        git.run(&["add", "--", "a.txt"]).unwrap();

        // Soft keeps the index and the working tree whole (the file stays staged, b and c
        // come back staged too).
        reset_ref(&git, &base, ResetMode::parse("soft").unwrap()).unwrap();
        assert_eq!(head(&git), base);
        assert_eq!(
            std::fs::read_to_string(git.repo.join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert!(git
            .output(&["diff", "--name-only", "--cached"])
            .unwrap()
            .contains("a.txt"));

        // Mixed resets the index but keeps the working tree's files.
        reset_ref(&git, &base, ResetMode::parse("mixed").unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.repo.join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert!(git
            .output(&["diff", "--name-only", "--cached"])
            .unwrap()
            .trim()
            .is_empty());

        // Hard resets the working tree too — the dirty state is gone.
        reset_ref(&git, &base, ResetMode::parse("hard").unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.repo.join("a.txt")).unwrap(),
            "one\n"
        );

        // An unknown mode never reaches git.
        assert!(ResetMode::parse("weak").is_err());
        assert!(ResetMode::parse("").is_err());
    }

    /// A reset target may be a revision expression, exactly as VS Code's "Reset Current
    /// Branch to Commit" accepts: the target is verified by asking git
    /// (`rev-parse --verify <expr>^{commit}`) — the ref-name validator cannot judge the
    /// expressions' `~`/`^`/`@{` parts. Only the shapes that could never be a revision are
    /// refused without a spawn.
    #[test]
    fn a_reset_target_may_be_a_revision_expression() {
        let scratch = Scratch::new("scm-reset-expression");
        let git = scratch.repo("repo");
        let base = commit(&git, "a.txt", "one\n", "base");
        let second = commit(&git, "b.txt", "two\n", "second");

        // The expressions resolve like the hashes do.
        reset_ref(&git, "HEAD~1", ResetMode::parse("mixed").unwrap()).unwrap();
        assert_eq!(head(&git), base);
        // Mixed keeps the working tree's file, but the commit is gone from the branch.
        assert!(
            git.repo.join("b.txt").exists(),
            "mixed keeps the working tree's file"
        );
        assert!(
            git.output(&["ls-files", "--", "b.txt"])
                .unwrap()
                .trim()
                .is_empty(),
            "b.txt left the index"
        );
        assert!(
            !git.output(&["log", "--format=%s", "-2"])
                .unwrap()
                .contains("second"),
            "the second commit left the branch"
        );
        reset_ref(&git, &second, ResetMode::parse("hard").unwrap()).unwrap();
        assert_eq!(head(&git), second);
        reset_ref(&git, "HEAD^", ResetMode::parse("hard").unwrap()).unwrap();
        assert_eq!(head(&git), base);

        // verify_commitish: the acceptance and refusal edges, without a write.
        assert!(verify_commitish(&git, "HEAD").is_ok());
        assert!(verify_commitish(&git, "main").is_ok());
        assert!(verify_commitish(&git, &base).is_ok());
        assert!(verify_commitish(&git, "no-such-ref").is_err());
        assert!(verify_commitish(&git, "").is_err());
        assert!(verify_commitish(&git, "   ").is_err());
        let error = verify_commitish(&git, "--hard").unwrap_err();
        assert!(
            error.contains("--hard"),
            "the refusal names the target: {error}"
        );
        // …and the refusal is the validator's, not git's option parser eating one.
        assert!(reset_ref(&git, "--hard", ResetMode::parse("soft").unwrap()).is_err());
    }

    /// A stage batch of hundreds of paths splits into byte-bounded chunks
    /// ([`crate::runner::run_chunked`]) and still stages everything — one argument per
    /// path on a single command line used to walk into Windows' 32 767-character
    /// CreateProcess ceiling on exactly this shape.
    #[test]
    fn a_stage_of_many_untracked_files_chunks_the_spawn_and_stages_everything() {
        let scratch = Scratch::new("scm-stage-many");
        let git = scratch.repo("repo");
        // 240 untracked files with names long enough that the batch cannot fit one
        // spawn's command line: each name ~60 bytes, the whole listing well past the
        // 8 000-byte chunk budget — several spawns, one outcome.
        let mut names = Vec::new();
        for i in 0..240 {
            let name = format!("{}{i}.txt", "p".repeat(60));
            write(&git, &name, "content\n");
            names.push(name);
        }
        stage_all_untracked(&git).unwrap();
        let staged = git.output(&["diff", "--name-only", "--cached"]).unwrap();
        for name in &names {
            assert!(staged.contains(name.as_str()), "{name} must be staged");
        }
        assert_eq!(staged.lines().count(), names.len(), "nothing else joined");
    }

    /// A name git itself cannot decode (verified live on this machine: an unpaired
    /// surrogate is a legal NTFS name, and `git status --porcelain -z` reports it with
    /// the bytes `EF BF BD` — U+FFFD — where the surrogate stood) cannot be addressed by
    /// any pathspec. The batch stages the rest and leaves it unstaged, instead of
    /// failing the whole command on git's "pathspec did not match".
    #[cfg(windows)]
    #[test]
    fn stage_all_untracked_leaves_a_name_git_cannot_decode_unstaged() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let scratch = Scratch::new("scm-stage-undecodable");
        let git = scratch.repo("repo");
        write(&git, "good.txt", "staged\n");
        // The surrogate-named file goes through the wide API directly — no &str can
        // spell a lone surrogate (UTF-8 cannot encode it), which is exactly the point.
        let mut wide: Vec<u16> = git.repo.as_os_str().encode_wide().collect();
        wide.push('\\' as u16);
        wide.push(0xD800);
        wide.extend("bad.txt".encode_utf16());
        let bad = std::ffi::OsString::from_wide(&wide);
        std::fs::File::create(git.repo.join(&bad)).unwrap();

        // The premise: git reports the name with the replacement character in it, and no
        // pathspec matches the real file.
        let listed = git
            .output(&[
                "-c",
                "core.quotepath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
            ])
            .unwrap();
        assert!(
            listed.contains('\u{FFFD}'),
            "git lists the name lossily: {listed:?}"
        );

        stage_all_untracked(&git).unwrap();
        let staged = git.output(&["diff", "--name-only", "--cached"]).unwrap();
        assert!(
            staged.contains("good.txt"),
            "the representable path stages: {staged:?}"
        );
        assert!(
            !staged.contains('\u{FFFD}'),
            "the undecodable name stays out"
        );
        let still_untracked = git
            .output(&[
                "-c",
                "core.quotepath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
            ])
            .unwrap();
        assert!(
            still_untracked.contains('\u{FFFD}'),
            "the file itself is untouched"
        );
    }

    #[test]
    fn a_conflicting_cherry_pick_names_the_conflicted_paths() {
        let scratch = Scratch::new("scm-cherry-conflict");
        let git = scratch.repo("repo");
        commit(&git, "c.txt", "base\n", "base");
        git.run(&["checkout", "-q", "-b", "side"]).unwrap();
        let side_commit = commit(&git, "c.txt", "side\n", "side");
        git.run(&["checkout", "-q", "main"]).unwrap();
        commit(&git, "c.txt", "main\n", "main");

        let error = cherry_pick(&git, &side_commit).unwrap_err();
        assert!(error.contains("Conflicted paths"), "{error}");
        assert!(error.contains("c.txt"), "{error}");
        // The repository stays mid-cherry-pick for the user to resolve, exactly as git
        // leaves it after a stopped cherry-pick.
        assert!(!git.output(&["ls-files", "-u"]).unwrap().trim().is_empty());
    }

    #[test]
    fn checkout_of_a_hash_detaches_and_branch_merged_answers_the_delete_guard() {
        let scratch = Scratch::new("scm-detached");
        let git = scratch.repo("repo");
        let first = commit(&git, "a.txt", "one\n", "first");
        commit(&git, "b.txt", "two\n", "second");

        // The full hash checks out detached.
        checkout(&git, &first).unwrap();
        assert_eq!(scratch_current_branch(&git).as_deref(), None, "detached");
        assert_eq!(head(&git), first);
        // So does an abbreviated one.
        checkout(&git, "main").unwrap();
        checkout(&git, &first[..7]).unwrap();
        assert_eq!(head(&git), first);
        checkout(&git, "main").unwrap();

        // The merged fact the delete guard words itself by.
        git.run(&["branch", "topic", "main"]).unwrap();
        assert!(branch_merged(&git, "topic").unwrap());
        git.run(&["checkout", "-q", "topic"]).unwrap();
        commit(&git, "c.txt", "three\n", "topic only");
        git.run(&["checkout", "-q", "main"]).unwrap();
        assert!(!branch_merged(&git, "topic").unwrap());
        // An unknown ref is the error, never a wrong merged answer.
        assert!(branch_merged(&git, "no-such-branch").is_err());
    }

    #[test]
    fn push_branch_publishes_a_local_branch_by_name_from_any_checkout() {
        let scratch = Scratch::new("scm-push-branch");
        let git = scratch.repo("repo");
        let bare = scratch.bare("origin.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();
        commit(&git, "a.txt", "one\n", "one");
        git.run(&["checkout", "-q", "-b", "feature"]).unwrap();
        commit(&git, "f.txt", "feature\n", "feature");

        // `main` is pushed while `feature` is the checkout — the named branch's own tip,
        // not the checked-out one's.
        push_branch(&git, "origin", "main", false).unwrap();
        assert_eq!(
            scratch
                .git(&bare)
                .output(&["rev-parse", "main"])
                .unwrap()
                .trim(),
            rev(&git, "main")
        );
        assert_ne!(rev(&git, "main"), head(&git));

        assert!(push_branch(&git, "origin", "--evil", false).is_err());
        assert!(push_branch(&git, "--evil", "main", false).is_err());
    }

    #[test]
    fn delete_remote_branch_and_tag_push_the_deletions() {
        let scratch = Scratch::new("scm-delete-remote");
        let git = scratch.repo("repo");
        let bare = scratch.bare("origin.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();
        let base = commit(&git, "a.txt", "one\n", "one");
        git.run(&["push", "-q", "origin", "main"]).unwrap();
        // A branch the bare's own HEAD does not point at: deleting the remote's current
        // branch is denied by the remote itself, never a concern of this operation's.
        git.run(&["branch", "topic"]).unwrap();
        git.run(&["push", "-q", "origin", "topic"]).unwrap();
        add_tag(&git, "v1", "", "release", false).unwrap();
        git.run(&["push", "-q", "origin", "v1"]).unwrap();
        let origin = scratch.git(&bare);

        // The remote branch goes; the local one (and its commit) stay.
        delete_remote_branch(&git, "origin", "topic").unwrap();
        assert!(origin
            .output(&["rev-parse", "--verify", "refs/heads/topic"])
            .is_err());
        assert_eq!(head(&git), base);
        // The names are validated before git ever runs.
        assert!(delete_remote_branch(&git, "origin", "--evil").is_err());
        assert!(delete_remote_branch(&git, "--evil", "topic").is_err());
        // An unknown tag is the remote's own complaint.
        assert!(delete_remote_tag(&git, "origin", "no-such").is_err());

        delete_remote_tag(&git, "origin", "v1").unwrap();
        assert!(origin
            .output(&["rev-parse", "--verify", "refs/tags/v1"])
            .is_err());
        assert_eq!(tags(&git).unwrap(), vec!["v1".to_owned()]);
        assert!(delete_remote_tag(&git, "origin", "--evil").is_err());
    }

    #[test]
    fn abort_merge_and_rebase_back_out_of_the_stopped_operations() {
        let scratch = Scratch::new("scm-abort");
        let git = scratch.repo("repo");
        commit(&git, "c.txt", "base\n", "base");

        // Nothing pending: the state says so and the aborts refuse with the plain answer.
        let state = operation_state(&git).unwrap();
        assert!(!state.merge && !state.rebase);
        let error = abort_merge(&git).unwrap_err();
        assert!(error.contains("no merge in progress"), "{error}");
        let error = abort_rebase(&git).unwrap_err();
        assert!(error.contains("no rebase in progress"), "{error}");

        // A stopped merge is detected and aborted: the branch is back at its tip and the
        // index holds no unmerged paths.
        git.run(&["checkout", "-q", "-b", "side"]).unwrap();
        commit(&git, "c.txt", "side\n", "side");
        git.run(&["checkout", "-q", "main"]).unwrap();
        commit(&git, "c.txt", "main\n", "main");
        assert!(git.run(&["merge", "side"]).is_err());
        assert!(operation_state(&git).unwrap().merge);
        abort_merge(&git).unwrap();
        assert!(!operation_state(&git).unwrap().merge);
        assert_eq!(subject(&git, "HEAD"), "main");
        assert!(git.output(&["ls-files", "-u"]).unwrap().trim().is_empty());

        // A stopped rebase too: the branch is back where it stood before the rebase began.
        git.run(&["checkout", "-q", "side"]).unwrap();
        commit(&git, "d.txt", "d\n", "side two");
        let side_tip = head(&git);
        assert!(git.run(&["rebase", "main"]).is_err());
        assert!(operation_state(&git).unwrap().rebase);
        assert!(
            !operation_state(&git).unwrap().merge,
            "rebase is not a merge"
        );
        abort_rebase(&git).unwrap();
        assert!(!operation_state(&git).unwrap().rebase);
        assert_eq!(head(&git), side_tip);
        assert!(git.output(&["ls-files", "-u"]).unwrap().trim().is_empty());
    }

    #[test]
    fn push_tags_pushes_the_local_tags_to_the_chosen_remote() {
        let scratch = Scratch::new("scm-push-tags");
        let git = scratch.repo("repo");
        let bare = scratch.bare("origin.git");
        git.run(&["remote", "add", "origin", &bare.display().to_string()])
            .unwrap();
        commit(&git, "a.txt", "one\n", "one");
        add_tag(&git, "light", "", "", false).unwrap();
        add_tag(&git, "v1", "", "release one", false).unwrap();

        push_tags(&git, "origin").unwrap();
        let origin = scratch.git(&bare);
        assert_eq!(
            origin.output(&["tag", "--list"]).unwrap().lines().count(),
            2
        );
        assert!(push_tags(&git, "--evil").is_err());

        // Without a named remote the upstream's remote answers, once there is one.
        let lonely = scratch.repo("lonely");
        add_tag(&lonely, "v1", "", "", false).unwrap();
        assert!(push_tags(&lonely, "origin").is_err(), "no remotes at all");
        git.run(&["push", "-q", "-u", "origin", "main"]).unwrap();
        push_tags(&git, "origin").unwrap();
        assert_eq!(
            origin.output(&["tag", "--list"]).unwrap().lines().count(),
            2,
            "an already-pushed tag set pushes idempotently"
        );
    }

    #[test]
    fn stage_all_tracked_and_untracked_stage_their_half_alone() {
        let scratch = Scratch::new("scm-stage-halves");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "one\n", "one");
        commit(&git, "b.txt", "b\n", "two");
        write(&git, "a.txt", "two\n");
        std::fs::remove_file(git.repo.join("b.txt")).unwrap();
        write(&git, "c.txt", "new\n");

        // Tracked only: the modification and the deletion are staged, the untracked file
        // stays out of the index.
        stage_all_tracked(&git).unwrap();
        let cached = git.output(&["diff", "--cached", "--name-status"]).unwrap();
        assert!(cached.contains("M\ta.txt"), "{cached}");
        assert!(cached.contains("D\tb.txt"), "{cached}");
        assert!(
            git.output(&["ls-files", "--", "c.txt"])
                .unwrap()
                .trim()
                .is_empty(),
            "the untracked file is not staged"
        );

        // Untracked only: the staged halves reset first, then only c.txt joins the index.
        git.run(&["reset", "-q"]).unwrap();
        stage_all_untracked(&git).unwrap();
        let cached = git.output(&["diff", "--cached", "--name-status"]).unwrap();
        assert_eq!(cached.trim(), "A\tc.txt");
        let unstaged = git.output(&["diff", "--name-status"]).unwrap();
        assert!(unstaged.contains("M\ta.txt"), "{unstaged}");
        assert!(unstaged.contains("D\tb.txt"), "{unstaged}");

        // A clean tree's untracked half has nothing to do: the staged new file is gone with
        // the hard reset (it lived only in the index), so nothing is left to stage.
        git.run(&["reset", "-q", "--hard"]).unwrap();
        assert!(
            !git.repo.join("c.txt").exists(),
            "the staged new file is gone"
        );
        stage_all_untracked(&git).unwrap();
        assert!(git
            .output(&["diff", "--cached", "--name-only"])
            .unwrap()
            .trim()
            .is_empty());
    }
}
