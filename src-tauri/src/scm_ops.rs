//! The operations behind the Source Control view's "..." menu — the same set VS Code's Git
//! extension offers (pull, push, sync, clone, checkout, branches, remotes, stashes, tags) plus
//! the extension's own contributions (amend the last commit, soft-reset to the remote, the
//! Gerrit commit-msg hook and `refs/for/` push). Everything runs through `git`, like the view's
//! other writes; the read helpers feed the quick picks.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::Git;
use crate::cmd_graph::is_safe_ref_name;

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
    /// `refs/stash@{n}`, the selector the Git Graph view's stash actions take.
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
                selector: format!("refs/stash@{{{index}}}"),
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
        // No upstream: push to the first remote and record it, as VS Code offers to.
        let remote = remotes(git)?
            .into_iter()
            .next()
            .ok_or_else(|| "The repository has no remotes to push to.".to_owned())?;
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

pub fn fetch(git: &Git, remote: Option<&str>, prune: bool) -> Status {
    crate::cmd_graph::fetch(git, remote, prune, false)
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

/// Download and install a hook (`commit-msg`) from the Gerrit server of `remote`. Returns
/// whether a hook was written (false when the identical hook was already installed).
pub fn gerrit_install_hook(git: &Git, remote: &str, hook: &str) -> Result<bool, String> {
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
    let hook_url = format!("{origin}/tools/hooks/{hook}");
    let content = ureq::get(&hook_url)
        .call()
        .and_then(|mut response| response.body_mut().read_to_string())
        .map_err(|e| format!("Unable to download the {hook} hook from {hook_url}: {e}"))?;
    if !content.trim_start().starts_with("#!") {
        return Err(format!(
            "The file downloaded from {hook_url} is not a valid hook script."
        ));
    }
    let hooks_dir = git.git_dir()?.join("hooks");
    let hook_path = hooks_dir.join(hook);
    if std::fs::read_to_string(&hook_path).ok().as_deref() == Some(content.as_str()) {
        return Ok(false);
    }
    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("Unable to create {}: {e}", hooks_dir.display()))?;
    std::fs::write(&hook_path, &content).map_err(|e| {
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
    git.run(&["commit", "--amend", "-m", &amended])?;
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
    let output = git
        .command()
        .args(["push", remote, &target])
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
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
    use crate::test_support::{
        commit, current_branch as branch_of, head, rev, subject, write, Scratch,
    };

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
        assert_eq!(stashes[0].selector, "refs/stash@{0}");
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
        assert_eq!(branch_of(&git).as_deref(), Some("feature"));
        checkout(&git, "main").unwrap();
        assert_eq!(branch_of(&git).as_deref(), Some("main"));
        // A remote-tracking branch becomes a tracking local branch.
        git.run(&["push", "-q", "origin", "feature"]).unwrap();
        git.run(&["branch", "-D", "feature"]).unwrap();
        checkout(&git, "origin/feature").unwrap();
        assert_eq!(branch_of(&git).as_deref(), Some("feature"));
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
        let error = gerrit_install_hook(&git, "origin", "commit-msg").unwrap_err();
        assert!(
            error.contains("Unable to derive the Gerrit server URL"),
            "{error}"
        );
        assert!(gerrit_install_hook(&git, "origin", "pre-commit").is_err());
        assert!(
            !fs::exists(git.git_dir().unwrap().join("hooks").join("commit-msg")).unwrap_or(false)
        );
    }
}
