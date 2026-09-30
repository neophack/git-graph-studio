// The editor area: a grid of editor groups, built like VS Code's editor grid (M3 3.1). The
// layout is a tree of split nodes (`x` = side-by-side, `y` = stacked) whose leaves are
// `EditorGroup`s; directions (left/right/up/down) walk the tree, so a group always opens in
// the neighbouring layer when one exists and otherwise a new split is created at the edge.
// `EditorGroup` stays a self-contained tab strip plus pane stack; this class owns the layout
// around any number of them and is the workbench's facade - the focused group answers
// everything that concerns "the" editor, the whole area answers what spans groups (saving,
// closing, path renames).

import { EditorGroup, askToSaveMany, tabDrag, type Editor, type EditorInput, type EditorPlacement } from './editor';
import { setDecorationRanges } from './editorDecorations';
import type { EditorGridCell } from './state';
import { el } from './ui';
import type { EditorView } from '@codemirror/view';

/** One editor group in the grid: its box element and its group. */
interface GroupBox {
	el: HTMLElement;
	group: EditorGroup;
}

/** One extension-page overlay: the stable DOM home a webview tab's frame keeps while the
 *  group tree around its placeholder pane is rebuilt. */
interface ExtOverlay {
	host: HTMLElement;
	placeholder: HTMLElement;
	resize: ResizeObserver | null;
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
	/** The group tree's render root — the only part of the area `render()` clears and
	 *  rebuilds. */
	private readonly groupsRoot: HTMLElement;
	/** The webview overlay layer: extension-page frames live here, each positioned over its
	 *  tab's placeholder pane. No render ever touches this layer — a re-parented iframe
	 *  loses its browsing context and reloads (WKWebView reloads the page, interrupting the
	 *  extension chat mid-conversation), so a frame must never sit inside the rebuilt tree. */
	private readonly overlayLayer: HTMLElement;
	/** The live overlays: one per open extension-page tab. */
	private readonly overlays: ExtOverlay[] = [];
	/** A pending overlay-placement frame id (0 = none). */
	private overlaySyncPending = 0;
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
	/** A file editor's text changed, from whichever group (see EditorGroup). */
	onDocumentEdited: ((path: string, text: () => string) => void) | null = null;
	/** A file's last editor across every group closed. */
	onDocumentClosed: ((path: string) => void) | null = null;
	/** A windowed editor's save streamed a progress report (`null` clears it), from whichever
	 *  group it belongs to; the workbench forwards this to the status bar's save item. */
	onSaveProgress: ((progress: { written: number; total: number } | null) => void) | null = null;
	onMergeResolved: (() => void) | null = null;
	onExternalFileChange: (() => void) | null = null;
	/** A `.py` file's tab-strip run button was clicked: the workbench opens the terminal and
	 *  runs the file there (the area reaches no panel). */
	onRunInTerminal: ((path: string) => void) | null = null;
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
	renderSelfTest: ((container: HTMLElement) => void) | null = null;
	renderProviders: ((container: HTMLElement) => void | (() => void)) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		container.classList.add('editor-area');
		// The area's two permanent children: the group tree's root, which `render()` rebuilds,
		// and the webview overlay layer, which nothing rebuilds — an extension page's frame
		// keeps its DOM home (and so its browsing context) across every layout change.
		this.groupsRoot = el('div', 'editor-groups-root');
		this.overlayLayer = el('div', 'ext-overlay-layer');
		container.append(this.groupsRoot, this.overlayLayer);
		// Every mutation under the group tree (a layout rebuild, a pane's `hidden`, a sash's
		// flexGrow, a tab moved between groups) can move or resize a placeholder: the hosts
		// follow on the next frame. Resizes that change no DOM inside the tree — a window
		// resize, a sidebar toggle — arrive through the per-placeholder observers and this
		// window listener.
		new MutationObserver(() => this.scheduleOverlaySync())
			.observe(this.groupsRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
		const onResize = () => {
			// The workbench's one area never detaches; a test's does, and takes its listener
			// with it rather than leaking one per constructed area.
			if (!container.isConnected) {
				window.removeEventListener('resize', onResize);
				return;
			}
			this.scheduleOverlaySync();
		};
		window.addEventListener('resize', onResize);
		this.root = { kind: 'leaf', box: this.makeBox() };
		this.render();
		this.reassignWelcome();
		this.focus(this.leaves()[0]!.box);
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

	/** VS Code's group lock (`workbench.action.lock/unlockEditorGroup`): a locked group
	 *  keeps its editors — placed opens land elsewhere (`groupForPlacement`) — its box
	 *  carries the state class and its tab strip re-renders, where the lock badge lives
	 *  (in flow after the title actions, covering nothing). */
	setGroupLock(group: EditorGroup, lock: boolean): void {
		group.locked = lock;
		this.leafBoxOf(group)?.el.classList.toggle('locked', lock);
		group.update();
	}

	/** A tab's icon, set after its open (a webview panel opens before its package icon's
	 *  read answers). The first group holding the input id wins, as `renameById`. */
	setIconSrc(id: string, iconSrc: string): boolean {
		for (const group of this.groups()) {
			if (group.setIconSrc(id, iconSrc)) return true;
		}
		return false;
	}

	/** The closed-tabs stack behind VS Code's `workbench.action.reopenClosedEditor`
	 *  (Ctrl+Shift+T): the inputs that can re-open, newest first, capped like a history. */
	private readonly closedStack: { group: EditorGroup; open: (group: EditorGroup) => void }[] = [];

	/** Reopen the most recently closed tab, in the group it closed from — the active group
	 *  once that layer is gone. Not every close left something re-openable (an extension
	 *  page's mount lives with its open call); those closes simply skip the stack. */
	reopenClosed(): void {
		const entry = this.closedStack.shift();
		if (!entry) return;
		entry.open(this.groups().includes(entry.group) ? entry.group : this.activeGroup);
	}

	/** The re-open call for a closing editor's input, when the input carries everything its
	 *  open needs: files and CAN logs, diffs, content tabs, folder compares, analysis pages,
	 *  the symbol database, markdown previews, file histories, hex views, help pages. */
	private reopenOf(editor: Editor): ((group: EditorGroup) => void) | null {
		const input = editor.input;
		switch (input.kind) {
			case 'file': return (group) => void group.openFile(input.path);
			case 'diff': return (group) => void group.openDiff(input);
			case 'content': return (group) => void group.openContent(input);
			case 'folders': return (group) => group.openFolderCompare(input);
			case 'symboldb': return (group) => group.openSymbolDatabase();
			case 'analysis': return (group) => group.openAnalysisPage(input.tool, input.folders);
			case 'markdown': return (group) => void group.openMarkdownPreview(input.path);
			case 'history': return (group) => void group.openFileHistory(input.path);
			case 'hex': return (group) => void group.openHex(input.path);
			case 'canlog': return (group) => void group.openFile(input.path);
			case 'help': return (group) => group.openHelp(input.help);
		}
		return null;
	}

	/** Close the tab with this input id in whichever group holds it (the extension host
	 *  closes a webview panel's tab this way). Returns whether a tab was found. */
	closeById(id: string): boolean {
		for (const group of this.groups()) {
			if (group.closeById(id)) return true;
		}
		return false;
	}

	/** Rename the tab with this input id in whichever group holds it (the extension host
	 *  applies a webview panel's `setTitle` — a chat tab's session summary — this way). */
	renameById(id: string, title: string): boolean {
		for (const group of this.groups()) {
			if (group.renameById(id, title)) return true;
		}
		return false;
	}

	/** The active editor's whole text, when a file editor is active — module 12 pushes it to
	 *  extension frames on active-editor changes (only when the document changed). */
	/** An open file editor's current text (unsaved edits included), from any group. */
	documentText(path: string): string | null {
		for (const group of this.groups()) {
			const view = group.fileViewFor(path);
			if (view) return view.state.doc.toString();
		}
		return null;
	}

	/** Save a file's open editor, from whichever group holds it. */
	async saveFile(path: string): Promise<boolean> {
		for (const group of this.groups()) {
			if (group.fileViewFor(path)) return await group.saveByPath(path);
		}
		return false;
	}

	activeText(): string | null {
		if (this.activeInput?.kind !== 'file') return null;
		return this.activeView?.state.doc.toString() ?? null;
	}

	/** Apply a TextEdit batch (1-based lines, 0-based characters) to an open file editor —
	 *  module 12's `vscode.workspace.applyEdit` / `TextEditor.edit`. A null path addresses
	 *  the active file editor; false means the file is not open (the caller falls back to
	 *  file-level edits through the extension filesystem). */
/** GGS-patch: extension decoration marks for one document (null = the active file
 *  editor); the ranges REPLACE the type's previous set (see editorDecorations.ts). */
	setExtensionDecorations(path: string | null, key: string, ranges: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]): void {
		const target = path === null
			? (this.activeInput?.kind === 'file' ? this.activeInput.path : null)
			: path;
		if (!target) return;
		setDecorationRanges(target, key, ranges);
	}

	applyTextEdits(path: string | null, edits: { startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }[]): boolean {
		const view = path === null
			? (this.activeInput?.kind === 'file' ? this.activeView : null)
			: (this.groups().map((group) => group.fileViewFor(path)).find((candidate) => candidate !== null) ?? null);
		if (!view) return false;
		const doc = view.state.doc;
		const position = (line: number, character: number): number => {
			const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
			return Math.min(target.from + Math.max(0, character), target.to);
		};
		const changes = [...edits]
			.sort((a, b) => (a.startLine - b.startLine) || (a.startCharacter - b.startCharacter))
			.reverse()
			.map((edit) => {
				const from = Math.min(position(edit.startLine, edit.startCharacter), doc.length);
				const to = Math.max(from, Math.min(position(edit.endLine, edit.endCharacter), doc.length));
				return { from, to, insert: edit.newText };
			});
		view.dispatch({ changes });
		return true;
	}

	/** Focus the tab with this input id in whichever group holds it (a webview panel's
	 *  `reveal()`); returns whether a tab was found. */
	revealById(id: string): boolean {
		for (const group of this.groups()) {
			if (group.hasEditor(id)) {
				group.activateById(id);
				return true;
			}
		}
		return false;
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

	/** The group the last `'beside'` open landed in, while it still lives: clicking inside
	 *  a webview (the extension chat that links to its outputs) never refocuses its editor
	 *  group, so the focused group alone cannot name "the other view" — repeated placed
	 *  opens keep landing in the same side layer this way instead of cascading splits. */
	private besideGroup: EditorGroup | null = null;

	/** The group a placed open lands in: `'beside'` answers the side layer — the last one
	 *  a placed open took, while it lives, else the focused group's right neighbour (a
	 *  fresh right split when it has none) — so the view the user reads from (an
	 *  extension's chat panel, typically) keeps its half of the area and the opened
	 *  editor takes the other; a 1-based index answers that group, splitting right until
	 *  it exists (VS Code creates missing columns); `undefined` is the focused group. */
	private groupForPlacement(placement?: EditorPlacement): EditorGroup {
		if (placement === undefined) {
			// A locked group receives no new editors (VS Code's group lock — claude-code locks
			// its chat's group right after opening it): the open lands in the first unlocked
			// group, and only in the locked one when every group is locked.
			const active = this.activeGroup;
			if (!active.locked) return active;
			return this.groups().find((group) => !group.locked) ?? active;
		}
		if (placement === 'beside') {
			// The remembered side layer is the destination while it lives — even when the
			// focus moved into it (clicking inside a webview never refocuses its group) —
			// unless that layer is locked now.
			if (this.besideGroup !== null && this.groups().includes(this.besideGroup) && !this.besideGroup.locked) return this.besideGroup;
			const active = this.activeGroup;
			// An empty focused group is where the content belongs — nothing is open to sit
			// beside (the caller's surface is a sidebar view, not an editor tab).
			if (active.openEditorIds().length === 0 || this.groupCount >= 8) return active;
			const source = this.leafOfBox(this.focused) ?? this.leaves()[0]!;
			// A locked right neighbour is no destination either: a fresh split beside the
			// source takes the content instead of piling into the pinned layer.
			const neighbour = this.neighbor(source, 'right');
			const target = neighbour === null || neighbour.box.group.locked ? this.insertBeside(source, 'right') : neighbour;
			this.render();
			this.besideGroup = target.box.group;
			return target.box.group;
		}
		const wanted = Math.max(1, Math.floor(placement));
		while (this.leaves().length < wanted && this.groupCount < 8) {
			const before = this.leaves().length;
			this.split('right');
			if (this.leaves().length === before) break; // the group cap stopped the split
		}
		const leaf = this.leaves()[Math.min(wanted, this.leaves().length) - 1]!;
		this.focus(leaf.box);
		return leaf.box.group;
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
		// The first group owns the welcome page; `reassignWelcome` sorts that out after the
		// tree change, so a box is created welcome-less here (the tree may not exist yet).
		group.showWelcome = false;
		// The locked-group badge (VS Code's marker) renders in the group's tab strip (in
		// flow, after the title actions) whenever the group re-renders its tabs locked.
		const box: GroupBox = { el: elBox, group };
		this.wire(group, elBox);
		return box;
	}

	/** Rebuild the DOM from the layout tree. The panes themselves (each group's tab strip and
	 *  editors) are moved, not recreated — and an extension page's frame is not even moved:
	 *  it lives in the overlay layer, over the placeholder pane its tab keeps here. */
	private render(): void {
		this.groupsRoot.textContent = '';
		this.renderNode(this.root, this.groupsRoot);
		if (this.focused) this.focused.el.classList.add('focused');
		this.scheduleOverlaySync();
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

	/* ---------- The webview overlay layer ---------- */

	/** An extension page's stable frame home: the pane stays in the group tree as the
	 *  positioned placeholder, and the host the frame mounts into lives in the overlay
	 *  layer, where no layout change ever re-parents it. The disposer runs when the tab
	 *  closes. */
	private attachExtOverlay(placeholder: HTMLElement): { host: HTMLElement; dispose: () => void } {
		const host = el('div', 'ext-overlay-host');
		this.overlayLayer.appendChild(host);
		const entry: ExtOverlay = { host, placeholder, resize: null };
		// The area-level mutation observer cannot see a placeholder resize that changed no
		// DOM inside the tree (a window resize, a sidebar toggle, a settings-driven metrics
		// change), so each placeholder carries its own observer where the platform has one
		// (jsdom does not — its zero-size boxes make placement a no-op there anyway).
		if (typeof ResizeObserver !== 'undefined') {
			entry.resize = new ResizeObserver(() => this.scheduleOverlaySync());
			entry.resize.observe(placeholder);
		}
		this.overlays.push(entry);
		this.placeOverlay(entry);
		return {
			host,
			dispose: () => {
				const index = this.overlays.indexOf(entry);
				if (index !== -1) this.overlays.splice(index, 1);
				entry.resize?.disconnect();
				host.remove();
			}
		};
	}

	/** Position one overlay's host exactly over its placeholder pane, or hide it while the
	 *  placeholder is hidden or gone (another tab showing, the tab closed) — the frame
	 *  beneath keeps running either way, as a pane-hidden pane always kept its iframe. */
	private placeOverlay(entry: ExtOverlay): void {
		const { host, placeholder } = entry;
		if (!placeholder.isConnected || placeholder.hidden) {
			host.style.display = 'none';
			return;
		}
		const base = this.overlayLayer.getBoundingClientRect();
		const box = placeholder.getBoundingClientRect();
		host.style.display = 'block';
		host.style.left = `${box.left - base.left}px`;
		host.style.top = `${box.top - base.top}px`;
		host.style.width = `${box.width}px`;
		host.style.height = `${box.height}px`;
	}

	/** Re-place every overlay on the next frame: mutations and resizes arrive in bursts (a
	 *  layout rebuild, a sash drag), and one placement per frame reads layout once. */
	private scheduleOverlaySync(): void {
		if (this.overlaySyncPending) return;
		const raf = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => window.setTimeout(callback, 16) as unknown as number);
		this.overlaySyncPending = raf(() => {
			this.overlaySyncPending = 0;
			for (const entry of this.overlays) this.placeOverlay(entry);
		});
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
		group.onDocumentEdited = (path, text) => this.onDocumentEdited?.(path, text);
		group.onDocumentClosed = (path) => {
			if (!this.groups().some((candidate) => candidate.fileViewFor(path) !== null)) this.onDocumentClosed?.(path);
		};
		group.onSaveProgress = (progress) => this.onSaveProgress?.(progress);
		group.onMergeResolved = () => this.onMergeResolved?.();
		group.onExternalFileChange = () => this.onExternalFileChange?.();
		group.onOpenPreviewToSide = (path) => void this.openMarkdownPreviewToSide(path);
		group.onRunInTerminal = (path) => this.onRunInTerminal?.(path);
		group.renderWelcome = (container) => this.renderWelcome?.(container);
		group.renderHelp = (help, container) => this.renderHelp?.(help, container);
		group.renderSelfTest = (container) => this.renderSelfTest?.(container);
		group.renderProviders = (container) => this.renderProviders?.(container);
		// The overlay service the group's extension pages mount through: the pane stays in
		// this tree, the frame lives in the overlay layer above it.
		group.extOverlayHost = (placeholder) => this.attachExtOverlay(placeholder);
		// A tab closing here feeds the reopen-closed stack when its input can re-open.
		group.onEditorClosed = (editor) => {
			const open = this.reopenOf(editor);
			if (open) {
				this.closedStack.unshift({ group, open });
				if (this.closedStack.length > 50) this.closedStack.length = 50;
			}
		};
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

	get seedableView(): EditorView | null {
		return this.activeGroup.seedableView;
	}

	setRoot(rootPath: string | null): void {
		for (const group of this.groups()) group.setRoot(rootPath);
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

	/** Everything else concerns the focused group's active editor; a placement moves the
	 *  open into the group `groupForPlacement` picks (an extension's `ViewColumn`). */
	openFile = (path: string, options?: { line?: number; column?: number; inactive?: boolean }, placement?: EditorPlacement) => this.groupForPlacement(placement).openFile(path, options);
	openDiff = (input: Extract<EditorInput, { kind: 'diff' }>, placement?: EditorPlacement) => this.groupForPlacement(placement).openDiff(input);
	openContent = (input: Extract<EditorInput, { kind: 'content' }>, placement?: EditorPlacement) => this.groupForPlacement(placement).openContent(input);
	openRevision = (revision: string, path: string, title: string, repo?: string) => this.activeGroup.openRevision(revision, path, title, repo);
	openHelp = (help: 'welcome' | 'shortcuts') => this.activeGroup.openHelp(help);
	openSelfTest = () => this.activeGroup.openSelfTest();
	openProviders = () => this.activeGroup.openProviders();
	openHex = (path?: string) => this.activeGroup.openHex(path);
	openLocalHexCompare = (left: string, right: string) => this.activeGroup.openLocalHexCompare(left, right);
	openMarkdownPreview = (path?: string) => this.activeGroup.openMarkdownPreview(path);
	openMarkdownPreviewToSide = (path?: string) => {
		// The path is captured before the split: the fresh group is empty and focused, so
		// the preview's "active file" default would find nothing there.
		const target = path ?? (this.activeInput?.kind === 'file' ? this.activeInput.path : '');
		if (!target) return Promise.resolve();
		return this.split('right').openMarkdownPreview(target);
	};
	openFileHistory = (path?: string) => this.activeGroup.openFileHistory(path);
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
	runEditorCommand = (command: 'undo' | 'redo' | 'selectAll' | 'find' | 'replace' | 'toggleLineComment' | 'toggleBlockComment') => this.activeGroup.runEditorCommand(command);
	goToDefinition = () => this.activeGroup.goToDefinition();
	findReferences = () => this.activeGroup.findReferences();
	openCallTreeAtCursor = () => this.activeGroup.openCallTreeAtCursor();
	openSymbolDatabase = () => this.activeGroup.openSymbolDatabase();
	openAnalysisPage = (tool: import('./analysisTools').AnalysisToolId, folders?: string[]) => this.activeGroup.openAnalysisPage(tool, folders);
	/** An extension page tab (module 12): mounts through the active group, like every other
	 *  custom editor kind — or, with a placement (a webview panel's `ViewColumn`), in the
	 *  group that placement names (`groupForPlacement`), focused as VS Code focuses the
	 *  column a panel opens in unless `preserveFocus` held (`focus`). */
	openExtPage = (input: import('./editor').EditorInput & { kind: 'extpage' }, mount: (pane: HTMLElement) => (() => void) | void, iconSrc?: string | null, placement?: EditorPlacement, focus?: boolean) => {
		if (placement === undefined) {
			this.activeGroup.openExtPage(input, mount, iconSrc);
			return;
		}
		const group = this.groupForPlacement(placement);
		group.openExtPage(input, mount, iconSrc);
		if (focus) {
			const box = this.leafBoxOf(group);
			if (box) this.focus(box);
		}
	};
	/** The Extensions view's detail page tab (module 12): the same mounting path. */
	openExtDetail = (input: import('./editor').EditorInput & { kind: 'extdetail' }, mount: (pane: HTMLElement) => (() => void) | void) => this.activeGroup.openExtDetail(input, mount);
	gotoSymbolInFile = () => this.activeGroup.gotoSymbolInFile();
	lineInfo = () => this.activeGroup.lineInfo();
	gotoLine = (line: number, column = 1) => this.activeGroup.gotoLine(line, column);
	restoreBackup = (path: string, contents: string) => this.activeGroup.restoreBackup(path, contents);
	reopenWithEncoding = (encoding: string) => this.activeGroup.reopenWithEncoding(encoding);
	saveWithEncoding = (encoding: string) => this.activeGroup.saveWithEncoding(encoding);
	setEol = (eol: 'lf' | 'crlf') => this.activeGroup.setEol(eol);
}
