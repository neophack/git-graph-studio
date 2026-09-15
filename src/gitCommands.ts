// The Git commands behind the Source Control view's "..." menu and the Command Palette: the
// set VS Code's Git extension offers (pull, push, sync, clone, checkout, branches, remotes,
// stashes, tags) and the extension's own contributions (amend, soft-reset to remote, the
// Gerrit hook and refs/for push). Each asks with a quick pick / input where VS Code does,
// runs through the backend, and reports through notifications.

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import type { CommandRegistry } from './commands';
import { runGraphAction, type GraphActionSettings } from './graphHost';
import { confirmDialog, notify, quickInput, quickPick, type QuickPickItem } from './ui';

interface BranchInfo { name: string; remote: boolean; current: boolean; upstream: string | null }
interface RemoteInfo { name: string; url: string }
interface StashInfo { selector: string; index: number; message: string; hash: string }

/** What the commands need from the workbench. */
export interface GitCommandHost {
	repoPath(): string | null;
	/** After a write: the SCM view, the graph, the explorer and the status bar catch up. */
	repoChanged(): void;
	openFolder(path: string): Promise<void>;
	showOutput(): void;
	/** The Git Graph view's settings for its write path (signing, squash messages). */
	graphSettings(): GraphActionSettings;
	/** The staged/unstaged state the SCM view knows, for the commit commands. */
	commit(options: { amend?: boolean; all?: boolean; stagedOnly?: boolean }): Promise<void>;
}

/** Run one of the Git Graph view's write requests through the seam (graphHost.ts): the
 *  confirmation protocol and git's complaint-as-Error are settled there. */
async function graphAction(host: GitCommandHost, message: Record<string, unknown>): Promise<void> {
	const repo = host.repoPath();
	if (!repo) throw new Error('No repository is open.');
	await runGraphAction({ ...message, repo }, {
		settings: host.graphSettings(),
		confirm: (text) => confirmDialog(text, 'Proceed')
	});
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
	const branches = await invoke<BranchInfo[]>('scm_branches');
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
	const remotes = await invoke<RemoteInfo[]>('scm_remotes');
	if (remotes.length === 0) {
		notify('info', 'The repository has no remotes. Add one with Remote > Add Remote...');
		return null;
	}
	if (remotes.length === 1) return remotes[0]!;
	const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), placeholder);
	return remotes.find((r) => r.name === chosen) ?? null;
}

async function pickStash(placeholder: string): Promise<StashInfo | null> {
	const stashes = await invoke<StashInfo[]>('scm_stashes');
	if (stashes.length === 0) {
		notify('info', 'There are no stashes in the repository.');
		return null;
	}
	const chosen = await quickPick(stashes.map((s) => ({ label: `#${s.index}: ${s.message}`, icon: 'archive', value: s.selector })), placeholder);
	return stashes.find((s) => s.selector === chosen) ?? null;
}

const REF_NAME = /^(?![-.])(?!.*(\.\.|@\{|[\\^:?*\[\s~]))[^\x00-\x1f\x7f]+(?<![./])(?<!\.lock)$/;

function validateRef(value: string): string | null {
	return value.trim() === '' ? 'A name is required' : REF_NAME.test(value.trim()) ? null : `'${value}' is not a valid Git reference name`;
}

export function registerGitCommands(commands: CommandRegistry, host: GitCommandHost): void {
	const category = 'Git';
	const hasRepo = () => host.repoPath() !== null;
	const add = (id: string, title: string, work: () => Promise<void>, keybinding?: string) =>
		commands.register({ id, title, category, keybinding, enabled: hasRepo, run: () => run(host, work) });

	/* Sync */
	add('git.pull', 'Pull', () => invoke('scm_pull', { remote: null, branch: null, rebase: false }));
	add('git.pullRebase', 'Pull (Rebase)', () => invoke('scm_pull', { remote: null, branch: null, rebase: true }));
	add('git.pullFrom', 'Pull from...', async () => {
		const remote = await pickRemote('Pick a remote to pull the branch from');
		if (!remote) return;
		const branch = await pickBranch(`Pick a branch to pull from ${remote.name}`, (b) => b.remote && b.name.startsWith(remote.name + '/'));
		if (!branch) return;
		await invoke('scm_pull', { remote: remote.name, branch: branch.name.slice(remote.name.length + 1), rebase: false });
	});
	add('git.push', 'Push', () => invoke('scm_push', { remote: null, setUpstream: false, force: false }));
	add('git.pushTo', 'Push to...', async () => {
		const remote = await pickRemote('Pick a remote to publish the branch to');
		if (!remote) return;
		await invoke('scm_push', { remote: remote.name, setUpstream: true, force: false });
	});
	add('git.pushForce', 'Push (Force With Lease)', async () => {
		if (!(await confirmDialog('Force-push the current branch to its upstream? Commits the remote has that this push does not contain become unreachable there.', 'Force Push'))) return;
		await invoke('scm_push', { remote: null, setUpstream: false, force: true });
	});
	add('git.sync', 'Sync', () => invoke('scm_sync', { rebase: false }));
	add('git.syncRebase', 'Sync (Rebase)', () => invoke('scm_sync', { rebase: true }));
	add('git.fetch', 'Fetch', () => invoke('scm_fetch', { remote: null, prune: false }));
	add('git.fetchPrune', 'Fetch (Prune)', () => invoke('scm_fetch', { remote: null, prune: true }));
	add('git.fetchFrom', 'Fetch From...', async () => {
		const remote = await pickRemote('Pick a remote to fetch from');
		if (remote) await invoke('scm_fetch', { remote: remote.name, prune: false });
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
				const path = await invoke<string>('scm_clone', { url: url.trim(), parent: folder, name: null });
				notify('info', `Cloned into ${path}`, [{ label: 'Open', run: () => void host.openFolder(path) }]);
			} catch (error) {
				notify('error', String(error));
			}
		}
	});

	/* Branches */
	add('git.checkout', 'Checkout to...', async () => {
		const branches = await invoke<BranchInfo[]>('scm_branches');
		const tags = await invoke<string[]>('scm_tags');
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
		const chosen = await quickPick(items, 'Select a branch or tag to checkout');
		if (chosen) await invoke('scm_checkout', { name: chosen.replace(/^(branch|tag):/, '') });
	});
	add('git.branch', 'Create Branch...', async () => {
		const name = await quickInput({ placeholder: 'Branch name', title: 'Please provide a new branch name', validate: validateRef });
		if (name) await invoke('scm_create_branch', { name: name.trim(), from: null });
	});
	add('git.branchFrom', 'Create Branch From...', async () => {
		const from = await pickBranch('Select a ref to create the branch from');
		if (!from) return;
		const name = await quickInput({ placeholder: 'Branch name', title: `Please provide a new branch name (from ${from.name})`, validate: validateRef });
		if (name) await invoke('scm_create_branch', { name: name.trim(), from: from.name });
	});
	add('git.renameBranch', 'Rename Branch...', async () => {
		const branch = await pickBranch('Select a branch to rename', (b) => !b.remote);
		if (!branch) return;
		const name = await quickInput({ placeholder: 'Branch name', title: `Please provide a new name for '${branch.name}'`, value: branch.name, validate: validateRef });
		if (name && name.trim() !== branch.name) await graphAction(host, { command: 'renameBranch', oldName: branch.name, newName: name.trim() });
	});
	add('git.deleteBranch', 'Delete Branch...', async () => {
		const branch = await pickBranch('Select a branch to delete', (b) => !b.remote && !b.current);
		if (!branch) return;
		if (!(await confirmDialog(`Delete the branch '${branch.name}'? Commits only reachable from it will be lost.`, 'Delete Branch'))) return;
		await graphAction(host, { command: 'deleteBranch', branchName: branch.name, forceDelete: true, deleteOnRemotes: [] });
	});
	add('git.merge', 'Merge Branch...', async () => {
		const branch = await pickBranch('Select a branch to merge from', (b) => !b.current);
		if (branch) await graphAction(host, { command: 'merge', obj: branch.name, actionOn: 'Branch', createNewCommit: false, squash: false, noCommit: false });
	});
	add('git.rebase', 'Rebase Branch...', async () => {
		const branch = await pickBranch('Select a branch to rebase onto', (b) => !b.current);
		if (branch) await graphAction(host, { command: 'rebase', obj: branch.name, actionOn: 'Branch', ignoreDate: false, interactive: false, autosquash: false });
	});

	/* Remotes */
	add('git.addRemote', 'Add Remote...', async () => {
		const url = await quickInput({ title: 'Add Remote', placeholder: 'Provide repository URL', validate: (v) => (v.trim() === '' ? 'A URL is required' : v.startsWith('-') ? 'Invalid URL' : null) });
		if (!url) return;
		const name = await quickInput({ title: 'Add Remote', placeholder: 'Remote name', value: 'origin', validate: validateRef });
		if (!name) return;
		await graphAction(host, { command: 'addRemote', name: name.trim(), url: url.trim(), pushUrl: null, fetch: true });
	});
	add('git.removeRemote', 'Remove Remote', async () => {
		const remotes = await invoke<RemoteInfo[]>('scm_remotes');
		if (remotes.length === 0) {
			notify('info', 'The repository has no remotes.');
			return;
		}
		const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), 'Pick a remote to remove');
		if (chosen) await graphAction(host, { command: 'deleteRemote', name: chosen });
	});

	/* Stashes */
	add('git.stash', 'Stash', async () => {
		const message = await quickInput({ title: 'Stash', placeholder: 'Optionally provide a stash message' });
		if (message === null) return;
		await graphAction(host, { command: 'pushStash', message, includeUntracked: false });
	});
	add('git.stashIncludeUntracked', 'Stash (Include Untracked)', async () => {
		const message = await quickInput({ title: 'Stash (Include Untracked)', placeholder: 'Optionally provide a stash message' });
		if (message === null) return;
		await graphAction(host, { command: 'pushStash', message, includeUntracked: true });
	});
	add('git.stashApply', 'Apply Stash...', async () => {
		const stash = await pickStash('Pick a stash to apply');
		if (stash) await graphAction(host, { command: 'applyStash', selector: stash.selector, reinstateIndex: false });
	});
	add('git.stashApplyLatest', 'Apply Latest Stash', () => graphAction(host, { command: 'applyStash', selector: 'refs/stash@{0}', reinstateIndex: false }));
	add('git.stashPop', 'Pop Stash...', async () => {
		const stash = await pickStash('Pick a stash to pop');
		if (stash) await graphAction(host, { command: 'popStash', selector: stash.selector, reinstateIndex: false });
	});
	add('git.stashPopLatest', 'Pop Latest Stash', () => graphAction(host, { command: 'popStash', selector: 'refs/stash@{0}', reinstateIndex: false }));
	add('git.stashDrop', 'Drop Stash...', async () => {
		const stash = await pickStash('Pick a stash to drop');
		if (stash && (await confirmDialog(`Drop the stash '${stash.message}'? This cannot be undone.`, 'Drop Stash'))) {
			await graphAction(host, { command: 'dropStash', selector: stash.selector });
		}
	});

	/* Tags */
	add('git.createTag', 'Create Tag', async () => {
		const name = await quickInput({ title: 'Create Tag', placeholder: 'Tag name', validate: validateRef });
		if (!name) return;
		const message = await quickInput({ title: 'Create Tag', placeholder: 'Message (leave empty for a lightweight tag)' });
		if (message === null) return;
		const head = await invoke<{ shortHash: string }>('repo_head');
		await graphAction(host, { command: 'addTag', tagName: name.trim(), commitHash: head.shortHash, type: message.trim() === '' ? 1 : 0, message, force: false, pushToRemote: null, pushSkipRemoteCheck: false });
	});
	add('git.deleteTag', 'Delete Tag', async () => {
		const tags = await invoke<string[]>('scm_tags');
		if (tags.length === 0) {
			notify('info', 'The repository has no tags.');
			return;
		}
		const chosen = await quickPick(tags.map((t) => ({ label: t, icon: 'tag', value: t })), 'Select a tag to delete');
		if (chosen) await graphAction(host, { command: 'deleteTag', tagName: chosen, deleteOnRemote: null });
	});

	/* Commits (the SCM view owns the message box; these route through it) */
	commands.register({ id: 'git.commit', title: 'Commit', category, enabled: hasRepo, run: () => host.commit({}) });
	commands.register({ id: 'git.commitStaged', title: 'Commit Staged', category, enabled: hasRepo, run: () => host.commit({ stagedOnly: true }) });
	commands.register({ id: 'git.commitAll', title: 'Commit All', category, enabled: hasRepo, run: () => host.commit({ all: true }) });
	commands.register({ id: 'git.commitAmend', title: 'Commit (Amend)', category, enabled: hasRepo, run: () => host.commit({ amend: true }) });
	commands.register({ id: 'git.commitStagedAmend', title: 'Commit Staged (Amend)', category, enabled: hasRepo, run: () => host.commit({ amend: true, stagedOnly: true }) });
	add('git.undoCommit', 'Undo Last Commit', () => graphAction(host, { command: 'undoLastCommit' }));

	/* The extension's own commands */
	add('gitGraph.amendLastCommit', 'Amend Last Commit', async () => {
		if (!(await confirmDialog('Amend the last commit with the staged changes (the message is kept)?', 'Amend'))) return;
		await invoke('scm_amend_last_commit');
	});
	add('gitGraph.gerritFetchCommitMsgHook', 'Fetch commit-msg Hook (Gerrit)', async () => {
		const remote = await pickRemote('Pick the Gerrit remote');
		if (!remote) return;
		const installed = await invoke<boolean>('gerrit_install_hook', { remote: remote.name });
		notify('info', installed ? 'The Gerrit commit-msg hook was installed.' : 'The Gerrit commit-msg hook is already installed.');
	});
	add('gitGraph.resetCurrentBranchToRemote', 'Reset Current Branch to Remote (Soft)', async () => {
		if (!(await confirmDialog('Soft-reset the current branch to its upstream? Your local commits are kept as staged changes.', 'Reset'))) return;
		const upstream = await invoke<string>('scm_reset_to_remote');
		notify('info', `The current branch was reset to ${upstream}; its changes are staged.`);
	});
	add('gitGraph.gerritPushRef', 'Push to Gerrit Ref for Current Branch (refs/for/...)', async () => {
		const remote = await pickRemote('Pick the Gerrit remote');
		if (!remote) return;
		const url = await invoke<string | null>('gerrit_push_ref', { remote: remote.name });
		if (url) notify('info', `Pushed for review: ${url}`, [{ label: 'Open Change', run: () => void openUrl(url) }]);
		else notify('info', `Pushed the current branch to ${remote.name} for review.`);
	});

	commands.register({ id: 'git.showOutput', title: 'Show Git Output', category, run: () => host.showOutput() });
}
