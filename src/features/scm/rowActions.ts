// The row interactions: file rows, open-change navigation, discard (file and all), and path helpers.


import { invoke } from '../../platform/ipc/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { CommandRegistry } from '../../platform/commands';
import { commandIconContent, contextUri, resolvedMenuEntries } from '../extensions';
import { extFileDataUrl } from '../../platform/extAssets';
import type { DiffRequest, DiffSide } from '../editor/types';
import { fileIcon, fileIconColor } from '../../platform/fileIcons';
import type { BlameLine, BranchInfo, RemoteInfo, ScmChange, StashInfo, StatusMap } from '../../platform/ipc/scm';
import { gerritInstallHook, gerritPushRef, gitCommit, gitStageAll, scmAmendLastCommit, scmBranches, scmCheckout, scmCreateBranch, scmFetch, scmPull, scmPush, scmRemotes, scmResetToRemote, scmStashes, scmStatus, scmSync, scmTags } from '../../platform/ipc/scm';
import { repoHead, repoSubmodules } from '../../platform/ipc/revision';
import { t, tf, trText } from '../../platform/i18n';
import * as state from '../../platform/state';
import { actionButton, basename, confirmDialog, el, icon, liveSidebarTitle, notify, quickInput, quickPick, showContextMenu, showMenuBelow, toPosix, type MenuEntry, type QuickPickItem } from '../../platform/ui/index';
import { LETTER_TITLE, ScmRow, SubRepoState, letterOf } from './view';
import type { ScmGroup, SourceControlView } from './view';

/** The rowActions concern of SourceControlView — assigned onto the prototype by the module facade. */
export const rowActionsMethods: ThisType<SourceControlView> = {
	rowElement(row: ScmRow): HTMLElement {
		switch (row.kind) {
			case 'group': {
				const files = row.key === 'merge' ? this.changes.filter((c) => c.conflicted) : [];
				const header = el('div', 'pane-header', [
					icon(this.collapsed[row.key] ? 'chevron-right' : 'chevron-down', 'twistie'),
					el('span', 'label', [trText(row.label)]),
					el('div', 'actions', this.groupActions(row.key, files)),
					el('span', 'badge', [String(row.count)])
				]);
				header.addEventListener('click', () => {
					this.collapsed[row.key] = !this.collapsed[row.key];
					this.render();
				});
				return header;
			}
			case 'empty':
				return el('div', 'scm-empty', [t('scm.noChanges')]);
			case 'folder': {
				const element = el('div', 'row scm-folder', [
					icon(row.collapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
					el('span', 'icon', [icon(row.collapsed ? 'folder' : 'folder-opened')]),
					el('span', 'label', [row.node.name])
				]);
				element.style.paddingLeft = `${8 + row.depth * 8}px`;
				element.addEventListener('click', () => {
					if (row.collapsed) this.collapsedFolders.delete(row.folderKey);
					else this.collapsedFolders.add(row.folderKey);
					this.render();
				});
				return element;
			}
			case 'file':
				return this.fileRow(row.file, row.key, row.depth, row.inTree);
		}
	},

	fileRow(file: ScmChange, key: ScmGroup, depth: number, inTree: boolean): HTMLElement {
		const letter = letterOf(file, key);
		const cls = { M: 'git-modified', A: 'git-added', D: 'git-deleted', R: 'git-renamed', U: 'git-untracked', '!': 'git-conflict' }[letter] ?? '';
		const posix = toPosix(file.path);
		const name = basename(posix);
		const dir = posix.slice(0, Math.max(0, posix.length - name.length - 1));
		const glyph = icon(fileIcon(name));
		glyph.style.color = fileIconColor(name) ?? '';
		const row = el('div', `row ${cls}`, [
			inTree ? el('span', 'twistie') : null,
			el('span', 'icon', [glyph]),
			el('span', 'label-block', [
				el('span', 'label', [name]),
				dir && !inTree ? el('span', 'description', [dir]) : null
			])
		]);
		if (inTree) row.style.paddingLeft = `${8 + depth * 8}px`;
		row.title = `${posix} • ${LETTER_TITLE[letter] ?? letter}`;
		const id = key + ':' + posix;
		row.dataset.scmKey = id;
		if (this.selection.has(id)) row.classList.add('selected');
		if (this.anchor === id) row.classList.add('focused');
		const actions = el('div', 'actions', [
			actionButton('go-to-file', 'Open File', () => this.onOpenFile?.(this.absolute(file.path)))
		]);
		if (key === 'merge') {
			actions.appendChild(actionButton('add', 'Stage Changes (Mark Resolved)', () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) })));
		} else if (key === 'changes') {
			actions.appendChild(actionButton('discard', 'Discard Changes', () => void this.discardFiles(this.targetsFor(key, file, ['changes']))));
			actions.appendChild(actionButton('add', 'Stage Changes', () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) })));
		} else {
			actions.appendChild(actionButton('remove', 'Unstage Changes', () => void this.run('git_unstage', { paths: this.targetsFor(key, file, ['staged']).map((f) => f.path) })));
		}
		row.appendChild(actions);
		const decoration = el('span', 'decoration', [letter]);
		decoration.title = LETTER_TITLE[letter] ?? letter;
		row.appendChild(decoration);
		row.addEventListener('click', (event) => {
			if (event.ctrlKey || event.metaKey) {
				// Ctrl toggles one row into or out of the selection; nothing opens — the
				// gesture picks files, it does not read them.
				if (this.selection.has(id)) this.selection.delete(id);
				else this.selection.add(id);
				this.anchor = id;
				this.repaintSelection();
				return;
			}
			if (event.shiftKey && this.anchor !== null) {
				// The range spans the flattened file rows between the anchor and this row
				// (groups and collapsed folders in between are geometry, not boundaries).
				const ids = this.rows.filter((r) => r.kind === 'file').map((r) => r.key + ':' + toPosix(r.file.path));
				const from = ids.indexOf(this.anchor);
				const to = ids.indexOf(id);
				if (from >= 0 && to >= 0) {
					this.selection.clear();
					for (const between of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) this.selection.add(between);
					this.repaintSelection();
					return;
				}
			}
			this.selection.clear();
			this.selection.add(id);
			this.anchor = id;
			this.repaintSelection();
			this.openChange(file, key, letter);
		});
		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			// A right-click on an unselected row makes it the selection (VS Code's own rule);
			// on a selected one the menu below speaks for the whole selection.
			if (!this.selection.has(id)) {
				this.selection.clear();
				this.selection.add(id);
				this.anchor = id;
				this.repaintSelection();
			}
			const open = (): void => {
				for (const f of this.targetsFor(key, file, ['merge', 'staged', 'changes'])) this.onOpenFile?.(this.absolute(f.path));
			};
			const entries = key === 'merge'
				? [
					{ label: 'Open in Merge Editor', run: open },
					'separator' as const,
					{ label: 'Stage Changes (Mark Resolved)', run: () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) }) }
				]
				: key === 'changes'
				? [
					{ label: 'Open File', run: open },
					{ label: 'Open Changes', run: () => { for (const target of this.targetRows(key, file, ['staged', 'merge', 'changes'])) this.openChange(target.file, target.key, letterOf(target.file, target.key)); } },
					'separator' as const,
					{ label: 'Stage Changes', run: () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) }) },
					{ label: 'Discard Changes', run: () => void this.discardFiles(this.targetsFor(key, file, ['changes'])) }
				]
				: [
					{ label: 'Open File', run: open },
					{ label: 'Open Changes', run: () => { for (const target of this.targetRows(key, file, ['staged'])) this.openChange(target.file, target.key, letterOf(target.file, target.key)); } },
					'separator' as const,
					{ label: 'Unstage Changes', run: () => void this.run('git_unstage', { paths: this.targetsFor(key, file, ['staged']).map((f) => f.path) }) }
				];
			// Every scm/resourceState/context contribution an installed extension's manifest
			// declares: the right-clicked resource rides along as VS Code's own menu argument —
			// a SourceControlResourceState, whose `resourceUri` is what a "filter by this
			// file" command reads. With a multi-selection every picked resource rides along,
			// one argument per file.
			for (const entry of resolvedMenuEntries('scm/resourceState/context')) {
				entries.push('separator', {
					label: entry.label,
					run: () => this.onExtensionCommand?.(entry.command, this.targetsFor(key, file, ['merge', 'staged', 'changes']).map((f) => ({ resourceUri: contextUri(this.absolute(f.path)) })))
				});
			}
			showContextMenu(event.clientX, event.clientY, entries);
		});
		return row;
	},

	subFileRow(sub: SubRepoState, file: ScmChange, key: ScmGroup): HTMLElement {
		const letter = letterOf(file, key);
		const cls = { M: 'git-modified', A: 'git-added', D: 'git-deleted', R: 'git-renamed', U: 'git-untracked', '!': 'git-conflict' }[letter] ?? '';
		const posix = toPosix(file.path);
		const name = basename(posix);
		const dir = posix.slice(0, Math.max(0, posix.length - name.length - 1));
		const glyph = icon(fileIcon(name));
		glyph.style.color = fileIconColor(name) ?? '';
		const row = el('div', `row ${cls}`, [
			el('span', 'icon', [glyph]),
			el('span', 'label-block', [el('span', 'label', [name]), dir ? el('span', 'description', [dir]) : null])
		]);
		row.title = `${posix} • ${LETTER_TITLE[letter] ?? letter}`;
		const actions = el('div', 'actions', [
			actionButton('go-to-file', 'Open File', () => this.onOpenFile?.(this.subAbsolute(sub, file.path)))
		]);
		if (key === 'merge') {
			actions.appendChild(actionButton('add', 'Stage Changes (Mark Resolved)', () => void this.subRun(sub, 'git_stage', { paths: [file.path] })));
		} else if (key === 'changes') {
			actions.appendChild(actionButton('discard', 'Discard Changes', () => void this.subDiscard(sub, file)));
			actions.appendChild(actionButton('add', 'Stage Changes', () => void this.subRun(sub, 'git_stage', { paths: [file.path] })));
		} else {
			actions.appendChild(actionButton('remove', 'Unstage Changes', () => void this.subRun(sub, 'git_unstage', { paths: [file.path] })));
		}
		row.appendChild(actions);
		const decoration = el('span', 'decoration', [letter]);
		decoration.title = LETTER_TITLE[letter] ?? letter;
		row.appendChild(decoration);
		row.addEventListener('click', () => this.subOpenChange(sub, file, key, letter));
		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			const entries = key === 'merge'
				? [
					{ label: 'Open in Merge Editor', run: () => this.onOpenFile?.(this.subAbsolute(sub, file.path)) },
					'separator' as const,
					{ label: 'Stage Changes (Mark Resolved)', run: () => void this.subRun(sub, 'git_stage', { paths: [file.path] }) }
				]
				: key === 'changes'
				? [
					{ label: 'Open File', run: () => this.onOpenFile?.(this.subAbsolute(sub, file.path)) },
					{ label: 'Open Changes', run: () => this.subOpenChange(sub, file, key, letter) },
					'separator' as const,
					{ label: 'Stage Changes', run: () => void this.subRun(sub, 'git_stage', { paths: [file.path] }) },
					{ label: 'Discard Changes', run: () => void this.subDiscard(sub, file) }
				]
				: [
					{ label: 'Open File', run: () => this.onOpenFile?.(this.subAbsolute(sub, file.path)) },
					{ label: 'Open Changes', run: () => this.subOpenChange(sub, file, key, letter) },
					'separator' as const,
					{ label: 'Unstage Changes', run: () => void this.subRun(sub, 'git_unstage', { paths: [file.path] }) }
				];
			// Same extension contribution the main repository's rows offer (fileRow), scoped
			// to this submodule's absolute path as the resource state's `resourceUri`.
			for (const entry of resolvedMenuEntries('scm/resourceState/context')) {
				entries.push('separator', { label: entry.label, run: () => this.onExtensionCommand?.(entry.command, [{ resourceUri: contextUri(this.subAbsolute(sub, file.path)) }]) });
			}
			showContextMenu(event.clientX, event.clientY, entries);
		});
		return row;
	},

	openChange(file: ScmChange, key: ScmGroup, letter: string): void {
		const path = toPosix(file.path);
		// A conflicted file opens in the editor, whose conflict toolbar walks and resolves the
		// markers - a diff of a half-merged file against the index would show only noise.
		if (letter === '!' || letter === 'U' || (key === 'changes' && file.unstaged === 'added')) {
			this.onOpenFile?.(this.absolute(file.path));
			return;
		}
		const oldPath = file.oldPath ? toPosix(file.oldPath) : path;
		const diff: DiffRequest = key === 'staged'
			? {
				id: `scm:index:${path}`,
				title: `${basename(path)} (Index)`,
				left: { revision: 'HEAD', path: oldPath, label: 'HEAD', exists: letter !== 'A' },
				right: { revision: ':index', path, label: 'Index', exists: letter !== 'D' }
			}
			: {
				id: `scm:worktree:${path}`,
				title: `${basename(path)} (Working Tree)`,
				left: { revision: file.staged !== null ? ':index' : 'HEAD', path: file.staged !== null ? path : oldPath, label: file.staged !== null ? 'Index' : 'HEAD', exists: true },
				right: { revision: '*', path, label: 'Working Tree', exists: letter !== 'D' }
			};
		this.onOpenDiff?.(diff);
	},

	subOpenChange(sub: SubRepoState, file: ScmChange, key: ScmGroup, letter: string): void {
		const path = toPosix(file.path);
		if (letter === '!' || letter === 'U' || (key === 'changes' && file.unstaged === 'added')) {
			this.onOpenFile?.(this.subAbsolute(sub, file.path));
			return;
		}
		const oldPath = file.oldPath ? toPosix(file.oldPath) : path;
		const diff: DiffRequest = key === 'staged'
			? {
				id: `scm:${sub.repoPath}:index:${path}`,
				title: `${basename(path)} (Index)`,
				repo: sub.repoPath,
				left: { revision: 'HEAD', path: oldPath, label: 'HEAD', exists: letter !== 'A' },
				right: { revision: ':index', path, label: 'Index', exists: letter !== 'D' }
			}
			: {
				id: `scm:${sub.repoPath}:worktree:${path}`,
				title: `${basename(path)} (Working Tree)`,
				repo: sub.repoPath,
				left: { revision: file.staged !== null ? ':index' : 'HEAD', path: file.staged !== null ? path : oldPath, label: file.staged !== null ? 'Index' : 'HEAD', exists: true },
				right: { revision: '*', path, label: 'Working Tree', exists: letter !== 'D' }
			};
		this.onOpenDiff?.(diff);
	},

	async discard(file: ScmChange): Promise<void> {
		const label = basename(toPosix(file.path));
		const confirmed = await confirmDialog(
			file.untracked
				? `Are you sure you want to DELETE ${label}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.`
				: `Are you sure you want to discard changes in ${label}?`,
			file.untracked ? 'Delete file' : 'Discard Changes'
		);
		if (!confirmed) return;
		await this.run('git_discard', { path: file.path, untracked: file.untracked });
	},

	async discardFiles(files: ScmChange[]): Promise<void> {
		if (files.length === 0) return;
		if (files.length === 1) return this.discard(files[0]!);
		const untracked = files.filter((f) => f.untracked);
		const confirmed = await confirmDialog(
			untracked.length > 0
				? tf('scm.discardMany.confirmUntracked', files.length, untracked.length)
				: tf('scm.discardMany.confirm', files.length),
			t('scm.discardMany.action')
		);
		if (!confirmed) return;
		await this.run('git_discard_all', {
			restore: files.filter((f) => !f.untracked).map((f) => f.path),
			clean: untracked.map((f) => f.path)
		});
	},

	async discardAll(): Promise<void> {
		// Only the "Changes" group: conflicted paths are the merge's own business - a
		// pathspec-less `git restore -- .` aborts on the first unmerged path and discards
		// nothing - so the operation names the non-conflicted paths explicitly.
		const unstaged = this.changes.filter((c) => !c.conflicted && (c.unstaged !== null || c.untracked));
		if (unstaged.length === 0) return;
		const untracked = unstaged.filter((c) => c.untracked);
		const confirmed = await confirmDialog(
			untracked.length > 0
				? `Are you sure you want to discard ALL changes? ${untracked.length} untracked file(s) will be DELETED!\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST.`
				: `Are you sure you want to discard ALL ${unstaged.length} changes?\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST if you proceed.`,
			'Discard All Changes'
		);
		if (!confirmed) return;
		await this.run('git_discard_all', {
			restore: unstaged.filter((c) => !c.untracked).map((c) => c.path),
			clean: untracked.map((c) => c.path)
		});
	},

	async subDiscard(sub: SubRepoState, file: ScmChange): Promise<void> {
		const label = basename(toPosix(file.path));
		const confirmed = await confirmDialog(
			file.untracked
				? `Are you sure you want to DELETE ${label}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.`
				: `Are you sure you want to discard changes in ${label}?`,
			file.untracked ? 'Delete file' : 'Discard Changes'
		);
		if (!confirmed) return;
		await this.subRun(sub, 'git_discard', { path: file.path, untracked: file.untracked });
	},

	async subDiscardAll(sub: SubRepoState): Promise<void> {
		const unstaged = sub.changes.filter((c) => !c.conflicted && (c.unstaged !== null || c.untracked));
		if (unstaged.length === 0) return;
		const untracked = unstaged.filter((c) => c.untracked);
		const confirmed = await confirmDialog(
			untracked.length > 0
				? `Are you sure you want to discard ALL changes? ${untracked.length} untracked file(s) will be DELETED!\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST.`
				: `Are you sure you want to discard ALL ${unstaged.length} changes?\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST if you proceed.`,
			'Discard All Changes'
		);
		if (!confirmed) return;
		await this.subRun(sub, 'git_discard_all', {
			restore: unstaged.filter((c) => !c.untracked).map((c) => c.path),
			clean: untracked.map((c) => c.path)
		});
	},

	absolute(relative: string): string {
		const root = this.repoPath!;
		const separator = root.includes('\\') ? '\\' : '/';
		return root.replace(/[\\/]+$/, '') + separator + relative.replaceAll('/', separator);
	},

	subAbsolute(sub: SubRepoState, relative: string): string {
		const separator = sub.repoPath.includes('\\') ? '\\' : '/';
		return sub.repoPath.replace(/[\\/]+$/, '') + separator + relative.replaceAll('/', separator);
	},
};
