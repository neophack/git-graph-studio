// The editor area: a grid of editor groups, built like VS Code's editor grid (M3 3.1). The
// layout is a tree of split nodes (`x` = side-by-side, `y` = stacked) whose leaves are
// `EditorGroup`s; directions (left/right/up/down) walk the tree, so a group always opens in
// the neighbouring layer when one exists and otherwise a new split is created at the edge.
// `EditorGroup` stays a self-contained tab strip plus pane stack; this class owns the layout
// around any number of them and is the workbench's facade - the focused group answers
// everything that concerns "the" editor, the whole area answers what spans groups (saving,
// closing, path renames).

import { EditorGroup, askToSaveMany, tabDrag, type EditorInput } from './editor';
import type { EditorGridCell } from './state';
import { el } from './ui';
import type { EditorView } from '@codemirror/view';

/** One editor group in the grid: its box element and its group. */
interface GroupBox {
	el: HTMLElement;
	group: EditorGroup;
}

/** A grid leaf: one editor group. */
interface LeafNode {
	kind: 'leaf';
	box: GroupBox;
}

/** A grid split: children laid out along an axis, each owning a share of the space. */
interface SplitNode {
	kind: 'split';
	axis: 'x' | 'y';
	children: Node[];
	/** Proportions that sum to 1, one per child. */
	sizes: number[];
}

type Node = LeafNode | SplitNode;

type Direction = 'left' | 'right' | 'up' | 'down';

/** The focused group's active editor, as the status bar and snapshots read it. */
export type ActiveEditorInfo = Parameters<NonNullable<EditorGroup['onActiveChange']>>[0];

export class EditorArea {
	private readonly container: HTMLElement;
	/** Assigned in the constructor; until then a group's first `update()` (fired by the
	 *  render-welcome wiring) must not touch the tree, hence the tolerant `leaves`. */
	private root!: Node;
	private focused: GroupBox | null = null;
	/** While a session restore builds the layout and opens files into it, empty groups must
	 *  not collapse - the layers are about to receive their files. */
	private holdingEmpty = false;
	/** The next group index number, for "Focus nth Editor Group" (Ctrl+1/2/3). */

	onActiveChange: ((editor: ActiveEditorInfo | null) => void) | null = null;
	onNavigationChange: (() => void) | null = null;
	/** Any group's set of tabs changed: the workbench snapshots the session. */
	onTabsChange: (() => void) | null = null;
	onFileSaved: ((path: string) => void) | null = null;
	onMergeResolved: (() => void) | null = null;
	onExternalFileChange: (() => void) | null = null;
	private welcomeRenderer: ((container: HTMLElement) => void) | null = null;
	/** The welcome-page renderer, late-assigned by the workbench: setting it re-renders every
	 *  group that is showing the welcome page, so a freshly-built shell does not sit blank. */
	set renderWelcome(renderer: ((container: HTMLElement) => void) | null) {
		this.welcomeRenderer = renderer;
		for (const leaf of this.leaves()) {
			if (leaf.box.group.activeInput === null) leaf.box.group.update();
		}
	}
	get renderWelcome(): ((container: HTMLElement) => void) | null {
		return this.welcomeRenderer;
	}
	renderHelp: ((help: 'welcome' | 'shortcuts', container: HTMLElement) => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		container.classList.add('editor-area');
		this.root = { kind: 'leaf', box: this.makeBox() };
		this.render();
		this.reassignWelcome();
		this.focus(this.leaves()[0]!.box);
	}

	/** The one graph iframe, remembered so groups split later receive it too - a group
	 *  without it could never open the Git Graph tab (only one graph tab exists at a time;
	 *  `openGraph` below activates the existing tab wherever it lives). */
	private graphFrame: HTMLElement | null = null;

	set graphElement(element: HTMLElement | null) {
		this.graphFrame = element;
		for (const leaf of this.leaves()) leaf.box.group.graphElement = element;
	}

	/** The groups in visual order (depth-first, left to right, top to bottom). */
	groups(): EditorGroup[] {
		return this.leaves().map((leaf) => leaf.box.group);
	}

	groupAt(index: number): EditorGroup {
		const groups = this.groups();
		return groups[Math.min(index, groups.length - 1)]!;
	}

	get groupCount(): number {
		return this.leaves().length;
	}

	/** The group commands act on: the focused one, or the first. */
	get activeGroup(): EditorGroup {
		return this.focused?.group ?? this.groups()[0]!;
	}

	get focusedIndex(): number {
		return Math.max(0, this.leaves().findIndex((leaf) => leaf.box === this.focused));
	}

	/* ---------- Directions, splitting and focusing ---------- */

	/** Open a file in the neighbouring layer - left, right, above or below - creating that
	 *  layer at the edge when it does not exist yet, as VS Code's grid does. This is how
	 *  layers are meant to appear: from a file's context menu, never as an empty split. */
	openInDirection(path: string, direction: Direction): void {		if (this.groupCount >= 8) {
			void this.activeGroup.openFile(path);
			return;
		}
		const source = this.leafOfBox(this.focused) ?? this.leaves()[0]!;
		let target = this.neighbor(source, direction);
		if (!target) {
			target = this.insertBeside(source, direction);
			this.render();
		}
		this.focus(target.box);
		void target.box.group.openFile(path);
	}

	/** VS Code's Split Editor (Ctrl+\): a new group to the right of the focused one, showing
	 *  the same file again (an empty group when nothing splittable is active). */
	splitEditor(direction: 'right' | 'down' = 'right'): void {
		const input = this.activeGroup.activeInput;
		const group = this.split(direction);
		if (input?.kind === 'file') void group.openFile(input.path);
	}

	/** Split the focused group: right (a group beside it) or down (a group beneath it). The
	 *  new group is empty, focused, and takes half of the source's space. Returns the new
	 *  group. Used by session restore; live splits come from `openInDirection`. */
	split(direction: 'right' | 'down'): EditorGroup {
		// A cap, like VS Code's editor-group limit: unbounded splits made the area grow past
		// the window (220px minimum each) and push the whole layout off-screen.
		if (this.groupCount >= 8) return this.activeGroup;
		const source = this.leafOfBox(this.focused) ?? this.leaves()[0]!;
		const fresh = this.insertBeside(source, direction);
		this.render();
		this.focus(fresh.box);
		return fresh.box.group;
	}

	/** The nearest leaf in a direction, as VS Code's grid neighbour lookup: walk up from the
	 *  leaf until an ancestor splits along that direction's axis with a child further that
	 *  way, then descend taking the boundary-most child at every level. */
	private neighbor(from: LeafNode, direction: Direction): LeafNode | null {
		const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
		const forward = direction === 'right' || direction === 'down';
		let current: Node = from;
		for (;;) {
			const parent = this.parentOf(current);
			if (!parent) return null;
			const next = parent.children.indexOf(current) + (forward ? 1 : -1);
			if (parent.axis === axis && next >= 0 && next < parent.children.length) {
				return this.edgeLeaf(parent.children[next]!, forward);
			}
			current = parent;
		}
	}

	/** The boundary-most leaf below a node: first child going forward, last going back. */
	private edgeLeaf(node: Node, forward: boolean): LeafNode {
		while (node.kind === 'split') node = node.children[forward ? 0 : node.children.length - 1]!;
		return node;
	}

	/** Create a new leaf beside an existing one. The new group takes half of the source's
	 *  space, from the source's neighbours when it sits at a split's edge, else by wrapping
	 *  the source in a fresh split - either way only the source loses width/height. */
	private insertBeside(source: LeafNode, direction: Direction): LeafNode {
		const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
		const forward = direction === 'right' || direction === 'down';
		const fresh: LeafNode = { kind: 'leaf', box: this.makeBox() };
		const parent = this.parentOf(source);
		const index = parent ? parent.children.indexOf(source) : -1;
		if (parent && parent.axis === axis) {
			const atEdge = forward ? index === parent.children.length - 1 : index === 0;
			if (atEdge) {
				// A sibling at the split's edge: the newcomer takes half of the source's share.
				parent.sizes[index]! /= 2;
				parent.sizes.splice(forward ? index + 1 : index, 0, parent.sizes[index]!);
				parent.children.splice(forward ? index + 1 : index, 0, fresh);
				return fresh;
			}
		}
		const split: SplitNode = {
			kind: 'split',
			axis,
			children: forward ? [source, fresh] : [fresh, source],
			sizes: [0.5, 0.5]
		};
		this.replaceNode(source, split);
		return fresh;
	}

	/** Focus the active group's active editor view (F6's cycle stops here). */
	focusActiveEditor(): void {
		this.activeGroup.activeView?.focus();
	}

	/** Focus the nth group (Ctrl+1/2/3, 0-based). */
	focusIndex(index: number): void {
		const leaves = this.leaves();
		if (index >= 0 && index < leaves.length) this.focus(leaves[index]!.box);
	}

	private focus(box: GroupBox): void {
		this.focused = box;
		for (const leaf of this.leaves()) leaf.box.el.classList.toggle('focused', leaf.box === box);
		this.collapseEmptyGroups(box);
		// The status bar follows the newly focused group's active editor.
		box.group.emitActive();
		this.onTabsChange?.();
	}

	/** Remove every group that holds no editors, so a layer disappears once its last file is
	 *  closed and the survivors take the space back. `keep` (the box being focused) is spared,
	 *  so a freshly split group survives until it is left empty by a close. The welcome page
	 *  is not a reason to keep a pane: `reassignWelcome` moves it to the first survivor. */
	private collapseEmptyGroups(keep?: GroupBox): void {
		if (this.holdingEmpty || this.groupCount <= 1) return;
		for (const leaf of [...this.leaves()]) {
			if (leaf.box !== keep && leaf.box.group.openEditorIds().length === 0) this.removeLeaf(leaf);
		}
		if (!this.focused) {
			const first = this.leaves()[0]!;
			this.focused = first.box;
			first.box.el.classList.add('focused');
			first.box.group.emitActive();
		}
	}

	/** The first group carries the welcome page; when groups collapse back to one, that one
	 *  group takes the welcome back. */
	private reassignWelcome(): void {
		const leaves = this.leaves();
		for (const [index, leaf] of leaves.entries()) leaf.box.group.showWelcome = index === 0;
		if (leaves.length > 0 && leaves[0]!.box.group.activeInput === null) leaves[0]!.box.group.update();
	}

	private removeLeaf(leaf: LeafNode): void {
		const parent = this.parentOf(leaf);
		if (!parent) return;
		const index = parent.children.indexOf(leaf);
		parent.children.splice(index, 1);
		parent.sizes.splice(index, 1);
		if (parent.children.length === 1) this.hoist(parent);
		if (this.focused === leaf.box) this.focused = null;
		leaf.box.group.dispose();
		this.render();
		this.reassignWelcome();
	}

	/** A split with one child left is meaningless: replace it with that child, cascading. */
	private hoist(node: SplitNode): void {
		const only = node.children[0]!;
		const parent = this.parentOf(node);
		if (!parent) this.root = only;
		else {
			parent.children[parent.children.indexOf(node)] = only;
			if (parent.children.length === 1) this.hoist(parent);
		}
	}

	/* ---------- Tree helpers ---------- */

	private leaves(node: Node | undefined = this.root): LeafNode[] {
		if (!node) return [];
		if (node.kind === 'leaf') return [node];
		return node.children.flatMap((child) => this.leaves(child));
	}

	private leafOfBox(box: GroupBox | null): LeafNode | null {
		return box ? (this.leaves().find((leaf) => leaf.box === box) ?? null) : null;
	}

	private parentOf(target: Node): SplitNode | null {
		const search = (node: Node): SplitNode | null => {
			if (node.kind === 'leaf') return null;
			if (node.children.includes(target)) return node;
			return node.children.flatMap((child) => search(child))[0] ?? null;
		};
		return search(this.root);
	}

	private replaceNode(target: Node, replacement: Node): void {
		const parent = this.parentOf(target);
		if (!parent) this.root = replacement;
		else parent.children[parent.children.indexOf(target)] = replacement;
	}

	/* ---------- Layout rendering and sashes ---------- */

	private makeBox(): GroupBox {
		const elBox = el('div', 'editor-group-box');
		const group = new EditorGroup(elBox.appendChild(el('div', 'editor-group-container')));
		group.graphElement = this.graphFrame;
		// The first group owns the welcome page; `reassignWelcome` sorts that out after the
		// tree change, so a box is created welcome-less here (the tree may not exist yet).
		group.showWelcome = false;
		const box: GroupBox = { el: elBox, group };
		this.wire(group, elBox);
		return box;
	}

	/** Rebuild the DOM from the layout tree. The panes themselves (each group's tab strip and
	 *  editors) are moved, not recreated. */
	private render(): void {
		this.container.textContent = '';
		this.renderNode(this.root, this.container);
		if (this.focused) this.focused.el.classList.add('focused');
	}

	private renderNode(node: Node, host: HTMLElement): void {
		if (node.kind === 'leaf') {
			host.appendChild(node.box.el);
			return;
		}
		const splitEl = el('div', node.axis === 'x' ? 'editor-area-row' : 'editor-area-col');
		host.appendChild(splitEl);
		node.children.forEach((child, index) => {
			if (index > 0) splitEl.appendChild(this.makeSash(node, index));
			// The wrapper owns the child's share of the split; the child itself just fills it.
			const childHost = el('div', 'editor-split-child');
			childHost.style.flexGrow = String(node.sizes[index]!);
			splitEl.appendChild(childHost);
			this.renderNode(child, childHost);
		});
	}

	/** A sash between two neighbouring children of a split: dragging transfers share between
	 *  them, clamped so neither side can be pushed under 15% of the pair. The sibling
	 *  wrappers are reached through the DOM (the sash sits between them), so a render while
	 *  the drag is coalescing still updates the right elements. */
	private makeSash(split: SplitNode, rightIndex: number): HTMLElement {
		const axis = split.axis;
		return this.sash(axis === 'x' ? 'vertical' : 'horizontal', (sash, delta) => {
			const bounds = sash.parentElement?.getBoundingClientRect();
			const span = Math.max(1, axis === 'x' ? (bounds?.width ?? 0) : (bounds?.height ?? 0));
			const left = split.sizes[rightIndex - 1]!;
			const right = split.sizes[rightIndex]!;
			const total = left + right;
			// Dragging the divider towards a side hands space to that side: a positive delta
			// (right/down) shrinks the `rightIndex` child's share. The delta is a fraction of
			// the whole split's span; the share is a fraction of this pair's `total` - with
			// three or more children the pair is not the whole split.
			const share = Math.max(0.15, Math.min(0.85, right / total - delta / (span * total)));
			split.sizes[rightIndex]! = share * total;
			split.sizes[rightIndex - 1]! = (1 - share) * total;
			const before = sash.previousElementSibling as HTMLElement | null;
			const after = sash.nextElementSibling as HTMLElement | null;
			if (before) before.style.flexGrow = String(split.sizes[rightIndex - 1]!);
			if (after) after.style.flexGrow = String(split.sizes[rightIndex]!);
		});
	}

	/** The drag handle itself: ew-resize (vertical sash) or ns-resize (horizontal sash). The
	 *  moves are coalesced to one apply per animation frame, as the workbench's sashes are -
	 *  each apply reflows the editors (CodeMirror re-measures), which must not run per
	 *  mousemove event. */
	private sash(axis: 'vertical' | 'horizontal', onMove: (sash: HTMLElement, delta: number) => void): HTMLElement {
		const sash = el('div', `editor-sash ${axis}`);
		sash.addEventListener('mousedown', (event) => {
			event.preventDefault();
			const origin = axis === 'vertical' ? event.clientX : event.clientY;
			let latest = origin;
			let applied = 0;
			let pending = 0;
			sash.classList.add('active');
			// The same marker the workbench's sashes set: git refreshes defer to after the drag.
			document.body.classList.add('resizing');
			const raf = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => window.setTimeout(callback, 16) as unknown as number);
			const apply = (): void => {
				pending = 0;
				onMove(sash, latest - origin - applied);
				applied = latest - origin;
			};
			const move = (e: MouseEvent): void => {
				latest = axis === 'vertical' ? e.clientX : e.clientY;
				if (pending) return;
				pending = raf(apply);
			};
			const up = () => {
				if (pending) {
					window.cancelAnimationFrame?.(pending);
					apply();
				}
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				sash.classList.remove('active');
				document.body.classList.remove('resizing');
				this.onTabsChange?.();
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
		return sash;
	}

	/* ---------- Group wiring ---------- */

	private wire(group: EditorGroup, boxEl: HTMLElement): void {
		group.onFocus = () => {
			const leaf = this.leafOfBox(this.leafBoxOf(group));
			if (leaf) this.focus(leaf.box);
		};
		group.onActiveChange = (editor) => {
			if (this.focused?.group === group) this.onActiveChange?.(editor);
		};
		group.onNavigationChange = () => {
			if (this.focused?.group === group) this.onNavigationChange?.();
		};
		group.onTabsChange = () => {
			this.collapseEmptyGroups();
			this.onTabsChange?.();
		};
		group.onFileSaved = (path) => this.onFileSaved?.(path);
		group.onMergeResolved = () => this.onMergeResolved?.();
		group.onExternalFileChange = () => this.onExternalFileChange?.();
		group.onOpenPreviewToSide = (path) => void this.openMarkdownPreviewToSide(path);
		group.renderWelcome = (container) => this.renderWelcome?.(container);
		group.renderHelp = (help, container) => this.renderHelp?.(help, container);
		// A tab dragged from another group drops here (the payload lives in `tabDrag`).
		boxEl.addEventListener('dragover', (event) => {
			if (tabDrag.editor && tabDrag.groupId !== group.groupId) {
				event.preventDefault();
				boxEl.classList.add('drop-target');
			}
		});
		boxEl.addEventListener('dragleave', () => boxEl.classList.remove('drop-target'));
		boxEl.addEventListener('drop', (event) => {
			boxEl.classList.remove('drop-target');
			const editor = tabDrag.editor;
			const fromId = tabDrag.groupId;
			tabDrag.editor = null;
			tabDrag.groupId = null;
			if (!editor || fromId === null || fromId === group.groupId) return;
			event.preventDefault();
			const from = this.groups().find((g) => g.groupId === fromId);
			if (!from || !from.moveOut(editor)) return;
			group.moveIn(editor);
		});
	}

	/** The box element a group lives in, for focus lookups. */
	private leafBoxOf(group: EditorGroup): GroupBox | null {
		return this.leaves().find((leaf) => leaf.box.group === group)?.box ?? null;
	}

	/* ---------- The facade the workbench talks to ---------- */

	get activeInput(): EditorInput | null {
		return this.activeGroup.activeInput;
	}

	get activeView(): EditorView | null {
		return this.activeGroup.activeView;
	}

	setRoot(rootPath: string | null): void {
		for (const group of this.groups()) group.setRoot(rootPath);
	}

	/** The Git Graph tab is one shared iframe: open it wherever it already is, else in the
	 *  focused group. */
	openGraph(): void {
		const holder = this.groups().find((g) => g.isGraphOpen());
		if (holder) holder.openGraph();
		else this.activeGroup.openGraph();
	}

	isGraphOpen(): boolean {
		return this.groups().some((g) => g.isGraphOpen());
	}

	/** The open file tabs of every group, in visual order (what a relaunch reopens). */
	openFilePaths(): string[] {
		return this.groups().flatMap((g) => g.openFilePaths());
	}

	/** Per-group file sessions, for the workspace snapshot's group layout. Groups without
	 *  file tabs are dropped: restoring them would conjure empty splits out of nowhere. */
	groupSessions(): { files: string[]; active: string | null }[] {
		return this.groups()
			.filter((group) => this.hasSession(group))
			.map((group) => ({
				files: group.openFilePaths(),
				active: group.activeInput?.kind === 'file' ? group.activeInput.path : null
			}));
	}

	/** The grid as a serialisable tree, its leaves numbered in the same visual order
	 *  `groupSessions` lists the groups in. Groups `groupSessions` drops (no file tabs - a
	 *  group holding only the graph, a hex view or a preview) leave the tree too, and a
	 *  split left with one child collapses into it: the cell numbers must line up with the
	 *  sessions, or the restore opens each session's files in the wrong pane. `null` for a
	 *  layout with at most one session-bearing group. */
	gridLayout(): EditorGridCell | null {
		let counter = 0;
		const serialise = (node: Node): EditorGridCell | null => {
			if (node.kind === 'leaf') return this.hasSession(node.box.group) ? { group: counter++ } : null;
			const kept: { cell: EditorGridCell; size: number }[] = [];
			node.children.forEach((child, index) => {
				const cell = serialise(child);
				if (cell) kept.push({ cell, size: node.sizes[index]! });
			});
			if (kept.length === 0) return null;
			if (kept.length === 1) return kept[0]!.cell;
			const total = kept.reduce((sum, entry) => sum + entry.size, 0) || 1;
			return { axis: node.axis, sizes: kept.map((entry) => entry.size / total), children: kept.map((entry) => entry.cell) };
		};
		const cell = serialise(this.root);
		return counter <= 1 ? null : cell;
	}

	/** Whether `groupSessions` records the group: it holds file tabs (or a file is active). */
	private hasSession(group: EditorGroup): boolean {
		return group.openFilePaths().length > 0 || group.activeInput?.kind === 'file';
	}

	/** Rebuild the grid from a serialised layout, for session restore. Returns the groups in
	 *  the order the cells were numbered - the same order as the snapshot's `groups` - so the
	 *  caller opens each session's files into its group. Call `restoringLayout` around the
	 *  whole restore, or the still-empty layers collapse before their files arrive. */
	applyGridLayout(cell: EditorGridCell | null): EditorGroup[] {
		this.holdingEmpty = true;
		const first = this.leaves()[0]!; // the boot group, reused as cell 0
		// Every group the rebuild replaces is destroyed, not just dropped from the tree.
		for (const leaf of this.leaves()) {
			if (leaf.box !== first.box) leaf.box.group.dispose();
		}
		const created: GroupBox[] = [];
		const build = (node: EditorGridCell): Node => {
			if ('group' in node) {
				const box = created.length === 0 ? first.box : this.makeBox();
				created.push(box);
				return { kind: 'leaf', box };
			}
			if (node.children.length === 0) return { kind: 'leaf', box: first.box };
			return { kind: 'split', axis: node.axis, sizes: [...node.sizes], children: node.children.map(build) };
		};
		this.root = cell ? build(cell) : first;
		this.render();
		this.reassignWelcome();
		this.focus(created[0] ?? first.box);
		return created.map((box) => box.group);
	}

	/** While true, layers without editors are kept: a session restore builds the layout
	 *  first and opens the files into it afterwards. */
	set restoringLayout(restoring: boolean) {
		this.holdingEmpty = restoring;
		if (!restoring) this.collapseEmptyGroups();
	}

	hasDirtyEditors(): boolean {
		return this.groups().some((g) => g.hasDirtyEditors());
	}

	async saveAll(): Promise<void> {
		for (const group of this.groups()) await group.saveAll();
	}

	async closeAll(): Promise<boolean> {
		// Groups shrink as they empty; walk a stable copy of the list. Several dirty files
		// across the groups get one prompt (VS Code's), answered for all of them at once.
		const groups = [...this.groups()];
		const dirty = groups.flatMap((group) => group.dirtyLabels());
		if (dirty.length > 1) {
			const choice = await askToSaveMany(dirty);
			if (choice === 'cancel') return false;
			for (const group of groups) if (!(await group.settleDirty(choice))) return false;
		}
		for (const group of groups) {
			if (!(await group.closeAll())) return false;
		}
		return true;
	}

	pathRenamed(from: string, to: string): void {
		for (const group of this.groups()) group.pathRenamed(from, to);
	}

	async pathDeleted(path: string): Promise<void> {
		for (const group of [...this.groups()]) await group.pathDeleted(path);
	}

	onWindowBlur(): void {
		for (const group of this.groups()) group.onWindowBlur();
	}

	async reloadIfClean(path: string): Promise<void> {
		for (const group of this.groups()) await group.reloadIfClean(path);
	}

	/** Everything else concerns the focused group's active editor. */
	openFile = (path: string, options?: { line?: number; column?: number }) => this.activeGroup.openFile(path, options);
	openDiff = (input: Extract<EditorInput, { kind: 'diff' }>) => this.activeGroup.openDiff(input);
	openRevision = (revision: string, path: string, title: string, repo?: string) => this.activeGroup.openRevision(revision, path, title, repo);
	openHelp = (help: 'welcome' | 'shortcuts') => this.activeGroup.openHelp(help);
	openHex = (path?: string) => this.activeGroup.openHex(path);
	openMarkdownPreview = (path?: string) => this.activeGroup.openMarkdownPreview(path);
	openMarkdownPreviewToSide = (path?: string) => {
		// The path is captured before the split: the fresh group is empty and focused, so
		// the preview's "active file" default would find nothing there.
		const target = path ?? (this.activeInput?.kind === 'file' ? this.activeInput.path : '');
		if (!target) return Promise.resolve();
		return this.split('right').openMarkdownPreview(target);
	};
	openFileHistory = (path?: string) => this.activeGroup.openFileHistory(path);
	openCompare = (input: Extract<EditorInput, { kind: 'compare' }>) => this.activeGroup.openCompare(input);
	openFolderCompare = (input: Extract<EditorInput, { kind: 'folders' }>) => this.activeGroup.openFolderCompare(input);
	toggleBlame = () => this.activeGroup.toggleBlame();
	/** Back / forward follow the focused group; if it cannot go further, a group that can
	 *  answers instead (the history lives per group, the buttons do not). */
	goBack(): void {
		if (this.activeGroup.canGoBack()) this.activeGroup.goBack();
		else this.groups().find((g) => g.canGoBack())?.goBack();
	}
	goForward(): void {
		if (this.activeGroup.canGoForward()) this.activeGroup.goForward();
		else this.groups().find((g) => g.canGoForward())?.goForward();
	}
	canGoBack = (): boolean => this.groups().some((g) => g.canGoBack());
	canGoForward = (): boolean => this.groups().some((g) => g.canGoForward());
	activateNext = (direction: 1 | -1) => this.activeGroup.activateNext(direction);
	close = () => this.activeGroup.close();
	save = () => this.activeGroup.save();
	runEditorCommand = (command: 'undo' | 'redo' | 'selectAll' | 'find') => this.activeGroup.runEditorCommand(command);
	goToDefinition = () => this.activeGroup.goToDefinition();
	findReferences = () => this.activeGroup.findReferences();
	openCallTreeAtCursor = () => this.activeGroup.openCallTreeAtCursor();
	openSymbolDatabase = () => this.activeGroup.openSymbolDatabase();
	gotoSymbolInFile = () => this.activeGroup.gotoSymbolInFile();
	lineInfo = () => this.activeGroup.lineInfo();
	gotoLine = (line: number, column = 1) => this.activeGroup.gotoLine(line, column);
	restoreBackup = (path: string, contents: string) => this.activeGroup.restoreBackup(path, contents);
	reopenWithEncoding = (encoding: string) => this.activeGroup.reopenWithEncoding(encoding);
	saveWithEncoding = (encoding: string) => this.activeGroup.saveWithEncoding(encoding);
	setEol = (eol: 'lf' | 'crlf') => this.activeGroup.setEol(eol);
}
