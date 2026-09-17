//! Every write operation of the Git Graph view, exercised end-to-end against scratch
//! repositories with the real `git` — the same requests the webview sends, checked for the
//! response shape the webview expects and for the effect on the repository.
//!
//! Git is pointed at a scratch global configuration, so the "global" user-detail actions never
//! touch the developer's own ~/.gitconfig.

use std::fs;

use serde_json::{json, Value};

use super::{handle, operation_state, ActionSettings};
use crate::git::Git;
use crate::test_support::{branches, commit, current_branch, head, rev, subject, write, Scratch};

fn dispatch(git: &Git, request: Value) -> Value {
    let mut request = request;
    request["repo"] = json!(git.repo.display().to_string());
    handle(git, &request, ActionSettings::default())
        .unwrap_or_else(|| panic!("{} is not a write command", request["command"]))
}

/// Assert a response reports success: `error: null`, or `errors` all null.
#[track_caller]
fn assert_ok(response: &Value) {
    if let Some(error) = response.get("error") {
        assert!(error.is_null(), "unexpected error: {error}");
    } else if let Some(errors) = response.get("errors") {
        for error in errors.as_array().unwrap() {
            assert!(error.is_null(), "unexpected error: {error}");
        }
    } else {
        panic!("response carries neither error nor errors: {response}");
    }
}

fn git_version() -> (u32, u32) {
    let out = std::process::Command::new("git")
        .arg("--version")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let numbers: Vec<u32> = text
        .split_whitespace()
        .nth(2)
        .unwrap_or("0.0")
        .split('.')
        .take(2)
        .filter_map(|n| n.parse().ok())
        .collect();
    (
        numbers.first().copied().unwrap_or(0),
        numbers.get(1).copied().unwrap_or(0),
    )
}

/* ---------- Branches ---------- */

#[test]
fn create_checkout_rename_delete_branch() {
    let scratch = Scratch::new("branches");
    let git = scratch.repo("repo");
    let base = head(&git);

    let response = dispatch(
        &git,
        json!({ "command": "createBranch", "branchName": "feature", "commitHash": base, "checkout": false, "force": false }),
    );
    assert_eq!(response["command"], "createBranch");
    assert_ok(&response);
    assert!(branches(&git).contains(&"feature".to_owned()));
    assert_eq!(current_branch(&git).as_deref(), Some("main"));

    assert_ok(&dispatch(
        &git,
        json!({ "command": "checkoutBranch", "branchName": "feature", "remoteBranch": null, "pullAfterwards": null }),
    ));
    assert_eq!(current_branch(&git).as_deref(), Some("feature"));

    // Creating with checkout + force re-points an existing branch and switches to it.
    commit(&git, "a.txt", "a\n", "On feature");
    let response = dispatch(
        &git,
        json!({ "command": "createBranch", "branchName": "main", "commitHash": head(&git), "checkout": true, "force": true }),
    );
    assert_ok(&response);
    assert_eq!(
        response["errors"].as_array().unwrap().len(),
        2,
        "branch -f, then checkout"
    );
    assert_eq!(current_branch(&git).as_deref(), Some("main"));
    assert_eq!(rev(&git, "main"), rev(&git, "feature"));

    assert_ok(&dispatch(
        &git,
        json!({ "command": "renameBranch", "oldName": "feature", "newName": "topic" }),
    ));
    assert!(branches(&git).contains(&"topic".to_owned()));
    assert!(!branches(&git).contains(&"feature".to_owned()));

    let response = dispatch(
        &git,
        json!({ "command": "deleteBranch", "branchName": "topic", "forceDelete": false, "deleteOnRemotes": [] }),
    );
    assert_ok(&response);
    assert_eq!(response["branchName"], "topic");
    assert!(!branches(&git).contains(&"topic".to_owned()));
}

#[test]
fn checkout_commit_warns_before_stranding_detached_commits() {
    let scratch = Scratch::new("detached");
    let git = scratch.repo("repo");
    let base = head(&git);

    assert_ok(&dispatch(
        &git,
        json!({ "command": "checkoutCommit", "commitHash": base }),
    ));
    assert_eq!(current_branch(&git), None, "HEAD is detached");

    // A commit made while detached would be lost by a checkout: the view is warned first.
    commit(&git, "detached.txt", "x\n", "Detached work");
    let response = dispatch(
        &git,
        json!({ "command": "checkoutBranch", "branchName": "main", "remoteBranch": null, "pullAfterwards": null }),
    );
    assert_eq!(response["command"], "lossWarning");
    assert!(response["message"]
        .as_str()
        .unwrap()
        .contains("1 commit(s)"));
    assert_eq!(response["retry"]["confirmed"], true);
    assert_eq!(response["retry"]["command"], "checkoutBranch");
    assert_eq!(current_branch(&git), None, "nothing happened yet");

    // The retry carries confirmed: true and goes through.
    let retry = response["retry"].clone();
    let response = handle(&git, &retry, ActionSettings::default()).unwrap();
    assert_ok(&response);
    assert_eq!(current_branch(&git).as_deref(), Some("main"));

    // Creating a branch AT the detached commit keeps it: no warning.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "checkoutCommit", "commitHash": base }),
    ));
    let stranded = commit(&git, "more.txt", "y\n", "More detached work");
    let response = dispatch(
        &git,
        json!({ "command": "createBranch", "branchName": "keep", "commitHash": stranded, "checkout": true, "force": false }),
    );
    assert_ok(&response);
    assert_eq!(current_branch(&git).as_deref(), Some("keep"));
}

#[test]
fn invalid_arguments_are_rejected_before_git_runs() {
    let scratch = Scratch::new("validation");
    let git = scratch.repo("repo");
    let response = dispatch(
        &git,
        json!({ "command": "createBranch", "branchName": "--evil", "commitHash": head(&git), "checkout": false, "force": false }),
    );
    assert_eq!(
        response["errors"][0],
        "Invalid reference name was provided for \"branchName\""
    );
    let response = dispatch(
        &git,
        json!({ "command": "checkoutCommit", "commitHash": "not-a-hash" }),
    );
    assert_eq!(
        response["error"],
        "Invalid commit hash was provided for \"commitHash\""
    );
    let response = dispatch(
        &git,
        json!({ "command": "dropStash", "selector": "refs/stash@{x}" }),
    );
    assert_eq!(
        response["error"],
        "Invalid stash selector was provided for \"selector\""
    );
    let response = dispatch(
        &git,
        json!({ "command": "addRemote", "name": "r", "url": "--upload-pack=evil", "pushUrl": null, "fetch": false }),
    );
    assert_eq!(response["error"], "Invalid URL was provided for \"url\"");
}

/* ---------- Tags ---------- */

#[test]
fn add_and_delete_tags() {
    let scratch = Scratch::new("tags");
    let git = scratch.repo("repo");
    let base = head(&git);

    // Lightweight (type 1) and annotated (type 0).
    let response = dispatch(
        &git,
        json!({ "command": "addTag", "tagName": "v1", "commitHash": base, "type": 1, "message": "", "force": false, "pushToRemote": null, "pushSkipRemoteCheck": false }),
    );
    assert_ok(&response);
    assert_eq!(response["tagName"], "v1");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "addTag", "tagName": "v2", "commitHash": base, "type": 0, "message": "Release two", "force": false, "pushToRemote": null, "pushSkipRemoteCheck": false }),
    ));
    assert_eq!(git.output(&["cat-file", "-t", "v2"]).unwrap().trim(), "tag");
    assert_eq!(
        git.output(&["cat-file", "-t", "v1"]).unwrap().trim(),
        "commit"
    );

    // Re-adding needs force.
    let response = dispatch(
        &git,
        json!({ "command": "addTag", "tagName": "v1", "commitHash": base, "type": 1, "message": "", "force": false, "pushToRemote": null, "pushSkipRemoteCheck": false }),
    );
    assert!(response["errors"][0]
        .as_str()
        .unwrap()
        .contains("already exists"));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "addTag", "tagName": "v1", "commitHash": base, "type": 1, "message": "", "force": true, "pushToRemote": null, "pushSkipRemoteCheck": false }),
    ));

    assert_ok(&dispatch(
        &git,
        json!({ "command": "deleteTag", "tagName": "v1", "deleteOnRemote": null }),
    ));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "deleteTag", "tagName": "v2", "deleteOnRemote": null }),
    ));
    assert_eq!(git.output(&["tag"]).unwrap().trim(), "");
}

#[test]
fn push_tag_checks_the_commit_is_on_the_remote() {
    let scratch = Scratch::new("pushtag");
    let git = scratch.repo("repo");
    let remote = scratch.bare("origin.git");
    let base = head(&git);
    git.run(&["remote", "add", "origin", &remote.display().to_string()])
        .unwrap();

    // Not pushed yet: the view gets the prefixed error listing the remote.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "addTag", "tagName": "v1", "commitHash": base, "type": 1, "message": "", "force": false, "pushToRemote": null, "pushSkipRemoteCheck": false }),
    ));
    let response = dispatch(
        &git,
        json!({ "command": "pushTag", "tagName": "v1", "remotes": ["origin"], "commitHash": base, "skipRemoteCheck": false }),
    );
    assert_eq!(
        response["errors"][0],
        format!("{}[\"origin\"]", super::PUSH_TAG_COMMIT_NOT_ON_REMOTE)
    );

    assert_ok(&dispatch(
        &git,
        json!({ "command": "pushBranch", "branchName": "main", "remotes": ["origin"], "setUpstream": true, "mode": "", "willUpdateBranchConfig": true }),
    ));
    let response = dispatch(
        &git,
        json!({ "command": "pushTag", "tagName": "v1", "remotes": ["origin"], "commitHash": base, "skipRemoteCheck": false }),
    );
    assert_ok(&response);
    assert_eq!(response["remotes"], json!(["origin"]));
    let remote_git = scratch.git(&remote);
    assert_eq!(remote_git.output(&["tag"]).unwrap().trim(), "v1");

    // Adding with pushToRemote pushes in the same request; deleting with deleteOnRemote deletes there too.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "addTag", "tagName": "v2", "commitHash": base, "type": 0, "message": "two", "force": false, "pushToRemote": "origin", "pushSkipRemoteCheck": true }),
    ));
    assert!(remote_git.output(&["tag"]).unwrap().contains("v2"));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "deleteTag", "tagName": "v2", "deleteOnRemote": "origin" }),
    ));
    assert!(!remote_git.output(&["tag"]).unwrap().contains("v2"));
    assert!(!git.output(&["tag"]).unwrap().contains("v2"));
}

/* ---------- Stashes ---------- */

#[test]
fn stash_push_apply_pop_drop_and_branch() {
    let scratch = Scratch::new("stash");
    let git = scratch.repo("repo");

    write(&git, "README.md", "changed\n");
    write(&git, "untracked.txt", "new\n");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "pushStash", "message": "WIP one", "includeUntracked": true }),
    ));
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(!git.repo.join("untracked.txt").exists());
    assert!(git.output(&["stash", "list"]).unwrap().contains("WIP one"));

    assert_ok(&dispatch(
        &git,
        json!({ "command": "applyStash", "selector": "refs/stash@{0}", "reinstateIndex": false }),
    ));
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "changed\n"
    );
    assert!(git.repo.join("untracked.txt").exists());
    assert!(
        git.output(&["stash", "list"]).unwrap().contains("WIP one"),
        "apply keeps the stash"
    );

    git.run(&["checkout", "--", "."]).unwrap();
    git.run(&["clean", "-fdq"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "popStash", "selector": "refs/stash@{0}", "reinstateIndex": false }),
    ));
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "changed\n"
    );
    assert_eq!(
        git.output(&["stash", "list"]).unwrap().trim(),
        "",
        "pop drops the stash"
    );

    assert_ok(&dispatch(
        &git,
        json!({ "command": "pushStash", "message": "", "includeUntracked": true }),
    ));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "pushStash", "message": "second", "includeUntracked": false }),
    ));
    // The working tree is clean now: stash push with nothing to save is still a success.
    assert_eq!(git.output(&["stash", "list"]).unwrap().lines().count(), 1);
    assert_ok(&dispatch(
        &git,
        json!({ "command": "dropStash", "selector": "refs/stash@{0}" }),
    ));
    assert_eq!(git.output(&["stash", "list"]).unwrap().trim(), "");

    write(&git, "README.md", "for branch\n");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "pushStash", "message": "to branch", "includeUntracked": false }),
    ));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "branchFromStash", "selector": "refs/stash@{0}", "branchName": "from-stash" }),
    ));
    assert_eq!(current_branch(&git).as_deref(), Some("from-stash"));
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "for branch\n"
    );
}

/* ---------- Merge, rebase, conflicts ---------- */

fn diverge(git: &Git) -> (String, String) {
    // main: README + a.txt ; topic: README + b.txt (no conflict)
    git.run(&["checkout", "-q", "-b", "topic"]).unwrap();
    let topic = commit(git, "b.txt", "b\n", "Add b");
    git.run(&["checkout", "-q", "main"]).unwrap();
    let main = commit(git, "a.txt", "a\n", "Add a");
    (main, topic)
}

#[test]
fn merge_fast_forward_no_ff_and_squash() {
    let scratch = Scratch::new("merge");
    let git = scratch.repo("repo");

    // Fast-forward.
    git.run(&["checkout", "-q", "-b", "ff"]).unwrap();
    let tip = commit(&git, "ff.txt", "ff\n", "FF commit");
    git.run(&["checkout", "-q", "main"]).unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "merge", "obj": "ff", "actionOn": "Branch", "createNewCommit": false, "squash": false, "noCommit": false }),
    );
    assert_ok(&response);
    assert_eq!(response["actionOn"], "Branch");
    assert_eq!(head(&git), tip);

    // --no-ff creates a merge commit.
    let (_, topic) = diverge(&git);
    assert_ok(&dispatch(
        &git,
        json!({ "command": "merge", "obj": "topic", "actionOn": "Branch", "createNewCommit": true, "squash": false, "noCommit": false }),
    ));
    let parents = git
        .output(&["rev-list", "--parents", "-n", "1", "HEAD"])
        .unwrap();
    assert_eq!(
        parents.split_whitespace().count(),
        3,
        "a merge commit with two parents"
    );
    assert!(parents.contains(&topic));

    // --squash commits with the extension's default message.
    git.run(&["checkout", "-q", "-b", "squashme"]).unwrap();
    commit(&git, "s.txt", "s\n", "Squash me");
    git.run(&["checkout", "-q", "main"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "merge", "obj": "squashme", "actionOn": "Branch", "createNewCommit": false, "squash": true, "noCommit": false }),
    ));
    assert_eq!(subject(&git, "HEAD"), "Merge branch 'squashme'");
    assert!(git.repo.join("s.txt").exists());

    // Merging a commit by hash, --no-commit leaves the merge staged.
    git.run(&["checkout", "-q", "-b", "nc"]).unwrap();
    let nc = commit(&git, "nc.txt", "nc\n", "No commit");
    git.run(&["checkout", "-q", "main"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "merge", "obj": nc, "actionOn": "Commit", "createNewCommit": true, "squash": false, "noCommit": true }),
    ));
    assert_eq!(operation_state(&git)["type"], "merge");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "abortOperation", "type": "merge" }),
    ));
    assert!(operation_state(&git)["type"].is_null());
}

#[test]
fn conflicting_merge_reports_state_and_can_be_continued_or_aborted() {
    let scratch = Scratch::new("conflict");
    let git = scratch.repo("repo");
    git.run(&["checkout", "-q", "-b", "theirs"]).unwrap();
    commit(&git, "README.md", "theirs\n", "Theirs");
    git.run(&["checkout", "-q", "main"]).unwrap();
    commit(&git, "README.md", "ours\n", "Ours");

    // Predicted first (git 2.40+ only), then attempted.
    let response = dispatch(
        &git,
        json!({ "command": "predictConflicts", "ours": "main", "theirs": "theirs" }),
    );
    assert_eq!(response["ours"], "main");
    if git_version() >= (2, 40) {
        assert_eq!(response["prediction"]["conflicted"], true);
        assert_eq!(response["prediction"]["files"], json!(["README.md"]));
    }
    let response = dispatch(
        &git,
        json!({ "command": "predictConflicts", "ours": "main", "theirs": "main" }),
    );
    if git_version() >= (2, 40) {
        assert_eq!(response["prediction"]["conflicted"], false);
    }

    let response = dispatch(
        &git,
        json!({ "command": "merge", "obj": "theirs", "actionOn": "Branch", "createNewCommit": false, "squash": false, "noCommit": false }),
    );
    assert!(response["error"].as_str().unwrap().contains("CONFLICT"));
    let state = operation_state(&git);
    assert_eq!(state["type"], "merge");
    assert_eq!(state["conflictedFiles"], json!(["README.md"]));

    // Abort restores the pre-merge state.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "abortOperation", "type": "merge" }),
    ));
    assert!(operation_state(&git)["type"].is_null());
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "ours\n"
    );

    // Resolve and continue.
    let _ = dispatch(
        &git,
        json!({ "command": "merge", "obj": "theirs", "actionOn": "Branch", "createNewCommit": false, "squash": false, "noCommit": false }),
    );
    write(&git, "README.md", "resolved\n");
    git.run(&["add", "README.md"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "continueOperation", "type": "merge" }),
    ));
    assert!(operation_state(&git)["type"].is_null());
    assert_eq!(
        git.output(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .unwrap()
            .split_whitespace()
            .count(),
        3
    );
}

#[test]
fn rebase_cherrypick_revert_drop_fixup_squash() {
    let scratch = Scratch::new("rewrite");
    let git = scratch.repo("repo");
    let (main_tip, topic_tip) = diverge(&git);

    // Rebase topic onto main.
    git.run(&["checkout", "-q", "topic"]).unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "rebase", "obj": "main", "actionOn": "Branch", "ignoreDate": false, "interactive": false, "autosquash": false }),
    );
    assert_ok(&response);
    assert_eq!(response["interactive"], false);
    assert_eq!(rev(&git, "HEAD^"), main_tip);
    assert_ne!(head(&git), topic_tip);
    assert!(operation_state(&git)["type"].is_null());

    // Cherry-pick main's commit is a no-op now; pick a fresh one instead.
    git.run(&["checkout", "-q", "main"]).unwrap();
    git.run(&["checkout", "-q", "-b", "pick-src"]).unwrap();
    let pick = commit(&git, "pick.txt", "p\n", "Pickable");
    git.run(&["checkout", "-q", "main"]).unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "cherrypickCommit", "commitHash": pick, "parentIndex": 0, "recordOrigin": true, "noCommit": false }),
    );
    assert_ok(&response);
    assert!(git.repo.join("pick.txt").exists());
    assert!(git
        .output(&["log", "-1", "--format=%B"])
        .unwrap()
        .contains("cherry picked from commit"));

    // Revert it.
    let picked = head(&git);
    assert_ok(&dispatch(
        &git,
        json!({ "command": "revertCommit", "commitHash": picked, "parentIndex": 0 }),
    ));
    assert!(!git.repo.join("pick.txt").exists());
    assert!(subject(&git, "HEAD").starts_with("Revert"));

    // Drop the revert commit again (rebase --onto).
    let revert = head(&git);
    assert_ok(&dispatch(
        &git,
        json!({ "command": "dropCommit", "commitHash": revert }),
    ));
    assert_eq!(head(&git), picked);
    assert!(git.repo.join("pick.txt").exists());

    // Fixup / squash commits target the picked commit.
    write(&git, "pick.txt", "p2\n");
    git.run(&["add", "pick.txt"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "commitFixup", "commitHash": picked }),
    ));
    assert_eq!(subject(&git, "HEAD"), "fixup! Pickable");
    write(&git, "pick.txt", "p3\n");
    git.run(&["add", "pick.txt"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "commitSquash", "commitHash": picked }),
    ));
    assert_eq!(subject(&git, "HEAD"), "squash! Pickable");

    // --no-commit cherry-pick leaves the change staged, for the SCM view.
    git.run(&["reset", "-q", "--hard", &picked]).unwrap();
    git.run(&["checkout", "-q", "pick-src"]).unwrap();
    let extra = commit(&git, "extra.txt", "e\n", "Extra");
    git.run(&["checkout", "-q", "main"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "cherrypickCommit", "commitHash": extra, "parentIndex": 0, "recordOrigin": false, "noCommit": true }),
    ));
    assert!(git
        .output(&["diff", "--cached", "--name-only"])
        .unwrap()
        .contains("extra.txt"));
    assert!(
        operation_state(&git)["type"].is_null(),
        "a clean --no-commit pick leaves no CHERRY_PICK_HEAD"
    );
    git.run(&["reset", "-q", "--hard", "HEAD"]).unwrap();

    // A conflicting pick is an operation in progress, which can be aborted.
    git.run(&["checkout", "-q", "pick-src"]).unwrap();
    let clash = commit(&git, "README.md", "from pick-src\n", "Clash");
    git.run(&["checkout", "-q", "main"]).unwrap();
    commit(&git, "README.md", "from main\n", "Main clash");
    let response = dispatch(
        &git,
        json!({ "command": "cherrypickCommit", "commitHash": clash, "parentIndex": 0, "recordOrigin": false, "noCommit": false }),
    );
    assert!(response["errors"][0].as_str().unwrap().contains("CONFLICT"));
    assert_eq!(operation_state(&git)["type"], "cherry-pick");
    assert_eq!(
        operation_state(&git)["conflictedFiles"],
        json!(["README.md"])
    );
    assert_ok(&dispatch(
        &git,
        json!({ "command": "abortOperation", "type": "cherry-pick" }),
    ));
    assert!(operation_state(&git)["type"].is_null());

    // Likewise a conflicting revert: undoing "Main clash" after README changed again.
    let clashed = head(&git);
    commit(&git, "README.md", "changed again\n", "Changed again");
    let response = dispatch(
        &git,
        json!({ "command": "revertCommit", "commitHash": clashed, "parentIndex": 0 }),
    );
    assert!(response["error"].as_str().unwrap().contains("CONFLICT"));
    assert_eq!(operation_state(&git)["type"], "revert");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "abortOperation", "type": "revert" }),
    ));

    // And a conflicting rebase reports its progress.
    git.run(&["checkout", "-q", "pick-src"]).unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "rebase", "obj": "main", "actionOn": "Branch", "ignoreDate": false, "interactive": false, "autosquash": false }),
    );
    assert!(response["error"].as_str().unwrap().contains("CONFLICT"));
    let state = operation_state(&git);
    assert_eq!(state["type"], "rebase");
    assert!(state["progress"]["total"].as_u64().unwrap() >= 1);
    assert_ok(&dispatch(
        &git,
        json!({ "command": "abortOperation", "type": "rebase" }),
    ));
    assert!(operation_state(&git)["type"].is_null());
}

#[test]
fn reset_modes_and_hard_reset_warning() {
    let scratch = Scratch::new("reset");
    let git = scratch.repo("repo");
    let first = head(&git);
    let second = commit(&git, "two.txt", "2\n", "Second");

    assert_ok(&dispatch(
        &git,
        json!({ "command": "resetToCommit", "commit": first, "resetMode": "soft" }),
    ));
    assert_eq!(head(&git), first);
    assert!(
        git.output(&["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("two.txt"),
        "soft keeps the index"
    );

    git.run(&["reset", "-q", "--hard", &second]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "resetToCommit", "commit": first, "resetMode": "mixed" }),
    ));
    assert_eq!(
        git.output(&["diff", "--cached", "--name-only"])
            .unwrap()
            .trim(),
        ""
    );
    assert!(
        git.repo.join("two.txt").exists(),
        "mixed keeps the working tree"
    );

    // Hard with a dirty tree: warned first, then done on the confirmed retry.
    git.run(&["reset", "-q", "--hard", &second]).unwrap();
    write(&git, "two.txt", "dirty\n");
    let response = dispatch(
        &git,
        json!({ "command": "resetToCommit", "commit": first, "resetMode": "hard" }),
    );
    assert_eq!(response["command"], "lossWarning");
    assert!(response["message"].as_str().unwrap().contains("hard reset"));
    let response = handle(&git, &response["retry"], ActionSettings::default()).unwrap();
    assert_ok(&response);
    assert_eq!(head(&git), first);
    assert!(!git.repo.join("two.txt").exists());

    // The uncommitted-changes reset uses the HEAD sentinel and never warns.
    write(&git, "README.md", "dirty\n");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "resetToCommit", "commit": "HEAD", "resetMode": "hard" }),
    ));
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "hello\n"
    );
}

#[test]
fn undo_last_commit_and_edit_commit_message() {
    let scratch = Scratch::new("amend");
    let git = scratch.repo("repo");
    let first = head(&git);
    let second = commit(&git, "two.txt", "2\n", "Second");
    let third = commit(&git, "three.txt", "3\n", "Third");

    // HEAD: amended in place.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "editCommitMessage", "commitHash": third, "message": "Third (edited)" }),
    ));
    assert_eq!(subject(&git, "HEAD"), "Third (edited)");
    assert_eq!(rev(&git, "HEAD^"), second);

    // An older commit: reworded through the autosquash rebase (git 2.32+), history otherwise intact.
    if git_version() >= (2, 32) {
        write(&git, "README.md", "unsaved\n"); // --autostash carries this across
        assert_ok(&dispatch(
            &git,
            json!({ "command": "editCommitMessage", "commitHash": second, "message": "Second (edited)\n\nWith a body." }),
        ));
        assert_eq!(subject(&git, "HEAD^"), "Second (edited)");
        assert!(git
            .output(&["log", "-1", "--format=%B", "HEAD^"])
            .unwrap()
            .contains("With a body."));
        assert_eq!(subject(&git, "HEAD"), "Third (edited)");
        assert_eq!(rev(&git, "HEAD~2"), first);
        assert_eq!(
            git.output(&["rev-list", "--count", "HEAD"]).unwrap().trim(),
            "3"
        );
        assert_eq!(
            fs::read_to_string(git.repo.join("README.md")).unwrap(),
            "unsaved\n"
        );
        git.run(&["checkout", "--", "README.md"]).unwrap();
    }

    // A commit outside the current branch cannot be edited.
    git.run(&["checkout", "-q", "-b", "other", &first]).unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "editCommitMessage", "commitHash": third, "message": "x" }),
    );
    assert!(response["error"]
        .as_str()
        .unwrap()
        .contains("current branch"));
    git.run(&["checkout", "-q", "main"]).unwrap();

    assert_ok(&dispatch(&git, json!({ "command": "undoLastCommit" })));
    assert_eq!(
        git.output(&["rev-list", "--count", "HEAD"]).unwrap().trim(),
        "2"
    );
    assert!(git
        .output(&["diff", "--cached", "--name-only"])
        .unwrap()
        .contains("three.txt"));
}

/* ---------- Config, clean, file reset ---------- */

#[test]
fn user_details_local_and_global() {
    let scratch = Scratch::new("config");
    let git = scratch.repo("repo");

    assert_ok(&dispatch(
        &git,
        json!({ "command": "editUserDetails", "name": "Local Name", "email": "local@example.com", "location": "local", "deleteLocalName": false, "deleteLocalEmail": false }),
    ));
    assert_eq!(
        git.output(&["config", "--local", "user.name"])
            .unwrap()
            .trim(),
        "Local Name"
    );

    assert_ok(&dispatch(
        &git,
        json!({ "command": "editUserDetails", "name": "Global Name", "email": "global@example.com", "location": "global", "deleteLocalName": true, "deleteLocalEmail": true }),
    ));
    assert_eq!(
        git.output(&["config", "--global", "user.name"])
            .unwrap()
            .trim(),
        "Global Name"
    );
    assert!(
        git.output(&["config", "--local", "user.name"]).is_err(),
        "the local override was removed"
    );
    assert!(
        fs::read_to_string(scratch.root.join("gitconfig"))
            .unwrap()
            .contains("Global Name"),
        "written to the scratch global config"
    );

    assert_ok(&dispatch(
        &git,
        json!({ "command": "deleteUserDetails", "name": true, "email": true, "location": "global" }),
    ));
    assert!(git.output(&["config", "--global", "user.name"]).is_err());
}

#[test]
fn edit_user_details_leaves_absent_fields_unchanged() {
    let scratch = Scratch::new("user-details-absent");
    let git = scratch.repo("repo");
    git.run(&["config", "--local", "user.name", "Kept Name"])
        .unwrap();
    git.run(&["config", "--local", "user.email", "kept@example.com"])
        .unwrap();

    // Only the email is sent: the name must survive instead of being overwritten with an
    // empty string (git rejects commits with an empty ident).
    assert_ok(&dispatch(
        &git,
        json!({ "command": "editUserDetails", "email": "new@example.com", "location": "local", "deleteLocalName": false, "deleteLocalEmail": false }),
    ));
    assert_eq!(
        git.output(&["config", "--local", "user.name"])
            .unwrap()
            .trim(),
        "Kept Name"
    );
    assert_eq!(
        git.output(&["config", "--local", "user.email"])
            .unwrap()
            .trim(),
        "new@example.com"
    );
}

#[test]
fn clean_untracked_and_reset_file_to_revision() {
    let scratch = Scratch::new("clean");
    let git = scratch.repo("repo");
    let first = head(&git);
    commit(&git, "README.md", "second\n", "Second");

    write(&git, "junk.txt", "j\n");
    write(&git, "dir/junk.txt", "j\n");
    assert_ok(&dispatch(
        &git,
        json!({ "command": "cleanUntrackedFiles", "directories": false }),
    ));
    assert!(!git.repo.join("junk.txt").exists());
    assert!(
        git.repo.join("dir/junk.txt").exists(),
        "directories need the flag"
    );
    assert_ok(&dispatch(
        &git,
        json!({ "command": "cleanUntrackedFiles", "directories": true }),
    ));
    assert!(!git.repo.join("dir").exists());

    assert_ok(&dispatch(
        &git,
        json!({ "command": "resetFileToRevision", "commitHash": first, "filePath": "README.md" }),
    ));
    assert_eq!(
        fs::read_to_string(git.repo.join("README.md")).unwrap(),
        "hello\n"
    );
}

/* ---------- Remotes ---------- */

#[test]
fn remotes_fetch_push_pull() {
    let scratch = Scratch::new("remotes");
    let git = scratch.repo("repo");
    let bare = scratch.bare("origin.git");
    let url = bare.display().to_string();

    assert_ok(&dispatch(
        &git,
        json!({ "command": "addRemote", "name": "origin", "url": url, "pushUrl": null, "fetch": true }),
    ));
    assert_eq!(git.output(&["remote"]).unwrap().trim(), "origin");

    // Push with upstream, then the remote-tracking ref exists and the upstream is configured.
    let response = dispatch(
        &git,
        json!({ "command": "pushBranch", "branchName": "main", "remotes": ["origin"], "setUpstream": true, "mode": "", "willUpdateBranchConfig": true }),
    );
    assert_ok(&response);
    assert_eq!(response["willUpdateBranchConfig"], true);
    assert_eq!(rev(&git, "origin/main"), head(&git));
    assert_eq!(
        git.output(&["config", "branch.main.remote"])
            .unwrap()
            .trim(),
        "origin"
    );

    // A force push is confirmed first.
    let response = dispatch(
        &git,
        json!({ "command": "pushBranch", "branchName": "main", "remotes": ["origin"], "setUpstream": false, "mode": "force", "willUpdateBranchConfig": false }),
    );
    assert_eq!(response["command"], "lossWarning");
    assert_ok(&handle(&git, &response["retry"], ActionSettings::default()).unwrap());
    // --force-with-lease is the guarded variant and needs no confirmation.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "pushBranch", "branchName": "main", "remotes": ["origin"], "setUpstream": false, "mode": "force-with-lease", "willUpdateBranchConfig": false }),
    ));

    // Someone else pushes: fetch sees it, pull brings it in.
    let other = scratch.path("other");
    scratch
        .git(&scratch.root)
        .run(&["clone", "-q", &url, &other.display().to_string()])
        .unwrap();
    let other_git = scratch.git(&other);
    let upstream_tip = commit(&other_git, "from-other.txt", "o\n", "From other");
    other_git.run(&["push", "-q", "origin", "main"]).unwrap();

    assert_ok(&dispatch(
        &git,
        json!({ "command": "fetch", "name": "origin", "prune": true, "pruneTags": false }),
    ));
    assert_eq!(rev(&git, "origin/main"), upstream_tip);
    assert_ne!(head(&git), upstream_tip);
    let response = dispatch(
        &git,
        json!({ "command": "fetch", "name": null, "prune": false, "pruneTags": true }),
    );
    assert!(response["error"].as_str().unwrap().contains("Prune Tags"));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "fetch", "name": null, "prune": true, "pruneTags": true }),
    ));

    assert_ok(&dispatch(
        &git,
        json!({ "command": "pullBranch", "branchName": "main", "remote": "origin", "createNewCommit": false, "squash": false }),
    ));
    assert_eq!(head(&git), upstream_tip);

    // Pull --squash of a diverged remote branch commits with the default message.
    other_git.run(&["checkout", "-q", "-b", "side"]).unwrap();
    commit(&other_git, "side.txt", "s\n", "Side");
    other_git.run(&["push", "-q", "origin", "side"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "fetch", "name": "origin", "prune": false, "pruneTags": false }),
    ));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "pullBranch", "branchName": "side", "remote": "origin", "createNewCommit": false, "squash": true }),
    ));
    assert_eq!(subject(&git, "HEAD"), "Merge branch 'origin/side'");

    // fetchIntoLocalBranch: a branch that is not checked out is updated by a refspec fetch...
    git.run(&["branch", "-q", "local-side", "origin/side~1"])
        .unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "fetchIntoLocalBranch", "remote": "origin", "remoteBranch": "side", "localBranch": "local-side", "force": false }),
    ));
    assert_eq!(rev(&git, "local-side"), rev(&git, "origin/side"));
    // ...and the checked-out branch by a pull (or a hard reset with force).
    commit(&other_git, "side2.txt", "s2\n", "Side 2");
    other_git.run(&["push", "-q", "origin", "side"]).unwrap();
    git.run(&["checkout", "-q", "local-side"]).unwrap();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "fetchIntoLocalBranch", "remote": "origin", "remoteBranch": "side", "localBranch": "local-side", "force": true }),
    ));
    assert_eq!(head(&git), rev(&git, "origin/side"));
    git.run(&["checkout", "-q", "main"]).unwrap();

    // Delete a branch on the remote (and a stale tracking ref for one that is gone there).
    let response = dispatch(
        &git,
        json!({ "command": "deleteRemoteBranch", "branchName": "side", "remote": "origin" }),
    );
    assert_ok(&response);
    assert!(scratch
        .git(&bare)
        .output(&["branch", "--list", "side"])
        .unwrap()
        .trim()
        .is_empty());
    git.run(&["update-ref", "refs/remotes/origin/ghost", &head(&git)])
        .unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "deleteBranch", "branchName": "local-side", "forceDelete": true, "deleteOnRemotes": ["origin"] }),
    );
    // local-side never existed on the remote: git reports so, and the tracking ref is cleaned up.
    assert!(response["errors"][0].is_null());
    assert_ok(&dispatch(
        &git,
        json!({ "command": "deleteRemoteBranch", "branchName": "ghost", "remote": "origin" }),
    ));
    assert!(git
        .output(&["for-each-ref", "refs/remotes/origin/ghost"])
        .unwrap()
        .trim()
        .is_empty());

    // Edit: rename, change the URL, add a push URL, remove it again; prune; delete.
    assert_ok(&dispatch(
        &git,
        json!({ "command": "editRemote", "nameOld": "origin", "nameNew": "upstream", "urlOld": url, "urlNew": url, "pushUrlOld": null, "pushUrlNew": "https://example.com/push.git" }),
    ));
    assert_eq!(
        git.output(&["remote", "get-url", "--push", "upstream"])
            .unwrap()
            .trim(),
        "https://example.com/push.git"
    );
    assert_ok(&dispatch(
        &git,
        json!({ "command": "editRemote", "nameOld": "upstream", "nameNew": "upstream", "urlOld": url, "urlNew": url, "pushUrlOld": "https://example.com/push.git", "pushUrlNew": null }),
    ));
    assert_eq!(
        git.output(&["remote", "get-url", "--push", "upstream"])
            .unwrap()
            .trim(),
        url
    );
    assert_ok(&dispatch(
        &git,
        json!({ "command": "pruneRemote", "name": "upstream" }),
    ));
    assert_ok(&dispatch(
        &git,
        json!({ "command": "deleteRemote", "name": "upstream" }),
    ));
    assert_eq!(git.output(&["remote"]).unwrap().trim(), "");
}

#[test]
fn create_pull_request_pushes_first() {
    let scratch = Scratch::new("pr");
    let git = scratch.repo("repo");
    let bare = scratch.bare("origin.git");
    git.run(&["remote", "add", "origin", &bare.display().to_string()])
        .unwrap();
    git.run(&["checkout", "-q", "-b", "pr-branch"]).unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "createPullRequest", "config": {}, "sourceRemote": "origin", "sourceOwner": "o", "sourceRepo": "r", "sourceBranch": "pr-branch", "push": true }),
    );
    assert_ok(&response);
    assert_eq!(response["push"], true);
    assert_eq!(rev(&git, "origin/pr-branch"), head(&git));
}

/* ---------- Worktrees, reflog, archive, gerrit ---------- */

#[test]
fn worktrees_add_list_remove_prune() {
    let scratch = Scratch::new("worktree");
    let git = scratch.repo("repo");
    let wt = scratch.path("wt").display().to_string();

    assert_ok(&dispatch(
        &git,
        json!({ "command": "worktreeAdd", "path": wt, "branch": null, "newBranch": "wt-branch" }),
    ));
    let response = dispatch(&git, json!({ "command": "worktreeList" }));
    let list = response["worktrees"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["isMain"], true);
    assert_eq!(list[1]["branch"], "wt-branch");
    assert_eq!(list[1]["isMain"], false);
    assert_eq!(list[1]["hash"], head(&git));

    assert_ok(&dispatch(
        &git,
        json!({ "command": "worktreeRemove", "path": wt, "force": false }),
    ));
    assert_eq!(
        dispatch(&git, json!({ "command": "worktreeList" }))["worktrees"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // A worktree deleted behind git's back is pruned.
    let wt2 = scratch.path("wt2").display().to_string();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "worktreeAdd", "path": wt2, "branch": "wt-branch", "newBranch": null }),
    ));
    fs::remove_dir_all(scratch.path("wt2")).unwrap();
    assert_eq!(
        dispatch(&git, json!({ "command": "worktreeList" }))["worktrees"][1]["prunable"],
        true
    );
    assert_ok(&dispatch(&git, json!({ "command": "worktreePrune" })));
    assert_eq!(
        dispatch(&git, json!({ "command": "worktreeList" }))["worktrees"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn reflog_pages_newest_first() {
    let scratch = Scratch::new("reflog");
    let git = scratch.repo("repo");
    let second = commit(&git, "two.txt", "2\n", "Second");
    let third = commit(&git, "three.txt", "3\n", "Third");

    let response = dispatch(
        &git,
        json!({ "command": "reflog", "ref": "HEAD", "limit": 2 }),
    );
    assert_eq!(response["command"], "reflog");
    assert_eq!(response["ref"], "HEAD");
    assert!(response["error"].is_null());
    assert_eq!(response["moreAvailable"], true);
    let entries = response["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["hash"], third);
    assert_eq!(entries[0]["selector"], "HEAD@{0}");
    assert_eq!(entries[1]["hash"], second);
    assert_eq!(entries[1]["selector"], "HEAD@{1}");
    assert!(entries[0]["message"].as_str().unwrap().contains("Third"));
    assert!(entries[0]["date"].as_u64().unwrap() > 1_600_000_000);
    assert_eq!(entries[0]["dangling"], false);

    let response = dispatch(
        &git,
        json!({ "command": "reflog", "ref": "HEAD", "limit": 10 }),
    );
    assert_eq!(response["moreAvailable"], false);
    assert_eq!(response["entries"].as_array().unwrap().len(), 3);
}

#[test]
fn create_archive_writes_the_file() {
    let scratch = Scratch::new("archive");
    let git = scratch.repo("repo");
    let zip = scratch.path("out.zip").display().to_string();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "createArchive", "ref": "main", "outputFilePath": zip }),
    ));
    let bytes = fs::read(scratch.path("out.zip")).unwrap();
    assert_eq!(&bytes[..2], b"PK");
    let tar = scratch.path("out.tar").display().to_string();
    assert_ok(&dispatch(
        &git,
        json!({ "command": "createArchive", "ref": "main", "outputFilePath": tar }),
    ));
    assert!(fs::metadata(scratch.path("out.tar")).unwrap().len() > 512);
}

#[test]
fn gerrit_fetch_refs_toggle_clears_local_change_refs() {
    let scratch = Scratch::new("gerrit");
    let git = scratch.repo("repo");
    let response = dispatch(
        &git,
        json!({ "command": "gerritSetFetchRefs", "enabled": true }),
    );
    assert_ok(&response);
    assert_eq!(response["enabled"], true);
    assert_eq!(response["cleared"], 0);

    let tip = head(&git);
    git.run(&["update-ref", "refs/remotes/origin/changes/01/1/1", &tip])
        .unwrap();
    git.run(&["update-ref", "refs/remotes/origin/changes/02/2/1", &tip])
        .unwrap();
    let response = dispatch(
        &git,
        json!({ "command": "gerritSetFetchRefs", "enabled": false }),
    );
    assert_ok(&response);
    assert_eq!(response["enabled"], false);
    assert_eq!(response["cleared"], 2);
    assert!(git
        .output(&["for-each-ref", "refs/remotes/origin/changes/"])
        .unwrap()
        .trim()
        .is_empty());
}

#[test]
fn read_commands_are_not_handled_here() {
    let scratch = Scratch::new("reads");
    let git = scratch.repo("repo");
    for command in [
        "loadCommits",
        "loadRepoInfo",
        "commitDetails",
        "openFile",
        "viewDiff",
        "copyToClipboard",
    ] {
        assert!(
            handle(
                &git,
                &json!({ "command": command }),
                ActionSettings::default()
            )
            .is_none(),
            "{command}"
        );
    }
}
