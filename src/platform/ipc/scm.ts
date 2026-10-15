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
}

/** One line of `scm_blame`. */
export interface BlameLine {
	hash: string;
	author: string;
	/** Seconds since the epoch. */
	time: number;
	summary: string;
}

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
export const gitCommit = (message: string, amend: boolean, repo?: string) => invoke<void>('git_commit', withRepo({ message, amend }, repo));
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
/** The Output view's Git channel: the runner's captured output, and the clear that keeps
 *  it bounded. */
export const gitOutputLog = () => invoke<string[]>('git_output_log');
export const gitOutputClear = () => invoke<void>('git_output_clear');
