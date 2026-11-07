// The row interactions: file rows, open-change navigation, discard (file and all), and path helpers.


import { contextUri, resolvedMenuEntries } from '../extensions';
import type { DiffRequest } from '../editor/types';
import { fileIcon, fileIconColor } from '../../platform/fileIcons';
import { readFile, writeFile, renamePath, deletePath } from '../../platform/ipc/fs';
import type { ScmChange } from '../../platform/ipc/scm';
import { t, tf, trText } from '../../platform/i18n';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { actionButton, basename, confirmDialog, el, icon, notify, quickInput, showContextMenu, swipeReveal, toPosix, type MenuEntry, type RevealAction } from '../../platform/ui/index';
import { LETTER_TITLE, ScmRow, SubRepoState, letterOf } from './view';
import type { ScmGroup, SourceControlView } from './view';

/** The page-stack shells (the phone orientations and the portrait tablet,
 *  docs/remote-client-plan.md §5.1–§5.3): their change rows carry the swipe-left gesture —
 *  the marker responsive.ts keeps on <html>; a desktop build carries neither. */
function pageStackShell(): boolean {
	return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-page-stack');
}

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
			const openChanges = (groups: ScmGroup[]): void => {
				for (const target of this.targetRows(key, file, groups)) this.openChange(target.file, target.key, letterOf(target.file, target.key));
			};
			// "Open Changes with Revision": the whole change against HEAD — the worktree file
			// against HEAD, so a staged-then-edited file's both halves show in one diff.
			// Untracked rows have no HEAD side and conflicts belong to the merge editor.
			const openVsHead = (): void => {
				for (const target of this.targetRows(key, file, ['staged', 'merge', 'changes'])) {
					const letter = letterOf(target.file, target.key);
					if (letter === 'U' || letter === '!') continue;
					const path = toPosix(target.file.path);
					const oldPath = target.file.oldPath ? toPosix(target.file.oldPath) : path;
					this.onOpenDiff?.({
						id: `scm:head:${path}`,
						title: `${basename(path)} (Working Tree)`,
						left: { revision: 'HEAD', path: oldPath, label: 'HEAD', exists: letter !== 'A' },
						right: { revision: '*', path, label: 'Working Tree', exists: letter !== 'D' }
					});
				}
			};
			const absolute = (p: string): string => this.absolute(p);
			const entries: MenuEntry[] = key === 'merge'
				? [
					{ label: 'Open in Merge Editor', run: open },
					'separator',
					...this.navCluster(key, file, absolute, true),
					'separator',
					{ label: 'Stage Changes (Mark Resolved)', run: () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) }) }
				]
				: key === 'changes'
				? [
					{ label: 'Open File', run: open },
					{ label: 'Open Changes', run: () => openChanges(['staged', 'merge', 'changes']) },
					...(file.untracked ? [] : ([{ label: 'Open Changes with Revision', run: openVsHead }] as MenuEntry[])),
					'separator',
					...this.navCluster(key, file, absolute, true),
					'separator',
					{ label: 'Stage Changes', run: () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) }) },
					{ label: 'Discard Changes', run: () => void this.discardFiles(this.targetsFor(key, file, ['changes'])) },
					...this.untrackedExtras(key, file, absolute, this.repoPath!)
				]
				: [
					{ label: 'Open File', run: open },
					{ label: 'Open Changes', run: () => openChanges(['staged']) },
					'separator',
					...this.navCluster(key, file, absolute, true),
					'separator',
					{ label: 'Unstage Changes', run: () => void this.run('git_unstage', { paths: this.targetsFor(key, file, ['staged']).map((f) => f.path) }) },
					...this.untrackedExtras(key, file, absolute, this.repoPath!)
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
		// The page-stack shells' row gesture (§6.3): a swipe left uncovers the row's own
		// stage / unstage verb and — on the unstaged group — the discard, the same handlers
		// the hover buttons and the context menu run (a discard keeps its own confirm).
		// A re-render drops the rows whole; the gesture's own listeners ride the row.
		if (pageStackShell()) {
			const swipe: RevealAction[] = [];
			if (key === 'changes') {
				swipe.push(
					{ icon: 'discard', label: 'Discard Changes', danger: true, run: () => void this.discardFiles(this.targetsFor(key, file, ['changes'])) },
					{ icon: 'add', label: 'Stage Changes', run: () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) }) }
				);
			} else if (key === 'merge') {
				swipe.push({ icon: 'add', label: 'Stage Changes (Mark Resolved)', run: () => void this.run('git_stage', { paths: this.targetsFor(key, file, ['merge', 'changes']).map((f) => f.path) }) });
			} else {
				swipe.push({ icon: 'remove', label: 'Unstage Changes', run: () => void this.run('git_unstage', { paths: this.targetsFor(key, file, ['staged']).map((f) => f.path) }) });
			}
			swipeReveal(row, swipe);
		}
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
			const path = sub.repoPath;
			const absolute = (p: string): string => this.subAbsolute(sub, p);
			// A sub-repo row is single-file (the rows never join the selection), and the
			// editor's history page follows the workspace root — a sub-repo's timeline has
			// no page to land in, so the cluster carries it nowhere.
			const nav = this.navCluster(key, file, absolute, false, [file]);
			// Single-file on purpose: the sub-repo rows never join the selection, so the
			// extras must not inherit whatever the main repository has picked (a shared
			// relative path would collide with its selection ids).
			const untracked = this.untrackedExtras(key, file, absolute, path, [file]);
			const entries = key === 'merge'
				? [
					{ label: 'Open in Merge Editor', run: () => this.onOpenFile?.(absolute(file.path)) },
					'separator' as const,
					...nav,
					'separator' as const,
					{ label: 'Stage Changes (Mark Resolved)', run: () => void this.subRun(sub, 'git_stage', { paths: [file.path] }) }
				]
				: key === 'changes'
				? [
					{ label: 'Open File', run: () => this.onOpenFile?.(absolute(file.path)) },
					{ label: 'Open Changes', run: () => this.subOpenChange(sub, file, key, letter) },
					...(file.untracked ? [] : ([{ label: 'Open Changes with Revision', run: () => {
						const p = toPosix(file.path);
						const oldPath = file.oldPath ? toPosix(file.oldPath) : p;
						this.onOpenDiff?.({
							id: `scm:${sub.repoPath}:head:${p}`,
							title: `${basename(p)} (Working Tree)`,
							repo: sub.repoPath,
							left: { revision: 'HEAD', path: oldPath, label: 'HEAD', exists: letter !== 'A' },
							right: { revision: '*', path: p, label: 'Working Tree', exists: letter !== 'D' }
						});
					} }] as MenuEntry[])),
					'separator' as const,
					...nav,
					'separator' as const,
					{ label: 'Stage Changes', run: () => void this.subRun(sub, 'git_stage', { paths: [file.path] }) },
					{ label: 'Discard Changes', run: () => void this.subDiscard(sub, file) },
					...untracked
				]
				: [
					{ label: 'Open File', run: () => this.onOpenFile?.(absolute(file.path)) },
					{ label: 'Open Changes', run: () => this.subOpenChange(sub, file, key, letter) },
					'separator' as const,
					...nav,
					'separator' as const,
					{ label: 'Unstage Changes', run: () => void this.subRun(sub, 'git_unstage', { paths: [file.path] }) },
					...untracked
				];
			// Same extension contribution the main repository's rows offer (fileRow), scoped
			// to this submodule's absolute path as the resource state's `resourceUri`.
			for (const entry of resolvedMenuEntries('scm/resourceState/context')) {
				entries.push('separator', { label: entry.label, run: () => this.onExtensionCommand?.(entry.command, [{ resourceUri: contextUri(absolute(file.path)) }]) });
			}
			showContextMenu(event.clientX, event.clientY, entries);
		});
		return row;
	},

	/** The navigation cluster every change row's menu carries — the file's history, its
	 *  row in the workspace tree (an existing file only), and the paths on the clipboard.
	 *  Copy speaks for the whole selection where one exists; a caller may pass the targets
	 *  explicitly (a sub-repo row never joins the main repository's selection, whose paths
	 *  must not leak onto its clipboard). */
	navCluster(key: ScmGroup, file: ScmChange, absolute: (relative: string) => string, timeline: boolean, explicit?: ScmChange[]): MenuEntry[] {
		const entries: MenuEntry[] = [];
		if (timeline) entries.push({ label: 'Open Timeline', run: () => this.onOpenHistory?.(absolute(file.path)) });
		if (letterOf(file, key) !== 'D') entries.push({ label: 'Reveal in Explorer', run: () => this.onReveal?.(absolute(file.path)) });
		const targets = explicit ?? this.targetsFor(key, file, ['merge', 'staged', 'changes']);
		entries.push(
			{ label: 'Copy Path', run: () => void writeText(targets.map((f) => absolute(f.path)).join('\n')) },
			{ label: 'Copy Relative Path', run: () => void writeText(targets.map((f) => toPosix(f.path)).join('\n')) }
		);
		return entries;
	},

	/** The untracked-only extras: the ignore file, and — one file at a time — the plain
	 *  rename and delete a working-tree file keeps. Tracked paths never see them. The
	 *  targets speak for the multi-selection where one exists; a caller may pass them
	 *  explicitly (a sub-repo row never joins the main repository's selection, whose ids
	 *  a same-path sub file would otherwise collide with). */
	untrackedExtras(key: ScmGroup, file: ScmChange, absolute: (relative: string) => string, root: string, explicit?: ScmChange[]): MenuEntry[] {
		const targets = explicit ?? this.targetsFor(key, file, ['merge', 'staged', 'changes']);
		const untracked = targets.filter((f) => f.untracked);
		if (untracked.length === 0) return [];
		const entries: MenuEntry[] = [
			'separator',
			{ label: 'Add to .gitignore', run: () => void this.addToGitignore(root, untracked.map((f) => f.path)) }
		];
		const single = targets.length === 1 ? targets[0]! : null;
		if (single?.untracked) {
			entries.push(
				{ label: 'Rename...', run: () => void this.renameChange(single, absolute) },
				{ label: 'Delete File', run: () => void this.deleteChange(single, absolute) }
			);
		}
		return entries;
	},

	/** "Add to .gitignore": the repository's ignore file gains one posix path per line —
	 *  the file's own encoding and line endings kept, existing lines never duplicated,
	 *  a missing file created. The write rides the workspace-confined fs seam. */
	async addToGitignore(root: string, paths: string[]): Promise<void> {
		const separator = root.includes('\\') ? '\\' : '/';
		const file = root.replace(/[\\/]+$/, '') + separator + '.gitignore';
		let current = '';
		let eol: 'lf' | 'crlf' = 'lf';
		try {
			const read = await readFile(file);
			if (read?.contents) current = read.contents;
			eol = read?.eol === 'crlf' ? 'crlf' : 'lf';
		} catch {
			current = '';
		}
		const existing = current.split(/\r?\n/);
		const newline = eol === 'crlf' ? '\r\n' : '\n';
		const addition = paths.map((p) => toPosix(p)).filter((p) => !existing.includes(p));
		if (addition.length === 0) return;
		const body = current + (current !== '' && !current.endsWith('\n') ? newline : '') + addition.join(newline) + newline;
		try {
			await writeFile(file, body, undefined, eol);
			await this.refresh();
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error instanceof Error ? error.message : error));
		}
	},

	/** "Rename...": a working-tree rename of the untracked path (the folder's absolute
	 *  prefix kept, the row refreshed out of the change list once the path moved). */
	async renameChange(file: ScmChange, absolute: (relative: string) => string): Promise<void> {
		const absolutePath = absolute(file.path);
		const name = basename(toPosix(file.path));
		const next = await quickInput({ title: 'Rename', placeholder: 'New name', value: name });
		if (!next || next.trim() === '' || next.trim() === name) return;
		try {
			const dir = absolutePath.slice(0, Math.max(0, absolutePath.length - name.length));
			await renamePath(absolutePath, dir + next.trim());
			await this.refresh();
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error instanceof Error ? error.message : error));
		}
	},

	/** "Delete File": the untracked path to the OS trash, after the same DELETE confirm
	 *  a discard of the row asks. */
	async deleteChange(file: ScmChange, absolute: (relative: string) => string): Promise<void> {
		const label = basename(toPosix(file.path));
		if (!(await confirmDialog(`Are you sure you want to DELETE ${label}?`, 'Delete File'))) return;
		try {
			await deletePath(absolute(file.path), false);
			await this.refresh();
			this.onChanged?.();
		} catch (error) {
			notify('error', String(error instanceof Error ? error.message : error));
		}
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

	/** The delete/discard confirmation a single file's row asks (verbatim for the row menu
	 *  and the sub-repo's, which differ only in where the confirmed write runs). The
	 *  untracked case carries no irreversible wording: its discard rides the same
	 *  Recycle Bin engine the view's own "Delete File" uses, so the file is restorable. */
	confirmDiscardOne(file: ScmChange): Promise<boolean> {
		const label = basename(toPosix(file.path));
		return confirmDialog(
			file.untracked
				? tf('scm.discardUntracked.confirm', label)
				: `Are you sure you want to discard changes in ${label}?`,
			file.untracked ? t('scm.discardUntracked.action') : 'Discard Changes'
		);
	},

	async discard(file: ScmChange): Promise<void> {
		if (!(await this.confirmDiscardOne(file))) return;
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

	/** The discard-everything pass over one group's changes (the Changes group of the
	 *  repository or of a sub-repo — the confirmed write goes through `run`). Only the
	 *  "Changes" group: conflicted paths are the merge's own business - a pathspec-less
	 *  `git restore -- .` aborts on the first unmerged path and discards nothing - so the
	 *  operation names the non-conflicted paths explicitly. */
	async discardChangesOf(changes: ScmChange[], run: (command: string, args: Record<string, unknown>) => Promise<void>): Promise<void> {
		const unstaged = changes.filter((c) => !c.conflicted && (c.unstaged !== null || c.untracked));
		if (unstaged.length === 0) return;
		const untracked = unstaged.filter((c) => c.untracked);
		const confirmed = await confirmDialog(
			untracked.length > 0
				? `Are you sure you want to discard ALL changes? ${untracked.length} untracked file(s) will be DELETED!\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST.`
				: `Are you sure you want to discard ALL ${unstaged.length} changes?\nThis is IRREVERSIBLE!\nYour current working set will be FOREVER LOST if you proceed.`,
			'Discard All Changes'
		);
		if (!confirmed) return;
		await run('git_discard_all', {
			restore: unstaged.filter((c) => !c.untracked).map((c) => c.path),
			clean: untracked.map((c) => c.path)
		});
	},

	async discardAll(): Promise<void> {
		await this.discardChangesOf(this.changes, (command, args) => this.run(command, args));
	},

	async subDiscard(sub: SubRepoState, file: ScmChange): Promise<void> {
		if (!(await this.confirmDiscardOne(file))) return;
		await this.subRun(sub, 'git_discard', { path: file.path, untracked: file.untracked });
	},

	async subDiscardAll(sub: SubRepoState): Promise<void> {
		await this.discardChangesOf(sub.changes, (command, args) => this.subRun(sub, command, args));
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
