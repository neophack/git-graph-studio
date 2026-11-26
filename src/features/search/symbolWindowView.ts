// The Symbol Window sidebar page (module 5) — redesigned for zero-jump stability:
// - Three independent persistent DOM slots inside `.sw-list`: `importsSlot`, `localsSlot`,
//   and `outlineSlot`. Updating locals or imports NEVER tears down or rebuilds the outline.
// - Stale-while-revalidate locals: moving between functions keeps the prior locals visible
//   until the new `symbol_locals` IPC resolves, diffs against the previous list, and applies
//   scrollTop height-delta compensation so outline rows below never shift a single pixel.
// - Outline fingerprint diffing: background refreshes / saves that don't change the outline
//   perform zero DOM mutations and preserve exact scroll position.
// - Container-local safe scrolling: replaces `scrollIntoView()` with local `scrollTop` math
//   guarded by a user-interaction cooldown so manual scrolling or clicking never fights the
//   cursor follower.

import { symbolFileOutline, symbolLocals } from '../../platform/ipc/symbols';

import { t, type LocaleKey } from '../../platform/i18n';
import { load, save } from '../../platform/state';
import { notify, quickInput } from '../../platform/ui/index';
import { KIND_ICONS } from './contextView';
import { RelationGraphView } from './relationGraph';
import type { DefinitionSubject } from './definitionView';
import { el, icon, relativeTo } from '../../platform/ui/index';

import type { FileOutlineImport, FileOutlineSymbol, ScopeDefinition } from '../../platform/ipc/symbols';

import './symbolWindow.css';

/** The file's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

/** The path's extension the scope parser reads by — the last dot segment (the
 *  convention every `symbol_*` scope caller uses). */
function extOf(path: string): string {
	return path.split('.').pop() ?? '';
}

/** The covering symbol's identity: name plus declaration line. */
function sameIdentity(a: FileOutlineSymbol | null, b: FileOutlineSymbol | null): boolean {
	return a === b || (a !== null && b !== null && a.name === b.name && a.line === b.line);
}

/** Structural equality check for two locals arrays so identical refreshes skip DOM work. */
function sameLocals(a: ScopeDefinition[] | null, b: ScopeDefinition[] | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (x.name !== y.name || x.kind !== y.kind || x.line !== y.line) return false;
	}
	return true;
}

/** Lightweight structural fingerprint for the outline rows so unchanged refreshes skip DOM work. */
function outlineFingerprint(
	path: string | null,
	loaded: boolean,
	failed: boolean,
	sortMode: SymbolSortMode,
	filter: string,
	collapsed: Set<string>,
	symbols: FileOutlineSymbol[]
): string {
	const head = `${path ?? ''}\u0001${loaded ? 1 : 0}\u0001${failed ? 1 : 0}\u0001${sortMode}\u0001${filter}\u0001${[...collapsed].sort().join(',')}`;
	const body = symbols.map((s) => `${s.kind}|${s.container ?? ''}|${s.name}|${s.line}|${s.endLine}`).join('\u0002');
	return `${head}\u0000${body}`;
}

/** Lightweight structural fingerprint for imports. */
function importsFingerprint(path: string | null, collapsed: boolean, imports: FileOutlineImport[]): string {
	return `${path ?? ''}\u0001${collapsed ? 1 : 0}\u0001${imports.map((i) => `${i.name}:${i.line}`).join('\u0002')}`;
}

/** One listed row's container-chain depth: one past the most recent earlier listed row
 *  carrying the container's name; no container, or a container never listed above, is
 *  the top level. Three levels is the deepest the indentation goes. */
function containerDepth(symbol: FileOutlineSymbol, depths: Map<string, number>): number {
	if (symbol.container === null) return 0;
	return Math.min((depths.get(symbol.container) ?? -1) + 1, 3);
}

/** Container-local scroll-into-view: only adjusts `container.scrollTop` when `row` is
 *  actually outside the visible viewport, never scrolling ancestor workbench containers. */
function scrollRowIntoContainer(container: HTMLElement, row: HTMLElement): void {
	const viewH = container.clientHeight;
	const cRect = container.getBoundingClientRect();
	if (viewH <= 0 || cRect.height <= 0) {
		// Headless/jsdom environment without layout geometry: preserve scrollIntoView contract.
		row.scrollIntoView({ block: 'nearest' });
		return;
	}
	const rowH = row.offsetHeight;
	if (rowH <= 0) return;
	const rRect = row.getBoundingClientRect();
	const relTop = rRect.top - cRect.top;
	const relBot = rRect.bottom - cRect.top;
	const pad = 4;
	if (relTop < pad) {
		container.scrollTop = Math.max(0, container.scrollTop + relTop - pad);
	} else if (relBot > viewH - pad) {
		container.scrollTop = Math.max(0, container.scrollTop + (relBot - viewH + pad));
	}
}

/* ---------- The collapsible tree ---------- */

/** The sort's three states, in the header cycle's order — By Line is the tree, the only
 *  state that folds ("Items can only be collapsed when sorted by line."); By Name and
 *  By Type read as the flat lists. */
export type SymbolSortMode = 'line' | 'name' | 'type';

const SORT_ORDER: SymbolSortMode[] = ['line', 'name', 'type'];

const SORT_LABELS: Record<SymbolSortMode, LocaleKey> = {
	line: 'symbols.window.sortLine',
	name: 'symbols.window.sortName',
	type: 'symbols.window.sortType'
};

/** The kind order the flat By Type list groups by — the backend's own KINDS order, the
 *  format's vocabulary. */
const KIND_ORDER = ['function', 'method', 'class', 'struct', 'interface', 'enum', 'module', 'type', 'macro', 'variable', 'field', 'constant'];

/** One rendered outline row: the symbol, its structural depth, whether it carries a
 *  fold twistie (some listed row names it as the container), and the identity key the
 *  collapse set holds. */
interface OutlineRow {
	symbol: FileOutlineSymbol;
	depth: number;
	toggle: boolean;
	key: string;
}

function rowKey(symbol: FileOutlineSymbol): string {
	return `${symbol.name}\u0000${symbol.line}`;
}

/** The line-sorted outline as the collapsible tree (pure for the tests): the container
 *  chain gives every row its structural depth (capped at three, the flat view's own
 *  rule), a row carries its twistie when a later row names it as the container, the
 *  filter keeps a row when it or any descendant matches, and a row whose ancestor sits
 *  in the collapsed set stays folded away. */
export function outlineRows(symbols: FileOutlineSymbol[], filter: string, collapsed: Set<string>): OutlineRow[] {
	const parentOf: number[] = [];
	const depth: number[] = [];
	const lastSeen = new Map<string, number>();
	for (let index = 0; index < symbols.length; index++) {
		const sym = symbols[index]!;
		const container = sym.container;
		const parent = container === null ? -1 : (lastSeen.get(container) ?? -1);
		parentOf.push(parent);
		depth.push(parent === -1 ? 0 : Math.min(depth[parent]! + 1, 3));
		// A constructor (`Foo::Foo`) shares its enclosing class's name; don't let it
		// hijack parent lookup for subsequent sibling methods of the class.
		if (sym.name !== container) lastSeen.set(sym.name, index);
	}
	const hasKids = new Set<number>();
	for (let index = 0; index < symbols.length; index++) if (parentOf[index]! >= 0) hasKids.add(parentOf[index]!);
	// The filter shows a row when it matches or something under it does.
	const matching = symbols.map((symbol) => filter === '' || symbol.name.toLowerCase().includes(filter));
	const shown = matching.slice();
	for (let index = symbols.length - 1; index >= 0; index--) {
		const parent = parentOf[index]!;
		if (shown[index] && parent >= 0) shown[parent] = true;
	}
	const rows: OutlineRow[] = [];
	for (let index = 0; index < symbols.length; index++) {
		if (!shown[index]) continue;
		let hidden = false;
		for (let at = parentOf[index]!; at >= 0 && !hidden; at = parentOf[at]!) hidden = collapsed.has(rowKey(symbols[at]!));
		if (hidden) continue;
		rows.push({ symbol: symbols[index]!, depth: depth[index]!, toggle: hasKids.has(index), key: rowKey(symbols[index]!) });
	}
	return rows;
}

/** The flat list the name and type sorts show — the tree folded away, the depth kept
 *  for the indentation. */
export function flatRows(symbols: FileOutlineSymbol[], mode: Exclude<SymbolSortMode, 'line'>, filter = ''): OutlineRow[] {
	const sorted = symbols.slice();
	if (mode === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line);
	else
		sorted.sort(
			(a, b) =>
				(KIND_ORDER.indexOf(a.kind) === -1 ? KIND_ORDER.length : KIND_ORDER.indexOf(a.kind)) -
					(KIND_ORDER.indexOf(b.kind) === -1 ? KIND_ORDER.length : KIND_ORDER.indexOf(b.kind)) ||
				a.line - b.line
		);
	const depthOf = new Map<string, number>();
	const rows: OutlineRow[] = [];
	for (const symbol of sorted) {
		const depth = containerDepth(symbol, depthOf);
		depthOf.set(symbol.name, depth);
		if (filter === '' || symbol.name.toLowerCase().includes(filter)) {
			rows.push({ symbol, depth, toggle: false, key: rowKey(symbol) });
		}
	}
	return rows;
}

/** Cooldown (ms) after user pointer/wheel interaction inside the Symbol Window during
 *  which cursor-following auto-scroll will not hijack the user's scroll position. */
const USER_SCROLL_COOLDOWN_MS = 650;

export class SymbolWindowView {
	private readonly title: HTMLElement;

	private readonly filterInput: HTMLInputElement;

	private readonly body: HTMLElement;

	/** Three independent persistent DOM slots inside `body` so locals/imports updates
	 *  never tear down or shift the outline list. */
	private readonly importsSlot: HTMLElement;
	private readonly localsSlot: HTMLElement;
	private readonly outlineSlot: HTMLElement;

	private lastImportsSig = '';
	private lastOutlineSig = '';
	private lastUserInteractAt = 0;

	/** The file the view is asked to follow; null when no editor is active. */
	private targetPath: string | null = null;

	/** The file whose outline is on screen — behind `targetPath` while a hidden view
	 *  waits for the showView refresh hook, null while a load is unserved or failed. */
	private loadedPath: string | null = null;

	/** The outline request in flight, so a burst of setFile/refresh for one path asks once. */
	private loadingPath: string | null = null;

	/** Invalidates an older load's answer against a newer setFile/refresh. */
	private generation = 0;

	private symbols: FileOutlineSymbol[] = [];

	private imports: FileOutlineImport[] = [];

	private importsCollapsed = false;

	private filterText = '';

	/** The sort's state — the three states, persisted; only the line sort folds. */
	private sortMode: SymbolSortMode = load<SymbolSortMode>('symbolWindow.sort', 'line');

	/** The folded containers' identity keys (name + declaration line) — the twisties'
	 *  state, per file (a file switch starts the tree over). */
	private readonly collapsed = new Set<string>();

	/** The sort cycle's header button — the cycle command living on the head. */
	private readonly sortButton: HTMLButtonElement;

	/** The cursor line the highlight is painted for (0-based); -1 is none. */
	private cursorLine = -1;

	private currentRow: HTMLElement | null = null;

	/** A reload the view owed while hidden — the next refresh() with the view shown settles it. */
	private dirty = false;

	/** The last load for the followed file answered null or failed: the index holds
	 *  nothing servable for it (distinct from a load still pending). */
	private failed = false;

	/** The rendered rows and their symbols, in display order (filter applied, line
	 *  ascending, index-aligned) — the highlight moves across these without a rebuild. */
	private renderedRows: HTMLElement[] = [];

	private renderedSymbols: FileOutlineSymbol[] = [];

	/** The live buffer the locals parse reads — the host (boot) hands over the active
	 *  text editor's document; null whenever the cursor is not in a text editor. */
	provideText?: () => string | null;

	/** The workspace root the repo-relative paths speak — the host (boot) hands over the
	 *  open repo, so the graph's root reaches the index in its own vocabulary. Null keeps
	 *  the editor's path as-is (the graph then answers the empty ring, not a crash). */
	provideRepo?: () => string | null;

	/** The current function's locals as `symbol_locals` answered, null while the section
	 *  is hidden — no covering symbol, no text to parse, failed, or cleared. */
	private locals: ScopeDefinition[] | null = null;

	/** The covering symbol the locals belong to, and whether the field reflects the
	 *  current outline + cursor at all (false after every outline reload, forcing one
	 *  re-evaluation). The identity — name plus line — is the locals' query key. */
	private localsOwner: FileOutlineSymbol | null = null;

	private localsOwnerKnown = false;

	/** Invalidates an older locals answer against a newer ask or outline reload. */
	private localsGen = 0;

	/** The lower half's graph over the covering symbol, its section shell, and the sash
	 *  between the outline and it. */
	private readonly graph: RelationGraphView;

	private readonly graphSection: HTMLElement;

	private readonly graphHead: HTMLElement;

	private readonly graphSubjectEl: HTMLElement;

	private readonly sash: HTMLElement;

	private graphCollapsed = false;

	/** True while the Relation Window is tracking a specific identifier at the cursor or
	 *  clicked in the outline, so same-file `setFile` updates don't clobber it back to the
	 *  enclosing function. */
	private liveRootActive = false;

	/** The drag the sash is running — its window listeners end it. */
	private sashDrag: { startY: number; baseHeight: number; viewHeight: number } | null = null;

	onOpen?: (path: string, line: number) => void;

	/** The relation graph's plain click, shown in the Definition page — the host (boot)
	 *  pins the page, shows it and feeds it; the code page stays where it stands
	 *  (2026-11-23, the owner's direction: a relation click shows the jump in the
	 *  Definition page, the code page never jumps). */
	onShowDefinition?: (subject: DefinitionSubject) => void;

	/** Ask the workbench to re-resolve the relation graph root from the active editor's
	 *  current cursor position (used when unpinning, expanding, or revealing the view). */
	onNeedRelationRoot?: () => void;

	constructor(private readonly container: HTMLElement) {
		container.classList.add('symbol-window');
		this.title = el('span', 'sw-title');
		this.filterInput = el('input', 'sw-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('symbols.window.filter');
		this.filterInput.setAttribute('aria-label', t('symbols.window.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filterText = this.filterInput.value.trim().toLowerCase();
			this.patchOutline();
			this.updateHighlight();
		});
		this.sortButton = el('button', 'sw-sort');
		this.sortButton.addEventListener('click', () => this.cycleSort());
		const header = el('div', 'sw-header', [icon('symbol-class'), this.title, this.filterInput, this.sortButton]);
		this.paintSort();

		this.importsSlot = el('div', 'sw-slot-imports');
		this.localsSlot = el('div', 'sw-slot-locals');
		this.outlineSlot = el('div', 'sw-slot-outline');
		this.body = el('div', 'sw-list', [this.importsSlot, this.localsSlot, this.outlineSlot]);
		const noteInteract = () => { this.lastUserInteractAt = Date.now(); };
		this.body.addEventListener('wheel', noteInteract, { passive: true });
		this.body.addEventListener('pointerdown', noteInteract, { passive: true });

		this.graph = new RelationGraphView();
		this.graph.onOpen = (path, line) => this.onOpen?.(path, line);
		this.graph.onShowDefinition = (subject) => this.onShowDefinition?.(subject);
		this.graph.resolvePath = (path) => {
			const repo = this.provideRepo?.() ?? null;
			if (repo === null || /^([a-zA-Z]:[\\/]|\\|\/)/.test(path)) return path;
			const separator = repo.includes('\\') ? '\\' : '/';
			return repo.replace(/[\\/]+$/, '') + separator + path.replaceAll('/', separator);
		};
		this.graphSubjectEl = el('span', 'sw-graph-subject');
		this.graph.onRootChange = (root) => {
			this.graphSubjectEl.textContent = root ? `· ${root.name}` : '';
			this.graphSubjectEl.title = root ? `${root.name} (${root.kind})` : '';
		};
		this.graph.onPinChange = (pinned) => {
			if (!pinned) {
				this.liveRootActive = false;
				if (this.onNeedRelationRoot) this.onNeedRelationRoot();
				else this.feedGraph();
			}
		};
		this.graphSection = el('div', 'sw-graph');
		this.graphHead = el('div', 'sw-graph-head');
		this.graphHead.setAttribute('role', 'button');
		this.graph.controls.addEventListener('click', (event) => event.stopPropagation());
		this.paintGraphHead();
		this.graphHead.addEventListener('click', () => this.toggleGraph());
		this.sash = el('div', 'sw-sash');
		this.sash.setAttribute('role', 'separator');
		this.sash.addEventListener('pointerdown', (event) => this.beginSashDrag(event));
		this.graphSection.append(this.graphHead, this.graph.element);
		container.append(header, this.body, this.sash, this.graphSection);
		this.render();
	}

	/** The section head's twistie and label — one paint per collapse toggle. */
	private paintGraphHead(): void {
		this.graphHead.textContent = '';
		this.graphHead.append(
			el('span', 'twistie', [icon(this.graphCollapsed ? 'chevron-right' : 'chevron-down')]),
			el('span', 'sw-graph-label', [t('symbols.graph.title')]),
			this.graphSubjectEl,
			this.graph.controls
		);
	}

	private toggleGraph(): void {
		this.graphCollapsed = !this.graphCollapsed;
		this.graphSection.classList.toggle('collapsed', this.graphCollapsed);
		this.paintGraphHead();
		if (!this.graphCollapsed) {
			if (this.onNeedRelationRoot && !this.graph.isPinned()) this.onNeedRelationRoot();
			else this.feedGraph();
			window.requestAnimationFrame(() => this.graph.fit());
		}
	}

	/** The sash: a vertical drag between the outline and the graph moves the split, as a
	 *  percentage of the view's height clamped so neither half collapses. */
	private beginSashDrag(event: PointerEvent): void {
		if (event.button !== 0 || this.graphCollapsed) return;
		const viewRect = this.container.getBoundingClientRect();
		if (viewRect.height === 0) return;
		event.preventDefault();
		this.sashDrag = { startY: event.clientY, baseHeight: this.graphSection.getBoundingClientRect().height, viewHeight: viewRect.height };
		const move = (e: PointerEvent): void => {
			const drag = this.sashDrag;
			if (!drag) return;
			const height = drag.baseHeight + (drag.startY - e.clientY);
			const clamped = Math.min(Math.max(height, drag.viewHeight * 0.15), drag.viewHeight * 0.8);
			this.graphSection.style.height = `${(clamped / drag.viewHeight) * 100}%`;
		};
		const up = (): void => {
			this.sashDrag = null;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (!this.graphCollapsed) window.requestAnimationFrame(() => this.graph.frame());
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	/** The covering symbol moved: remember it and refresh the locals — once per identity
	 *  change, never per keystroke. */
	private noteCurrentSymbol(symbol: FileOutlineSymbol | null): void {
		if (this.localsOwnerKnown && sameIdentity(this.localsOwner, symbol)) return;
		this.localsOwner = symbol;
		this.localsOwnerKnown = true;
		void this.fetchLocals();
		if (!this.liveRootActive) this.feedGraph();
	}

	/** The hover card's jump: root the graph on the hovered symbol, pinned so the
	 *  cursor-follow never clobbers it, and make sure the section stands open. */
	openGraphRoot(sym: { kind: string; name: string; path: string; line: number }): void {
		if (this.graphCollapsed) this.toggleGraph();
		this.liveRootActive = false;
		this.graph.pinRoot(sym);
	}

	/** Whether the Relation Window is actively following the editor cursor position. */
	isRelationLive(): boolean {
		return this.visible() && !this.graphCollapsed && !this.graph.isPinned();
	}

	/** Cursor-driven live follow: root the graph on the exact symbol at the editor cursor
	 *  position or clicked in the outline without pinning. */
	setLiveRoot(sym: { kind: string; name: string; path: string; line: number } | null): void {
		if (this.graph.isPinned() || this.graphCollapsed) return;
		if (sym) {
			this.liveRootActive = true;
			const repo = this.provideRepo?.() ?? null;
			const relPath = repo && /^([a-zA-Z]:[\\/]|\\|\/)/.test(sym.path) ? relativeTo(repo, sym.path) : sym.path;
			this.graph.setRoot({ kind: sym.kind, name: sym.name, path: relPath, line: sym.line });
			return;
		}
		this.liveRootActive = false;
		this.feedGraph();
	}

	/** Root the graph on the covering symbol. */
	private feedGraph(): void {
		if (this.graph.isPinned() || this.graphCollapsed) return;
		const symbol = this.localsOwner;
		const path = this.targetPath;
		if (!symbol || !path) {
			this.graph.setRoot(null);
			return;
		}
		const repo = this.provideRepo?.() ?? null;
		this.graph.setRoot({ kind: symbol.kind, name: symbol.name, path: repo ? relativeTo(repo, path) : path, line: symbol.line });
	}

	/** The active editor moved: remember the file, load it when visible, and for the same
	 *  file move only the cursor highlight — never re-querying or rebuilding the outline. */
	setFile(path: string | null, cursorLine?: number): void {
		this.targetPath = path;
		if (cursorLine !== undefined) this.cursorLine = cursorLine;
		if (path === null) {
			this.liveRootActive = false;
			this.generation++;
			this.loadedPath = null;
			this.loadingPath = null;
			this.dirty = false;
			this.failed = false;
			this.symbols = [];
			this.imports = [];
			this.resetLocals();
			this.feedGraph();
			this.render();
			return;
		}
		if (path === this.loadedPath || path === this.loadingPath) {
			this.updateHighlight();
			return;
		}
		// Switching to a different file: reset per-file fold & scroll state cleanly.
		this.liveRootActive = false;
		this.collapsed.clear();
		this.generation++;
		this.loadedPath = null;
		this.loadingPath = null;
		this.failed = false;
		this.dirty = !this.visible();
		this.symbols = [];
		this.imports = [];
		this.resetLocals();
		this.body.scrollTop = 0;
		this.render();
		if (!this.dirty) void this.load(false);
	}

	/** Re-pull the followed file's outline (e.g., after a save): keeps the current outline
	 *  and locals visible while loading (zero blank flash) and skips DOM work if unchanged. */
	refresh(): void {
		if (this.targetPath === null) return;
		if (!this.visible() || this.loadingPath !== null) {
			this.dirty = true;
			return;
		}
		if (!this.graphCollapsed) {
			if (!this.graph.isPinned()) this.onNeedRelationRoot?.();
			window.requestAnimationFrame(() => this.graph.frame());
		}
		const sameFile = this.loadedPath === this.targetPath;
		void this.load(sameFile);
	}

	focusFilter(): void {
		this.filterInput.focus();
	}

	private visible(): boolean {
		return this.container.style.display !== 'none';
	}

	private async load(preserveWhileLoading: boolean): Promise<void> {
		const path = this.targetPath;
		if (path === null) return;
		// On a same-file refresh, keep the current locals & outline painted while fetching
		// so saving a file never causes a blank-then-refill jump.
		if (!preserveWhileLoading) {
			this.resetLocals();
		} else {
			this.localsOwnerKnown = false;
		}
		const generation = ++this.generation;
		this.loadingPath = path;
		this.dirty = false;
		this.failed = false;
		try {
			const outline = await symbolFileOutline(path);
			if (generation !== this.generation || this.targetPath !== path) return;
			this.symbols = (outline?.symbols ?? []).slice().sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
			this.imports = outline?.imports ?? [];
			this.failed = outline === null;
		} catch {
			if (generation !== this.generation || this.targetPath !== path) return;
			this.symbols = [];
			this.imports = [];
			this.failed = true;
		}
		this.loadingPath = null;
		this.loadedPath = this.failed ? null : path;
		this.render();
		this.updateHighlight();
		if (this.dirty && this.visible()) void this.load(true);
	}

	/** Reconcile header + all three independent DOM slots without wiping untouched slots. */
	private render(): void {
		this.title.textContent = this.targetPath === null ? '' : baseName(this.targetPath);
		this.title.title = this.targetPath ?? '';
		this.patchImports();
		this.patchLocals();
		this.patchOutline();
		this.updateHighlight();
	}

	/** Patch ONLY `importsSlot` when imports or collapse state changed, compensating
	 *  `body.scrollTop` so outline rows below stay anchored. */
	private patchImports(): void {
		const sig = importsFingerprint(this.targetPath, this.importsCollapsed, this.imports);
		if (sig === this.lastImportsSig) return;
		this.lastImportsSig = sig;
		const beforeH = this.importsSlot.offsetHeight;
		const prevScroll = this.body.scrollTop;
		this.importsSlot.textContent = '';
		if (this.targetPath !== null && this.imports.length > 0) {
			this.importsSlot.appendChild(this.importsSection());
		}
		if (prevScroll > 0) {
			const delta = this.importsSlot.offsetHeight - beforeH;
			if (delta !== 0) this.body.scrollTop = Math.max(0, prevScroll + delta);
		}
	}

	/** Patch ONLY `localsSlot`, preserving `outlineSlot` untouched and compensating
	 *  `body.scrollTop` for any height change so the outline below never jumps. */
	private patchLocals(): void {
		const beforeH = this.localsSlot.offsetHeight;
		const prevScroll = this.body.scrollTop;
		this.localsSlot.textContent = '';
		const section = this.localsSection();
		if (section !== null) this.localsSlot.appendChild(section);
		if (prevScroll > 0) {
			const delta = this.localsSlot.offsetHeight - beforeH;
			if (delta !== 0) this.body.scrollTop = Math.max(0, prevScroll + delta);
		}
	}

	/** Patch ONLY `outlineSlot` when the outline fingerprint actually changed, preserving
	 *  `body.scrollTop` across the update. */
	private patchOutline(): void {
		const sig = outlineFingerprint(
			this.targetPath,
			this.loadedPath !== null,
			this.failed,
			this.sortMode,
			this.filterText,
			this.collapsed,
			this.symbols
		);
		if (sig === this.lastOutlineSig) return;
		this.lastOutlineSig = sig;
		const prevScroll = this.body.scrollTop;
		this.outlineSlot.textContent = '';
		this.renderedRows = [];
		this.renderedSymbols = [];
		this.currentRow = null;
		if (this.targetPath === null) {
			this.outlineSlot.appendChild(el('div', 'sw-empty', [t('symbols.window.empty')]));
			return;
		}
		if (this.loadedPath === null && !this.failed) return;
		if (this.symbols.length === 0) {
			this.outlineSlot.appendChild(el('div', 'sw-empty', [t('symbols.window.noIndex')]));
			return;
		}
		const query = this.filterText;
		const rows = this.sortMode === 'line' ? outlineRows(this.symbols, query, this.collapsed) : flatRows(this.symbols, this.sortMode, query);
		const frag = document.createDocumentFragment();
		for (const row of rows) frag.appendChild(this.symbolRow(row));
		this.outlineSlot.appendChild(frag);
		if (prevScroll > 0) this.body.scrollTop = prevScroll;
	}

	/* ---------- The collapsible tree and the sort ---------- */

	private toggleCollapse(key: string): void {
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		this.patchOutline();
		this.updateHighlight();
	}

	collapseAll(): void {
		if (this.sortMode !== 'line') {
			notify('info', t('symbols.window.sortedNote'));
			return;
		}
		for (const row of outlineRows(this.symbols, '', new Set())) if (row.toggle) this.collapsed.add(row.key);
		this.patchOutline();
		this.updateHighlight();
	}

	expandAll(): void {
		this.collapsed.clear();
		this.patchOutline();
		this.updateHighlight();
	}

	async expandSpecial(): Promise<void> {
		const raw = await quickInput({
			title: t('symbols.window.expandSpecial'),
			placeholder: t('relations.expandSpecial.prompt'),
			validate: (value) => (/^[1-8]$/.test(value.trim()) ? null : t('relations.expandSpecial.bad'))
		});
		if (raw === null) return;
		const levels = Number(raw.trim());
		if (!Number.isFinite(levels) || levels < 1) return;
		for (let level = 0; level < Math.min(8, Math.round(levels)); level++) {
			for (const row of outlineRows(this.symbols, '', this.collapsed)) {
				if (row.toggle && this.collapsed.has(row.key) && row.depth <= level) this.collapsed.delete(row.key);
			}
		}
		this.patchOutline();
		this.updateHighlight();
	}

	/** The sort cycle: By Line → By Name → By Type → By Line. */
	cycleSort(): void {
		const at = SORT_ORDER.indexOf(this.sortMode);
		this.sortMode = SORT_ORDER[(at + 1) % SORT_ORDER.length]!;
		save('symbolWindow.sort', this.sortMode);
		this.paintSort();
		this.patchOutline();
		this.updateHighlight();
	}

	private paintSort(): void {
		this.sortButton.textContent = '';
		this.sortButton.append(el('span', 'sw-sort-label', [t(SORT_LABELS[this.sortMode])]), icon('chevron-down'));
		this.sortButton.title = t('symbols.window.sortCycle');
		this.sortButton.setAttribute('aria-label', this.sortButton.title);
	}

	cycleRelationView(): void {
		this.graph.cycleView();
	}

	private importsSection(): HTMLElement {
		const path = this.targetPath!;
		const section = el('div', 'sw-imports');
		const head = el('div', 'sw-section', [
			el('span', 'twistie', [icon(this.importsCollapsed ? 'chevron-right' : 'chevron-down')]),
			el('span', 'sw-section-label', [t('symbols.window.imports')])
		]);
		head.setAttribute('role', 'button');
		head.addEventListener('click', () => {
			this.importsCollapsed = !this.importsCollapsed;
			this.patchImports();
		});
		section.appendChild(head);
		if (this.importsCollapsed) return section;
		for (const entry of this.imports) {
			const row = el('div', 'sw-import-row', [icon('file-code'), el('span', 'sw-name', [entry.name])]);
			const line = (entry.line ?? 0) + 1;
			row.title = `${path}:${line}`;
			row.addEventListener('click', () => this.onOpen?.(path, line));
			section.appendChild(row);
		}
		return section;
	}

	/** The "current function" section: the enclosing symbol's parameters and locals. */
	private localsSection(): HTMLElement | null {
		const path = this.targetPath;
		if (this.locals === null || path === null) return null;
		const section = el('div', 'sw-locals');
		section.appendChild(el('div', 'sw-section sw-locals-head', [el('span', 'sw-section-label', [t('symbols.window.locals')])]));
		for (const def of this.locals) {
			const row = el('div', 'sw-row sw-local-row', [
				icon(KIND_ICONS[def.kind] ?? 'symbol-variable'),
				el('span', 'sw-name', [def.name]),
				el('span', 'sw-line', [String(def.line + 1)])
			]);
			row.addEventListener('click', () => {
				this.lastUserInteractAt = Date.now();
				this.setLiveRoot({ kind: def.kind, name: def.name, path, line: def.line });
				this.onOpen?.(path, def.line + 1);
			});
			section.appendChild(row);
		}
		return section;
	}

	private symbolRow(entry: OutlineRow): HTMLElement {
		const path = this.targetPath!;
		const symbol = entry.symbol;
		const row = el('div', 'sw-row');
		row.dataset['path'] = path;
		row.dataset['line'] = String(symbol.line);
		if (entry.toggle) {
			const twist = el('span', 'twistie sw-fold', [icon(this.collapsed.has(entry.key) ? 'chevron-right' : 'chevron-down')]);
			twist.title = this.collapsed.has(entry.key) ? t('symbols.window.expand') : t('symbols.window.collapse');
			twist.addEventListener('click', (event) => {
				event.stopPropagation();
				this.toggleCollapse(entry.key);
			});
			row.appendChild(twist);
		} else {
			row.appendChild(el('span', 'twistie sw-fold-space'));
		}
		row.append(icon(KIND_ICONS[symbol.kind] ?? 'symbol-variable'));
		if (symbol.container) row.appendChild(el('span', 'sw-container', [`${symbol.container}·`]));
		row.appendChild(el('span', 'sw-name', [symbol.name]));
		row.appendChild(el('span', 'sw-line', [String(symbol.line + 1)]));
		if (entry.depth > 0) row.style.paddingLeft = `${8 + entry.depth * 14}px`;
		row.addEventListener('click', () => {
			this.lastUserInteractAt = Date.now();
			this.setLiveRoot({ kind: symbol.kind, name: symbol.name, path, line: symbol.line });
			this.onOpen?.(path, symbol.line + 1);
		});
		this.renderedRows.push(row);
		this.renderedSymbols.push(symbol);
		return row;
	}

	/** Update the `current` highlight class in place without rebuilding any DOM. Uses safe
	 *  container-local scrolling guarded by the user-interaction cooldown. */
	private updateHighlight(): void {
		let next: HTMLElement | null = null;
		let start = -1;
		for (let index = 0; index < this.renderedSymbols.length; index++) {
			const symbol = this.renderedSymbols[index]!;
			if (this.cursorLine < symbol.line || this.cursorLine > symbol.endLine) continue;
			if (symbol.line >= start) {
				start = symbol.line;
				next = this.renderedRows[index] ?? null;
			}
		}
		if (next !== this.currentRow) {
			this.currentRow?.classList.remove('current');
			next?.classList.add('current');
			this.currentRow = next;
			if (next !== null && this.visible() && Date.now() - this.lastUserInteractAt > USER_SCROLL_COOLDOWN_MS) {
				scrollRowIntoContainer(this.body, next);
			}
		}
		this.noteCurrentSymbol(this.coveringSymbol());
	}

	private coveringSymbol(): FileOutlineSymbol | null {
		let enclosing: FileOutlineSymbol | null = null;
		let enclosingStart = -1;
		let onLine: FileOutlineSymbol | null = null;
		let onLineStart = -1;
		for (const symbol of this.symbols) {
			if (this.cursorLine < symbol.line || this.cursorLine > symbol.endLine) continue;
			if (symbol.endLine > symbol.line) {
				if (symbol.line >= enclosingStart) {
					enclosingStart = symbol.line;
					enclosing = symbol;
				}
			} else if (symbol.line >= onLineStart) {
				onLineStart = symbol.line;
				onLine = symbol;
			}
		}
		return enclosing ?? onLine;
	}

	/** Stale-while-revalidate locals fetch: keeps the previous locals painted while IPC
	 *  runs, patches ONLY `localsSlot` on resolution, and skips DOM work when unchanged. */
	private async fetchLocals(): Promise<void> {
		const symbol = this.localsOwner;
		const path = this.targetPath;
		const provide = this.provideText;
		const generation = ++this.localsGen;
		if (symbol === null || path === null || provide === undefined) {
			if (this.locals !== null) {
				this.locals = null;
				this.patchLocals();
			}
			return;
		}
		const text = provide();
		if (text === null) {
			if (this.locals !== null) {
				this.locals = null;
				this.patchLocals();
			}
			return;
		}
		try {
			const defs = (await symbolLocals(text, extOf(path), this.cursorLine)) ?? [];
			if (generation !== this.localsGen) return;
			if (sameLocals(this.locals, defs)) return;
			this.locals = defs;
			this.patchLocals();
		} catch {
			if (generation !== this.localsGen) return;
			if (this.locals !== null) {
				this.locals = null;
				this.patchLocals();
			}
		}
	}

	private resetLocals(): void {
		this.localsOwner = null;
		this.localsOwnerKnown = false;
		this.locals = null;
		this.localsGen++;
	}
}
