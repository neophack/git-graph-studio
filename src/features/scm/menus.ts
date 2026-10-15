// The view's menus and view-mode/sort switches: the '...' menu and the sub-repo variants.


import { invoke } from '../../platform/ipc/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { resolvedMenuEntries } from '../extensions';
import { gerritInstallHook, gerritPushRef, scmAmendLastCommit, scmBranches, scmCheckout, scmCreateBranch, scmFetch, scmPull, scmPush, scmRemotes, scmResetToRemote, scmSync, scmTags } from '../../platform/ipc/scm';
import { repoHead } from '../../platform/ipc/revision';
import * as state from '../../platform/state';
import { confirmDialog, notify, quickInput, quickPick, type MenuEntry, type QuickPickItem } from '../../platform/ui/index';
import { SubRepoState, pickBranchIn, pickRemoteIn, pickStashIn, validateSubRef } from './view';
import type { ScmSort, ScmViewMode, SourceControlView } from './view';

/** The menus concern of SourceControlView — assigned onto the prototype by the module facade. */
export const menusMethods: ThisType<SourceControlView> = {
	moreMenu(): MenuEntry[] {
		const cmd = (id: string): MenuEntry => (this.commands ? this.commands.menuItem(id) : { label: id, disabled: true });
		const toggleView: MenuEntry = { label: this.viewMode === 'tree' ? 'View as List' : 'View as Tree', run: () => this.setViewMode(this.viewMode === 'tree' ? 'list' : 'tree') };
		// The installed extensions' scm/title entries not in the "navigation" group (those
		// render as title-bar icons instead, see render()) — the extension's own commands,
		// whichever locale variant its manifest's `when` currently selects.
		const graphTitleMenu: MenuEntry[] = resolvedMenuEntries('scm/title')
			.filter((entry) => entry.group !== 'navigation')
			.map((entry) => ({
				label: entry.label,
				disabled: this.commands ? !this.commands.isEnabled(entry.command) : true,
				run: () => void this.commands?.execute(entry.command)
			}));
		// Its git.pullpush entries (the Gerrit `refs/for/` push) sit in the Pull, Push submenu,
		// the placement VS Code's own sync menu gives them.
		const pullPushMenu: MenuEntry[] = resolvedMenuEntries('git.pullpush').map((entry) => ({
			label: entry.label,
			disabled: this.commands ? !this.commands.isEnabled(entry.command) : true,
			run: () => void this.commands?.execute(entry.command)
		}));
		return [
			toggleView,
			{
				label: 'View & Sort',
				submenu: [
					toggleView,
					'separator',
					{ label: 'Sort by Name', checked: this.sort === 'name', run: () => this.setSort('name') },
					{ label: 'Sort by Path', checked: this.sort === 'path', run: () => this.setSort('path') },
					{ label: 'Sort by Status', checked: this.sort === 'status', run: () => this.setSort('status') }
				]
			},
			'separator',
			cmd('git.pull'),
			cmd('git.push'),
			cmd('git.clone'),
			cmd('git.checkout'),
			cmd('git.fetch'),
			'separator',
			{ label: 'Commit', submenu: [cmd('git.commit'), cmd('git.commitStaged'), cmd('git.commitAll'), 'separator', cmd('git.commitAmend'), cmd('git.commitStagedAmend'), 'separator', cmd('git.undoCommit')] },
			{ label: 'Changes', submenu: [
				{ label: 'Stage All Changes', run: () => void this.run('git_stage_all') },
				{ label: 'Unstage All Changes', run: () => void this.run('git_unstage_all') },
				{ label: 'Discard All Changes', run: () => void this.discardAll() }
			] },
			{ label: 'Pull, Push', submenu: [cmd('git.sync'), cmd('git.syncRebase'), 'separator', cmd('git.pull'), cmd('git.pullRebase'), cmd('git.pullFrom'), 'separator', cmd('git.push'), cmd('git.pushTo'), cmd('git.pushForce'), 'separator', cmd('git.fetch'), cmd('git.fetchPrune'), cmd('git.fetchFrom'), ...(pullPushMenu.length > 0 ? ['separator' as const, ...pullPushMenu] : [])] },
			{ label: 'Branch', submenu: [cmd('git.merge'), cmd('git.rebase'), 'separator', cmd('git.branch'), cmd('git.branchFrom'), cmd('git.renameBranch'), cmd('git.deleteBranch')] },
			{ label: 'Remote', submenu: [cmd('git.addRemote'), cmd('git.removeRemote')] },
			{ label: 'Stash', submenu: [cmd('git.stash'), cmd('git.stashIncludeUntracked'), 'separator', cmd('git.stashApply'), cmd('git.stashApplyLatest'), cmd('git.stashPop'), cmd('git.stashPopLatest'), cmd('git.stashDrop')] },
			{ label: 'Tags', submenu: [cmd('git.createTag'), cmd('git.deleteTag')] },
			'separator',
			cmd('git.showOutput'),
			...(graphTitleMenu.length > 0 ? ['separator' as const, ...graphTitleMenu] : [])
		];
	},

	subMoreMenu(sub: SubRepoState): MenuEntry[] {
		const repo = sub.repoPath;
		const run = (work: () => Promise<void>, done?: string) => void this.subMenuRun(work, done);
		const gitOp = (command: string, args: Record<string, unknown>): Promise<void> => invoke<void>(command, { ...args, repo });
		return [
			{ label: 'Pull', run: () => run(() => scmPull(null, null, false, repo)) },
			{ label: 'Push', run: () => run(() => scmPush(null, false, false, repo)) },
			{ label: 'Clone', run: () => void this.commands?.execute('git.clone') },
			{
				label: 'Checkout to...',
				run: () => void (async () => {
					const branches = await scmBranches(repo);
					const tags = await scmTags(repo);
					const items: QuickPickItem[] = [
						...branches.filter((b) => !b.current).map((b) => ({
							label: b.name,
							description: b.remote ? 'remote branch' : b.upstream ? `→ ${b.upstream}` : undefined,
							icon: b.remote ? 'cloud' : 'git-branch',
							value: 'branch:' + b.name
						})),
						...tags.map((t2) => ({ label: t2, description: 'tag', icon: 'tag', value: 'tag:' + t2 }))
					];
					if (items.length === 0) {
						notify('info', 'There are no branches or tags to checkout.');
						return;
					}
					const chosen = await quickPick(items, 'Select a branch or tag to checkout');
					if (chosen) run(() => scmCheckout(chosen.replace(/^(branch|tag):/, ''), repo));
				})()
			},
			{ label: 'Fetch', run: () => run(() => scmFetch(null, false, repo)) },
			'separator',
			{
				label: 'Commit', submenu: [
					{ label: 'Commit', run: () => void this.subCommit(sub) },
					{ label: 'Commit Staged', run: () => void this.subCommit(sub, { stagedOnly: true }) },
					{ label: 'Commit All', run: () => void this.subCommit(sub, { all: true }) },
					'separator',
					{ label: 'Commit (Amend)', run: () => void this.subCommit(sub, { amend: true }) },
					{ label: 'Commit Staged (Amend)', run: () => void this.subCommit(sub, { amend: true, stagedOnly: true }) },
					'separator',
					{ label: 'Undo Last Commit', run: () => run(() => gitOp('scm_undo_last_commit', {})) }
				]
			},
			{
				label: 'Changes', submenu: [
					{ label: 'Stage All Changes', run: () => void this.subRun(sub, 'git_stage_all') },
					{ label: 'Unstage All Changes', run: () => void this.subRun(sub, 'git_unstage_all') },
					{ label: 'Discard All Changes', run: () => void this.subDiscardAll(sub) }
				]
			},
			{
				label: 'Pull, Push', submenu: [
					{ label: 'Sync', run: () => run(() => scmSync(false, repo)) },
					{ label: 'Sync (Rebase)', run: () => run(() => scmSync(true, repo)) },
					'separator',
					{ label: 'Pull', run: () => run(() => scmPull(null, null, false, repo)) },
					{ label: 'Pull (Rebase)', run: () => run(() => scmPull(null, null, true, repo)) },
					{
						label: 'Pull from...', run: () => void (async () => {
							const remote = await pickRemoteIn(repo, 'Pick a remote to pull the branch from');
							if (!remote) return;
							const branch = await pickBranchIn(repo, `Pick a branch to pull from ${remote.name}`, (b) => b.remote && b.name.startsWith(remote.name + '/'));
							if (!branch) return;
							run(() => scmPull(remote.name, branch.name.slice(remote.name.length + 1), false, repo));
						})()
					},
					'separator',
					{ label: 'Push', run: () => run(() => scmPush(null, false, false, repo)) },
					{
						label: 'Push to...', run: () => void (async () => {
							const remote = await pickRemoteIn(repo, 'Pick a remote to publish the branch to');
							if (!remote) return;
							run(() => scmPush(remote.name, true, false, repo));
						})()
					},
					{
						label: 'Push (Force With Lease)', run: () => void (async () => {
							if (!(await confirmDialog('Force-push the current branch to its upstream? Commits the remote has that this push does not contain become unreachable there.', 'Force Push'))) return;
							run(() => scmPush(null, false, true, repo));
						})()
					},
					'separator',
					{ label: 'Fetch', run: () => run(() => scmFetch(null, false, repo)) },
					{ label: 'Fetch (Prune)', run: () => run(() => scmFetch(null, true, repo)) },
					{
						label: 'Fetch From...', run: () => void (async () => {
							const remote = await pickRemoteIn(repo, 'Pick a remote to fetch from');
							if (remote) run(() => scmFetch(remote.name, false, repo));
						})()
					}
				]
			},
			{
				label: 'Branch', submenu: [
					{
						label: 'Merge Branch...', run: () => void (async () => {
							const branch = await pickBranchIn(repo, 'Select a branch to merge from', (b) => !b.current);
							if (branch) run(() => gitOp('scm_merge', { name: branch.name }));
						})()
					},
					{
						label: 'Rebase Branch...', run: () => void (async () => {
							const branch = await pickBranchIn(repo, 'Select a branch to rebase onto', (b) => !b.current);
							if (branch) run(() => gitOp('scm_rebase', { name: branch.name }));
						})()
					},
					'separator',
					{
						label: 'Create Branch...', run: () => void (async () => {
							const name = await quickInput({ placeholder: 'Branch name', title: 'Please provide a new branch name', validate: validateSubRef });
							if (name) run(() => scmCreateBranch(name.trim(), null, repo));
						})()
					},
					{
						label: 'Create Branch From...', run: () => void (async () => {
							const from = await pickBranchIn(repo, 'Select a ref to create the branch from');
							if (!from) return;
							const name = await quickInput({ placeholder: 'Branch name', title: `Please provide a new branch name (from ${from.name})`, validate: validateSubRef });
							if (name) run(() => scmCreateBranch(name.trim(), from.name, repo));
						})()
					},
					{
						label: 'Rename Branch...', run: () => void (async () => {
							const branch = await pickBranchIn(repo, 'Select a branch to rename', (b) => !b.remote);
							if (!branch) return;
							const name = await quickInput({ placeholder: 'Branch name', title: `Please provide a new name for '${branch.name}'`, value: branch.name, validate: validateSubRef });
							if (name && name.trim() !== branch.name) run(() => gitOp('scm_rename_branch', { oldName: branch.name, newName: name.trim() }));
						})()
					},
					{
						label: 'Delete Branch...', run: () => void (async () => {
							const branch = await pickBranchIn(repo, 'Select a branch to delete', (b) => !b.remote && !b.current);
							if (!branch) return;
							if (!(await confirmDialog(`Delete the branch '${branch.name}'? Commits only reachable from it will be lost.`, 'Delete Branch'))) return;
							run(() => gitOp('scm_delete_branch', { branchName: branch.name, force: true }));
						})()
					}
				]
			},
			{
				label: 'Remote', submenu: [
					{
						label: 'Add Remote...', run: () => void (async () => {
							const url = await quickInput({ title: 'Add Remote', placeholder: 'Provide repository URL', validate: (v) => (v.trim() === '' ? 'A URL is required' : v.startsWith('-') ? 'Invalid URL' : null) });
							if (!url) return;
							const name = await quickInput({ title: 'Add Remote', placeholder: 'Remote name', value: 'origin', validate: validateSubRef });
							if (!name) return;
							run(() => gitOp('scm_add_remote', { name: name.trim(), url: url.trim(), fetch: true }));
						})()
					},
					{
						label: 'Remove Remote', run: () => void (async () => {
							const remotes = await scmRemotes(repo);
							if (remotes.length === 0) {
								notify('info', 'The repository has no remotes.');
								return;
							}
							const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), 'Pick a remote to remove');
							if (chosen) run(() => gitOp('scm_delete_remote', { name: chosen }));
						})()
					}
				]
			},
			{
				label: 'Stash', submenu: [
					{
						label: 'Stash', run: () => void (async () => {
							const message = await quickInput({ title: 'Stash', placeholder: 'Optionally provide a stash message' });
							if (message === null) return;
							run(() => gitOp('scm_push_stash', { message, includeUntracked: false }));
						})()
					},
					{
						label: 'Stash (Include Untracked)', run: () => void (async () => {
							const message = await quickInput({ title: 'Stash (Include Untracked)', placeholder: 'Optionally provide a stash message' });
							if (message === null) return;
							run(() => gitOp('scm_push_stash', { message, includeUntracked: true }));
						})()
					},
					{
						label: 'Apply Stash...', run: () => void (async () => {
							const stash = await pickStashIn(repo, 'Pick a stash to apply');
							if (stash) run(() => gitOp('scm_apply_stash', { selector: stash.selector, reinstateIndex: false }));
						})()
					},
					{ label: 'Apply Latest Stash', run: () => run(() => gitOp('scm_apply_stash', { selector: 'refs/stash@{0}', reinstateIndex: false })) },
					{
						label: 'Pop Stash...', run: () => void (async () => {
							const stash = await pickStashIn(repo, 'Pick a stash to pop');
							if (stash) run(() => gitOp('scm_pop_stash', { selector: stash.selector, reinstateIndex: false }));
						})()
					},
					{ label: 'Pop Latest Stash', run: () => run(() => gitOp('scm_pop_stash', { selector: 'refs/stash@{0}', reinstateIndex: false })) },
					{
						label: 'Drop Stash...', run: () => void (async () => {
							const stash = await pickStashIn(repo, 'Pick a stash to drop');
							if (stash && (await confirmDialog(`Drop the stash '${stash.message}'? This cannot be undone.`, 'Drop Stash'))) {
								run(() => gitOp('scm_drop_stash', { selector: stash.selector }));
							}
						})()
					}
				]
			},
			{
				label: 'Tags', submenu: [
					{
						label: 'Create Tag', run: () => void (async () => {
							const name = await quickInput({ title: 'Create Tag', placeholder: 'Tag name', validate: validateSubRef });
							if (!name) return;
							const message = await quickInput({ title: 'Create Tag', placeholder: 'Message (leave empty for a lightweight tag)' });
							if (message === null) return;
							const head = await repoHead(repo);
							run(() => gitOp('scm_add_tag', { tagName: name.trim(), commitHash: head.shortHash, message, force: false }));
						})()
					},
					{
						label: 'Delete Tag', run: () => void (async () => {
							const tags = await scmTags(repo);
							if (tags.length === 0) {
								notify('info', 'The repository has no tags.');
								return;
							}
							const chosen = await quickPick(tags.map((t2) => ({ label: t2, icon: 'tag', value: t2 })), 'Select a tag to delete');
							if (chosen) run(() => gitOp('scm_delete_tag', { tagName: chosen }));
						})()
					}
				]
			},
			'separator',
			{ label: 'Show Git Output', run: () => this.onShowOutput?.() },
			'separator',
			{
				label: 'Amend Last Commit', run: () => void (async () => {
					if (!(await confirmDialog('Amend the last commit with the staged changes (the message is kept)?', 'Amend'))) return;
					run(() => scmAmendLastCommit(repo));
				})()
			},
			{
				label: 'Fetch commit-msg Hook (Gerrit)', run: () => void (async () => {
					const remote = await pickRemoteIn(repo, 'Pick the Gerrit remote');
					if (!remote) return;
					const installed = await gerritInstallHook(remote.name, repo);
					notify('info', installed ? 'The Gerrit commit-msg hook was installed.' : 'The Gerrit commit-msg hook is already installed.');
					await this.refresh();
				})()
			},
			{
				label: 'Reset Current Branch to Remote (Soft)', run: () => void (async () => {
					if (!(await confirmDialog('Soft-reset the current branch to its upstream? Your local commits are kept as staged changes.', 'Reset'))) return;
					const upstream = await scmResetToRemote(repo);
					notify('info', `The current branch was reset to ${upstream}; its changes are staged.`);
					await this.refresh();
					this.onChanged?.();
				})()
			},
			{
				label: 'Push to Gerrit Ref for Current Branch (refs/for/...)', run: () => void (async () => {
					const remote = await pickRemoteIn(repo, 'Pick the Gerrit remote');
					if (!remote) return;
					const url = await gerritPushRef(remote.name, repo);
					if (url) notify('info', `Pushed for review: ${url}`, [{ label: 'Open Change', run: () => void openUrl(url) }]);
					else notify('info', `Pushed the current branch to ${remote.name} for review.`);
				})()
			}
		];
	},

	setViewMode(mode: ScmViewMode): void {
		this.viewMode = mode;
		state.save('scmViewMode', mode);
		this.render();
	},

	setSort(sort: ScmSort): void {
		this.sort = sort;
		state.save('scmSort', sort);
		this.render();
	},

	async subMenuRun(work: () => Promise<void>, done?: string): Promise<void> {
		try {
			await work();
			if (done) notify('info', done);
		} catch (error) {
			notify('error', String(error instanceof Error ? error.message : error));
		}
		await this.refresh();
		this.onChanged?.();
	},
};
