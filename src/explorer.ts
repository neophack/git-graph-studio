// The Explorer view: the folder tree (lazy, with VS Code's indent guides, twisties and
// codicon file/folder icons), git status decorations, the title actions (new file / new
// folder / refresh / collapse all), inline new/rename inputs, and the context menu.

import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { fileIcon, fileIconColor } from './editor';
import { menuSection } from './contributions';
import { actionButton, basename, confirmDialog, el, icon, joinPath, notify, relativeTo, showContextMenu, toPosix, type MenuEntry } from './ui';

interface DirEntryInfo {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
}

/** repo-relative path (forward slashes) -> status letter (M A D R U !), as the SCM view reports it. */
export type StatusMap = Map<string, string>;

const DECORATION_CLASS: Record<string, string> = { M: 'git-modified', A: 'git-added', D: 'git-deleted', R: 'git-renamed', U: 'git-untracked', '!': 'git-conflict' };

export class Explorer {
	private readonly pane: HTMLElement;
	private readonly header: HTMLElement;
	private readonly body: HTMLElement;
	private readonly tree: HTMLElement;
	private rootPath: string | null = null;
	/** Every open root: one entry for a plain folder, one per folder of a workspace (M3 3.8).
	 *  Several roots render a virtual top level - one expandable folder row per root. */
	private rootPaths: string[] = [];
	private status: StatusMap = new Map();
	/** Bumped on setRoot: a listing that started before a folder switch is dropped. */
	private generation = 0;
	private readonly expanded = new Set<string>();
	/** The anchor of the selection - the focused row, where a Shift+click range starts. */
	private selected: string | null = null;
	/** Every selected path, in selection order (Ctrl+click adds, Shift+click replaces with the
	 *  range from the anchor). Always contains the anchor; a plain click collapses it to one. */
	private selection: string[] = [];

	/** The selected entry's absolute path, or null. */
	get selectedPath(): string | null {
		return this.selected;
	}

	/** Every selected path, in selection order (the left/right sides of a compare, and the
	 *  files "Show File History in Git Graph" filters the view to). */
	get selectedPaths(): string[] {
		return [...this.selection];
	}

	private collapsed = false;

	onFileOpened: ((path: string) => void) | null = null;
	/** "Open to the Left/Right/Above/Below": the file opens in that editor layer, which is
	 *  created when missing and disappears again once all its files are closed. */
	onOpenInDirection: ((path: string, direction: 'left' | 'right' | 'up' | 'down') => void) | null = null;
	onOpenFolder: (() => void) | null = null;
	onPathRenamed: ((from: string, to: string) => void) | null = null;
	onPathDeleted: ((path: string) => void) | null = null;
	/** Two selected entries of the same kind asked for a compare (the left one was selected
	 *  first): a Beyond Compare-style file or folder comparison in an editor tab. */
	onCompare: ((left: string, right: string, isDir: boolean) => void) | null = null;
	/** "Open in Integrated Terminal": the shell is asked to cd into the folder. */
	onOpenInTerminal: ((folder: string) => void) | null = null;

	constructor(container: HTMLElement) {
		container.appendChild(el('div', 'sidebar-title', [el('span', 'label', ['Explorer'])]));
		this.pane = el('div', 'view-pane');
		this.header = el('div', 'pane-header');
		this.header.addEventListener('click', () => {
			this.collapsed = !this.collapsed;
			this.render();
		});
		this.body = el('div', 'pane-body list');
		this.body.tabIndex = 0;
		this.tree = el('div', 'tree');
		this.body.appendChild(this.tree);
		this.pane.append(this.header, this.body);
		container.appendChild(this.pane);
		this.body.addEventListener('contextmenu', (event) => {
			if ((event.target as HTMLElement).closest('.row')) return;
			event.preventDefault();
			if (this.rootPath) this.showMenu(event, this.rootPath, true);
		});
		this.body.addEventListener('keydown', (event) => this.onKey(event));
		this.render();
	}

	/** Expanded folders changed (a toggle, collapse all): the workbench snapshots them. */
	onExpandedChange: (() => void) | null = null;
	/** The render of the current root, for `whenRendered`. */
	private rendered: Promise<void> = Promise.resolve();

	/** `expanded` re-expands folders of a previous session, spelled repo-relative as
	 *  `expandedFolders()` reports them. */
	/** Open one or more roots (a workspace passes its folders). The first root stays
	 *  `rootPath` - the single-root seam (menus, the SCM status, reveal) keeps working; a
	 *  multi-root tree adds a virtual level above, one folder row per root. */
	setRoots(roots: string[], expanded: string[] = []): void {
		this.rootPaths = roots;
		if (roots.length <= 1) {
			this.setRoot(roots[0] ?? null, expanded);
			return;
		}
		this.setRoot(roots[0], expanded);
		// The roots sit on the virtual level, always expanded; their contents follow the
		// same expanded-folders machinery as any folder.
		for (const root of roots) this.expanded.add(root);
		this.render();
	}

	setRoot(rootPath: string | null, expanded: string[] = []): void {
		this.rootPath = rootPath;
		this.generation++;
		this.status = new Map(); // the old repo's status letters must not decorate the new tree
		this.expanded.clear();
		if (rootPath) {
			const separator = rootPath.includes('\\') ? '\\' : '/';
			for (const folder of expanded) this.expanded.add(rootPath.replace(/[\\/]+$/, '') + separator + folder.replaceAll('/', separator));
		}
		this.selected = null;
		this.selection = [];
		this.collapsed = false;
		if (rootPath === null) this.rootPaths = [];
		else if (this.rootPaths.length <= 1) this.rootPaths = rootPath ? [rootPath] : [];
		this.render();
	}

	/** Apply a fresh working-tree status to every rendered entry. */
	setStatus(status: StatusMap): void {
		this.status = status;
		if (!this.rootPath) return;
		for (const row of this.tree.querySelectorAll<HTMLElement>('.row[data-path]')) {
			this.decorate(row, row.dataset['path']!, row.dataset['dir'] === '1');
		}
	}

	/** Re-read every expanded level (files changed on disk). The old rows stay on screen
	 *  until each level's fresh listing arrives (renderLevel swaps them in), so refreshing
	 *  never blanks the tree - clearing up front made it flash on every refresh. */
	async refresh(): Promise<void> {
		if (!this.rootPath) return;
		const scrollTop = this.body.scrollTop;
		this.cancelInlineInputs();
		if (this.rootPaths.length > 1) await this.renderRoots();
		else await this.renderLevel(this.tree, this.rootPath, 0);
		this.body.scrollTop = scrollTop;
	}

	/** An inline new/rename input the tree is about to drop must settle (as cancelled), or the
	 *  operation awaiting it hangs forever. */
	private cancelInlineInputs(): void {
		for (const input of this.tree.querySelectorAll<HTMLInputElement>('.inline-input')) {
			// An explicit cancel, not a blur: losing focus would commit a half-typed name.
			input.dispatchEvent(new CustomEvent(INLINE_CANCEL_EVENT));
			if (document.activeElement === input) input.blur();
		}
	}

	/** Expand the folders down to a file and select it (the "reveal" of an opened editor). */
	async reveal(path: string): Promise<void> {
		if (!this.rootPath) return;
		const relative = relativeTo(this.rootPath, path);
		if (relative === path) return;
		const parts = relative.split('/');
		let current = this.rootPath;
		for (const part of parts.slice(0, -1)) {
			current = joinPath(current, part);
			if (!this.expanded.has(current)) {
				this.expanded.add(current);
				const row = this.rowFor(current);
				if (row) await this.renderLevel(this.childrenContainer(row, current), current, Number(row.dataset['depth']) + 1);
				this.updateTwistie(current);
			}
		}
		this.select(path);
		this.rowFor(path)?.scrollIntoView({ block: 'nearest' });
	}

	/* ---------- Rendering ---------- */

	private render(): void {
		this.header.innerHTML = '';
		this.cancelInlineInputs();
		this.tree.innerHTML = '';
		this.body.classList.toggle('collapsed', this.collapsed);
		this.pane.classList.toggle('collapsed', this.collapsed);
		if (!this.rootPath) {
			this.header.hidden = true;
			const welcome = el('div', 'welcome-view', [
				el('p', '', ['You have not yet opened a folder.']),
				(() => {
					const button = el('button', 'button', ['Open Folder']);
					button.addEventListener('click', () => this.onOpenFolder?.());
					return button;
				})(),
				el('p', '', ['Opening a Git repository shows its history in the Git Graph tab, its changes in Source Control, and its files here.'])
			]);
			this.tree.appendChild(welcome);
			return;
		}
		this.header.hidden = false;
		this.header.append(
			icon(this.collapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
			el('span', 'label', [basename(this.rootPath)])
		);
		this.header.title = this.rootPath;
		const actions = el('div', 'actions', [
			actionButton('new-file', 'New File...', () => void this.createInline(this.targetFolder(), false)),
			actionButton('new-folder', 'New Folder...', () => void this.createInline(this.targetFolder(), true)),
			actionButton('refresh', 'Refresh Explorer', () => void this.refresh()),
			actionButton('collapse-all', 'Collapse Folders in Explorer', () => this.collapseAll())
		]);
		this.header.appendChild(actions);
		if (!this.collapsed && this.rootPath) {
			this.rendered = this.rootPaths.length > 1 ? this.renderRoots() : this.renderLevel(this.tree, this.rootPath, 0);
		}
	}

	/** Settles once the tree of the last `setRoot(s)` is on screen (its top level listed and
	 *  every remembered folder re-expanded) - the folder-open boot stamp keys on it. */
	whenRendered(): Promise<void> {
		return this.rendered;
	}

	/** The virtual top level of a multi-root workspace: one expandable folder row per root,
	 *  reconciled like any other level so refreshes keep the rows (and their open groups). */
	private async renderRoots(): Promise<void> {
		const entries: DirEntryInfo[] = this.rootPaths.map((root) => ({
			name: basename(root),
			path: root,
			isDir: true,
			size: 0
		}));
		// Reuse the row machinery by driving the same reconciliation as renderLevel, minus
		// the directory listing: the "listing" here is the root list itself.
		const existing = new Map<string, { row: HTMLElement; group: HTMLElement | null }>();
		for (const child of Array.from(this.tree.children) as HTMLElement[]) {
			if (child.classList.contains('row') && child.dataset['path']) {
				existing.set(child.dataset['path']!, { row: child, group: null });
			} else if (child.classList.contains('children') && child.dataset['parent']) {
				const owner = existing.get(child.dataset['parent']);
				if (owner) owner.group = child;
			}
		}
		const next: HTMLElement[] = [];
		const recurse: Promise<void>[] = [];
		for (const entry of entries) {
			const kept = existing.get(entry.path);
			if (kept) existing.delete(entry.path);
			const row = kept?.row ?? this.makeRow(entry, 0);
			next.push(row);
			let group = kept?.group ?? null;
			if (this.expanded.has(entry.path)) {
				if (!group) {
					group = el('div', 'children');
					group.dataset['parent'] = entry.path;
				}
				next.push(group);
				recurse.push(this.renderLevel(group, entry.path, 1));
			} else if (group) {
				group.remove();
			}
		}
		for (const { row, group } of existing.values()) {
			row.remove();
			group?.remove();
		}
		const unchanged =
			next.length === this.tree.children.length && next.every((node, i) => this.tree.children[i] === node);
		if (unchanged) {
			await Promise.all(recurse);
			return;
		}
		for (const node of next) this.tree.appendChild(node);
		await Promise.all(recurse);
	}

	/** Render one folder's children into `parent`. Refreshes reconcile in place: unchanged rows
	 *  keep their DOM (and their expanded `.children` groups), so re-listing a folder that
	 *  didn't change never flickers — clearing and rebuilding made expanded folders visibly
	 *  collapse and re-expand on every refresh. */
	private async renderLevel(parent: HTMLElement, dirPath: string, depth: number): Promise<void> {
		const generation = this.generation;
		let entries: DirEntryInfo[];
		try {
			entries = await invoke<DirEntryInfo[]>('list_dir', { path: dirPath });
		} catch (error) {
			if (generation !== this.generation) return;
			notify('error', String(error));
			return;
		}
		// The folder switched while the listing was in flight: its rows belong to the old tree.
		if (generation !== this.generation) return;
		const existing = new Map<string, { row: HTMLElement; group: HTMLElement | null }>();
		for (const child of Array.from(parent.children) as HTMLElement[]) {
			if (child.classList.contains('row') && child.dataset['path']) {
				existing.set(child.dataset['path']!, { row: child, group: null });
			} else if (child.classList.contains('children') && child.dataset['parent']) {
				const owner = existing.get(child.dataset['parent']);
				if (owner) owner.group = child;
			}
		}
		const next: HTMLElement[] = [];
		const recurse: Promise<void>[] = [];
		for (const entry of entries) {
			const kept = existing.get(entry.path);
			if (kept) existing.delete(entry.path);
			const row = kept?.row ?? this.makeRow(entry, depth);
			next.push(row);
			const shouldHaveChildren = entry.isDir && this.expanded.has(entry.path);
			let group = kept?.group ?? null;
			if (!shouldHaveChildren) {
				group?.remove();
				continue;
			}
			if (!group) {
				group = el('div', 'children');
				group.dataset['parent'] = entry.path;
			}
			next.push(group);
			recurse.push(this.renderLevel(group, entry.path, depth + 1));
		}
		for (const { row, group } of existing.values()) {
			row.remove();
			group?.remove();
		}
		// Skip DOM mutation entirely when nothing changed — the common case on refresh. The
		// expanded folders beneath re-list either way, and this level settles only once they
		// have: `refresh()` (and `whenRendered`) promise the whole tree, not just its top.
		const unchanged =
			next.length === parent.children.length && next.every((node, i) => parent.children[i] === node);
		if (!unchanged) for (const node of next) parent.appendChild(node);
		await Promise.all(recurse);
	}

	private makeRow(entry: DirEntryInfo, depth: number): HTMLElement {
		const row = el('div', 'row');
		row.dataset['path'] = entry.path;
		row.dataset['dir'] = entry.isDir ? '1' : '0';
		row.dataset['depth'] = String(depth);
		row.title = entry.path;
		row.style.paddingLeft = `${8 + depth * 8}px`;
		for (let level = 0; level < depth; level++) {
			const guide = el('span', 'indent-guide');
			guide.style.left = `${16 + level * 8}px`;
			row.appendChild(guide);
		}
		const expanded = this.expanded.has(entry.path);
		row.appendChild(entry.isDir ? icon(expanded ? 'chevron-down' : 'chevron-right', 'twistie') : el('span', 'twistie'));
		const glyph = icon(entry.isDir ? (expanded ? 'folder-opened' : 'folder') : fileIcon(entry.name));
		if (!entry.isDir) glyph.style.color = fileIconColor(entry.name) ?? '';
		row.appendChild(el('span', 'icon', [glyph]));
		row.appendChild(el('span', 'label', [entry.name]));
		if (this.selection.includes(entry.path)) row.classList.add('selected');
		if (this.selected === entry.path) row.classList.add('focused');
		this.decorate(row, entry.path, entry.isDir);
		row.addEventListener('click', (event) => {
			// Ctrl/Cmd+click toggles one entry, Shift+click takes the range from the anchor -
			// neither opens the file, so a compare pair can be picked without opening either.
			if (event.ctrlKey || event.metaKey) {
				this.toggleSelect(entry.path);
				return;
			}
			if (event.shiftKey) {
				this.rangeSelect(entry.path);
				return;
			}
			this.select(entry.path);
			if (entry.isDir) {
				void this.toggle(entry.path);
			} else {
				this.onFileOpened?.(entry.path);
			}
		});
		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			// Right-clicking into an existing multi-selection keeps it, so the menu can act on
			// the pair; right-clicking outside it collapses to the clicked entry.
			if (this.selection.length < 2 || !this.selection.includes(entry.path)) this.select(entry.path);
			this.showMenu(event, entry.path, entry.isDir);
		});
		return row;
	}

	private decorate(row: HTMLElement, path: string, isDir: boolean): void {
		row.querySelector('.decoration')?.remove();
		row.classList.remove(...Object.values(DECORATION_CLASS));
		if (!this.rootPath) return;
		const relative = relativeTo(this.rootPath, path);
		let letter: string | null = null;
		if (isDir) {
			// A folder carries a dot when anything beneath it changed, coloured by the most
			// significant change (conflicts, then modifications, then new files).
			let best: string | null = null;
			for (const [file, status] of this.status) {
				if (file.startsWith(relative + '/')) {
					if (status === '!') best = '!';
					else if (best !== '!' && (status === 'M' || status === 'D' || status === 'R')) best = 'M';
					else if (best === null) best = 'U';
				}
			}
			if (best) {
				row.classList.add(DECORATION_CLASS[best]!);
				row.appendChild(el('span', 'decoration', ['●']));
			}
			return;
		}
		letter = this.status.get(relative) ?? null;
		if (!letter) return;
		row.classList.add(DECORATION_CLASS[letter] ?? 'git-modified');
		const badge = el('span', 'decoration', [letter]);
		badge.title = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', '!': 'Conflict' }[letter] ?? letter;
		row.appendChild(badge);
	}

	private rowFor(path: string): HTMLElement | null {
		for (const row of this.tree.querySelectorAll<HTMLElement>('.row[data-path]')) {
			if (row.dataset['path'] === path) return row;
		}
		return null;
	}

	private childrenContainer(row: HTMLElement, path: string): HTMLElement {
		const next = row.nextElementSibling as HTMLElement | null;
		if (next && next.classList.contains('children') && next.dataset['parent'] === path) return next;
		const group = el('div', 'children');
		group.dataset['parent'] = path;
		row.after(group);
		return group;
	}

	private updateTwistie(path: string): void {
		const row = this.rowFor(path);
		if (!row) return;
		const expanded = this.expanded.has(path);
		row.querySelector('.twistie')!.className = `codicon codicon-${expanded ? 'chevron-down' : 'chevron-right'} twistie`;
		row.querySelector('.icon')!.innerHTML = '';
		row.querySelector('.icon')!.appendChild(icon(expanded ? 'folder-opened' : 'folder'));
	}

	private async toggle(path: string): Promise<void> {
		const row = this.rowFor(path);
		if (!row) return;
		if (this.expanded.has(path)) {
			this.expanded.delete(path);
			const next = row.nextElementSibling as HTMLElement | null;
			if (next?.classList.contains('children')) next.remove();
		} else {
			this.expanded.add(path);
			await this.renderLevel(this.childrenContainer(row, path), path, Number(row.dataset['depth']) + 1);
		}
		this.updateTwistie(path);
		this.onExpandedChange?.();
	}

	private collapseAll(): void {
		this.expanded.clear();
		this.onExpandedChange?.();
		void this.refresh();
	}

	private select(path: string | null): void {
		this.setSelection(path === null ? [] : [path], path);
	}

	/** Ctrl/Cmd+click: toggle one entry, anchoring it when it joins the selection. */
	private toggleSelect(path: string): void {
		if (this.selection.includes(path)) {
			const rest = this.selection.filter((p) => p !== path);
			this.setSelection(rest, this.selected === path ? rest[rest.length - 1] ?? null : this.selected);
		} else {
			this.setSelection([...this.selection, path], path);
		}
	}

	/** Shift+click: every row from the anchor to the clicked one, in tree order. */
	private rangeSelect(path: string): void {
		const order = Array.from(this.tree.querySelectorAll<HTMLElement>('.row[data-path]')).map((r) => r.dataset['path']!);
		const anchor = this.selected && order.includes(this.selected) ? this.selected : order[0]!;
		const from = Math.min(order.indexOf(anchor), order.indexOf(path));
		const to = Math.max(order.indexOf(anchor), order.indexOf(path));
		this.setSelection(order.slice(from, to + 1), anchor);
	}

	private setSelection(paths: string[], anchor: string | null): void {
		this.selection = paths;
		this.selected = anchor;
		const set = new Set(paths);
		for (const row of this.tree.querySelectorAll<HTMLElement>('.row[data-path]')) {
			row.classList.toggle('selected', set.has(row.dataset['path']!));
			row.classList.toggle('focused', row.dataset['path'] === anchor);
		}
	}

	/** Exactly two selected entries of one kind, the clicked one among them - what the menu's
	 *  compare entry needs. */
	private comparePair(path: string, isDir: boolean): [string, string] | null {
		if (this.selection.length !== 2 || !this.selection.includes(path)) return null;
		return this.selection.every((p) => (this.rowFor(p)?.dataset['dir'] === '1') === isDir)
			? [this.selection[0]!, this.selection[1]!]
			: null;
	}

	/** The folder a "new file" lands in: the selected folder, the selected file's folder, or root. */
	private targetFolder(): string {
		if (!this.selected) return this.rootPath!;
		const row = this.rowFor(this.selected);
		if (row?.dataset['dir'] === '1') return this.selected;
		return this.selected.slice(0, this.selected.length - basename(this.selected).length - 1) || this.rootPath!;
	}

	private onKey(event: KeyboardEvent): void {
		const rows = Array.from(this.tree.querySelectorAll<HTMLElement>('.row[data-path]'));
		if (rows.length === 0) return;
		const index = rows.findIndex((r) => r.dataset['path'] === this.selected);
		const current = index === -1 ? null : rows[index]!;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]!;
			this.select(next.dataset['path']!);
			next.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'ArrowRight' && current?.dataset['dir'] === '1') {
			event.preventDefault();
			// A collapsed folder expands; an expanded one steps into its first child.
			if (!this.expanded.has(current.dataset['path']!)) {
				void this.toggle(current.dataset['path']!);
			} else {
				const child = rows[index + 1];
				if (child && (child.parentElement as HTMLElement).dataset['parent'] === current.dataset['path']) {
					this.select(child.dataset['path']!);
					child.scrollIntoView({ block: 'nearest' });
				}
			}
		} else if (event.key === 'ArrowLeft' && current) {
			event.preventDefault();
			if (current.dataset['dir'] === '1' && this.expanded.has(current.dataset['path']!)) {
				void this.toggle(current.dataset['path']!);
			} else {
				const parent = (current.parentElement as HTMLElement).dataset['parent'];
				if (parent) this.select(parent);
			}
		} else if (event.key === 'Enter' && current) {
			event.preventDefault();
			current.click();
		} else if (event.key === 'F2' && current) {
			event.preventDefault();
			void this.renameInline(current.dataset['path']!);
		} else if (event.key === 'Delete' && current) {
			event.preventDefault();
			void this.delete(current.dataset['path']!, event.shiftKey);
		}
	}

	/** File > New File: an inline input in the selected folder (or the root). */
	newFile(): Promise<void> {
		if (!this.rootPath) return Promise.resolve();
		return this.createInline(this.targetFolder(), false);
	}

	/* ---------- Context menu & operations ---------- */

	private showMenu(event: MouseEvent, path: string, isDir: boolean): void {
		const folder = isDir ? path : path.slice(0, path.length - basename(path).length - 1);
		const isRoot = path === this.rootPath;
		const pair = this.comparePair(path, isDir);
		showContextMenu(event.clientX, event.clientY, [
			...(pair ? [
				{ label: isDir ? 'Compare Two Folders' : 'Compare Two Files', run: () => this.onCompare?.(pair[0], pair[1], isDir) },
				'separator'
			] : []) as MenuEntry[],
				...(isDir ? [] : [
				{ label: 'Open to the Right', run: () => this.onOpenInDirection?.(path, 'right') },
				{ label: 'Open to the Left', run: () => this.onOpenInDirection?.(path, 'left') },
				{ label: 'Open Below', run: () => this.onOpenInDirection?.(path, 'down') },
				{ label: 'Open Above', run: () => this.onOpenInDirection?.(path, 'up') },
				'separator'
			] as MenuEntry[]),
			{ label: 'New File...', run: () => void this.createInline(folder, false) },
			{ label: 'New Folder...', run: () => void this.createInline(folder, true) },
			'separator',
			{ label: 'Reveal in File Explorer', run: () => void revealItemInDir(path).catch((e) => notify('error', String(e))) },
			...(isDir ? [{ label: 'Open in Integrated Terminal', run: () => this.onOpenInTerminal?.(path) }] : []),
			'separator',
			{ label: 'Copy Path', keybinding: 'Shift+Alt+C', run: () => void writeText(path) },
			{ label: 'Copy Relative Path', keybinding: 'Ctrl+K Ctrl+Shift+C', run: () => void writeText(relativeTo(this.rootPath!, path)) },
			'separator',
			{ label: 'Rename...', keybinding: 'F2', disabled: isRoot, run: () => void this.renameInline(path) },
			{ label: 'Delete', keybinding: 'Delete', disabled: isRoot, run: () => void this.delete(path) },
			// Extensions' `contributes.menus["explorer/context"]` entries.
			...menuSection('explorer/context')
		]);
	}

	/** An inline input row under `folder` (expanded first), like VS Code's new file/folder. */
	private async createInline(folder: string, isDir: boolean): Promise<void> {
		if (!this.rootPath) return;
		let container: HTMLElement = this.tree;
		let depth = 0;
		if (folder !== this.rootPath) {
			const row = this.rowFor(folder);
			if (!row) return;
			if (!this.expanded.has(folder)) await this.toggle(folder);
			container = this.childrenContainer(row, folder);
			depth = Number(row.dataset['depth']) + 1;
		}
		const row = el('div', 'row');
		row.style.paddingLeft = `${8 + depth * 8}px`;
		const placeholder = icon(isDir ? 'folder' : 'file');
		row.append(el('span', 'twistie'), el('span', 'icon', [placeholder]));
		const input = el('input', 'inline-input');
		input.type = 'text';
		input.spellcheck = false;
		row.appendChild(input);
		if (!isDir) input.addEventListener('input', () => {
			placeholder.style.color = fileIconColor(input.value) ?? '';
		});
		container.prepend(row);
		input.focus();
		const value = await inlineInput(input, (name) => this.validateName(folder, name));
		row.remove();
		if (value === null) return;
		const target = joinPath(folder, value);
		try {
			await invoke(isDir ? 'create_folder' : 'create_file', { path: target });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		await this.refresh();
		this.select(target);
		if (!isDir) this.onFileOpened?.(target);
	}

	private async renameInline(path: string): Promise<void> {
		const row = this.rowFor(path);
		if (!row || path === this.rootPath) return;
		const label = row.querySelector<HTMLElement>('.label')!;
		const input = el('input', 'inline-input');
		input.type = 'text';
		input.spellcheck = false;
		input.value = basename(path);
		label.replaceWith(input);
		input.focus();
		const stem = input.value.lastIndexOf('.');
		input.setSelectionRange(0, row.dataset['dir'] === '1' || stem <= 0 ? input.value.length : stem);
		const folder = path.slice(0, path.length - basename(path).length - 1);
		// The entry's own name never collides with itself: a case-only rename (readme.md ->
		// README.md) is a rename, not a clash with an existing file.
		const value = await inlineInput(input, (name) => (name === basename(path) ? null : this.validateName(folder, name, basename(path))));
		input.replaceWith(label);
		if (value === null || value === basename(path)) return;
		const target = joinPath(folder, value);
		try {
			await invoke('rename_path', { from: path, to: target });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		this.rekeyExpanded(path, target);
		this.onPathRenamed?.(path, target);
		await this.refresh();
		this.select(target);
	}

	/** A renamed folder keeps its expanded state (and that of the folders beneath it): the
	 *  expanded set is keyed by path, so the old spellings are moved to the new ones. A
	 *  deleted folder (`to` null) just drops out, so stale paths never reach the snapshot. */
	private rekeyExpanded(from: string, to: string | null): void {
		const prefix = toPosix(from) + '/';
		for (const expanded of [...this.expanded]) {
			if (expanded !== from && !toPosix(expanded).startsWith(prefix)) continue;
			this.expanded.delete(expanded);
			if (to !== null) this.expanded.add(to + expanded.slice(from.length));
		}
		this.onExpandedChange?.();
	}

	/** VS Code's delete: to the Recycle Bin by default (Shift+Delete, or a Recycle Bin that
	 *  refuses, deletes permanently), with VS Code's prompts. */
	private async delete(path: string, permanent = false): Promise<void> {
		if (path === this.rootPath) return;
		const isDir = this.rowFor(path)?.dataset['dir'] === '1';
		const name = basename(path);
		const what = `'${name}'${isDir ? ' and its contents' : ''}`;
		const confirmed = permanent
			? await confirmDialog(`Are you sure you want to permanently delete ${what}? This action is irreversible!`, 'Delete Permanently')
			: await confirmDialog(`Are you sure you want to delete ${what}? You can restore this ${isDir ? 'folder' : 'file'} from the Recycle Bin.`, 'Move to Recycle Bin');
		if (!confirmed) return;
		try {
			await invoke('delete_path', { path, permanent });
		} catch (error) {
			if (permanent) {
				notify('error', String(error));
				return;
			}
			// The Recycle Bin refused (a network share, a path it cannot handle): offer the
			// permanent delete instead, as VS Code does - one more confirmation, no re-prompt.
			const retry = await confirmDialog(`Failed to delete ${what} using the Recycle Bin. Do you want to permanently delete instead?`, 'Delete Permanently', 'error');
			if (!retry) return;
			try {
				await invoke('delete_path', { path, permanent: true });
			} catch (again) {
				notify('error', String(again));
				return;
			}
		}
		if (isDir) this.rekeyExpanded(path, null);
		await this.onPathDeleted?.(path);
		await this.refresh();
	}

	/** `except` is the entry being renamed: its own current name is not a collision. */
	private validateName(folder: string, name: string, except: string | null = null): string | null {
		if (name.trim() === '') return 'A file or folder name must be provided.';
		if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || name === '.' || name === '..' || name.endsWith(' ') || name.endsWith('.')) return `The name ${name} is not valid as a file or folder name.`;
		const existing = Array.from(this.childrenNames(folder)).filter((n) => n !== except);
		if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) return `A file or folder ${name} already exists at this location.`;
		return null;
	}

	private *childrenNames(folder: string): Iterable<string> {
		const container = folder === this.rootPath ? this.tree : (this.rowFor(folder)?.nextElementSibling as HTMLElement | null);
		if (!container) return;
		for (const row of container.querySelectorAll<HTMLElement>(':scope > .row[data-path]')) {
			yield basename(row.dataset['path']!);
		}
	}

	/** Every folder currently expanded, spelled repo-relative, for callers that mirror the tree. */
	expandedFolders(): string[] {
		return this.rootPath ? Array.from(this.expanded).map((p) => toPosix(relativeTo(this.rootPath!, p))) : [];
	}
}

/** The tree asks its inline inputs to give up (a refresh or re-render drops their rows). */
const INLINE_CANCEL_EVENT = 'inline-cancel';

/** Resolve with the input's value on Enter (when valid), null on Escape or a tree-side cancel.
 *  Losing focus commits a valid name and cancels an empty or invalid one - VS Code's explorer
 *  input box. */
function inlineInput(input: HTMLInputElement, validate: (name: string) => string | null): Promise<string | null> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: string | null) => {
			if (done) return;
			done = true;
			input.removeEventListener('blur', onBlur);
			resolve(value);
		};
		const onBlur = () => finish(input.value.trim() !== '' && validate(input.value) === null ? input.value : null);
		input.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				const error = validate(input.value);
				if (error) {
					input.title = error;
					input.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
					notify('error', error);
					return;
				}
				finish(input.value);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(null);
			}
		});
		input.addEventListener('blur', onBlur);
		input.addEventListener(INLINE_CANCEL_EVENT, () => finish(null));
	});
}
