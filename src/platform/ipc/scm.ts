// The typed IPC seam of the SCM domain (plan §5.6): one file per backend domain, function
// signatures as the contract. The status letters the Explorer decorates rows with, the
// branch/remote/stash/tag listings the picks feed on, the commit/stage writes and the
// gerrit contributions — the ggs-git crate behind the app's commands/scm adapters. The
// view's own generic runners (a "..." menu entry dispatching by name) keep the raw
// invoke: their command is a variable, not a literal this seam could own.
import { invoke } from './core';

/** repo-relative path (forward slashes) -> status letter (M A D R U !), as `scm_status`
 *  reports it. */
export type StatusMap = Map<string, string>;

/** One branch of `scm_branches`: local or remote-tracking, the checked-out one flagged. */
export interface BranchInfo {
	name: string;
	remote: boolean;
	current: boolean;
	upstream: string | null;
}

export interface RemoteInfo {
	name: string;
	url: string;
}

/** One stash of `scm_stashes`: the selector its apply/pop/drop commands take. */
export interface StashInfo {
	selector: string;
	index: number;
	message: string;
	hash: string;
}

/** One row of `scm_status`: a path with its staged/unstaged letters. */
export interface ScmChange {
	path: string;
	oldPath: string | null;
	staged: string | null;
	unstaged: string | null;
	untracked: boolean;
	/** The index holds conflict stages for the path: git lists it under "Unmerged paths". */
	conflicted?: boolean;
}

/** One commit of `file_log` (the Timeline). */
export interface HistoryEntry {
	hash: string;
	parents: string[];
	author: string;
	/** Seconds since the epoch. */
	date: number;
	message: string;
	/** The path the file carried at this commit — under `--follow`, the name it had
	 *  before a rename, which the row's diff and revision reads must open. */
	path: string;
}

/** One line of `scm_blame`. */
export interface BlameLine {
	hash: string;
	author: string;
	/** Seconds since the epoch. */
	time: number;
	summary: string;
}

/** One side of `scm_diff`: where its text comes from. `revision` carries the
 *  `read_file_at` vocabulary — `*` the working tree, `:index` the staged copy, anything
 *  else a git revision — and `text` overrides the read entirely (the diff editor's live
 *  buffer, so an edit re-diffs without touching the disk). */
export interface DiffSideSpec {
	revision: string;
	path: string;
	text?: string;
}

/** A run of characters within a changed line that differs from its twin on the other
 *  side — the inline highlight VS Code paints inside a changed line. The offsets are
 *  UTF-16 code units into the line's own `text`. */
export interface DiffSpanData {
	start: number;
	end: number;
}

/** One changed line of a `scm_diff` hunk, its text as the file carries it. `spans`
 *  carries the character-level difference against the line's twin in the same hunk
 *  (empty when the line has no twin or the pair was skipped as too far apart). */
export interface DiffLineData {
	kind: 'deleted' | 'added';
	text: string;
	spans?: DiffSpanData[];
}

/** One git-computed change: a run of deleted lines replaced by a run of added ones
 *  (either side may be empty). The starts are 1-based the way git's `@@ -l,c +l,c @@`
 *  headers spell them — a side with zero lines names the line the change sits after
 *  (`oldStart` 5 = an insertion following line 5). Hunks carry changed lines only; the
 *  unchanged gaps between them belong to the view. */
export interface DiffHunkData {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLineData[];
}

/** The backend's line diff for a text pair, computed by the gix engine (git's own
 *  algorithm and slider heuristics) — the frontend never diffs. `binary` replaces
 *  hunks when a side is binary. */
export interface LineDiffData {
	binary: boolean;
	hunks: DiffHunkData[];
	additions: number;
	deletions: number;
}

export const scmDiff = (args: {
	repo?: string;
	left: DiffSideSpec;
	right: DiffSideSpec;
	ignoreWhitespace?: boolean;
	ignoreCase?: boolean;
}) => invoke<LineDiffData>('scm_diff', args);

/** The repo-scoped forms omit the key entirely (the scripted backend records args as
 *  passed; an `undefined` property would differ from the key's absence). */
const withRepo = (args: Record<string, unknown>, repo?: string) => (repo === undefined ? args : { ...args, repo });

export const scmStatus = (repo?: string) => invoke<ScmChange[]>('scm_status', withRepo({}, repo));
export const scmBranches = (repo?: string) => invoke<BranchInfo[]>('scm_branches', withRepo({}, repo));
export const scmRemotes = (repo?: string) => invoke<RemoteInfo[]>('scm_remotes', withRepo({}, repo));
export const scmStashes = (repo?: string) => invoke<StashInfo[]>('scm_stashes', withRepo({}, repo));
export const scmTags = (repo?: string) => invoke<string[]>('scm_tags', withRepo({}, repo));
export const fileLog = (path: string, limit: number, repo: string) => invoke<HistoryEntry[] | null>('file_log', { path, limit, repo });
export const scmBlame = (path: string) => invoke<BlameLine[]>('scm_blame', { path });
export const gitInit = () => invoke<void>('git_init');
export const gitStage = (paths: string[]) => invoke<void>('git_stage', { paths });
export const gitStageAll = (repo?: string) => invoke<void>('git_stage_all', withRepo({}, repo));
/** "Stage All Tracked Changes": modifications and deletions of tracked files, never the untracked ones. */
export const gitStageAllTracked = (repo?: string) => invoke<void>('git_stage_all_tracked', withRepo({}, repo));
/** "Stage All Untracked Changes": only the untracked files; the tracked changes stay unstaged. */
export const gitStageAllUntracked = (repo?: string) => invoke<void>('git_stage_all_untracked', withRepo({}, repo));
/** Commit the index; `signoff` adds the `Signed-off-by:` trailer (omitted from the wire when
 *  false, so the recorded args stay the two-flag shape older recordings made). */
export const gitCommit = (message: string, amend: boolean, signoff = false, repo?: string) =>
  invoke<void>('git_commit', withRepo(signoff ? { message, amend, signoff } : { message, amend }, repo));
export const scmPull = (remote: string | null, branch: string | null, rebase: boolean, repo?: string) => invoke<void>('scm_pull', withRepo({ remote, branch, rebase }, repo));
export const scmPush = (remote: string | null, setUpstream: boolean, force: boolean, repo?: string) => invoke<void>('scm_push', withRepo({ remote, setUpstream, force }, repo));
export const scmSync = (rebase: boolean, repo?: string) => invoke<void>('scm_sync', withRepo({ rebase }, repo));
export const scmFetch = (remote: string | null, prune: boolean, repo?: string) => invoke<void>('scm_fetch', withRepo({ remote, prune }, repo));
export const scmCheckout = (name: string, repo?: string) => invoke<void>('scm_checkout', withRepo({ name }, repo));
export const scmCreateBranch = (name: string, from: string | null, repo?: string) => invoke<void>('scm_create_branch', withRepo({ name, from }, repo));
export const scmClone = (url: string, parent: string, name: string | null) => invoke<string>('scm_clone', { url, parent, name });
export const scmAmendLastCommit = (repo: string) => invoke<void>('scm_amend_last_commit', { repo });
export const gerritInstallHook = (remote: string, repo: string) => invoke<boolean>('gerrit_install_hook', { remote, repo });
export const scmResetToRemote = (repo: string) => invoke<string>('scm_reset_to_remote', { repo });
export const gerritPushRef = (remote: string, repo: string) => invoke<string | null>('gerrit_push_ref', { remote, repo });
/** Cherry-pick / revert an existing commit onto HEAD; the answer is the new HEAD's subject
 *  (the write's success notification). A conflict fails with git's complaint plus the
 *  conflicted paths. */
export const scmCherryPick = (target: string, repo?: string) => invoke<string>('scm_cherry_pick', withRepo({ target }, repo));
export const scmRevertCommit = (target: string, repo?: string) => invoke<string>('scm_revert_commit', withRepo({ target }, repo));
/** Reset the current branch to `target` at `mode`'s depth — `soft` | `mixed` | `hard`
 *  (anything else the backend rejects before git runs). */
export const scmResetRef = (target: string, mode: 'soft' | 'mixed' | 'hard', repo?: string) => invoke<void>('scm_reset_ref', withRepo({ target, mode }, repo));
/** Soft-reset past the last commit; the answer is its message, for the commit input to refill. */
export const scmUndoLastCommit = (repo?: string) => invoke<string>('scm_undo_last_commit', withRepo({}, repo));
/** Whether a branch's tip is reachable from HEAD (`git merge-base --is-ancestor`): the
 *  delete confirmation's merged/unmerged fact. */
export const scmBranchMerged = (branchName: string, repo?: string) => invoke<boolean>('scm_branch_merged', withRepo({ branchName }, repo));
/** Push the local branch of the chosen name to the remote (`refs/heads/<b>:refs/heads/<b>`)
 *  — works from any checkout, the checked-out branch's upstream untouched. */
export const scmPushBranch = (remote: string, branch: string, force: boolean, repo?: string) => invoke<void>('scm_push_branch', withRepo({ remote, branch, force }, repo));
/** Delete a branch on the remote (`git push <remote> --delete <branch>`); the local branch stays. */
export const scmDeleteRemoteBranch = (remote: string, branch: string, repo?: string) => invoke<void>('scm_delete_remote_branch', withRepo({ remote, branch }, repo));
/** Delete a tag on the remote (`git push <remote> --delete <tag>`); the local tag stays. */
export const scmDeleteRemoteTag = (remote: string, tagName: string, repo?: string) => invoke<void>('scm_delete_remote_tag', withRepo({ remote, tagName }, repo));
/** Push every local tag to the remote (`git push <remote> --tags`). */
export const scmPushTags = (remote: string, repo?: string) => invoke<void>('scm_push_tags', withRepo({ remote }, repo));
/** Whether a stopped merge or a stopped rebase is pending — the abort commands' guard. */
export const scmOperationState = (repo?: string) => invoke<ScmOperationState>('scm_operation_state', withRepo({}, repo));
/** One shape of the in-progress-operation probe (camelCase on the wire). */
export interface ScmOperationState {
  merge: boolean;
  rebase: boolean;
}
/** Back out of a stopped merge (`git merge --abort`) or a stopped rebase (`git rebase --abort`). */
export const scmAbortMerge = (repo?: string) => invoke<void>('scm_abort_merge', withRepo({}, repo));
export const scmAbortRebase = (repo?: string) => invoke<void>('scm_abort_rebase', withRepo({}, repo));
/** The Output view's Git channel: the runner's captured output, and the clear that keeps
 *  it bounded. */
export const gitOutputLog = () => invoke<string[]>('git_output_log');
export const gitOutputClear = () => invoke<void>('git_output_clear');
