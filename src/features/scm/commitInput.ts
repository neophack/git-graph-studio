// The commit input: the message box, the commit action and its aftermath, and the sub-repo commit boxes.


import { invoke } from '../../platform/ipc/core';
import { gitCommit, gitStageAll } from '../../platform/ipc/scm';
import { confirmDialog, el, icon, notify, showContextMenu } from '../../platform/ui/index';
import { SubRepoState } from './view';
import type { SourceControlView } from './view';

/** The commitInput concern of SourceControlView — assigned onto the prototype by the module facade. */
export const commitInputMethods: ThisType<SourceControlView> = {
	commitAction(state: { changes: number; branch: string | null; shortHash: string; ahead: number; behind: number; upstream: string | null }): 'commit' | 'publish' | 'push' | 'sync' | 'idle' {
		if (state.changes > 0) return 'commit';
		if (!state.upstream) return state.branch !== null && state.shortHash !== '' ? 'publish' : 'idle';
		if (state.behind > 0) return 'sync';
		if (state.ahead > 0) return 'push';
		return 'idle';
	},

	commitBox(): HTMLElement {
		const box = el('div', 'scm-input');
		const input = el('textarea', 'input');
		input.placeholder = this.placeholder();
		input.rows = 1;
		input.value = this.message;
		input.spellcheck = false;
		const grow = () => {
			input.style.height = 'auto';
			input.style.height = `${Math.min(140, input.scrollHeight + 2)}px`;
		};
		input.addEventListener('input', () => {
			this.message = input.value;
			grow();
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void this.commit();
			}
		});
		const action = this.commitAction({ changes: this.changes.length, branch: this.branch, shortHash: this.shortHash, ahead: this.ahead, behind: this.behind, upstream: this.upstream });
		const commit = el('button', 'button', [icon('check'), 'Commit']);
		if (action === 'commit') {
			// Live whatever the message says: a click without one warns and focuses the box.
			commit.addEventListener('click', () => void this.commit());
			const more = el('button', 'button more', [icon('chevron-down')]);
			more.title = 'More Commit Actions...';
			more.addEventListener('click', (event) => {
				const rect = more.getBoundingClientRect();
				showContextMenu(rect.left, rect.bottom, [
					{ label: 'Commit', run: () => void this.commit() },
					{ label: 'Commit & Push', run: () => void this.commit({}, () => this.afterCommit('scm_push', { remote: null, setUpstream: false, force: false })) },
					{ label: 'Commit & Sync', run: () => void this.commit({}, () => this.afterCommit('scm_sync', { rebase: false })) },
					{ label: 'Commit Staged', disabled: this.changes.every((c) => c.staged === null), run: () => void this.commit({ stagedOnly: true }) },
					{ label: 'Commit All', run: () => void this.commit({ all: true }) },
					'separator',
					{ label: 'Commit (Amend)', run: () => void this.commit({ amend: true }) },
					{ label: 'Commit Staged (Amend)', run: () => void this.commit({ amend: true, stagedOnly: true }) }
				]);
				event.stopPropagation();
			});
			box.append(input, el('div', 'commit-row', [commit, more]));
		} else {
			// A clean tree turns the button into the repository's server action; the chevron is
			// gone - there is no commit to configure.
			commit.innerHTML = '';
			if (action === 'publish') {
				commit.append(icon('cloud-upload'), 'Publish Branch');
				commit.title = 'Publish the branch to its remote (push, setting the upstream)';
				commit.addEventListener('click', () => void this.run('scm_push', { remote: null, setUpstream: true, force: false }));
			} else if (action === 'push') {
				commit.append(icon('cloud-upload'), `Push ${this.ahead}`);
				commit.title = `Push ${this.ahead} commit${this.ahead === 1 ? '' : 's'} to ${this.upstream}`;
				commit.addEventListener('click', () => void this.run('scm_push', { remote: null, setUpstream: false, force: false }));
			} else if (action === 'sync') {
				commit.append(icon('sync'), 'Sync Changes', ...(this.ahead > 0 ? [String(this.ahead)] : []));
				commit.title = `Pull ${this.behind} and push ${this.ahead} commits from/to ${this.upstream}`;
				commit.addEventListener('click', () => void this.run('scm_sync', { rebase: false }));
			} else {
				commit.append(icon('check'), 'Commit');
				commit.disabled = true;
				commit.title = 'Nothing to commit - the branch is up to date with its upstream';
			}
			box.append(input, el('div', 'commit-row single', [commit]));
		}
		requestAnimationFrame(grow);
		return box;
	},

	async afterCommit(command: string, args: Record<string, unknown>): Promise<void> {
		try {
			await invoke(command, args);
		} catch (error) {
			notify('error', String(error));
		}
		this.onChanged?.();
	},

	async commit(options: { amend?: boolean; all?: boolean; stagedOnly?: boolean } = {}, followUp: (() => Promise<void>) | null = null): Promise<void> {
		const amend = options.amend === true;
		const message = this.message.trim();
		if (message === '' && !amend) {
			notify('warning', 'Please provide a commit message.');
			this.content.querySelector<HTMLTextAreaElement>('textarea')?.focus();
			return;
		}
		const staged = this.changes.some((c) => c.staged !== null);
		if (!staged && !amend) {
			if (options.stagedOnly || this.changes.length === 0) {
				notify('info', 'There are no changes to commit.');
				return;
			}
			if (!options.all) {
				const confirmed = await confirmDialog('There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?', 'Yes', 'info');
				if (!confirmed) return;
			}
		}
		if ((!staged && !amend) || (options.all && !options.stagedOnly)) {
			try {
				await gitStageAll();
			} catch (error) {
				notify('error', String(error));
				return;
			}
		}
		try {
			// An amend with an empty box keeps the last commit's message (the backend's --no-edit path).
			await gitCommit(message, amend);
		} catch (error) {
			notify('error', String(error));
			await this.refresh();
			return;
		}
		this.message = '';
		await this.refresh();
		this.onChanged?.();
		if (followUp) await followUp();
	},

	subCommitBox(sub: SubRepoState): HTMLElement {
		const box = el('div', 'scm-input');
		const input = el('textarea', 'input');
		input.placeholder = `Message (Ctrl+Enter to commit${sub.branch ? ` on "${sub.branch}"` : ''})`;
		input.rows = 1;
		input.value = sub.message;
		input.spellcheck = false;
		const grow = () => {
			input.style.height = 'auto';
			input.style.height = `${Math.min(140, input.scrollHeight + 2)}px`;
		};
		input.addEventListener('input', () => {
			sub.message = input.value;
			grow();
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void this.subCommit(sub);
			}
		});
		// The same one-button-for-commit-and-push as the main repository's box, over this
		// submodule's own branch state - the sections read as one product, not two toolkits.
		const action = this.commitAction({ changes: sub.changes.length, branch: sub.branch, shortHash: sub.shortHash, ahead: sub.ahead, behind: sub.behind, upstream: sub.upstream });
		const commit = el('button', 'button', [icon('check'), 'Commit']);
		if (action === 'commit') {
			// Live whatever the message says: a click without one warns and focuses the box.
			commit.addEventListener('click', () => void this.subCommit(sub));
			const more = el('button', 'button more', [icon('chevron-down')]);
			more.title = 'More Commit Actions...';
			more.addEventListener('click', (event) => {
				const rect = more.getBoundingClientRect();
				showContextMenu(rect.left, rect.bottom, [
					{ label: 'Commit', run: () => void this.subCommit(sub) },
					{ label: 'Commit & Push', run: () => void this.subCommit(sub, {}, () => this.subRun(sub, 'scm_push', { remote: null, setUpstream: false, force: false })) },
					{ label: 'Commit & Sync', run: () => void this.subCommit(sub, {}, () => this.subRun(sub, 'scm_sync', { rebase: false })) },
					{ label: 'Commit Staged', disabled: sub.changes.every((c) => c.staged === null), run: () => void this.subCommit(sub, { stagedOnly: true }) },
					{ label: 'Commit All', run: () => void this.subCommit(sub, { all: true }) },
					'separator',
					{ label: 'Commit (Amend)', run: () => void this.subCommit(sub, { amend: true }) },
					{ label: 'Commit Staged (Amend)', run: () => void this.subCommit(sub, { amend: true, stagedOnly: true }) }
				]);
				event.stopPropagation();
			});
			box.append(input, el('div', 'commit-row', [commit, more]));
		} else {
			commit.innerHTML = '';
			if (action === 'publish') {
				commit.append(icon('cloud-upload'), 'Publish Branch');
				commit.title = 'Publish the branch to its remote (push, setting the upstream)';
				commit.addEventListener('click', () => void this.subRun(sub, 'scm_push', { remote: null, setUpstream: true, force: false }));
			} else if (action === 'push') {
				commit.append(icon('cloud-upload'), `Push ${sub.ahead}`);
				commit.title = `Push ${sub.ahead} commit${sub.ahead === 1 ? '' : 's'} to ${sub.upstream}`;
				commit.addEventListener('click', () => void this.subRun(sub, 'scm_push', { remote: null, setUpstream: false, force: false }));
			} else if (action === 'sync') {
				commit.append(icon('sync'), 'Sync Changes', ...(sub.ahead > 0 ? [String(sub.ahead)] : []));
				commit.title = `Pull ${sub.behind} and push ${sub.ahead} commits from/to ${sub.upstream}`;
				commit.addEventListener('click', () => void this.subRun(sub, 'scm_sync', { rebase: false }));
			} else {
				commit.append(icon('check'), 'Commit');
				commit.disabled = true;
				commit.title = 'Nothing to commit - the branch is up to date with its upstream';
			}
			box.append(input, el('div', 'commit-row single', [commit]));
		}
		requestAnimationFrame(grow);
		return box;
	},

	async subCommit(sub: SubRepoState, options: { amend?: boolean; all?: boolean; stagedOnly?: boolean } = {}, followUp: (() => Promise<void>) | null = null): Promise<void> {
		const amend = options.amend === true;
		const message = sub.message.trim();
		if (message === '' && !amend) {
			notify('warning', 'Please provide a commit message.');
			return;
		}
		const staged = sub.changes.some((c) => c.staged !== null);
		if (!staged && !amend) {
			if (options.stagedOnly || sub.changes.length === 0) {
				notify('info', 'There are no changes to commit.');
				return;
			}
			if (!options.all) {
				const confirmed = await confirmDialog('There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?', 'Yes', 'info');
				if (!confirmed) return;
			}
		}
		if ((!staged && !amend) || (options.all && !options.stagedOnly)) {
			try {
				await gitStageAll(sub.repoPath);
			} catch (error) {
				notify('error', String(error));
				return;
			}
		}
		try {
			await gitCommit(message, amend, sub.repoPath);
		} catch (error) {
			notify('error', String(error));
			await this.refresh();
			return;
		}
		sub.message = '';
		await this.refresh();
		this.onChanged?.();
		if (followUp) await followUp();
	},

	placeholder(): string {
		return `Message (Ctrl+Enter to commit${this.branch ? ` on "${this.branch}"` : ''})`;
	},
};
