//! The Source Control view: status listing and mutations alike through the git CLI.
//!
//! The status read parses `git status --porcelain` directly (one spawn per refresh — the
//! watcher's debounced batches pace it, the same way VS Code's own Git extension works); the
//! write path runs `git` deliberately — reproducing staging/commit/merge through anything else
//! would mean reimplementing what git already does well.

use std::path::Path;

use ggs_base::workspace::WorkspaceRoots;
use ggs_git::ops;
use ggs_git::runner::{has_undecodable_name, run_chunked, Git};
use tauri::State;

/// The repository a command acts on: the one the view names (`repo`, a submodule's section
/// of the view), or the open repository when it names none. See `WorkspaceRoots::resolve_repo`.
fn open_repo(roots: &State<WorkspaceRoots>, repo: Option<String>) -> Result<String, String> {
    roots.resolve_repo(repo)
}

/// The working tree's changes, staged and unstaged halves kept apart, as the two sections of
/// the Source Control view list them.
#[tauri::command]
pub async fn scm_status(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<Vec<ops::ScmStatusChange>, String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::status(&git))
        .await
        .map_err(|e| e.to_string())?
}

/// A file's commits, newest first, following the path across renames — the Timeline view's
/// listing.
#[tauri::command]
pub async fn file_log(
    roots: State<'_, WorkspaceRoots>,
    path: String,
    limit: Option<usize>,
    repo: Option<String>,
) -> Result<Vec<ops::FileLogEntry>, String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || {
        ops::file_log(&git, &path, limit.unwrap_or(300).clamp(1, 1000))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---------- The palette's mutations (branch/remote/stash/tag) ---------- */

#[tauri::command]
pub async fn scm_rename_branch(
    roots: State<'_, WorkspaceRoots>,
    old_name: String,
    new_name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::rename_branch(&git(&roots, repo)?, &old_name, &new_name)
}

#[tauri::command]
pub async fn scm_delete_branch(
    roots: State<'_, WorkspaceRoots>,
    branch_name: String,
    force: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::delete_branch(&git(&roots, repo)?, &branch_name, force)
}

#[tauri::command]
pub async fn scm_delete_remote_branch(
    roots: State<'_, WorkspaceRoots>,
    remote: String,
    branch: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::delete_remote_branch(&git(&roots, repo)?, &remote, &branch)
}

#[tauri::command]
pub async fn scm_delete_remote_tag(
    roots: State<'_, WorkspaceRoots>,
    remote: String,
    tag_name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::delete_remote_tag(&git(&roots, repo)?, &remote, &tag_name)
}

#[tauri::command]
pub async fn scm_merge(
    roots: State<'_, WorkspaceRoots>,
    name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::merge(&git(&roots, repo)?, &name)
}

#[tauri::command]
pub async fn scm_rebase(
    roots: State<'_, WorkspaceRoots>,
    name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::rebase(&git(&roots, repo)?, &name)
}

/// Whether a stopped merge or rebase is pending — the fact the view's abort entries
/// word themselves by (and hide behind: the palette commands answer it before asking).
#[tauri::command]
pub async fn scm_operation_state(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<ops::OperationState, String> {
    ops::operation_state(&git(&roots, repo)?)
}

#[tauri::command]
pub async fn scm_abort_merge(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    ops::abort_merge(&git(&roots, repo)?)
}

#[tauri::command]
pub async fn scm_abort_rebase(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    ops::abort_rebase(&git(&roots, repo)?)
}

#[tauri::command]
pub async fn scm_add_remote(
    roots: State<'_, WorkspaceRoots>,
    name: String,
    url: String,
    fetch: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::add_remote(&git(&roots, repo)?, &name, &url, fetch)
}

#[tauri::command]
pub async fn scm_delete_remote(
    roots: State<'_, WorkspaceRoots>,
    name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::delete_remote(&git(&roots, repo)?, &name)
}

#[tauri::command]
pub async fn scm_push_stash(
    roots: State<'_, WorkspaceRoots>,
    message: String,
    include_untracked: bool,
    staged: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::push_stash(&git(&roots, repo)?, &message, include_untracked, staged)
}

#[tauri::command]
pub async fn scm_apply_stash(
    roots: State<'_, WorkspaceRoots>,
    selector: String,
    reinstate_index: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::apply_stash(&git(&roots, repo)?, &selector, reinstate_index)
}

#[tauri::command]
pub async fn scm_pop_stash(
    roots: State<'_, WorkspaceRoots>,
    selector: String,
    reinstate_index: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::pop_stash(&git(&roots, repo)?, &selector, reinstate_index)
}

#[tauri::command]
pub async fn scm_drop_stash(
    roots: State<'_, WorkspaceRoots>,
    selector: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::drop_stash(&git(&roots, repo)?, &selector)
}

#[tauri::command]
pub async fn scm_add_tag(
    roots: State<'_, WorkspaceRoots>,
    tag_name: String,
    commit_hash: String,
    message: String,
    force: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::add_tag(
        &git(&roots, repo)?,
        &tag_name,
        &commit_hash,
        &message,
        force,
    )
}

#[tauri::command]
pub async fn scm_delete_tag(
    roots: State<'_, WorkspaceRoots>,
    tag_name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::delete_tag(&git(&roots, repo)?, &tag_name)
}

/// The undone commit's message travels back, so the commit input can carry it.
#[tauri::command]
pub async fn scm_undo_last_commit(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<String, String> {
    ops::undo_last_commit(&git(&roots, repo)?)
}

fn git(roots: &State<WorkspaceRoots>, repo: Option<String>) -> Result<Git, String> {
    Ok(Git::new(open_repo(roots, repo)?))
}

/// Turn the open folder into a Git repository (`git init`), so the git-backed views — the
/// graph, the Source Control view, the branch in the status bar — come alive. The folder
/// itself is the repository's root; the caller re-opens it to re-resolve everything.
#[tauri::command]
pub async fn git_init(roots: State<'_, WorkspaceRoots>) -> Result<String, String> {
    let folder = open_repo(&roots, None)?;
    Git::new(&folder).run(&["init"])?;
    Ok(folder)
}

/// The batch writes' decode-replacement guard: git cannot address a file by the name it
/// reported when that name carries U+FFFD ([`ggs_git::runner::has_undecodable_name`] —
/// git's own lossy decode substituted it, so no pathspec matches the real file). The
/// write is refused with the path called out instead of failing in git with a "pathspec
/// did not match" that names nothing useful; the frontend raises the same refusal in the
/// user's language before the spawn, this one catching every other way in.
fn refuse_undecodable(action: &str, paths: &[String]) -> Result<(), String> {
    if let Some(path) = paths.iter().find(|p| has_undecodable_name(p)) {
        return Err(format!(
            "{action} refused: \"{path}\" — the name contains U+FFFD, git's replacement for bytes \
             it could not decode, so the file cannot be addressed by the reported name. Rename it, \
             or act on it from a terminal with its original name."
        ));
    }
    Ok(())
}

/// Stage the listed paths (`git add --all --`), in byte-bounded chunks — a selection of
/// hundreds of paths keeps every spawn's command line under Windows' 32 767-character
/// ceiling ([`ggs_git::runner::run_chunked`]; the runner's error-206 ladder cannot rescue
/// argument length).
pub(crate) fn stage_paths(git: &ggs_git::runner::Git, paths: &[String]) -> Result<(), String> {
    refuse_undecodable("Stage", paths)?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    run_chunked(git, &["add", "--all", "--"], &refs)
}

#[tauri::command]
pub async fn git_stage(
    roots: State<'_, WorkspaceRoots>,
    paths: Vec<String>,
    repo: Option<String>,
) -> Result<(), String> {
    stage_paths(&git(&roots, repo)?, &paths)
}

#[tauri::command]
pub async fn git_stage_all(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    git(&roots, repo)?.run(&["add", "--all"])
}

/// Stage only the tracked files' changes ("Stage All Tracked Changes"): modifications and
/// deletions across the whole tree, never the untracked ones.
#[tauri::command]
pub async fn git_stage_all_tracked(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    ops::stage_all_tracked(&git(&roots, repo)?)
}

/// Stage only the untracked files ("Stage All Untracked Changes"); the tracked files'
/// changes stay unstaged.
#[tauri::command]
pub async fn git_stage_all_untracked(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    ops::stage_all_untracked(&git(&roots, repo)?)
}

pub(crate) fn unstage_paths(git: &ggs_git::runner::Git, paths: &[String]) -> Result<(), String> {
    refuse_undecodable("Unstage", paths)?;
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    // On an unborn HEAD `git reset HEAD` fails: the first commit does not exist yet, so the
    // staged blob can only be removed from the index directly. Both shapes are incremental,
    // so the batch rides the byte-bounded chunks ([`ggs_git::runner::run_chunked`]) —
    // hundreds of paths never overflow the Windows command-line ceiling.
    if git.run(&["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        run_chunked(git, &["rm", "-q", "--cached", "--"], &refs)
    } else {
        run_chunked(git, &["reset", "-q", "HEAD", "--"], &refs)
    }
}

#[tauri::command]
pub async fn git_unstage(
    roots: State<'_, WorkspaceRoots>,
    paths: Vec<String>,
    repo: Option<String>,
) -> Result<(), String> {
    unstage_paths(&git(&roots, repo)?, &paths)
}

#[tauri::command]
pub async fn git_unstage_all(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    let git = git(&roots, repo)?;
    if git.run(&["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        git.run(&["rm", "-q", "--cached", "-r", "--", "."])
    } else {
        git.run(&["reset", "-q", "HEAD"])
    }
}

/// Commit the index (`amend` re-does the last commit, `signoff` adds the
/// `Signed-off-by:` trailer). An empty message aborts with git's own complaint, shown by
/// the view.
pub(crate) fn commit_index(
    git: &ggs_git::runner::Git,
    message: &str,
    amend: bool,
    signoff: bool,
) -> Result<(), String> {
    if amend && message.is_empty() {
        // `--amend -m ""` aborts with git's empty-message complaint; `--no-edit` keeps the
        // original message, which is what an amend without a new message means.
        let mut args = vec!["commit", "--amend", "--no-edit"];
        if signoff {
            args.push("--signoff");
        }
        return git.run(&args);
    }
    // The message rides git's stdin (`-F -`), never the command line: Windows caps a
    // spawn's command line at 32 767 characters, and a long message pasted into the box
    // used to fail the spawn itself with error 206 before git ever ran.
    let mut args: Vec<&str> = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if signoff {
        args.push("--signoff");
    }
    git.run_input(&args, message.as_bytes())
}

#[tauri::command]
pub async fn git_commit(
    roots: State<'_, WorkspaceRoots>,
    message: String,
    amend: bool,
    signoff: Option<bool>,
    repo: Option<String>,
) -> Result<(), String> {
    commit_index(&git(&roots, repo)?, &message, amend, signoff == Some(true))
}

/// Delete an untracked path through the same Recycle Bin / Trash engine the view's own
/// "Delete File" (`delete_path`) uses — a discarded untracked file is restorable like any
/// deleted one, where the platform keeps a trash. (The discard-all clean half still runs
/// `git clean`, whose confirmation keeps its irreversible wording.)
fn discard_untracked(path: &str, full: &Path) -> Result<(), String> {
    // The metadata read keeps a missing path's own complaint before the trash is asked.
    if let Err(e) = std::fs::symlink_metadata(full) {
        return Err(format!("{path}: {e}"));
    }
    trash::delete(full).map_err(|e| format!("{path}: could not move to the Recycle Bin: {e}"))
}

/// Discard a path's unstaged changes (`git restore`), or send an untracked file to the
/// Recycle Bin — the destructive half is why the view confirms before calling this.
#[tauri::command]
pub async fn git_discard(
    roots: State<'_, WorkspaceRoots>,
    path: String,
    untracked: bool,
    repo: Option<String>,
) -> Result<(), String> {
    // The decode-replacement guard covers both halves: a trash delete of the mangled
    // name would fail the same "no such file" way a restore would.
    refuse_undecodable("Discard", std::slice::from_ref(&path))?;
    if untracked {
        let full = Path::new(&open_repo(&roots, repo)?).join(&path);
        discard_untracked(&path, &full)
    } else {
        git(&roots, repo)?.run(&["restore", "--", &path])
    }
}

/// Discard every unstaged change and delete every untracked file (`git clean`). With explicit
/// lists the operation is limited to those paths: the Source Control view's "Discard All" passes
/// them during a merge, where a pathspec-less `git restore -- .` aborts on the first unmerged
/// path and discards nothing at all.
#[tauri::command]
pub async fn git_discard_all(
    roots: State<'_, WorkspaceRoots>,
    restore: Option<Vec<String>>,
    clean: Option<Vec<String>>,
    repo: Option<String>,
) -> Result<(), String> {
    let git = git(&roots, repo)?;
    match (&restore, &clean) {
        (None, None) => {
            git.run(&["restore", "--", "."])?;
            git.run(&["clean", "-fdq"])
        }
        _ => discard_paths(
            &git,
            &restore.unwrap_or_default(),
            &clean.unwrap_or_default(),
        ),
    }
}

/// Restore the listed tracked paths and delete the listed untracked ones (empty lists skip
/// their half) — the path-limited form of discard-all. Both halves are incremental, so the
/// batches ride the byte-bounded chunks ([`ggs_git::runner::run_chunked`]) and the same
/// decode-replacement guard the other writes carry.
pub(crate) fn discard_paths(git: &Git, restore: &[String], clean: &[String]) -> Result<(), String> {
    refuse_undecodable("Discard", &[restore, clean].concat())?;
    if !restore.is_empty() {
        let refs: Vec<&str> = restore.iter().map(String::as_str).collect();
        run_chunked(git, &["restore", "--"], &refs)?;
    }
    if !clean.is_empty() {
        let refs: Vec<&str> = clean.iter().map(String::as_str).collect();
        run_chunked(git, &["clean", "-fdq", "--"], &refs)?;
    }
    Ok(())
}

/* ---------- The "..." menu (scm_ops) ---------- */

#[tauri::command]
pub async fn scm_branches(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<Vec<ops::BranchInfo>, String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::branches(&git))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_remotes(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<Vec<ops::RemoteInfo>, String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::remotes(&git))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_stashes(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<Vec<ops::StashInfo>, String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::stashes(&git))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_tags(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<Vec<String>, String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::tags(&git))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_pull(
    roots: State<'_, WorkspaceRoots>,
    remote: Option<String>,
    branch: Option<String>,
    rebase: bool,
    repo: Option<String>,
) -> Result<(), String> {
    let git = git(&roots, repo)?;
    // Pull/push/fetch wait on the network: off the async runtime's workers, the same way
    // `scm_status` and `file_log` run their git (a blocking worker starves every other
    // IPC command, the watcher-paced status refresh included).
    tauri::async_runtime::spawn_blocking(move || {
        ops::pull(&git, remote.as_deref(), branch.as_deref(), rebase)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_push(
    roots: State<'_, WorkspaceRoots>,
    remote: Option<String>,
    set_upstream: bool,
    force: bool,
    repo: Option<String>,
) -> Result<(), String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || {
        ops::push(&git, remote.as_deref(), set_upstream, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_sync(
    roots: State<'_, WorkspaceRoots>,
    rebase: bool,
    repo: Option<String>,
) -> Result<(), String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::sync(&git, rebase))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_fetch(
    roots: State<'_, WorkspaceRoots>,
    remote: Option<String>,
    prune: bool,
    repo: Option<String>,
) -> Result<(), String> {
    let git = git(&roots, repo)?;
    tauri::async_runtime::spawn_blocking(move || ops::fetch(&git, remote.as_deref(), prune))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scm_checkout(
    roots: State<'_, WorkspaceRoots>,
    name: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::checkout(&git(&roots, repo)?, &name)
}

#[tauri::command]
pub async fn scm_create_branch(
    roots: State<'_, WorkspaceRoots>,
    name: String,
    from: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    ops::create_branch(&git(&roots, repo)?, &name, from.as_deref())
}

#[tauri::command]
pub async fn scm_amend_last_commit(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<(), String> {
    ops::amend_last_commit(&git(&roots, repo)?)
}

#[tauri::command]
pub async fn scm_reset_to_remote(
    roots: State<'_, WorkspaceRoots>,
    repo: Option<String>,
) -> Result<String, String> {
    ops::reset_to_remote(&git(&roots, repo)?)
}

#[tauri::command]
pub async fn scm_cherry_pick(
    roots: State<'_, WorkspaceRoots>,
    target: String,
    repo: Option<String>,
) -> Result<String, String> {
    ops::cherry_pick(&git(&roots, repo)?, &target)
}

#[tauri::command]
pub async fn scm_revert_commit(
    roots: State<'_, WorkspaceRoots>,
    target: String,
    repo: Option<String>,
) -> Result<String, String> {
    ops::revert_commit(&git(&roots, repo)?, &target)
}

#[tauri::command]
pub async fn scm_reset_ref(
    roots: State<'_, WorkspaceRoots>,
    target: String,
    mode: String,
    repo: Option<String>,
) -> Result<(), String> {
    let mode = ops::ResetMode::parse(&mode)?;
    ops::reset_ref(&git(&roots, repo)?, &target, mode)
}

#[tauri::command]
pub async fn scm_branch_merged(
    roots: State<'_, WorkspaceRoots>,
    branch_name: String,
    repo: Option<String>,
) -> Result<bool, String> {
    ops::branch_merged(&git(&roots, repo)?, &branch_name)
}

#[tauri::command]
pub async fn scm_push_branch(
    roots: State<'_, WorkspaceRoots>,
    remote: String,
    branch: String,
    force: bool,
    repo: Option<String>,
) -> Result<(), String> {
    ops::push_branch(&git(&roots, repo)?, &remote, &branch, force)
}

#[tauri::command]
pub async fn scm_push_tags(
    roots: State<'_, WorkspaceRoots>,
    remote: String,
    repo: Option<String>,
) -> Result<(), String> {
    ops::push_tags(&git(&roots, repo)?, &remote)
}

/// Clone into `parent`; the new repository's path is returned for the app to open. The
/// clone waits on the network — off the main thread, like every other blocking body in
/// this file: a synchronous command freezes the window the whole transfer long.
#[tauri::command]
pub async fn scm_clone(
    url: String,
    parent: String,
    name: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ops::clone(&url, Path::new(&parent), name.as_deref(), &[]).map(|p| p.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gerrit_install_hook(
    roots: State<'_, WorkspaceRoots>,
    remote: String,
    repo: Option<String>,
) -> Result<bool, String> {
    let repo_path = open_repo(&roots, repo)?;
    // The hook download is network I/O on a blocking socket (ureq): off the async
    // runtime's workers, like every other git-and-IO body in this file.
    tauri::async_runtime::spawn_blocking(move || {
        let git = Git::new(&repo_path);
        let url = ops::gerrit_hook_url(&git, &remote, "commit-msg")?;
        let content = ureq::get(&url)
            .call()
            .and_then(|mut response| response.body_mut().read_to_string())
            .map_err(|e| format!("Unable to download the commit-msg hook from {url}: {e}"))?;
        ops::gerrit_install_hook_with(&git, "commit-msg", &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gerrit_push_ref(
    roots: State<'_, WorkspaceRoots>,
    remote: String,
    repo: Option<String>,
) -> Result<Option<String>, String> {
    ops::gerrit_push_ref(&git(&roots, repo)?, &remote)
}

/// The "Git" output channel: everything git printed so far.
/// One line's last change, for the blame gutter.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub hash: String,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub summary: String,
}

/// Parse `git blame --porcelain` output into one entry per line of the file. The porcelain
/// format repeats a commit's headers only the first time it appears, so they are remembered
/// per hash; an all-zero hash marks uncommitted lines.
pub(crate) fn parse_blame(porcelain: &str) -> Vec<BlameLine> {
    use std::collections::HashMap;
    let mut known: HashMap<String, (String, i64, String)> = HashMap::new();
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in porcelain.lines() {
        if let Some(text) = line.strip_prefix('\t') {
            let _ = text;
            if let Some(hash) = current.take() {
                let (author, time, summary) = known.get(&hash).cloned().unwrap_or_default();
                out.push(BlameLine {
                    hash,
                    author,
                    time,
                    summary,
                });
            }
            continue;
        }
        if current.is_none() {
            // "<hash> <orig> <final> [<count>]" opens a line group.
            if let Some(hash) = line.split(' ').next().filter(|h| {
                (40..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit())
            }) {
                current = Some(hash.to_owned());
                known.entry(hash.to_owned()).or_default();
            }
            continue;
        }
        let Some(hash) = current.as_ref() else {
            continue;
        };
        let entry = known.entry(hash.clone()).or_default();
        if let Some(author) = line.strip_prefix("author ") {
            entry.0 = author.to_owned();
        } else if let Some(time) = line.strip_prefix("author-time ") {
            entry.1 = time.trim().parse().unwrap_or(0);
        } else if let Some(summary) = line.strip_prefix("summary ") {
            entry.2 = summary.to_owned();
        }
    }
    out
}

/// Who last changed every line of a file in the working tree (`git blame --porcelain`).
#[tauri::command]
pub async fn scm_blame(
    roots: State<'_, WorkspaceRoots>,
    path: String,
    repo: Option<String>,
) -> Result<Vec<BlameLine>, String> {
    let git = git(&roots, repo)?;
    // Blame of a large file runs seconds to minutes — off the async runtime's workers,
    // the same way `scm_status` and `file_log` run theirs (a blocking worker starves
    // every other IPC command, the watcher-paced status refresh included).
    tauri::async_runtime::spawn_blocking(move || {
        let output = git.output(&["blame", "--porcelain", "--", &path])?;
        Ok(parse_blame(&output))
    })
    .await
    .map_err(|error| format!("blame failed: {error}"))?
}

#[tauri::command]
pub fn git_output_log() -> Vec<String> {
    ggs_git::runner::log_lines()
}

#[tauri::command]
pub fn git_output_clear() {
    ggs_git::runner::clear_log();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_git_helpers::*;
    use ggs_testkit::Scratch;

    #[test]
    fn amend_without_a_message_keeps_the_original_one() {
        let scratch = Scratch::new("amend-empty");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "1\n", "first words");
        write(&git, "a.txt", "2\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        commit_index(&git, "", true, false).unwrap();
        assert_eq!(subject(&git, "HEAD"), "first words");
        commit_index(&git, "reworded", true, false).unwrap();
        assert_eq!(subject(&git, "HEAD"), "reworded");
    }

    #[test]
    fn a_signed_off_commit_carries_the_trailer() {
        let scratch = Scratch::new("commit-signoff");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "1\n", "base");
        write(&git, "a.txt", "2\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        commit_index(&git, "signed work", false, true).unwrap();
        let body = git.output(&["log", "-1", "--format=%B"]).unwrap();
        assert!(body.starts_with("signed work"), "{body}");
        assert!(body.contains("Signed-off-by:"), "{body}");

        // An amend without a message keeps both the original message and the trailer.
        commit_index(&git, "", true, true).unwrap();
        let body = git.output(&["log", "-1", "--format=%B"]).unwrap();
        assert!(body.contains("signed work"), "{body}");
        assert!(body.contains("Signed-off-by:"), "{body}");

        // The plain commit stays trailer-free.
        write(&git, "a.txt", "3\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        commit_index(&git, "unsigned", false, false).unwrap();
        assert!(!git
            .output(&["log", "-1", "--format=%B"])
            .unwrap()
            .contains("Signed-off-by:"));
    }

    #[test]
    fn a_message_longer_than_the_windows_command_line_still_commits() {
        let scratch = Scratch::new("commit-long-message");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "1\n", "base");
        write(&git, "a.txt", "2\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        // 32 767 characters is Windows' whole-command-line ceiling; past it, a message
        // riding `-m` failed the spawn itself with error 206 before git ever ran. The
        // message rides git's stdin (`-F -`) now.
        let message = "m".repeat(40_000);
        commit_index(&git, &message, false, false).unwrap();
        let body = git.output(&["log", "-1", "--format=%B"]).unwrap();
        assert_eq!(body.trim_end(), message);
    }

    #[test]
    fn unstage_works_both_before_and_after_the_first_commit() {
        let scratch = Scratch::new("unstage-unborn");
        let path = scratch.path("repo");
        std::fs::create_dir_all(&path).unwrap();
        let git = scratch.git(&path);
        git.run(&["init", "-q", "-b", "main"]).unwrap();

        // Before any commit exists, HEAD cannot be reset against: the file must still
        // unstaged without an error.
        write(&git, "a.txt", "hello\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        unstage_paths(&git, &["a.txt".to_owned()]).unwrap();
        assert!(git
            .output(&["ls-files", "--", "a.txt"])
            .unwrap()
            .trim()
            .is_empty());

        commit(&git, "a.txt", "hello\n", "initial");
        write(&git, "a.txt", "changed\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        unstage_paths(&git, &["a.txt".to_owned()]).unwrap();
        assert_eq!(
            git.output(&["diff", "--name-only", "--cached"])
                .unwrap()
                .trim(),
            ""
        );
    }

    use ggs_git::runner::is_valid_commit_hash;

    #[test]
    fn discard_paths_leaves_unmerged_and_unlisted_paths_alone() {
        let scratch = Scratch::new("discard-paths");
        let git = scratch.repo("repo");
        commit(&git, "keep.txt", "keep\n", "add keep");
        commit(&git, "conf.txt", "base\n", "base");
        git.run(&["checkout", "-q", "-b", "side"]).unwrap();
        commit(&git, "conf.txt", "side\n", "side");
        git.run(&["checkout", "-q", "main"]).unwrap();
        commit(&git, "conf.txt", "main\n", "main");
        assert!(
            git.run(&["merge", "side"]).is_err(),
            "the merge stops on the conflict"
        );

        write(&git, "README.md", "edited\n");
        write(&git, "keep.txt", "changed\n");
        write(&git, "new.txt", "new\n");
        // The premise: the wholesale form fails outright while a conflict is pending.
        assert!(git.run(&["restore", "--", "."]).is_err());
        write(&git, "README.md", "edited\n");
        write(&git, "keep.txt", "changed\n");
        write(&git, "new.txt", "new\n");

        discard_paths(&git, &["README.md".to_owned()], &["new.txt".to_owned()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(git.repo.join("README.md")).unwrap(),
            "hello\n",
            "the listed tracked path is restored"
        );
        assert!(
            !git.repo.join("new.txt").exists(),
            "the listed untracked path is deleted"
        );
        assert_eq!(
            std::fs::read_to_string(git.repo.join("keep.txt")).unwrap(),
            "changed\n",
            "an unlisted modification survives"
        );
        let conf = std::fs::read_to_string(git.repo.join("conf.txt")).unwrap();
        assert!(
            conf.contains("<<<<<<<"),
            "the conflicted file keeps its markers"
        );
        assert!(
            !git.output(&["ls-files", "-u"]).unwrap().trim().is_empty(),
            "the path stays unmerged"
        );
    }

    #[test]
    fn commit_hash_validation_accepts_sha256_lengths() {
        assert!(is_valid_commit_hash("abcd"));
        assert!(is_valid_commit_hash(&"a".repeat(40)));
        assert!(is_valid_commit_hash(&"a".repeat(64)));
        assert!(!is_valid_commit_hash("abc"));
        assert!(!is_valid_commit_hash(&"a".repeat(65)));
        assert!(!is_valid_commit_hash(&"g".repeat(40)));
    }

    #[test]
    fn an_untracked_discard_moves_the_path_to_the_trash_like_delete_file() {
        let scratch = Scratch::new("discard-untracked-trash");
        let git = scratch.repo("repo");
        // A file and a folder both go through the Recycle Bin engine the view's own
        // "Delete File" uses — never removed outright.
        write(&git, "scratch.txt", "keepable\n");
        let file = git.repo.join("scratch.txt");
        discard_untracked("scratch.txt", &file).unwrap();
        assert!(!file.exists(), "the path left the working tree");

        std::fs::create_dir_all(git.repo.join("scratchdir")).unwrap();
        write(&git, "scratchdir/nested.txt", "nested\n");
        let dir = git.repo.join("scratchdir");
        discard_untracked("scratchdir", &dir).unwrap();
        assert!(!dir.exists(), "the folder went whole");

        // A missing path keeps its own complaint.
        assert!(discard_untracked("gone.txt", &git.repo.join("gone.txt")).is_err());
    }

    /// A stage batch of hundreds of paths splits into byte-bounded chunks
    /// ([`ggs_git::runner::run_chunked`]) and still stages everything — one argument per
    /// path on a single command line walked into Windows' 32 767-character CreateProcess
    /// ceiling on exactly this shape, and the runner's error-206 ladder cannot rescue
    /// argument length.
    #[test]
    fn a_stage_of_many_paths_chunks_the_spawn_and_stages_everything() {
        let scratch = Scratch::new("stage-many-paths");
        let git = scratch.repo("repo");
        // 240 tracked-side edits whose names are long enough that the batch cannot fit
        // one spawn's command line: each ~70 bytes, the whole listing several times past
        // the 8 000-byte chunk budget — several spawns, one outcome.
        let mut paths = Vec::new();
        for i in 0..240 {
            let name = format!("{}{i}.txt", "m".repeat(70));
            write(&git, &name, "edited\n");
            paths.push(name);
        }
        stage_paths(&git, &paths).unwrap();
        let staged = git.output(&["diff", "--name-only", "--cached"]).unwrap();
        for path in &paths {
            assert!(staged.contains(path.as_str()), "{path} must be staged");
        }
        assert_eq!(staged.lines().count(), paths.len(), "nothing else joined");
    }

    /// The chunked unstage matches single-path semantics: one call over a batch leaves
    /// the index exactly as unstaging every path one at a time would, and the working
    /// tree keeps every file.
    #[test]
    fn a_chunked_unstage_matches_single_path_semantics() {
        let scratch = Scratch::new("unstage-chunked");
        let batch = scratch.repo("batch");
        let singles = scratch.repo("singles");
        // The same listing twice, each name long enough that one spawn cannot carry the
        // whole batch (the chunk budget is byte-based; a name-heavy listing splits).
        let mut paths = Vec::new();
        for i in 0..120 {
            let name = format!("{}{i}.txt", "n".repeat(70));
            paths.push(name);
        }
        for git in [&batch, &singles] {
            for path in &paths {
                write(git, path, "staged\n");
            }
            stage_paths(git, &paths).unwrap();
        }

        // One unstage call over the whole batch…
        unstage_paths(&batch, &paths).unwrap();
        // …versus one call per path.
        for path in &paths {
            unstage_paths(&singles, std::slice::from_ref(path)).unwrap();
        }

        // Identical outcomes: nothing staged in either, and identical trees.
        for (label, git) in [("batch", &batch), ("singles", &singles)] {
            assert!(
                git.output(&["diff", "--name-only", "--cached"])
                    .unwrap()
                    .trim()
                    .is_empty(),
                "{label}: nothing stays staged"
            );
            for path in &paths {
                assert_eq!(
                    std::fs::read_to_string(git.repo.join(path)).unwrap(),
                    "staged\n",
                    "{label}: the file keeps its working-tree content"
                );
            }
        }
    }

    /// The decode-replacement guard: a path git cannot address by the name it reported
    /// refuses every write that names it — the error says so and names the path — instead
    /// of failing in git with a "pathspec did not match" that names nothing useful.
    #[test]
    fn the_batch_writes_refuse_a_path_git_cannot_decode() {
        let scratch = Scratch::new("undecodable-guard");
        let git = scratch.repo("repo");
        write(&git, "good.txt", "keep\n");
        git.run(&["add", "--", "good.txt"]).unwrap();

        let mangled = format!("{}bad.txt", ggs_git::runner::REPLACEMENT_CHAR);
        let error = stage_paths(&git, std::slice::from_ref(&mangled)).unwrap_err();
        assert!(
            error.contains("U+FFFD") && error.contains(&mangled),
            "{error}"
        );
        assert!(unstage_paths(&git, std::slice::from_ref(&mangled))
            .unwrap_err()
            .contains("U+FFFD"));
        assert!(discard_paths(&git, std::slice::from_ref(&mangled), &[])
            .unwrap_err()
            .contains("U+FFFD"));
        assert!(discard_paths(&git, &[], std::slice::from_ref(&mangled))
            .unwrap_err()
            .contains("U+FFFD"));

        // The good path next to the bad one keeps its own refusal too: a batch naming an
        // unaddressable path aborts whole, it does not half-apply.
        let error = stage_paths(&git, &["good.txt".to_owned(), mangled.clone()]).unwrap_err();
        assert!(error.contains("U+FFFD"), "{error}");
        let staged = git.output(&["diff", "--name-only", "--cached"]).unwrap();
        assert_eq!(
            staged.trim(),
            "good.txt",
            "the refusal fires before anything new is staged (the setup's own stage is all)"
        );
    }
}

#[cfg(test)]
mod blame_tests {
    use super::parse_blame;

    #[test]
    fn porcelain_blame_yields_one_entry_per_line_with_headers_remembered_per_commit() {
        let porcelain = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
author Ada
author-mail <ada@example.com>
author-time 1700000000
summary first commit
filename a.txt
\tline one
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
\tline two
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1 3 1
author Bob
author-time 1700005000
summary second commit
\tline three
0000000000000000000000000000000000000000 4 4 1
author Not Committed Yet
author-time 1700009000
summary Version of a.txt from a.txt
\tline four
";
        let lines = parse_blame(porcelain);
        assert_eq!(lines.len(), 4);
        assert_eq!(
            (
                lines[0].author.as_str(),
                lines[0].time,
                lines[0].summary.as_str()
            ),
            ("Ada", 1700000000, "first commit")
        );
        assert_eq!(
            lines[1].hash, lines[0].hash,
            "the second line of the group reuses the remembered headers"
        );
        assert_eq!(lines[1].author, "Ada");
        assert_eq!(lines[2].author, "Bob");
        assert!(lines[3].hash.chars().all(|c| c == '0'));
    }

    #[test]
    fn porcelain_blame_accepts_sha256_length_hashes() {
        // A SHA-256 repository's blame headers carry 64 hex digits; dropping them loses
        // every content line of the file.
        let hash = "a".repeat(64);
        let porcelain = format!("{hash} 1 1 1\nauthor Ada\nauthor-time 1700000000\nsummary sha256 commit\nfilename a.txt\n\tline one\n");
        let lines = parse_blame(&porcelain);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].hash, hash);
        assert_eq!(lines[0].author, "Ada");
        assert_eq!(lines[0].summary, "sha256 commit");
    }
}
