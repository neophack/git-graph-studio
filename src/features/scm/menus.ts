// The view's menus and view-mode/sort switches: the '...' menu and the sub-repo variants.


import { invoke } from '../../platform/ipc/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { resolvedMenuEntries } from '../extensions';
import { gerritInstallHook, gerritPushRef, scmAbortMerge, scmAbortRebase, scmAmendLastCommit, scmBranches, scmBranchMerged, scmCheckout, scmCherryPick, scmCreateBranch, scmDeleteRemoteBranch, scmDeleteRemoteTag, scmFetch, scmOperationState, scmPull, scmPush, scmPushBranch, scmPushTags, scmRevertCommit, scmResetRef, scmRemotes, scmResetToRemote, scmSync, scmTags } from '../../platform/ipc/scm';
import { repoHead } from '../../platform/ipc/revision';
import * as state from '../../platform/state';
import { t, tf } from '../../platform/i18n';
import { confirmDialog, notify, quickInput, quickPick, type MenuEntry, type QuickPickItem } from '../../platform/ui/index';
import { SubRepoState, pickBranchIn, pickRemoteIn, pickStashIn, validateSubRef } from './view';
import { validateCommitHash, validateTarget } from './gitCommands';
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
			{ label: 'Commit', submenu: [cmd('git.commit'), cmd('git.commitStaged'), cmd('git.commitAll'), 'separator', cmd('git.commitAmend'), cmd('git.commitStagedAmend'), 'separator', cmd('git.commitSignedOff'), cmd('git.commitStagedSignedOff'), cmd('git.commitAllSignedOff'), cmd('git.commitAmendSignedOff'), cmd('git.commitStagedAmendSignedOff'), 'separator', cmd('git.undoCommit')] },
			{ label: 'Changes', submenu: [
				{ label: 'Stage All Changes', run: () => void this.run('git_stage_all') },
				{ label: 'Stage All Tracked Changes', run: () => void this.run('git_stage_all_tracked') },
				{ label: 'Stage All Untracked Changes', run: () => void this.run('git_stage_all_untracked') },
				{ label: 'Unstage All Changes', run: () => void this.run('git_unstage_all') },
				{ label: 'Discard All Changes', run: () => void this.discardAll() }
			] },
			{ label: 'Pull, Push', submenu: [cmd('git.sync'), cmd('git.syncRebase'), 'separator', cmd('git.pull'), cmd('git.pullRebase'), cmd('git.pullFrom'), 'separator', cmd('git.push'), cmd('git.pushTo'), cmd('git.pushForce'), 'separator', cmd('git.fetch'), cmd('git.fetchPrune'), cmd('git.fetchFrom'), ...(pullPushMenu.length > 0 ? ['separator' as const, ...pullPushMenu] : [])] },
			{ label: 'Branch', submenu: [cmd('git.merge'), cmd('git.rebase'), cmd('git.mergeAbort'), cmd('git.rebaseAbort'), cmd('git.cherryPick'), cmd('git.revertCommit'), cmd('git.resetToCommit'), 'separator', cmd('git.branch'), cmd('git.branchFrom'), cmd('git.renameBranch'), cmd('git.deleteBranch'), cmd('git.deleteRemoteBranch')] },
			{ label: 'Remote', submenu: [cmd('git.addRemote'), cmd('git.removeRemote'), cmd('git.listRemotes')] },
			{ label: 'Stash', submenu: [cmd('git.stash'), cmd('git.stashIncludeUntracked'), cmd('git.stashStaged'), 'separator', cmd('git.stashApply'), cmd('git.stashApplyLatest'), cmd('git.stashPop'), cmd('git.stashPopLatest'), cmd('git.stashDrop')] },
			{ label: 'Tags', submenu: [cmd('git.createTag'), cmd('git.deleteTag'), cmd('git.deleteRemoteTag'), cmd('git.pushTags')] },
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
					items.push({ label: t('scm.checkoutDetached.pick'), description: undefined, icon: 'git-commit', value: 'detached:' });
					const chosen = await quickPick(items, 'Select a branch or tag to checkout');
					if (!chosen) return;
					if (chosen.startsWith('detached:')) {
						if (!(await confirmDialog(t('scm.checkoutDetached.confirm'), t('scm.checkoutDetached.action')))) return;
						const hash = await quickInput({ title: t('scm.checkoutDetached.pick'), placeholder: t('scm.checkoutDetached.placeholder'), validate: validateCommitHash });
						if (!hash) return;
						run(() => scmCheckout(hash.trim(), repo));
						return;
					}
					run(() => scmCheckout(chosen.replace(/^(branch|tag):/, ''), repo));
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
					{ label: 'Commit (Signed Off)', run: () => void this.subCommit(sub, { signoff: true }) },
					{ label: 'Commit Staged (Signed Off)', run: () => void this.subCommit(sub, { signoff: true, stagedOnly: true }) },
					'separator',
					{ label: 'Undo Last Commit', run: () => void this.subUndoCommit(sub) }
				]
			},
			{
				label: 'Changes', submenu: [
					{ label: 'Stage All Changes', run: () => void this.subRun(sub, 'git_stage_all') },
					{ label: 'Stage All Tracked Changes', run: () => void this.subRun(sub, 'git_stage_all_tracked') },
					{ label: 'Stage All Untracked Changes', run: () => void this.subRun(sub, 'git_stage_all_untracked') },
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
							const prefix = remote.name + '/';
							const remoteBranches = (await scmBranches(repo)).filter((b) => b.remote && b.name.startsWith(prefix)).map((b) => b.name.slice(prefix.length));
							const branch = remoteBranches.length > 0
								? await quickPick(remoteBranches.map((b) => ({ label: b, icon: 'cloud', value: b })), tf('scm.pushTo.pickBranch', remote.name))
								: await quickInput({ title: 'Push to...', placeholder: tf('scm.pushTo.pickBranch', remote.name), validate: validateSubRef });
							if (!branch) return;
							run(() => scmPushBranch(remote.name, branch.trim(), false, repo));
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
					{
						label: 'Abort Merge', run: () => void (async () => {
							const state = await scmOperationState(repo).catch(() => null);
							if (state && !state.merge) {
								notify('info', t('scm.abortMerge.none'));
								return;
							}
							if (!(await confirmDialog(t('scm.abortMerge.confirm'), t('scm.abortMerge.action')))) return;
							run(() => scmAbortMerge(repo));
						})()
					},
					{
						label: 'Abort Rebase', run: () => void (async () => {
							const state = await scmOperationState(repo).catch(() => null);
							if (state && !state.rebase) {
								notify('info', t('scm.rebaseAbort.none'));
								return;
							}
							if (!(await confirmDialog(t('scm.rebaseAbort.confirm'), t('scm.rebaseAbort.action')))) return;
							run(() => scmAbortRebase(repo));
						})()
					},
					{
						label: 'Cherry-Pick...', run: () => void (async () => {
							const target = await quickInput({ title: 'Cherry-Pick', placeholder: t('scm.cherryPick.placeholder'), validate: validateTarget });
							if (!target) return;
							run(async () => notify('info', tf('scm.cherryPick.done', await scmCherryPick(target.trim(), repo))));
						})()
					},
					{
						label: 'Revert Commit...', run: () => void (async () => {
							const target = await quickInput({ title: 'Revert Commit', placeholder: t('scm.revert.placeholder'), validate: validateTarget });
							if (!target) return;
							run(async () => notify('info', tf('scm.revert.done', await scmRevertCommit(target.trim(), repo))));
						})()
					},
					{
						label: 'Reset Current Branch to Commit...', run: () => void (async () => {
							const target = await quickInput({ title: 'Reset Current Branch to Commit', placeholder: t('scm.reset.placeholder'), validate: validateTarget });
							if (!target) return;
							const ref = target.trim();
							const mode = await quickPick([
								{ label: 'Soft', description: t('scm.reset.soft'), icon: 'arrow-up', value: 'soft' },
								{ label: 'Mixed', description: t('scm.reset.mixed'), icon: 'arrow-both', value: 'mixed' },
								{ label: 'Hard', description: t('scm.reset.hard'), icon: 'discard', value: 'hard' }
							], t('scm.reset.modePrompt'), tf('scm.reset.title', ref));
							if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') return;
							if (mode === 'hard' && !(await confirmDialog(tf('scm.reset.hardConfirm', ref), t('scm.reset.hardAction')))) return;
							run(async () => {
								await scmResetRef(ref, mode, repo);
								notify('info', tf('scm.reset.done', ref, mode));
							});
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
								// The merged fact words the confirmation, exactly as the palette's own
								// Delete Branch does (gitCommands.ts): only the unmerged case offers
								// the force delete, a merged one deletes through the safe `-d`.
								let merged: boolean;
								try {
									merged = await scmBranchMerged(branch.name, repo);
								} catch (error) {
									notify('error', String(error instanceof Error ? error.message : error));
									return;
								}
								if (!merged) {
									if (!(await confirmDialog(tf('scm.deleteBranch.unmergedConfirm', branch.name), t('scm.deleteBranch.forceAction')))) return;
									run(() => gitOp('scm_delete_branch', { branchName: branch.name, force: true }));
									return;
								}
								if (!(await confirmDialog(`Delete the branch '${branch.name}'? Commits only reachable from it will be lost.`, 'Delete Branch'))) return;
								run(() => gitOp('scm_delete_branch', { branchName: branch.name, force: false }));
							})()
						},
						{
							label: 'Delete Remote Branch...', run: () => void (async () => {
								const remote = await pickRemoteIn(repo, 'Pick a remote to delete the branch from');
								if (!remote) return;
								const prefix = remote.name + '/';
								const branch = await pickBranchIn(repo, `Pick a branch to delete from ${remote.name}`, (b) => b.remote && b.name.startsWith(prefix));
								if (!branch) return;
								const name = branch.name.slice(prefix.length);
								if (!(await confirmDialog(tf('scm.deleteRemoteBranch.confirm', name, remote.name), t('scm.deleteRemoteBranch.action')))) return;
								run(() => scmDeleteRemoteBranch(remote.name, name, repo));
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
					},
					{
						label: 'All Remotes...', run: () => void (async () => {
							const remotes = await scmRemotes(repo);
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
								run(() => gitOp('scm_delete_remote', { name: remote.name }));
							}
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
							run(() => gitOp('scm_push_stash', { message, includeUntracked: false, staged: false }));
						})()
					},
					{
						label: 'Stash (Include Untracked)', run: () => void (async () => {
							const message = await quickInput({ title: 'Stash (Include Untracked)', placeholder: 'Optionally provide a stash message' });
							if (message === null) return;
							run(() => gitOp('scm_push_stash', { message, includeUntracked: true, staged: false }));
						})()
					},
					{
						label: 'Stash Staged', run: () => void (async () => {
							const message = await quickInput({ title: 'Stash Staged', placeholder: 'Optionally provide a stash message' });
							if (message === null) return;
							run(() => gitOp('scm_push_stash', { message, includeUntracked: false, staged: true }));
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
							// The full hash, never the 7-character display prefix: a short form
							// is ambiguous in a large repository.
							run(() => gitOp('scm_add_tag', { tagName: name.trim(), commitHash: head.hash || head.shortHash, message, force: false }));
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
					},
					{
						label: 'Delete Remote Tag...', run: () => void (async () => {
							const tags = await scmTags(repo);
							if (tags.length === 0) {
								notify('info', 'The repository has no tags.');
								return;
							}
							const tag = await quickPick(tags.map((t2) => ({ label: t2, icon: 'tag', value: t2 })), 'Select a tag to delete from the remote');
							if (!tag) return;
							const remote = await pickRemoteIn(repo, 'Pick a remote to delete the tag from');
							if (!remote) return;
							if (!(await confirmDialog(tf('scm.deleteRemoteTag.confirm', tag, remote.name), t('scm.deleteRemoteTag.action')))) return;
							run(() => scmDeleteRemoteTag(remote.name, tag, repo));
						})()
					},
					{
						label: 'Push Tags', run: () => void (async () => {
							const remote = await pickRemoteIn(repo, 'Pick a remote to push the tags to');
							if (!remote) return;
							run(async () => {
								await scmPushTags(remote.name, repo);
								notify('info', tf('scm.pushTags.done', remote.name));
							});
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
