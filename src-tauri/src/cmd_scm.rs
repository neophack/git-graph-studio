//! The Source Control view: status listing through the engine, mutations through the git CLI.
//!
//! The engine is deliberately read-only, and reproducing staging/commit through gix would mean
//! reimplementing what git already does well — so the view's write path runs `git` directly,
//! the same seam the extension's CLI backend uses for its writes. The status read itself goes
//! through `cmd_graph`'s engine seam, in this process.

use std::path::Path;

use serde_json::Value;

use crate::git::Git;
use crate::AppState;
use tauri::State;

fn open_repo(state: &State<AppState>) -> Result<String, String> {
    state
        .first_repo()
        .ok_or_else(|| "No repository is open".to_string())
}

/// The working tree's changes, staged and unstaged halves kept apart, as the two sections of
/// the Source Control view list them. Read by the engine, in this process.
#[tauri::command]
pub async fn scm_status(state: State<'_, AppState>) -> Result<Value, String> {
    let repo_path = open_repo(&state)?;
    tauri::async_runtime::spawn_blocking(move || crate::cmd_graph::scm_changes(&repo_path))
        .await
        .map_err(|e| e.to_string())?
}

fn git(state: &State<AppState>) -> Result<Git, String> {
    Ok(Git::new(open_repo(state)?))
}

/// Turn the open folder into a Git repository (`git init`), so the git-backed views — the
/// graph, the Source Control view, the branch in the status bar — come alive. The folder
/// itself is the repository's root; the caller re-opens it to re-resolve everything.
#[tauri::command]
pub async fn git_init(state: State<'_, AppState>) -> Result<String, String> {
    let folder = open_repo(&state)?;
    Git::new(&folder).run(&["init"])?;
    Ok(folder)
}

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    git(&state)?.run(&[&["add", "--all", "--"], &refs[..]].concat())
}

#[tauri::command]
pub async fn git_stage_all(state: State<'_, AppState>) -> Result<(), String> {
    git(&state)?.run(&["add", "--all"])
}

pub(crate) fn unstage_paths(git: &crate::git::Git, paths: &[String]) -> Result<(), String> {
    let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    // On an unborn HEAD `git reset HEAD` fails: the first commit does not exist yet, so the
    // staged blob can only be removed from the index directly.
    if git.run(&["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        git.run(&[&["rm", "-q", "--cached", "--"], &refs[..]].concat())
    } else {
        git.run(&[&["reset", "-q", "HEAD", "--"], &refs[..]].concat())
    }
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    unstage_paths(&git(&state)?, &paths)
}

#[tauri::command]
pub async fn git_unstage_all(state: State<'_, AppState>) -> Result<(), String> {
    let git = git(&state)?;
    if git.run(&["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        git.run(&["rm", "-q", "--cached", "-r", "--", "."])
    } else {
        git.run(&["reset", "-q", "HEAD"])
    }
}

/// Commit the index (`amend` re-does the last commit). An empty message aborts with git's own
/// complaint, shown by the view.
pub(crate) fn commit_index(
    git: &crate::git::Git,
    message: &str,
    amend: bool,
) -> Result<(), String> {
    if amend && message.is_empty() {
        // `--amend -m ""` aborts with git's empty-message complaint; `--no-edit` keeps the
        // original message, which is what an amend without a new message means.
        return git.run(&["commit", "--amend", "--no-edit"]);
    }
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    git.run(&args)
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    message: String,
    amend: bool,
) -> Result<(), String> {
    commit_index(&git(&state)?, &message, amend)
}

/// Discard a path's unstaged changes (`git restore`), or delete an untracked file — the
/// destructive half is why the view confirms before calling this.
#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    path: String,
    untracked: bool,
) -> Result<(), String> {
    if untracked {
        let full = Path::new(&open_repo(&state)?).join(&path);
        let meta = std::fs::symlink_metadata(&full).map_err(|e| format!("{path}: {e}"))?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&full).map_err(|e| format!("{path}: {e}"))
        } else {
            std::fs::remove_file(&full).map_err(|e| format!("{path}: {e}"))
        }
    } else {
        git(&state)?.run(&["restore", "--", &path])
    }
}

/// Discard every unstaged change and delete every untracked file (`git clean`). With explicit
/// lists the operation is limited to those paths: the Source Control view's "Discard All" passes
/// them during a merge, where a pathspec-less `git restore -- .` aborts on the first unmerged
/// path and discards nothing at all.
#[tauri::command]
pub async fn git_discard_all(
    state: State<'_, AppState>,
    restore: Option<Vec<String>>,
    clean: Option<Vec<String>>,
) -> Result<(), String> {
    let git = git(&state)?;
    match (&restore, &clean) {
        (None, None) => {
            git.run(&["restore", "--", "."])?;
            git.run(&["clean", "-fdq"])
        }
        _ => discard_paths(&git, &restore.unwrap_or_default(), &clean.unwrap_or_default()),
    }
}

/// Restore the listed tracked paths and delete the listed untracked ones (empty lists skip
/// their half) — the path-limited form of discard-all.
pub(crate) fn discard_paths(git: &Git, restore: &[String], clean: &[String]) -> Result<(), String> {
    if !restore.is_empty() {
        let refs: Vec<&str> = restore.iter().map(String::as_str).collect();
        git.run(&[&["restore", "--"], &refs[..]].concat())?;
    }
    if !clean.is_empty() {
        let refs: Vec<&str> = clean.iter().map(String::as_str).collect();
        git.run(&[&["clean", "-fdq", "--"], &refs[..]].concat())?;
    }
    Ok(())
}

/* ---------- The "..." menu (scm_ops) ---------- */

use crate::scm_ops;

#[tauri::command]
pub async fn scm_branches(state: State<'_, AppState>) -> Result<Vec<scm_ops::BranchInfo>, String> {
    scm_ops::branches(&git(&state)?)
}

#[tauri::command]
pub async fn scm_remotes(state: State<'_, AppState>) -> Result<Vec<scm_ops::RemoteInfo>, String> {
    scm_ops::remotes(&git(&state)?)
}

#[tauri::command]
pub async fn scm_stashes(state: State<'_, AppState>) -> Result<Vec<scm_ops::StashInfo>, String> {
    scm_ops::stashes(&git(&state)?)
}

#[tauri::command]
pub async fn scm_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    scm_ops::tags(&git(&state)?)
}

#[tauri::command]
pub async fn scm_pull(
    state: State<'_, AppState>,
    remote: Option<String>,
    branch: Option<String>,
    rebase: bool,
) -> Result<(), String> {
    scm_ops::pull(&git(&state)?, remote.as_deref(), branch.as_deref(), rebase)
}

#[tauri::command]
pub async fn scm_push(
    state: State<'_, AppState>,
    remote: Option<String>,
    set_upstream: bool,
    force: bool,
) -> Result<(), String> {
    scm_ops::push(&git(&state)?, remote.as_deref(), set_upstream, force)
}

#[tauri::command]
pub async fn scm_sync(state: State<'_, AppState>, rebase: bool) -> Result<(), String> {
    scm_ops::sync(&git(&state)?, rebase)
}

#[tauri::command]
pub async fn scm_fetch(
    state: State<'_, AppState>,
    remote: Option<String>,
    prune: bool,
) -> Result<(), String> {
    scm_ops::fetch(&git(&state)?, remote.as_deref(), prune)
}

#[tauri::command]
pub async fn scm_checkout(state: State<'_, AppState>, name: String) -> Result<(), String> {
    scm_ops::checkout(&git(&state)?, &name)
}

#[tauri::command]
pub async fn scm_create_branch(
    state: State<'_, AppState>,
    name: String,
    from: Option<String>,
) -> Result<(), String> {
    scm_ops::create_branch(&git(&state)?, &name, from.as_deref())
}

#[tauri::command]
pub async fn scm_amend_last_commit(state: State<'_, AppState>) -> Result<(), String> {
    scm_ops::amend_last_commit(&git(&state)?)
}

#[tauri::command]
pub async fn scm_reset_to_remote(state: State<'_, AppState>) -> Result<String, String> {
    scm_ops::reset_to_remote(&git(&state)?)
}

/// Clone into `parent`; the new repository's path is returned for the app to open.
#[tauri::command]
pub fn scm_clone(url: String, parent: String, name: Option<String>) -> Result<String, String> {
    scm_ops::clone(&url, Path::new(&parent), name.as_deref(), &[]).map(|p| p.display().to_string())
}

#[tauri::command]
pub async fn gerrit_install_hook(
    state: State<'_, AppState>,
    remote: String,
) -> Result<bool, String> {
    scm_ops::gerrit_install_hook(&git(&state)?, &remote, "commit-msg")
}

#[tauri::command]
pub async fn gerrit_push_ref(
    state: State<'_, AppState>,
    remote: String,
) -> Result<Option<String>, String> {
    scm_ops::gerrit_push_ref(&git(&state)?, &remote)
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
            if let Some(hash) = line
                .split(' ')
                .next()
                .filter(|h| (40..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()))
            {
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
pub async fn scm_blame(state: State<'_, AppState>, path: String) -> Result<Vec<BlameLine>, String> {
    let git = git(&state)?;
    let output = git.output(&["blame", "--porcelain", "--", &path])?;
    Ok(parse_blame(&output))
}

#[tauri::command]
pub fn git_output_log() -> Vec<String> {
    crate::git::log_lines()
}

#[tauri::command]
pub fn git_output_clear() {
    crate::git::clear_log();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit, subject, write, Scratch};

    #[test]
    fn amend_without_a_message_keeps_the_original_one() {
        let scratch = Scratch::new("amend-empty");
        let git = scratch.repo("repo");
        commit(&git, "a.txt", "1\n", "first words");
        write(&git, "a.txt", "2\n");
        git.run(&["add", "--", "a.txt"]).unwrap();
        commit_index(&git, "", true).unwrap();
        assert_eq!(subject(&git, "HEAD"), "first words");
        commit_index(&git, "reworded", true).unwrap();
        assert_eq!(subject(&git, "HEAD"), "reworded");
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

    use crate::cmd_graph::is_valid_commit_hash;

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
        assert!(git.run(&["merge", "side"]).is_err(), "the merge stops on the conflict");

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
        assert!(!git.repo.join("new.txt").exists(), "the listed untracked path is deleted");
        assert_eq!(
            std::fs::read_to_string(git.repo.join("keep.txt")).unwrap(),
            "changed\n",
            "an unlisted modification survives"
        );
        let conf = std::fs::read_to_string(git.repo.join("conf.txt")).unwrap();
        assert!(conf.contains("<<<<<<<"), "the conflicted file keeps its markers");
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
