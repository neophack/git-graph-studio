// The Git commands behind the Source Control view's "..." menu and the Command Palette: the
// set VS Code's Git extension offers (pull, push, sync, clone, checkout, branches, remotes,
// stashes, tags). The git-graph-rs contributions (amend, soft-reset to remote, the Gerrit hook
// and refs/for push) are the plugin's own manifest commands, run by its backend. Each asks with a quick pick / input where VS Code does,
// runs through the backend, and reports through notifications.

import { invoke } from '../../platform/ipc/core';
import { scmAbortMerge, scmAbortRebase, type BranchInfo, scmBranches, scmBranchMerged, scmCheckout, scmCherryPick, scmClone, scmCreateBranch, scmDeleteRemoteBranch, scmDeleteRemoteTag, type RemoteInfo, scmFetch, scmOperationState, scmPull, scmPush, scmPushBranch, scmPushTags, scmRevertCommit, scmResetRef, type StashInfo, scmRemotes, scmStashes, scmSync, scmTags } from '../../platform/ipc/scm';
import { repoHead } from '../../platform/ipc/revision';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import type { CommandRegistry } from '../../platform/commands';
import { t, tf } from '../../platform/i18n';
import { confirmDialog, notify, quickInput, quickPick, type QuickPickItem } from '../../platform/ui/index';
/** What the commands need from the workbench. */
export interface GitCommandHost {
	repoPath(): string | null;
	/** After a write: the SCM view, the graph, the explorer and the status bar catch up. */
	repoChanged(): void;
	openFolder(path: string): Promise<void>;
	showOutput(): void;
	/** The staged/unstaged state the SCM view knows, for the commit commands. */
	commit(options: { amend?: boolean; all?: boolean; stagedOnly?: boolean; signoff?: boolean }): Promise<void>;
	/** Undo Last Commit through the view, so the undone message refills its commit box. */
	undoCommit(): Promise<void>;
}

/** Run one mutating backend command against the open repository; git's own complaint travels
 *  as the rejection the caller's `run` reports. */
async function gitOp(command: string, args: Record<string, unknown>): Promise<void> {
	await invoke(command, args);
}

async function run(host: GitCommandHost, work: () => Promise<void>, done?: string): Promise<void> {
	if (!host.repoPath()) {
		notify('warning', 'Open a folder containing a Git repository first.');
		return;
	}
	try {
		await work();
		if (done) notify('info', done);
	} catch (error) {
		notify('error', String(error instanceof Error ? error.message : error));
	}
	host.repoChanged();
}

async function pickBranch(placeholder: string, filter: (b: BranchInfo) => boolean = () => true): Promise<BranchInfo | null> {
	const branches = await scmBranches();
	const items: QuickPickItem[] = branches.filter(filter).map((b) => ({
		label: b.name,
		description: b.current ? 'current' : b.remote ? 'remote branch' : b.upstream ? `→ ${b.upstream}` : undefined,
		icon: b.remote ? 'cloud' : 'git-branch',
		value: b.name
	}));
	if (items.length === 0) {
		notify('info', 'There are no branches to choose from.');
		return null;
	}
	const chosen = await quickPick(items, placeholder);
	return branches.find((b) => b.name === chosen) ?? null;
}

async function pickRemote(placeholder: string): Promise<RemoteInfo | null> {
	const remotes = await scmRemotes();
	if (remotes.length === 0) {
		notify('info', 'The repository has no remotes. Add one with Remote > Add Remote...');
		return null;
	}
	if (remotes.length === 1) return remotes[0]!;
	const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), placeholder);
	return remotes.find((r) => r.name === chosen) ?? null;
}

async function pickStash(placeholder: string): Promise<StashInfo | null> {
	const stashes = await scmStashes();
	if (stashes.length === 0) {
		notify('info', 'There are no stashes in the repository.');
		return null;
	}
	const chosen = await quickPick(stashes.map((s) => ({ label: `#${s.index}: ${s.message}`, icon: 'archive', value: s.selector })), placeholder);
	return stashes.find((s) => s.selector === chosen) ?? null;
}

/** Push the current branch. With no upstream and several remotes, ask which one to
 *  publish to — the silent first-remote guess records the wrong upstream; a single
 *  remote (or an upstream already set) keeps the plain push. */
async function pushCurrent(setUpstream: boolean, force: boolean): Promise<void> {
	let remote: string | null = null;
	const head = await repoHead().catch(() => null);
	if (head && head.upstream === null) {
		const remotes = (await scmRemotes().catch(() => [])) ?? [];
		if (remotes.length > 1) {
			const chosen = await pickRemote('Pick a remote to publish the branch to');
			if (!chosen) return;
			remote = chosen.name;
		}
	}
	await scmPush(remote, setUpstream, force);
}

/** Git's own ref-name rules — `git check-ref-format`'s set, pinned against the real
 *  binary (every line a case it answers; the backend's `is_safe_ref_name` mirrors this
 *  line for line): no empty name; nothing leading with `-` (git itself refuses it — and
 *  our spawn would read it as an option), `/` or `.`; nothing ending with `/` or `.`;
 *  not the single `@` (the revision-syntax token — an `@` component or an `@` anywhere
 *  else is legal, as are `]` and dots inside a name); no `..` or `@{` sequence anywhere;
 *  nowhere any character git refuses: ASCII control, space, `~ ^ : ? * [` and `\`. Per
 *  component (`/` splits): no empty component (`//`), none starting with `.`
 *  (`refs/.hidden` is out), none ending with `.lock` (`foo.lock/bar` is out, while
 *  `foo./bar` and `foo.lock./bar` stand). */
export function isSafeRefName(name: string): boolean {
	if (name === '' || name === '@') return false;
	if (/^[-/.]/.test(name) || /[/.]$/.test(name)) return false;
	if (/[\x00-\x1f\x7f\s~^:?*[]/.test(name) || name.includes('\\')) return false;
	if (name.includes('..') || name.includes('@{')) return false;
	return !name.split('/').some((component) => component === '' || component.startsWith('.') || component.endsWith('.lock'));
}

function validateRef(value: string): string | null {
	return value.trim() === '' ? 'A name is required' : isSafeRefName(value.trim()) ? null : `'${value}' is not a valid Git reference name`;
}

/** The commit-ish the cherry-pick / revert / reset inputs take: a commit hash, a ref, or a
 *  revision expression ("HEAD~1", "HEAD^", "main@{yesterday}") — what VS Code's own
 *  "Reset Current Branch to Commit" accepts. The backend resolves the raw expression
 *  against git (`rev-parse --verify <expr>^{commit}`) before anything runs, git's own
 *  complaint traveling back when it names nothing, so this local check keeps only the
 *  shapes that could never be a revision: an empty input, or a leading dash that would
 *  ride the spawn as an option. */
export function validateTarget(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === '') return t('scm.target.required');
	if (trimmed.startsWith('-') || /\s/.test(trimmed)) return t('scm.target.invalid');
	return null;
}

/** The detached-checkout input takes a commit hash alone (4-64 hex digits, the shape the
 *  backend's validator accepts) — `validateTarget`'s looser commit-ish rules do not apply
 *  to it. */
const COMMIT_HASH = /^[0-9a-fA-F]{4,64}$/;

export function validateCommitHash(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === '') return t('scm.checkoutDetached.required');
	return COMMIT_HASH.test(trimmed) ? null : t('scm.checkoutDetached.invalid');
}

export function registerGitCommands(commands: CommandRegistry, host: GitCommandHost): void {
	const category = 'Git';
	const hasRepo = () => host.repoPath() !== null;
	const add = (id: string, title: string, work: () => Promise<void>, keybinding?: string) =>
		commands.register({ id, title, category, keybinding, enabled: hasRepo, run: () => run(host, work) });

	/* Sync */
	add('git.pull', 'Pull', () => scmPull(null, null, false));
	add('git.pullRebase', 'Pull (Rebase)', () => scmPull(null, null, true));
	add('git.pullFrom', 'Pull from...', async () => {
		const remote = await pickRemote('Pick a remote to pull the branch from');
		if (!remote) return;
		const branch = await pickBranch(`Pick a branch to pull from ${remote.name}`, (b) => b.remote && b.name.startsWith(remote.name + '/'));
		if (!branch) return;
		await scmPull(remote.name, branch.name.slice(remote.name.length + 1), false);
	});
	add('git.push', 'Push', () => pushCurrent(false, false));
	add('git.pushTo', 'Push to...', async () => {
		const remote = await pickRemote('Pick a remote to publish the branch to');
		if (!remote) return;
		// The second step offers the remote's own branches (the names as the remote spells
		// them); a free-typed name publishes under it, the same as VS Code's pick.
		const prefix = remote.name + '/';
		const remoteBranches = (await scmBranches()).filter((b) => b.remote && b.name.startsWith(prefix)).map((b) => b.name.slice(prefix.length));
		const branch = remoteBranches.length > 0
			? await quickPick(remoteBranches.map((b) => ({ label: b, icon: 'cloud', value: b })), tf('scm.pushTo.pickBranch', remote.name))
			: await quickInput({ title: 'Push to...', placeholder: tf('scm.pushTo.pickBranch', remote.name), validate: validateRef });
		if (!branch) return;
		await scmPushBranch(remote.name, branch.trim(), false);
	});
	add('git.pushForce', 'Push (Force With Lease)', async () => {
		if (!(await confirmDialog('Force-push the current branch to its upstream? Commits the remote has that this push does not contain become unreachable there.', 'Force Push'))) return;
		await pushCurrent(false, true);
	});
	add('git.sync', 'Sync', () => scmSync(false));
	add('git.syncRebase', 'Sync (Rebase)', () => scmSync(true));
	add('git.fetch', 'Fetch', () => scmFetch(null, false));
	add('git.fetchPrune', 'Fetch (Prune)', () => scmFetch(null, true));
	add('git.fetchFrom', 'Fetch From...', async () => {
		const remote = await pickRemote('Pick a remote to fetch from');
		if (remote) await scmFetch(remote.name, false);
	});

	commands.register({
		id: 'git.clone',
		title: 'Clone',
		category,
		run: async () => {
			const url = await quickInput({ title: 'Clone Repository', placeholder: 'Provide repository URL or pick a repository source.', validate: (v) => (v.trim() === '' ? 'A repository URL is required' : null) });
			if (!url) return;
			let parent: string | string[] | null;
			try {
				parent = await openDialog({ directory: true, multiple: false, title: 'Choose a folder to clone into' });
			} catch (error) {
				notify('error', String(error));
				return;
			}
			if (!parent) return;
			const folder = Array.isArray(parent) ? parent[0]! : parent;
			try {
				const path = await scmClone(url.trim(), folder, null);
				notify('info', `Cloned into ${path}`, [{ label: 'Open', run: () => void host.openFolder(path) }]);
			} catch (error) {
				notify('error', String(error));
			}
		}
	});

	/* Branches */
	add('git.checkout', 'Checkout to...', async () => {
		const branches = await scmBranches();
		const tags = await scmTags();
		const items: QuickPickItem[] = [
			...branches.filter((b) => !b.current).map((b) => ({
				label: b.name,
				description: b.remote ? 'remote branch' : b.upstream ? `→ ${b.upstream}` : undefined,
				icon: b.remote ? 'cloud' : 'git-branch',
				value: 'branch:' + b.name
			})),
			...tags.map((t) => ({ label: t, description: 'tag', icon: 'tag', value: 'tag:' + t }))
		];
		if (items.length === 0) {
			notify('info', 'There are no branches or tags to checkout.');
			return;
		}
		// VS Code's trailing affordance: checking a commit out directly, in a detached HEAD.
		items.push({ label: t('scm.checkoutDetached.pick'), description: undefined, icon: 'git-commit', value: 'detached:' });
		const chosen = await quickPick(items, 'Select a branch or tag to checkout');
		if (!chosen) return;
		if (chosen.startsWith('detached:')) {
			if (!(await confirmDialog(t('scm.checkoutDetached.confirm'), t('scm.checkoutDetached.action')))) return;
			const hash = await quickInput({ title: t('scm.checkoutDetached.pick'), placeholder: t('scm.checkoutDetached.placeholder'), validate: validateCommitHash });
			if (!hash) return;
			await scmCheckout(hash.trim());
			return;
		}
		await scmCheckout(chosen.replace(/^(branch|tag):/, ''));
	});
	add('git.branch', 'Create Branch...', async () => {
		const name = await quickInput({ placeholder: 'Branch name', title: 'Please provide a new branch name', validate: validateRef });
		if (name) await scmCreateBranch(name.trim(), null);
	});
	add('git.branchFrom', 'Create Branch From...', async () => {
		const from = await pickBranch('Select a ref to create the branch from');
		if (!from) return;
		const name = await quickInput({ placeholder: 'Branch name', title: `Please provide a new branch name (from ${from.name})`, validate: validateRef });
		if (name) await scmCreateBranch(name.trim(), from.name);
	});
	add('git.renameBranch', 'Rename Branch...', async () => {
		const branch = await pickBranch('Select a branch to rename', (b) => !b.remote);
		if (!branch) return;
		const name = await quickInput({ placeholder: 'Branch name', title: `Please provide a new name for '${branch.name}'`, value: branch.name, validate: validateRef });
		if (name && name.trim() !== branch.name) await gitOp('scm_rename_branch', { oldName: branch.name, newName: name.trim() });
	});
	add('git.deleteBranch', 'Delete Branch...', async () => {
		const branch = await pickBranch('Select a branch to delete', (b) => !b.remote && !b.current);
		if (!branch) return;
		// The merged fact words the confirmation: an unmerged branch's commits would be
		// unreachable, so only that case offers the force delete with the irreversible
		// wording; a merged one deletes with the ordinary confirm (git's safe `-d` still
		// refuses if the state moved since the probe).
		let merged: boolean;
		try {
			merged = await scmBranchMerged(branch.name);
		} catch (error) {
			notify('error', String(error instanceof Error ? error.message : error));
			return;
		}
		if (!merged) {
			if (!(await confirmDialog(tf('scm.deleteBranch.unmergedConfirm', branch.name), t('scm.deleteBranch.forceAction')))) return;
			await gitOp('scm_delete_branch', { branchName: branch.name, force: true });
			return;
		}
		if (!(await confirmDialog(`Delete the branch '${branch.name}'? Commits only reachable from it will be lost.`, 'Delete Branch'))) return;
		await gitOp('scm_delete_branch', { branchName: branch.name, force: false });
	});
	add('git.deleteRemoteBranch', 'Delete Remote Branch...', async () => {
		const remote = await pickRemote('Pick a remote to delete the branch from');
		if (!remote) return;
		const prefix = remote.name + '/';
		const branch = await pickBranch(`Pick a branch to delete from ${remote.name}`, (b) => b.remote && b.name.startsWith(prefix));
		if (!branch) return;
		const name = branch.name.slice(prefix.length);
		if (!(await confirmDialog(tf('scm.deleteRemoteBranch.confirm', name, remote.name), t('scm.deleteRemoteBranch.action')))) return;
		await scmDeleteRemoteBranch(remote.name, name);
		notify('info', tf('scm.deleteRemoteBranch.done', name, remote.name));
	});
	add('git.merge', 'Merge Branch...', async () => {
		const branch = await pickBranch('Select a branch to merge from', (b) => !b.current);
		if (branch) await gitOp('scm_merge', { name: branch.name });
	});
	add('git.rebase', 'Rebase Branch...', async () => {
		const branch = await pickBranch('Select a branch to rebase onto', (b) => !b.current);
		if (branch) await gitOp('scm_rebase', { name: branch.name });
	});
	// VS Code's abort entries: a stopped merge or rebase backs out with one command, the
	// working tree returned to where the operation began. The in-progress probe keeps the
	// idle case a plain info instead of git's fatal.
	add('git.mergeAbort', 'Abort Merge', async () => {
		const state = await scmOperationState().catch(() => null);
		if (state && !state.merge) {
			notify('info', t('scm.abortMerge.none'));
			return;
		}
		if (!(await confirmDialog(t('scm.abortMerge.confirm'), t('scm.abortMerge.action')))) return;
		await scmAbortMerge();
	});
	add('git.rebaseAbort', 'Abort Rebase', async () => {
		const state = await scmOperationState().catch(() => null);
		if (state && !state.rebase) {
			notify('info', t('scm.rebaseAbort.none'));
			return;
		}
		if (!(await confirmDialog(t('scm.rebaseAbort.confirm'), t('scm.rebaseAbort.action')))) return;
		await scmAbortRebase();
	});

	/* Commits: cherry-pick, revert, reset (the palette's commit-rewriting trio) */
	add('git.cherryPick', 'Cherry-Pick...', async () => {
		const target = await quickInput({ title: 'Cherry-Pick', placeholder: t('scm.cherryPick.placeholder'), validate: validateTarget });
		if (!target) return;
		const subject = await scmCherryPick(target.trim());
		notify('info', tf('scm.cherryPick.done', subject));
	});
	add('git.revertCommit', 'Revert Commit...', async () => {
		const target = await quickInput({ title: 'Revert Commit', placeholder: t('scm.revert.placeholder'), validate: validateTarget });
		if (!target) return;
		const subject = await scmRevertCommit(target.trim());
		notify('info', tf('scm.revert.done', subject));
	});
	add('git.resetToCommit', 'Reset Current Branch to Commit...', async () => {
		const target = await quickInput({ title: 'Reset Current Branch to Commit', placeholder: t('scm.reset.placeholder'), validate: validateTarget });
		if (!target) return;
		const ref = target.trim();
		const mode = await quickPick([
			{ label: 'Soft', description: t('scm.reset.soft'), icon: 'arrow-up', value: 'soft' },
			{ label: 'Mixed', description: t('scm.reset.mixed'), icon: 'arrow-both', value: 'mixed' },
			{ label: 'Hard', description: t('scm.reset.hard'), icon: 'discard', value: 'hard' }
		], t('scm.reset.modePrompt'), tf('scm.reset.title', ref));
		if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') return;
		// Hard discards every uncommitted change: the same irreversible warning the
		// discard-all confirm carries, before git runs.
		if (mode === 'hard' && !(await confirmDialog(tf('scm.reset.hardConfirm', ref), t('scm.reset.hardAction')))) return;
		await scmResetRef(ref, mode);
		notify('info', tf('scm.reset.done', ref, mode));
	});

	/* Remotes */
	add('git.addRemote', 'Add Remote...', async () => {
		const url = await quickInput({ title: 'Add Remote', placeholder: 'Provide repository URL', validate: (v) => (v.trim() === '' ? 'A URL is required' : v.startsWith('-') ? 'Invalid URL' : null) });
		if (!url) return;
		const name = await quickInput({ title: 'Add Remote', placeholder: 'Remote name', value: 'origin', validate: validateRef });
		if (!name) return;
		await gitOp('scm_add_remote', { name: name.trim(), url: url.trim(), fetch: true });
	});
	add('git.removeRemote', 'Remove Remote', async () => {
		const remotes = await scmRemotes();
		if (remotes.length === 0) {
			notify('info', 'The repository has no remotes.');
			return;
		}
		const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), 'Pick a remote to remove');
		if (chosen) await gitOp('scm_delete_remote', { name: chosen });
	});
	add('git.listRemotes', 'All Remotes...', async () => {
		const remotes = await scmRemotes();
		if (remotes.length === 0) {
			notify('info', 'The repository has no remotes.');
			return;
		}
		const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), 'Pick a remote to copy its URL or delete it');
		if (!chosen) return;
		const remote = remotes.find((r) => r.name === chosen);
		if (!remote) return;
		const action = await quickPick([
			{ label: 'Copy URL', icon: 'copy', value: 'copy' },
			{ label: 'Delete', icon: 'trash', value: 'delete' }
		], remote.name);
		if (action === 'copy') {
			await writeText(remote.url);
			notify('info', `The URL of '${remote.name}' is on the clipboard.`);
		} else if (action === 'delete') {
			await gitOp('scm_delete_remote', { name: remote.name });
		}
	});

	/* Stashes */
	add('git.stash', 'Stash', async () => {
		const message = await quickInput({ title: 'Stash', placeholder: 'Optionally provide a stash message' });
		if (message === null) return;
		await gitOp('scm_push_stash', { message, includeUntracked: false, staged: false });
	});
	add('git.stashIncludeUntracked', 'Stash (Include Untracked)', async () => {
		const message = await quickInput({ title: 'Stash (Include Untracked)', placeholder: 'Optionally provide a stash message' });
		if (message === null) return;
		await gitOp('scm_push_stash', { message, includeUntracked: true, staged: false });
	});
	add('git.stashStaged', 'Stash Staged', async () => {
		const message = await quickInput({ title: 'Stash Staged', placeholder: 'Optionally provide a stash message' });
		if (message === null) return;
		await gitOp('scm_push_stash', { message, includeUntracked: false, staged: true });
	});
	add('git.stashApply', 'Apply Stash...', async () => {
		const stash = await pickStash('Pick a stash to apply');
		if (stash) await gitOp('scm_apply_stash', { selector: stash.selector, reinstateIndex: false });
	});
	add('git.stashApplyLatest', 'Apply Latest Stash', () => gitOp('scm_apply_stash', { selector: 'refs/stash@{0}', reinstateIndex: false }));
	add('git.stashPop', 'Pop Stash...', async () => {
		const stash = await pickStash('Pick a stash to pop');
		if (stash) await gitOp('scm_pop_stash', { selector: stash.selector, reinstateIndex: false });
	});
	add('git.stashPopLatest', 'Pop Latest Stash', () => gitOp('scm_pop_stash', { selector: 'refs/stash@{0}', reinstateIndex: false }));
	add('git.stashDrop', 'Drop Stash...', async () => {
		const stash = await pickStash('Pick a stash to drop');
		if (stash && (await confirmDialog(`Drop the stash '${stash.message}'? This cannot be undone.`, 'Drop Stash'))) {
			await gitOp('scm_drop_stash', { selector: stash.selector });
		}
	});

	/* Tags */
	add('git.createTag', 'Create Tag', async () => {
		const name = await quickInput({ title: 'Create Tag', placeholder: 'Tag name', validate: validateRef });
		if (!name) return;
		const message = await quickInput({ title: 'Create Tag', placeholder: 'Message (leave empty for a lightweight tag)' });
		if (message === null) return;
		const head = await repoHead();
		// The full hash, never the 7-character display prefix: a short form is ambiguous
		// in a large repository, and a tag on the wrong commit is a rewrite to undo.
		await gitOp('scm_add_tag', { tagName: name.trim(), commitHash: head.hash || head.shortHash, message, force: false });
	});
	add('git.deleteTag', 'Delete Tag', async () => {
		const tags = await scmTags();
		if (tags.length === 0) {
			notify('info', 'The repository has no tags.');
			return;
		}
		const chosen = await quickPick(tags.map((t) => ({ label: t, icon: 'tag', value: t })), 'Select a tag to delete');
		if (chosen) await gitOp('scm_delete_tag', { tagName: chosen });
	});
	add('git.deleteRemoteTag', 'Delete Remote Tag...', async () => {
		const tags = await scmTags();
		if (tags.length === 0) {
			notify('info', 'The repository has no tags.');
			return;
		}
		const tag = await quickPick(tags.map((t) => ({ label: t, icon: 'tag', value: t })), 'Select a tag to delete from the remote');
		if (!tag) return;
		const remote = await pickRemote('Pick a remote to delete the tag from');
		if (!remote) return;
		if (!(await confirmDialog(tf('scm.deleteRemoteTag.confirm', tag, remote.name), t('scm.deleteRemoteTag.action')))) return;
		await scmDeleteRemoteTag(remote.name, tag);
		notify('info', tf('scm.deleteRemoteTag.done', tag, remote.name));
	});
	add('git.pushTags', 'Push Tags', async () => {
		const remote = await pickRemote('Pick a remote to push the tags to');
		if (!remote) return;
		await scmPushTags(remote.name);
		notify('info', tf('scm.pushTags.done', remote.name));
	});

	/* Staging halves (VS Code's "Stage All Tracked Changes" / "Stage All Untracked Changes") */
	add('git.stageAllTracked', 'Stage All Tracked Changes', () => gitOp('git_stage_all_tracked', {}));
	add('git.stageAllUntracked', 'Stage All Untracked Changes', () => gitOp('git_stage_all_untracked', {}));

	/* Commits (the SCM view owns the message box; these route through it) */
	commands.register({ id: 'git.commit', title: 'Commit', category, enabled: hasRepo, run: () => host.commit({}) });
	commands.register({ id: 'git.commitStaged', title: 'Commit Staged', category, enabled: hasRepo, run: () => host.commit({ stagedOnly: true }) });
	commands.register({ id: 'git.commitAll', title: 'Commit All', category, enabled: hasRepo, run: () => host.commit({ all: true }) });
	commands.register({ id: 'git.commitAmend', title: 'Commit (Amend)', category, enabled: hasRepo, run: () => host.commit({ amend: true }) });
	commands.register({ id: 'git.commitStagedAmend', title: 'Commit Staged (Amend)', category, enabled: hasRepo, run: () => host.commit({ amend: true, stagedOnly: true }) });
	// The Signed-off-by variants VS Code's palette offers beside the plain ones.
	commands.register({ id: 'git.commitSignedOff', title: 'Commit (Signed Off)', category, enabled: hasRepo, run: () => host.commit({ signoff: true }) });
	commands.register({ id: 'git.commitStagedSignedOff', title: 'Commit Staged (Signed Off)', category, enabled: hasRepo, run: () => host.commit({ signoff: true, stagedOnly: true }) });
	commands.register({ id: 'git.commitAllSignedOff', title: 'Commit All (Signed Off)', category, enabled: hasRepo, run: () => host.commit({ signoff: true, all: true }) });
	commands.register({ id: 'git.commitAmendSignedOff', title: 'Commit (Amend, Signed Off)', category, enabled: hasRepo, run: () => host.commit({ signoff: true, amend: true }) });
	commands.register({ id: 'git.commitStagedAmendSignedOff', title: 'Commit Staged (Amend, Signed Off)', category, enabled: hasRepo, run: () => host.commit({ signoff: true, amend: true, stagedOnly: true }) });
	// Through the view: the undone commit's message refills its commit box.
	commands.register({ id: 'git.undoCommit', title: 'Undo Last Commit', category, enabled: hasRepo, run: () => host.undoCommit() });

	commands.register({ id: 'git.showOutput', title: 'Show Git Output', category, run: () => host.showOutput() });
}
