// The Source Control view: the commit input, the Merge Changes / Staged Changes / Changes
// groups with their inline actions (stage, unstage, discard, open), and the diff editors a
// click opens - the same layout and behaviour as VS Code's built-in Git view. A conflicted
// file (a merge / rebase / cherry-pick stopped on it) opens in the editor, whose conflict
// toolbar resolves and stages it. The change list is virtualised: the groups, folders and
// files flatten to fixed-height rows and only the visible window is in the DOM, so a
// working tree with thousands of changes renders as fast as one with ten.

import { invoke } from '@tauri-apps/api/core';

import type { CommandRegistry } from './commands';
import { resolvedMenuEntries } from './contributions';
import type { DiffSide } from './editor';
import { fileIcon, fileIconColor } from './editor';
import type { StatusMap } from './explorer';
import { t, trText } from './i18n';
import * as state from './state';
import { actionButton, basename, confirmDialog, el, icon, notify, showContextMenu, showMenuBelow, toPosix, type MenuEntry } from './ui';

interface ScmChange {
	path: string;
	oldPath: string | null;
	staged: string | null;
	unstaged: string | null;
	untracked: boolean;
	/** The index holds conflict stages for the path: git lists it under "Unmerged paths". */
	conflicted?: boolean;
}

/** The three groups of the view, in display order; VS Code's names. */
export type ScmGroup = 'merge' | 'staged' | 'changes';

export interface DiffRequest {
	id: string;
	title: string;
	/** The repository the revisions belong to (the open repository, or a submodule when the
	 *  diff was opened from its graph). */
	repo?: string;
	left: DiffSide;
	right: DiffSide;
}

function letterFor(status: string | null, untracked: boolean): string {
	if (untracked) return 'U';
	switch (status) {
		case 'added': return 'A';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'untracked': return 'U';
		default: return 'M';
	}
}

const LETTER_TITLE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', '!': 'Conflict' };

/** Which group a change belongs to for the purposes of its letter: a conflicted file shows
 *  VS Code's `!` whichever group lists it. */
function letterOf(file: ScmChange, key: ScmGroup): string {
	if (file.conflicted) return '!';
	return key === 'staged' ? letterFor(file.staged, false) : letterFor(file.unstaged, file.untracked);
}

export type ScmViewMode = 'list' | 'tree';

/** Every row of the change list is this tall (kept in step with shell.css). */
const SCM_ROW_HEIGHT = 22;
/** Rows drawn above and below the viewport, so fast scrolls never show blank. */
const SCM_OVERSCAN = 10;

/** One row of the flattened change list. */
type ScmRow =
	| { kind: 'group'; key: ScmGroup; label: string; count: number }
	| { kind: 'empty'; key: ScmGroup }
	| { kind: 'folder'; key: ScmGroup; node: TreeNode; folderKey: string; collapsed: boolean; depth: number }
	| { kind: 'file'; key: ScmGroup; file: ScmChange; depth: number; inTree: boolean };
export type ScmSort = 'name' | 'path' | 'status';

export interface TreeNode {
	name: string;
	path: string;
	children: TreeNode[];
	file: ScmChange | null;
}

/** VS Code's tree view of changes: folders nested, single-child folder chains compacted. */
export function buildChangeTree(files: ScmChange[]): TreeNode[] {
	const root: TreeNode = { name: '', path: '', children: [], file: null };
	for (const file of files) {
		const parts = toPosix(file.path).split('/');
		let node = root;
		parts.forEach((part, index) => {
			const isLeaf = index === parts.length - 1;
			let child = node.children.find((c) => c.name === part && (c.file === null) === !isLeaf);
			if (!child) {
				child = { name: part, path: parts.slice(0, index + 1).join('/'), children: [], file: isLeaf ? file : null };
				node.children.push(child);
			}
			node = child;
		});
	}
	const compact = (node: TreeNode): TreeNode => {
		node.children = node.children.map(compact);
		if (node.file === null && node.name !== '' && node.children.length === 1 && node.children[0]!.file === null) {
			const only = node.children[0]!;
			return { ...only, name: `${node.name}/${only.name}` };
		}
		return node;
	};
	const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
		nodes
			.map((n) => ({ ...n, children: sortNodes(n.children) }))
			.sort((a, b) => (a.file === null ? 0 : 1) - (b.file === null ? 0 : 1) || a.name.localeCompare(b.name));
	return sortNodes(compact(root).children);
}

export function sortChanges(files: ScmChange[], sort: ScmSort, key: ScmGroup): ScmChange[] {
	const letter = (f: ScmChange) => letterOf(f, key);
	return [...files].sort((a, b) => {
		const pa = toPosix(a.path), pb = toPosix(b.path);
		if (sort === 'name') return basename(pa).localeCompare(basename(pb)) || pa.localeCompare(pb);
		if (sort === 'status') return letter(a).localeCompare(letter(b)) || pa.localeCompare(pb);
		return pa.localeCompare(pb);
	});
}

export class SourceControlView {
	private readonly container: HTMLElement;
	private readonly title: HTMLElement;
	private readonly content: HTMLElement;
	private changes: ScmChange[] = [];
	private repoPath: string | null = null;
	/** Whether the open folder is a Git repository (false: the Initialize button shows). */
	private isRepo = true;
	private branch: string | null = null;
	private message = '';
	private collapsed: Record<ScmGroup, boolean> = { merge: false, staged: false, changes: false };
	private readonly collapsedFolders = new Set<string>();
	private selected: string | null = null;
	private error: string | null = null;
	/** Bumped by setRepo: a refresh that started before a folder switch is dropped on return. */
	private generation = 0;
	/** The flattened change list (groups, folders, files) and its virtual window. */
	private rows: ScmRow[] = [];
	private list: HTMLElement | null = null;
	private listInner: HTMLElement | null = null;
	private scrollFrame: number | null = null;
	viewMode: ScmViewMode = state.load<ScmViewMode>('scmViewMode', 'list');
	sort: ScmSort = state.load<ScmSort>('scmSort', 'path');

	/** Refreshed alongside the view so the Explorer can colour its tree. */
	onStatus: ((status: StatusMap) => void) | null = null;
	onOpenFile: ((path: string) => void) | null = null;
	onOpenDiff: ((diff: DiffRequest) => void) | null = null;
	onOpenGraph: (() => void) | null = null;
	/** "Show File History in Git Graph" (git-graph-rs.filterByFile) from a resource's own
	 *  context menu - VS Code passes the right-clicked resource as the command's argument;
	 *  Studio's commands carry none, so this menu wires the path directly instead. */
	onShowFileHistory: ((path: string) => void) | null = null;
	/** Fired after every write, so the graph and the status bar can catch up. */
	onChanged: (() => void) | null = null;
	/** Fired whenever the pending change count changes, so the activity bar badge can track it. */
	onCount: ((count: number) => void) | null = null;
	/** Fired with the number of unmerged paths after every refresh (the status bar's "N conflicts"). */
	onConflicts: ((count: number) => void) | null = null;

	constructor(container: HTMLElement, private readonly commands: CommandRegistry | null = null) {
		this.container = container;
		this.title = el('div', 'sidebar-title', [el('span', 'label', ['Source Control'])]);
		this.content = el('div', 'view-pane');
		container.append(this.title, this.content);
		this.render();
	}

	setRepo(repoPath: string | null, isRepo = true): void {
		this.repoPath = repoPath;
		this.isRepo = isRepo;
		this.generation++;
		this.changes = [];
		this.error = null;
		this.branch = null;
		this.message = '';
		this.selected = null;
		this.collapsedFolders.clear();
		this.onStatus?.(new Map());
		this.onCount?.(0);
		this.onConflicts?.(0);
		this.render();
	}

	/** The unmerged paths, repo-relative (posix). */
	conflictedPaths(): string[] {
		return this.changes.filter((c) => c.conflicted).map((c) => toPosix(c.path));
	}

	setBranch(branch: string | null): void {
		this.branch = branch;
		const input = this.content.querySelector<HTMLTextAreaElement>('textarea');
		if (input) input.placeholder = this.placeholder();
	}

	changeCount(): number {
		return this.changes.length;
	}

	async refresh(): Promise<void> {
		if (!this.repoPath || !this.isRepo) return;
		const generation = this.generation;
		let changes: ScmChange[];
		try {
			changes = await invoke<ScmChange[]>('scm_status');
			if (generation !== this.generation) return; // the folder switched mid-flight
			this.changes = changes;
			this.error = null;
		} catch (error) {
			if (generation !== this.generation) return;
			this.changes = [];
			this.error = String(error);
		}
		const status: StatusMap = new Map();
		for (const change of this.changes) {
			status.set(toPosix(change.path), change.conflicted ? '!' : letterFor(change.staged ?? change.unstaged, change.untracked));
		}
		this.onStatus?.(status);
		this.onCount?.(this.changes.length);
		this.onConflicts?.(this.changes.filter((c) => c.conflicted).length);
		this.render();
	}

	/* ---------- Rendering ---------- */

	private placeholder(): string {
		return `Message (Ctrl+Enter to commit${this.branch ? ` on "${this.branch}"` : ''})`;
	}

	private render(): void {
		this.title.querySelector('.actions')?.remove();
		// A refresh re-renders under the user's hands; the commit box keeps its focus and caret.
		const previous = this.content.querySelector<HTMLTextAreaElement>('textarea');
		const hadFocus = previous !== null && document.activeElement === previous;
		const caret = previous === null ? null : { start: previous.selectionStart, end: previous.selectionEnd };
		this.content.innerHTML = '';
		if (!this.repoPath) {
			this.content.appendChild(el('div', 'welcome-view', [el('p', '', ['Open a folder containing a Git repository to see its changes here.'])]));
			return;
		}
		if (!this.isRepo) {
			// The open folder is not a repository yet: VS Code's own offer, in VS Code's own
			// place (the Source Control view's empty state).
			const button = el('button', 'button', ['Initialize Repository']);
			button.addEventListener('click', () => void this.commands?.execute('git.initRepository'));
			this.content.appendChild(el('div', 'welcome-view', [
				el('p', '', [`${basename(this.repoPath)} is not a Git repository.`]),
				button
			]));
			return;
		}
		// The extension's manifest places "View Git Graph" as a title-bar icon or inside "..."
		// depending on the git-graph-rs.sourceCodeProviderIntegrationLocation setting (scm/title,
		// group "navigation" vs. anything else) - default to the icon if the manifest is
		// somehow not loaded yet, matching that setting's own default ("Inline").
		const graphTitleEntry = resolvedMenuEntries('scm/title').find((entry) => entry.command === 'git-graph-rs.view');
		const actions: HTMLElement[] = [];
		if (!graphTitleEntry || graphTitleEntry.group === 'navigation') {
			const graphButton = actionButton('', graphTitleEntry?.label ?? 'View Git Graph', () => this.onOpenGraph?.());
			graphButton.innerHTML = '<img src="/icons/git-graph-16.svg" alt="" width="16" height="16">';
			actions.push(graphButton);
		}
		actions.push(
			actionButton(this.viewMode === 'tree' ? 'list-flat' : 'list-tree', this.viewMode === 'tree' ? 'View as List' : 'View as Tree', () => this.setViewMode(this.viewMode === 'tree' ? 'list' : 'tree')),
			actionButton('refresh', 'Refresh', () => void this.refresh()),
			actionButton('ellipsis', 'More Actions...', (event) => showMenuBelow(event.currentTarget as HTMLElement, this.moreMenu(), 220))
		);
		this.title.appendChild(el('div', 'actions', actions));
		this.title.querySelector<HTMLElement>('.actions')!.style.visibility = 'visible';

		const header = el('div', 'pane-header', [icon('chevron-down', 'twistie'), el('span', 'label', [basename(this.repoPath)])]);
		header.title = this.repoPath;
		if (this.changes.length > 0) header.appendChild(el('span', 'badge', [String(this.changes.length)]));
		this.content.appendChild(header);

		const body = el('div', 'pane-body list');
		body.tabIndex = 0;
		body.appendChild(this.commitBox());
		if (this.error) {
			body.appendChild(el('div', 'scm-input', [el('div', 'error', [this.error])]));
		}
		// The change list: a scroll container over a spacer of the full height, with only the
		// rows near the viewport drawn (renderWindow).
		const previousScroll = this.list?.scrollTop ?? 0;
		this.list = el('div', 'scm-list scm-group');
		this.listInner = el('div', 'scm-rows');
		this.list.appendChild(this.listInner);
		this.list.addEventListener('scroll', () => this.scheduleWindow(), { passive: true });
		body.appendChild(this.list);
		this.rows = this.buildRows();
		this.listInner.style.height = `${this.rows.length * SCM_ROW_HEIGHT}px`;
		this.content.appendChild(body);
		this.list.scrollTop = previousScroll;
		this.renderWindow();
		if (hadFocus) {
			const input = body.querySelector<HTMLTextAreaElement>('textarea');
			if (input) {
				input.focus();
				if (caret) input.setSelectionRange(caret.start, caret.end);
			}
		}
	}

	private commitBox(): HTMLElement {
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
			commit.disabled = input.value.trim() === '';
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void this.commit();
			}
		});
		const commit = el('button', 'button', [icon('check'), 'Commit']);
		commit.disabled = this.message.trim() === '';
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
		requestAnimationFrame(grow);
		return box;
	}

	/** Flatten the groups into rows: a header per group (the empty Changes group shows its
	 *  placeholder), then - unless collapsed - the files as a list, or folders and files as a
	 *  tree with collapsed folders pruned. */
	private buildRows(): ScmRow[] {
		const rows: ScmRow[] = [];
		const merge = this.changes.filter((c) => c.conflicted);
		const staged = this.changes.filter((c) => !c.conflicted && c.staged !== null);
		const unstaged = this.changes.filter((c) => !c.conflicted && (c.unstaged !== null || c.untracked));
		const groups: { label: string; key: ScmGroup; files: ScmChange[]; always: boolean }[] = [
			{ label: 'Merge Changes', key: 'merge', files: merge, always: false },
			{ label: 'Staged Changes', key: 'staged', files: staged, always: false },
			{ label: 'Changes', key: 'changes', files: unstaged, always: true }
		];
		for (const group of groups) {
			if (group.files.length === 0 && !group.always) continue;
			rows.push({ kind: 'group', key: group.key, label: group.label, count: group.files.length });
			if (this.collapsed[group.key]) continue;
			if (group.files.length === 0) {
				rows.push({ kind: 'empty', key: group.key });
				continue;
			}
			const sorted = sortChanges(group.files, this.sort, group.key);
			if (this.viewMode === 'tree') {
				const walk = (nodes: TreeNode[], depth: number) => {
					for (const node of nodes) {
						if (node.file) {
							rows.push({ kind: 'file', key: group.key, file: node.file, depth, inTree: true });
							continue;
						}
						const folderKey = `${group.key}:${node.path}`;
						const collapsed = this.collapsedFolders.has(folderKey);
						rows.push({ kind: 'folder', key: group.key, node, folderKey, collapsed, depth });
						if (!collapsed) walk(node.children, depth + 1);
					}
				};
				walk(buildChangeTree(sorted), 0);
			} else {
				for (const file of sorted) rows.push({ kind: 'file', key: group.key, file, depth: 0, inTree: false });
			}
		}
		return rows;
	}

	/** The actions of a group header. */
	private groupActions(key: ScmGroup, files: ScmChange[]): HTMLElement[] {
		switch (key) {
			case 'merge': return [actionButton('add', 'Stage All Merge Changes', () => void this.run('git_stage', { paths: files.map((c) => c.path) }))];
			case 'staged': return [actionButton('remove', 'Unstage All Changes', () => void this.run('git_unstage_all'))];
			default: return [
				actionButton('discard', 'Discard All Changes', () => void this.discardAll()),
				actionButton('add', 'Stage All Changes', () => void this.run('git_stage_all'))
			];
		}
	}

	/** Draw only the rows near the viewport. jsdom reports a zero-height viewport; a screen's
	 *  worth of rows is assumed then, so the head of every list is queryable in tests. */
	private renderWindow(): void {
		if (!this.list || !this.listInner) return;
		const total = this.rows.length;
		const scrollTop = this.list.scrollTop;
		const viewport = Math.max(this.list.clientHeight, SCM_ROW_HEIGHT * 30);
		const first = Math.max(0, Math.floor(scrollTop / SCM_ROW_HEIGHT) - SCM_OVERSCAN);
		const last = Math.min(total, Math.ceil((scrollTop + viewport) / SCM_ROW_HEIGHT) + SCM_OVERSCAN);
		this.listInner.innerHTML = '';
		for (let i = first; i < last; i++) {
			const element = this.rowElement(this.rows[i]!);
			element.style.top = `${i * SCM_ROW_HEIGHT}px`;
			this.listInner.appendChild(element);
		}
	}

	private scheduleWindow(): void {
		if (this.scrollFrame !== null) return;
		this.scrollFrame = requestAnimationFrame(() => {
			this.scrollFrame = null;
			this.renderWindow();
		});
	}

	private rowElement(row: ScmRow): HTMLElement {
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
	}

	setViewMode(mode: ScmViewMode): void {
		this.viewMode = mode;
		state.save('scmViewMode', mode);
		this.render();
	}

	setSort(sort: ScmSort): void {
		this.sort = sort;
		state.save('scmSort', sort);
		this.render();
	}

	/** The "..." menu, laid out as VS Code's Git extension lays out its own. */
	moreMenu(): MenuEntry[] {
		const cmd = (id: string): MenuEntry => (this.commands ? this.commands.menuItem(id) : { label: id, disabled: true });
		const toggleView: MenuEntry = { label: this.viewMode === 'tree' ? 'View as List' : 'View as Tree', run: () => this.setViewMode(this.viewMode === 'tree' ? 'list' : 'tree') };
		// git-graph-rs's own scm/title entries not in the "navigation" group (the icon rendered
		// in the title bar instead, see render()) - "View Git Graph" itself when the
		// sourceCodeProviderIntegrationLocation setting tucks it in here, and the Amend/Gerrit
		// commands, whichever locale variant the manifest's `when` currently selects.
		const graphTitleMenu: MenuEntry[] = resolvedMenuEntries('scm/title')
			.filter((entry) => entry.group !== 'navigation')
			.map((entry) => ({
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
			{ label: 'Pull, Push', submenu: [cmd('git.sync'), cmd('git.syncRebase'), 'separator', cmd('git.pull'), cmd('git.pullRebase'), cmd('git.pullFrom'), 'separator', cmd('git.push'), cmd('git.pushTo'), cmd('git.pushForce'), 'separator', cmd('git.fetch'), cmd('git.fetchPrune'), cmd('git.fetchFrom')] },
			{ label: 'Branch', submenu: [cmd('git.merge'), cmd('git.rebase'), 'separator', cmd('git.branch'), cmd('git.branchFrom'), cmd('git.renameBranch'), cmd('git.deleteBranch')] },
			{ label: 'Remote', submenu: [cmd('git.addRemote'), cmd('git.removeRemote')] },
			{ label: 'Stash', submenu: [cmd('git.stash'), cmd('git.stashIncludeUntracked'), 'separator', cmd('git.stashApply'), cmd('git.stashApplyLatest'), cmd('git.stashPop'), cmd('git.stashPopLatest'), cmd('git.stashDrop')] },
			{ label: 'Tags', submenu: [cmd('git.createTag'), cmd('git.deleteTag')] },
			'separator',
			cmd('git.showOutput'),
			...(graphTitleMenu.length > 0 ? ['separator' as const, ...graphTitleMenu] : [])
		];
	}

	private fileRow(file: ScmChange, key: ScmGroup, depth: number, inTree: boolean): HTMLElement {
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
		if (this.selected === key + ':' + posix) row.classList.add('selected', 'focused');
		const actions = el('div', 'actions', [
			actionButton('go-to-file', 'Open File', () => this.onOpenFile?.(this.absolute(file.path)))
		]);
		if (key === 'merge') {
			actions.appendChild(actionButton('add', 'Stage Changes (Mark Resolved)', () => void this.run('git_stage', { paths: [file.path] })));
		} else if (key === 'changes') {
			actions.appendChild(actionButton('discard', 'Discard Changes', () => void this.discard(file)));
			actions.appendChild(actionButton('add', 'Stage Changes', () => void this.run('git_stage', { paths: [file.path] })));
		} else {
			actions.appendChild(actionButton('remove', 'Unstage Changes', () => void this.run('git_unstage', { paths: [file.path] })));
		}
		row.appendChild(actions);
		const decoration = el('span', 'decoration', [letter]);
		decoration.title = LETTER_TITLE[letter] ?? letter;
		row.appendChild(decoration);
		row.addEventListener('click', () => {
			this.selected = key + ':' + posix;
			for (const other of this.content.querySelectorAll('.row')) other.classList.remove('selected', 'focused');
			row.classList.add('selected', 'focused');
			this.openChange(file, key, letter);
		});
		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			const entries = key === 'merge'
				? [
					{ label: 'Open in Merge Editor', run: () => this.onOpenFile?.(this.absolute(file.path)) },
					'separator' as const,
					{ label: 'Stage Changes (Mark Resolved)', run: () => void this.run('git_stage', { paths: [file.path] }) }
				]
				: key === 'changes'
				? [
					{ label: 'Open File', run: () => this.onOpenFile?.(this.absolute(file.path)) },
					{ label: 'Open Changes', run: () => this.openChange(file, key, letter) },
					'separator' as const,
					{ label: 'Stage Changes', run: () => void this.run('git_stage', { paths: [file.path] }) },
					{ label: 'Discard Changes', run: () => void this.discard(file) }
				]
				: [
					{ label: 'Open File', run: () => this.onOpenFile?.(this.absolute(file.path)) },
					{ label: 'Open Changes', run: () => this.openChange(file, key, letter) },
					'separator' as const,
					{ label: 'Unstage Changes', run: () => void this.run('git_unstage', { paths: [file.path] }) }
				];
			// The manifest's scm/resourceState/context contribution (git-graph-rs.filterByFile) -
			// present whenever the extension declares it and its `when` currently allows it.
			const fileHistory = resolvedMenuEntries('scm/resourceState/context').find((entry) => entry.command === 'git-graph-rs.filterByFile');
			if (fileHistory) entries.push('separator', { label: fileHistory.label, run: () => this.onShowFileHistory?.(this.absolute(file.path)) });
			showContextMenu(event.clientX, event.clientY, entries);
		});
		return row;
	}

	private absolute(relative: string): string {
		const root = this.repoPath!;
		const separator = root.includes('\\') ? '\\' : '/';
		return root.replace(/[\\/]+$/, '') + separator + relative.replaceAll('/', separator);
	}

	/** What a click on a change shows: VS Code diffs the index against the working tree for an
	 *  unstaged change, and HEAD against the index for a staged one. */
	private openChange(file: ScmChange, key: ScmGroup, letter: string): void {
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
	}

	/* ---------- Actions ---------- */

	/** The push/sync that follows a "Commit & ..." action: git's complaint is reported, the
	 *  view still catches up. */
	private async afterCommit(command: string, args: Record<string, unknown>): Promise<void> {
		try {
			await invoke(command, args);
		} catch (error) {
			notify('error', String(error));
		}
		this.onChanged?.();
	}

	/** Commit: VS Code's "smart commit" stages everything when nothing is staged (after asking),
	 *  `all` stages without asking, `stagedOnly` never stages, `amend` re-does the last commit.
	 *  `followUp` runs after a successful commit (the "Commit & Push" / "Commit & Sync" actions). */
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
				await invoke('git_stage_all');
			} catch (error) {
				notify('error', String(error));
				return;
			}
		}
		try {
			// An amend with an empty box keeps the last commit's message (the backend's --no-edit path).
			await invoke('git_commit', { message, amend });
		} catch (error) {
			notify('error', String(error));
			await this.refresh();
			return;
		}
		this.message = '';
		await this.refresh();
		this.onChanged?.();
		if (followUp) await followUp();
	}

	private async discard(file: ScmChange): Promise<void> {
		const label = basename(toPosix(file.path));
		const confirmed = await confirmDialog(
			file.untracked
				? `Are you sure you want to DELETE ${label}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.`
				: `Are you sure you want to discard changes in ${label}?`,
			file.untracked ? 'Delete file' : 'Discard Changes'
		);
		if (!confirmed) return;
		await this.run('git_discard', { path: file.path, untracked: file.untracked });
	}

	private async discardAll(): Promise<void> {
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
	}

	private async run(command: string, args: Record<string, unknown> = {}): Promise<void> {
		try {
			await invoke(command, args);
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
		this.onChanged?.();
	}
}
