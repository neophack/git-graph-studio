// The SourceControlView class shell: fields, constructor, the refresh/selection/
// rendering lifetime and the sub-repo plumbing stay here; the commit input, change
// groups, row actions and menus live in their concern files, typed against this
// class through ThisType and assigned onto the prototype by the module facade.

import { invoke } from '../../platform/ipc/core';
import type { CommandRegistry } from '../../platform/commands';
import { commandIconContent, contextUri, resolvedMenuEntries } from '../extensions';
import { extFileDataUrl } from '../../platform/extAssets';
import type { DiffRequest } from '../editor/types';
import type { BranchInfo, RemoteInfo, ScmChange, StashInfo, StatusMap } from '../../platform/ipc/scm';
import { scmBranches, scmRemotes, scmStashes, scmStatus } from '../../platform/ipc/scm';
import { repoHead, repoSubmodules } from '../../platform/ipc/revision';
import * as state from '../../platform/state';
import { coalesced } from '../../platform/coalesce';
import { actionButton, basename, el, icon, liveSidebarTitle, notify, quickPick, showMenuBelow, toPosix, type MenuEntry, type QuickPickItem } from '../../platform/ui/index';

export type ScmGroup = 'merge' | 'staged' | 'changes';


/** One of the open folder's initialised submodules, rendered as its own repository section
 *  below the main one - VS Code's Source Control view when several repositories are open:
 *  its own branch/sync header, commit box and change groups, all scoped to `repoPath`. */
export interface SubRepoState {
	repoPath: string;
	changes: ScmChange[];
	branch: string | null;
	/** The checked-out commit - empty on an unborn branch. A submodule typically checks out
	 *  its recorded commit detached: `branch` null, `shortHash` set, and nothing to publish. */
	shortHash: string;
	ahead: number;
	behind: number;
	upstream: string | null;
	message: string;
	collapsed: Record<ScmGroup, boolean>;
	error: string | null;
	/** The section itself, collapsed by its own twistie (independent of the group twisties). */
	sectionCollapsed: boolean;
}

/** Same validity rule gitCommands.ts uses for a new branch/tag/remote name - a submodule's
 *  "..." menu asks for one exactly like the main repository's. */
const SUB_REF_NAME = /^(?![-.])(?!.*(\.\.|@\{|[\\^:?*\[\s~]))[^\x00-\x1f\x7f]+(?<![./])(?<!\.lock)$/;
export function validateSubRef(value: string): string | null {
	return value.trim() === '' ? 'A name is required' : SUB_REF_NAME.test(value.trim()) ? null : `'${value}' is not a valid Git reference name`;
}

/** The pick flows a submodule's "..." menu needs, scoped to `repo` - gitCommands.ts's own
 *  pickBranch/pickRemote/pickStash, reimplemented here because those are wired to the single
 *  open repository the global Command Registry manages, not an arbitrary one. */
export async function pickBranchIn(repo: string, placeholder: string, filter: (b: BranchInfo) => boolean = () => true): Promise<BranchInfo | null> {
	const branches = await scmBranches(repo);
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

export async function pickRemoteIn(repo: string, placeholder: string): Promise<RemoteInfo | null> {
	const remotes = await scmRemotes(repo);
	if (remotes.length === 0) {
		notify('info', 'The repository has no remotes. Add one with Remote > Add Remote...');
		return null;
	}
	if (remotes.length === 1) return remotes[0]!;
	const chosen = await quickPick(remotes.map((r) => ({ label: r.name, description: r.url, icon: 'cloud', value: r.name })), placeholder);
	return remotes.find((r) => r.name === chosen) ?? null;
}

export async function pickStashIn(repo: string, placeholder: string): Promise<StashInfo | null> {
	const stashes = await scmStashes(repo);
	if (stashes.length === 0) {
		notify('info', 'There are no stashes in the repository.');
		return null;
	}
	const chosen = await quickPick(stashes.map((s) => ({ label: `#${s.index}: ${s.message}`, icon: 'archive', value: s.selector })), placeholder);
	return stashes.find((s) => s.selector === chosen) ?? null;
}

export function letterFor(status: string | null, untracked: boolean): string {
	if (untracked) return 'U';
	switch (status) {
		case 'added': return 'A';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'untracked': return 'U';
		default: return 'M';
	}
}

export const LETTER_TITLE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', '!': 'Conflict' };

/** Which group a change belongs to for the purposes of its letter: a conflicted file shows
 *  VS Code's `!` whichever group lists it. */
export function letterOf(file: ScmChange, key: ScmGroup): string {
	if (file.conflicted) return '!';
	return key === 'staged' ? letterFor(file.staged, false) : letterFor(file.unstaged, file.untracked);
}

export type ScmViewMode = 'list' | 'tree';

/** Every row of the change list is this tall (kept in step with shell.css). */
export const SCM_ROW_HEIGHT = 22;
/** Rows drawn above and below the viewport, so fast scrolls never show blank. */
export const SCM_OVERSCAN = 10;

/** One row of the flattened change list. */
export type ScmRow =
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
	commands: CommandRegistry | null = null;

	readonly container: HTMLElement;

	readonly title: HTMLElement;

	readonly content: HTMLElement;

	changes: ScmChange[] = [];

	repoPath: string | null = null;

	isRepo = true;

	branch: string | null = null;

	ahead = 0;

	behind = 0;

	upstream: string | null = null;

	shortHash = '';

	message = '';

	collapsed: Record<ScmGroup, boolean> = { merge: false, staged: false, changes: false };

	readonly collapsedFolders = new Set<string>();

	selection = new Set<string>();

	anchor: string | null = null;

	error: string | null = null;

	generation = 0;

	lastSnapshot: string | null = null;

	rows: ScmRow[] = [];

	list: HTMLElement | null = null;

	listInner: HTMLElement | null = null;

	scrollFrame: number | null = null;

	viewMode: ScmViewMode = state.load<ScmViewMode>('scmViewMode', 'list');

	sort: ScmSort = state.load<ScmSort>('scmSort', 'path');

	submodules: string[] = [];

	subRepos: SubRepoState[] = [];

	onStatus: ((status: StatusMap) => void) | null = null;

	onOpenFile: ((path: string) => void) | null = null;

	onOpenDiff: ((diff: DiffRequest) => void) | null = null;

	onExtensionCommand: ((command: string, args?: unknown[]) => void) | null = null;

	onChanged: (() => void) | null = null;

	onHead: ((head: { repo: string; branch: string | null; shortHash: string; ahead: number; behind: number; upstream: string | null } | null) => void) | null = null;

	onCount: ((count: number) => void) | null = null;

	onConflicts: ((count: number) => void) | null = null;

	onOpenFolder: ((path: string) => void) | null = null;

	onShowOutput: (() => void) | null = null;

	constructor(container: HTMLElement, commands: CommandRegistry | null = null) {
		this.commands = commands;
		this.container = container;
		this.title = liveSidebarTitle('scm.title');
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
		this.ahead = 0;
		this.behind = 0;
		this.upstream = null;
		this.shortHash = '';
		this.message = '';
		this.selection.clear();
		this.anchor = null;
		this.collapsedFolders.clear();
		this.submodules = [];
		this.subRepos = [];
		this.onStatus?.(new Map());
		this.onCount?.(0);
		this.onConflicts?.(0);
		this.render();
	}

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

	/** Re-read the status, the head and the submodules, then re-render. Coalesced: a call
	 *  while one runs queues a single trailing run instead of a second concurrent one. */
	refresh(): Promise<void> {
		return this.refreshFlight();
	}

	private readonly refreshFlight = coalesced(() => this.refreshNow());

	private async refreshNow(): Promise<void> {
		if (!this.repoPath || !this.isRepo) return;
		const generation = this.generation;
		let changes: ScmChange[];
		try {
			changes = await scmStatus();
			if (generation !== this.generation) return; // the folder switched mid-flight
			this.changes = changes;
			this.error = null;
		} catch (error) {
			if (generation !== this.generation) return;
			changes = [];
			this.changes = [];
			this.error = String(error);
		}
		this.trackSelection(changes);
		// The branch's own state rides along: the commit button's clean-tree roles (Push, Sync
		// Changes, Publish Branch) read it. A backend build or scripted test without repo_head
		// keeps the previous values; the workbench no longer needs its own follow-up fetch.
		const head = await repoHead().catch(() => null);
		if (generation !== this.generation) return;
		// The fingerprint a swallowed `.git`-only batch is re-checked against (see
		// `statusDiffers`): exactly what this refresh saw, nothing more.
		this.lastSnapshot = JSON.stringify([changes, head]);
		if (head) {
			this.branch = head.branch;
			this.shortHash = head.shortHash;
			this.ahead = head.ahead;
			this.behind = head.behind;
			this.upstream = head.upstream;
		}
		this.onHead?.(head);
		await this.refreshSubmodules(generation);
		if (generation !== this.generation) return;
		const status: StatusMap = new Map();
		for (const change of this.changes) {
			status.set(toPosix(change.path), change.conflicted ? '!' : letterFor(change.staged ?? change.unstaged, change.untracked));
		}
		let allChanges = this.changes;
		let allConflicts = this.changes.filter((c) => c.conflicted).length;
		for (const sub of this.subRepos) {
			for (const change of sub.changes) {
				status.set(toPosix(`${sub.repoPath}/${change.path}`), change.conflicted ? '!' : letterFor(change.staged ?? change.unstaged, change.untracked));
			}
			allChanges = allChanges.concat(sub.changes);
			allConflicts += sub.changes.filter((c) => c.conflicted).length;
		}
		this.onStatus?.(status);
		this.onCount?.(allChanges.length);
		this.onConflicts?.(allConflicts);
		this.render();
	}

	async statusDiffers(): Promise<boolean> {
		if (!this.repoPath || !this.isRepo) return false;
		const generation = this.generation;
		try {
			const [changes, head] = await Promise.all([
				scmStatus(),
				repoHead().catch(() => null)
			]);
			if (generation !== this.generation) return false;
			return JSON.stringify([changes, head]) !== this.lastSnapshot;
		} catch {
			return this.error === null;
		}
	}

	trackSelection(changes: ScmChange[]): void {
		if (this.selection.size === 0 && this.anchor === null) return;
		const valid = new Set<string>();
		const groupsOf = new Map<string, ScmGroup[]>();
		for (const file of changes) {
			const path = toPosix(file.path);
			const groups: ScmGroup[] = [];
			if (file.conflicted) groups.push('merge');
			if (file.staged !== null) groups.push('staged');
			if (!file.conflicted && (file.unstaged !== null || file.untracked)) groups.push('changes');
			groupsOf.set(path, groups);
			for (const key of groups) valid.add(key + ':' + path);
		}
		const remap = (id: string | null): string | null => {
			if (id === null || valid.has(id)) return id;
			const groups = groupsOf.get(id.slice(id.indexOf(':') + 1)) ?? [];
			return groups.length === 1 ? groups[0] + ':' + id.slice(id.indexOf(':') + 1) : null;
		};
		this.selection = new Set([...this.selection].map(remap).filter((id): id is string => id !== null));
		this.anchor = remap(this.anchor);
	}

	repaintSelection(): void {
		if (!this.listInner) return;
		for (const element of this.listInner.querySelectorAll<HTMLElement>('.row')) {
			const id = element.dataset.scmKey ?? '';
			element.classList.toggle('selected', this.selection.has(id));
			element.classList.toggle('focused', id === this.anchor);
		}
	}

	targetRows(key: ScmGroup, file: ScmChange, groups: ScmGroup[]): { file: ScmChange; key: ScmGroup }[] {
		if (!this.selection.has(key + ':' + toPosix(file.path)) || this.selection.size <= 1) return [{ file, key }];
		const targets: { file: ScmChange; key: ScmGroup }[] = [];
		for (const row of this.rows) {
			if (row.kind !== 'file' || !groups.includes(row.key)) continue;
			if (this.selection.has(row.key + ':' + toPosix(row.file.path))) targets.push({ file: row.file, key: row.key });
		}
		return targets;
	}

	targetsFor(key: ScmGroup, file: ScmChange, groups: ScmGroup[]): ScmChange[] {
		return this.targetRows(key, file, groups).map((target) => target.file);
	}

	async refreshSubmodules(generation: number): Promise<void> {
		let submodules: string[];
		try {
			// A test's (or an older backend build's) defaulting layer may answer `null` rather
			// than throw for a command it does not know: treated the same as no submodules.
			submodules = (await repoSubmodules(this.repoPath!)) ?? [];
		} catch {
			submodules = [];
		}
		if (generation !== this.generation) return;
		this.submodules = submodules;
		// Existing sections keep their message box, collapsed groups and section twistie
		// across a refresh; a submodule no longer present (removed, deinitialised) is dropped
		// and a newly initialised one gets a fresh section.
		const previous = new Map(this.subRepos.map((s) => [s.repoPath, s]));
		this.subRepos = submodules.map((repoPath) => previous.get(repoPath) ?? {
			repoPath,
			changes: [],
			branch: null,
			shortHash: '',
			ahead: 0,
			behind: 0,
			upstream: null,
			message: '',
			collapsed: { merge: false, staged: false, changes: false },
			error: null,
			sectionCollapsed: false
		});
		await Promise.all(this.subRepos.map(async (sub) => {
			try {
				const [changes, head] = await Promise.all([
					scmStatus(sub.repoPath),
					repoHead(sub.repoPath)
				]);
				sub.changes = changes;
				sub.branch = head.branch;
				sub.shortHash = head.shortHash;
				sub.ahead = head.ahead;
				sub.behind = head.behind;
				sub.upstream = head.upstream;
				sub.error = null;
			} catch (error) {
				sub.changes = [];
				sub.error = String(error);
			}
		}));
	}

	declare placeholder: () => string ;

	render(): void {
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
		// The view title stays bare ("Source Control" only): the repository's own header row
		// carries the actions, in the same slot every submodule section's header uses below
		// (after the label, before the badge - hover-revealed, like any pane header's).
		// Whatever an installed extension's manifest places in scm/title's "navigation" group
		// renders inline (its own command icon and title); everything else the manifest places
		// there sits inside "..." (moreMenu below) — exactly VS Code's split.
		const repoPath = this.repoPath;
		const actions: HTMLElement[] = this.extensionTitleButtons(repoPath);
		actions.push(
			actionButton(this.viewMode === 'tree' ? 'list-flat' : 'list-tree', this.viewMode === 'tree' ? 'View as List' : 'View as Tree', () => this.setViewMode(this.viewMode === 'tree' ? 'list' : 'tree')),
			actionButton('refresh', 'Refresh', () => void this.refresh()),
			actionButton('ellipsis', 'More Actions...', (event) => showMenuBelow(event.currentTarget as HTMLElement, this.moreMenu(), 220))
		);
		const header = el('div', 'pane-header scm-main-header', [
			icon('chevron-down', 'twistie'),
			el('span', 'label', [basename(this.repoPath)]),
			el('div', 'actions', actions)
		]);
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
		// Every initialised submodule stacks as its own repository section directly below the
		// main repository's rows, inside the one scrolling list - VS Code's Source Control view
		// with several repositories open: the sections follow the content above them compactly
		// (never pushed to the bottom of the view) and one scrollbar covers everything.
		for (const sub of this.subRepos) this.list.appendChild(this.renderSubRepo(sub));
		if (hadFocus) {
			const input = body.querySelector<HTMLTextAreaElement>('textarea');
			if (input) {
				input.focus();
				if (caret) input.setSelectionRange(caret.start, caret.end);
			}
		}
	}

	declare commitAction: (state: { changes: number; branch: string | null; shortHash: string; ahead: number; behind: number; upstream: string | null }) => 'commit' | 'publish' | 'push' | 'sync' | 'idle' ;

	declare commitBox: () => HTMLElement ;

	declare buildRows: () => ScmRow[] ;

	declare groupActions: (key: ScmGroup, files: ScmChange[]) => HTMLElement[] ;

	renderWindow(): void {
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

	scheduleWindow(): void {
		if (this.scrollFrame !== null) return;
		this.scrollFrame = requestAnimationFrame(() => {
			this.scrollFrame = null;
			this.renderWindow();
		});
	}

	declare rowElement: (row: ScmRow) => HTMLElement ;

	declare setViewMode: (mode: ScmViewMode) => void ;

	declare setSort: (sort: ScmSort) => void ;

	declare moreMenu: () => MenuEntry[] ;

	declare fileRow: (file: ScmChange, key: ScmGroup, depth: number, inTree: boolean) => HTMLElement ;

	extensionTitleButtons(repoPath: string): HTMLElement[] {
		const buttons: HTMLElement[] = [];
		for (const entry of resolvedMenuEntries('scm/title')) {
			if (entry.group !== 'navigation') continue;
			const button = actionButton('', entry.label, () => this.onExtensionCommand?.(entry.command, [{ rootUri: contextUri(repoPath) }]));
			buttons.push(button);
			// The manifest's own icon (a `$(codicon)`, else the package image), the title
			// text staying when neither resolves.
			button.replaceChildren(...commandIconContent(entry, entry.label, extFileDataUrl));
		}
		return buttons;
	}

	declare absolute: (relative: string) => string ;

	declare openChange: (file: ScmChange, key: ScmGroup, letter: string) => void ;

	declare afterCommit: (command: string, args: Record<string, unknown>) => Promise<void> ;

	declare commit: (options?: { amend?: boolean; all?: boolean; stagedOnly?: boolean }, followUp?: (() => Promise<void>) | null) => Promise<void> ;

	declare discard: (file: ScmChange) => Promise<void> ;

	declare confirmDiscardOne: (file: ScmChange) => Promise<boolean> ;

	declare discardChangesOf: (changes: ScmChange[], run: (command: string, args: Record<string, unknown>) => Promise<void>) => Promise<void> ;

	declare discardFiles: (files: ScmChange[]) => Promise<void> ;

	declare discardAll: () => Promise<void> ;

	async run(command: string, args: Record<string, unknown> = {}): Promise<void> {
		try {
			await invoke(command, args);
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
		this.onChanged?.();
	}

	declare subGroups: (sub: SubRepoState) => { key: ScmGroup; label: string; files: ScmChange[]; always: boolean }[] ;

	declare renderSubRepo: (sub: SubRepoState) => HTMLElement ;

	declare subCommitBox: (sub: SubRepoState) => HTMLElement ;

	declare subGroupSection: (sub: SubRepoState, group: { key: ScmGroup; label: string; files: ScmChange[] }) => HTMLElement ;

	declare subFileRow: (sub: SubRepoState, file: ScmChange, key: ScmGroup) => HTMLElement ;

	declare subAbsolute: (sub: SubRepoState, relative: string) => string ;

	declare subOpenChange: (sub: SubRepoState, file: ScmChange, key: ScmGroup, letter: string) => void ;

	declare subCommit: (sub: SubRepoState, options?: { amend?: boolean; all?: boolean; stagedOnly?: boolean }, followUp?: (() => Promise<void>) | null) => Promise<void> ;

	declare subDiscard: (sub: SubRepoState, file: ScmChange) => Promise<void> ;

	declare subDiscardAll: (sub: SubRepoState) => Promise<void> ;

	async subRun(sub: SubRepoState, command: string, args: Record<string, unknown> = {}): Promise<void> {
		try {
			await invoke(command, { ...args, repo: sub.repoPath });
		} catch (error) {
			notify('error', String(error));
		}
		await this.refresh();
		this.onChanged?.();
	}

	declare subMenuRun: (work: () => Promise<void>, done?: string) => Promise<void> ;

	declare subMoreMenu: (sub: SubRepoState) => MenuEntry[] ;
}

