// The Symbol Window sidebar page (module 5) — an outline window over the
// active editor's file: its includes/imports, the "current function" locals section, and
// the persistent index's per-file outline as one flat list. The workbench feeds it the
// active editor's path and cursor line (editorProviderViews' symbols, 0-based); a row
// click jumps to the declaration, and the row whose [line, endLine] span holds the
// cursor carries the highlight. The outline is one query per file change — the cursor
// only repaints a class. The locals ride the same discipline one level down: the
// enclosing symbol's identity (name + line) is the query key, and only its change asks
// the backend to parse the live buffer the host hands over through `provideText`.
// Below the outline, split by a draggable sash, sits the relation graph: the covering
// symbol's ring drawn as an interactive box-and-arrow canvas over `relationGraph.ts` —
// re-rooted on every covering-symbol identity change unless pinned, the same discipline
// the locals run on.
// The outline folds too (2026-11-23, the owner's direction: the windows read as one
// coherent set): a container row carries its own +/- twistie whose
// click folds and opens its members in place, Expand All / Collapse All / Expand Special
// are the tree commands (the special one asking its number of levels), and the sort
// speaks three states — By Line (the tree, the only state that folds), By Name and By
// Type as the flat lists.

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

/** One listed row's container-chain depth: one past the most recent earlier listed row
 *  carrying the container's name; no container, or a container never listed above, is
 *  the top level. Three levels is the deepest the indentation goes. */
function containerDepth(symbol: FileOutlineSymbol, depths: Map<string, number>): number {
	if (symbol.container === null) return 0;
	return Math.min((depths.get(symbol.container) ?? -1) + 1, 3);
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
		const container = symbols[index]!.container;
		const parent = container === null ? -1 : (lastSeen.get(container) ?? -1);
		parentOf.push(parent);
		depth.push(parent === -1 ? 0 : Math.min(depth[parent]! + 1, 3));
		lastSeen.set(symbols[index]!.name, index);
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
export function flatRows(symbols: FileOutlineSymbol[], mode: Exclude<SymbolSortMode, 'line'>): OutlineRow[] {
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
	return sorted.map((symbol) => {
		const depth = containerDepth(symbol, depthOf);
		depthOf.set(symbol.name, depth);
		return { symbol, depth, toggle: false, key: rowKey(symbol) };
	});
}

export class SymbolWindowView {
	private readonly title: HTMLElement;

	private readonly filterInput: HTMLInputElement;

	private readonly body: HTMLElement;

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
	 *  is hidden — no covering symbol, no text to parse, the request still in flight,
	 *  failed, or superseded. */
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

	private readonly sash: HTMLElement;

	private graphCollapsed = false;

	/** The drag the sash is running — its window listeners end it. */
	private sashDrag: { startY: number; baseHeight: number; viewHeight: number } | null = null;

	onOpen?: (path: string, line: number) => void;

	/** The relation graph's plain click, shown in the Definition page — the host (boot)
	 *  pins the page, shows it and feeds it; the code page stays where it stands
	 *  (2026-11-23, the owner's direction: a relation click shows the jump in the
	 *  Definition page, the code page never jumps). */
	onShowDefinition?: (subject: DefinitionSubject) => void;

	constructor(private readonly container: HTMLElement) {
		container.classList.add('symbol-window');
		this.title = el('span', 'sw-title');
		this.filterInput = el('input', 'sw-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('symbols.window.filter');
		this.filterInput.setAttribute('aria-label', t('symbols.window.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filterText = this.filterInput.value.trim().toLowerCase();
			this.render();
		});
		this.sortButton = el('button', 'sw-sort');
		this.sortButton.addEventListener('click', () => this.cycleSort());
		const header = el('div', 'sw-header', [icon('symbol-class'), this.title, this.filterInput, this.sortButton]);
		this.paintSort();
		this.body = el('div', 'sw-list');
		this.graph = new RelationGraphView();
		this.graph.onOpen = (path, line) => this.onOpen?.(path, line);
		// The plain click's jump lands in the Definition page — the host's wiring pins,
		// shows and feeds it (the code page never jumps for a graph click).
		this.graph.onShowDefinition = (subject) => this.onShowDefinition?.(subject);
		// The declaration card's file read: the index speaks repo-relative paths and the
		// backend's read_file needs the absolute spelling, so the graph resolves through
		// the host's root (an absolute path passes through).
		this.graph.resolvePath = (path) => {
			const repo = this.provideRepo?.() ?? null;
			if (repo === null || /^([a-zA-Z]:[\\/]|\\|\/)/.test(path)) return path;
			const separator = repo.includes('\\') ? '\\' : '/';
			return repo.replace(/[\\/]+$/, '') + separator + path.replaceAll('/', separator);
		};
		this.graph.onPinChange = (pinned) => {
			if (!pinned) this.feedGraph();
		};
		this.graphSection = el('div', 'sw-graph');
		// The head keeps its own classes — `.sw-section` stays the outline's collapsible
		// sections' vocabulary, which the tests and the collapse reads ride on.
		this.graphHead = el('div', 'sw-graph-head');
		this.graphHead.setAttribute('role', 'button');
		// The head's click is the section's collapse; the graph's own controls riding in it
		// must keep their clicks for themselves.
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
			this.graph.controls
		);
	}

	private toggleGraph(): void {
		this.graphCollapsed = !this.graphCollapsed;
		this.graphSection.classList.toggle('collapsed', this.graphCollapsed);
		this.paintGraphHead();
		if (!this.graphCollapsed) {
			this.feedGraph();
			// A re-shown section has a real viewport again — frame what stands.
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
			// The split moved: the graph re-frames over its new viewport (only when the
			// bounds no longer fit — the user's pan and zoom stay otherwise).
			if (!this.graphCollapsed) window.requestAnimationFrame(() => this.graph.frame());
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	/** The covering symbol moved: remember it and refresh the locals — once per identity
	 *  change, never per keystroke. Runs after the highlight swap so a synchronous
	 *  hide-render below always lands on the settled DOM. The graph rides the same
	 *  identity discipline: only an identity change re-roots it (and a collapsed section
	 *  is asked nothing — its re-show feeds it). */
	private noteCurrentSymbol(symbol: FileOutlineSymbol | null): void {
		if (this.localsOwnerKnown && sameIdentity(this.localsOwner, symbol)) return;
		this.localsOwner = symbol;
		this.localsOwnerKnown = true;
		void this.fetchLocals();
		this.feedGraph();
	}

	/** The hover card's jump: root the graph on the hovered symbol, pinned so the
	 *  cursor-follow never clobbers it, and make sure the section stands open. The
	 *  caller shows the view. */
	openGraphRoot(sym: { kind: string; name: string; path: string; line: number }): void {
		if (this.graphCollapsed) this.toggleGraph();
		this.graph.pinRoot(sym);
	}

	/** Root the graph on the covering symbol: the index speaks repo-relative paths, so the
	 *  editor's absolute path crosses through the host's root first. A pin freezes the
	 *  graph; no covering symbol (or no root to relativize against) empties it. */
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

	/** The active editor moved: remember the file, load it when the sidebar shows this
	 *  page (a hidden page marks dirty and waits for its refresh hook), and for the same
	 *  file move only the cursor highlight — the cursor advances on every keystroke and
	 *  must never re-query the index. */
	setFile(path: string | null, cursorLine?: number): void {
		this.targetPath = path;
		if (cursorLine !== undefined) this.cursorLine = cursorLine;
		if (path === null) {
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
		// A new file: drop the previous file's rows at once (they name another path) and
		// load, unless the page is hidden — its showView() refresh pulls then. The fold
		// state starts over: the keys name another file's symbols.
		this.collapsed.clear();
		this.generation++;
		this.loadedPath = null;
		this.loadingPath = null;
		this.failed = false;
		this.dirty = !this.visible();
		this.symbols = [];
		this.imports = [];
		this.resetLocals();
		this.render();
		if (!this.dirty) void this.load();
	}

	/** Re-pull the followed file's outline: a save or an external write may have moved it.
	 *  A hidden view records the debt; the showView hook re-asks with the view displayed.
	 *  The shown page's graph re-frames too — a feed that landed while the page was hidden
	 *  never saw a viewport, so its fit bailed and the graph would sit unframed. */
	refresh(): void {
		if (this.targetPath === null) return;
		if (!this.visible() || this.loadingPath !== null) {
			this.dirty = true;
			return;
		}
		if (!this.graphCollapsed) window.requestAnimationFrame(() => this.graph.frame());
		void this.load();
	}

	focusFilter(): void {
		this.filterInput.focus();
	}

	/** The sidebar page's on-screen state: the workbench hides every view with
	 *  `display: none`, so the inline style is the fact (jsdom answers it too). */
	private visible(): boolean {
		return this.container.style.display !== 'none';
	}

	private async load(): Promise<void> {
		const path = this.targetPath;
		if (path === null) return;
		// The outline is being re-read: the locals section drops (an edit may have moved
		// the enclosing function), and the highlight below re-derives the owner once.
		this.resetLocals();
		const generation = ++this.generation;
		this.loadingPath = path;
		this.failed = false;
		try {
			const outline = await symbolFileOutline(path);
			if (generation !== this.generation || this.targetPath !== path) return; // a newer ask superseded this one
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
		this.dirty = false;
		this.loadedPath = this.failed ? null : path;
		this.render();
		this.updateHighlight();
	}

	private render(): void {
		this.title.textContent = this.targetPath === null ? '' : baseName(this.targetPath);
		this.title.title = this.targetPath ?? '';
		this.body.textContent = '';
		this.renderedRows = [];
		this.renderedSymbols = [];
		this.currentRow = null;
		if (this.targetPath === null) {
			this.body.appendChild(el('div', 'sw-empty', [t('symbols.window.empty')]));
			return;
		}
		if (this.imports.length > 0) this.body.appendChild(this.importsSection());
		const locals = this.localsSection();
		if (locals !== null) this.body.appendChild(locals);
		if (this.loadedPath === null && !this.failed) return; // a load still owed (hidden page) — the list stays empty
		if (this.symbols.length === 0) {
			// No outline the index serves: null, failed, or a file it holds nothing for.
			this.body.appendChild(el('div', 'sw-empty', [t('symbols.window.noIndex')]));
			return;
		}
		const query = this.filterText;
		// The sort decides the shape: the line sort is the collapsible tree, the name and
		// type sorts the flat lists.
		const rows = this.sortMode === 'line' ? outlineRows(this.symbols, query, this.collapsed) : flatRows(this.symbols, this.sortMode);
		for (const row of rows) this.body.appendChild(this.symbolRow(row));
		this.updateHighlight();
	}

	/* ---------- The collapsible tree and the sort ---------- */

	private toggleCollapse(key: string): void {
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		this.render();
	}

	/** The tree commands: fold every container (line sort only — the fold constraint
	 *  answers the note otherwise), open everything, or open an asked number of tree
	 *  levels. */
	collapseAll(): void {
		if (this.sortMode !== 'line') {
			notify('info', t('symbols.window.sortedNote'));
			return;
		}
		for (const row of outlineRows(this.symbols, '', this.collapsed)) if (row.toggle) this.collapsed.add(row.key);
		this.render();
	}

	expandAll(): void {
		this.collapsed.clear();
		this.render();
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
		// N passes open the first N container levels: each pass re-lists what the
		// previous pass unfolded, so the newly visible depth answers the next.
		for (let level = 0; level < Math.min(8, Math.round(levels)); level++) {
			for (const row of outlineRows(this.symbols, '', this.collapsed)) {
				if (row.toggle && this.collapsed.has(row.key) && row.depth <= level) this.collapsed.delete(row.key);
			}
		}
		this.render();
	}

	/** The sort cycle: By Line → By Name → By Type → By Line. */
	cycleSort(): void {
		const at = SORT_ORDER.indexOf(this.sortMode);
		this.sortMode = SORT_ORDER[(at + 1) % SORT_ORDER.length]!;
		save('symbolWindow.sort', this.sortMode);
		this.paintSort();
		this.render();
	}

	private paintSort(): void {
		this.sortButton.textContent = '';
		this.sortButton.append(el('span', 'sw-sort-label', [t(SORT_LABELS[this.sortMode])]), icon('chevron-down'));
		this.sortButton.title = t('symbols.window.sortCycle');
		this.sortButton.setAttribute('aria-label', this.sortButton.title);
	}

	/** The palette's relation-window command: the three-view cycle, riding the graph
	 *  below whether its section stands open or not. */
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
			this.render();
		});
		section.appendChild(head);
		if (this.importsCollapsed) return section;
		for (const entry of this.imports) {
			const row = el('div', 'sw-import-row', [icon('file-code'), el('span', 'sw-name', [entry.name])]);
			// An include row is itself a jump — the click lands the
			// editor on the include's own line (a 0 or missing line is the file's first).
			const line = (entry.line ?? 0) + 1;
			row.title = `${path}:${line}`;
			row.addEventListener('click', () => this.onOpen?.(path, line));
			section.appendChild(row);
		}
		return section;
	}

	/** The "current function" section: the enclosing symbol's parameters and locals,
	 *  shown between the imports and the outline rows. Hidden whenever there is nothing
	 *  served for the cursor's position — no covering symbol, no text, no answer. */
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
			row.addEventListener('click', () => this.onOpen?.(path, def.line + 1));
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
		// The fold gutter: every row carries the slot — the container rows their +/-, the
		// leaves the empty one, so the indents line up.
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
		// The container chain's depth as padding — the row structure stays untouched.
		if (entry.depth > 0) row.style.paddingLeft = `${8 + entry.depth * 14}px`;
		row.addEventListener('click', () => this.onOpen?.(path, symbol.line + 1));
		this.renderedRows.push(row);
		this.renderedSymbols.push(symbol);
		return row;
	}

	/** The innermost symbol whose [line, endLine] holds the cursor's line carries the
	 *  `current` class — exactly one row, and only a change to which row that is
	 *  touches the DOM. A change also keeps the row on screen (the cursor follow:
	 *  the current function stays visible as the caret roams) — never on every
	 *  keystroke, which would jitter, and never on a hidden page, which has no layout.
	 *  The same pass re-derives the locals' owner over the whole outline (the filter
	 *  hides rows, never the cursor's own function); only an identity change asks. */
	private updateHighlight(): void {
		let next: HTMLElement | null = null;
		let start = -1;
		for (let index = 0; index < this.renderedSymbols.length; index++) {
			const symbol = this.renderedSymbols[index]!;
			if (this.cursorLine < symbol.line || this.cursorLine > symbol.endLine) continue;
			// The greatest declaration start among the covers is the innermost scope.
			if (symbol.line >= start) {
				start = symbol.line;
				next = this.renderedRows[index] ?? null;
			}
		}
		if (next !== this.currentRow) {
			this.currentRow?.classList.remove('current');
			next?.classList.add('current');
			this.currentRow = next;
			if (next !== null && this.visible()) next.scrollIntoView({ block: 'nearest' });
		}
		this.noteCurrentSymbol(this.coveringSymbol());
	}

	/** The symbol the cursor's line belongs to — the locals' owner and the relation
	 *  graph's root, over the full outline (not the filtered rows). A span reaching past
	 *  its own first line is an enclosing scope (the function whose body holds the
	 *  cursor), and the innermost of those wins: a one-line entry declaring a name on
	 *  the very line sits inside that scope, and its own bare ring is never the root.
	 *  Only when nothing encloses the line does the line's own entry answer. */
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

	/** Ask for the owner's locals. The host's text decides everything: no callback, a
	 *  null answer, or no covering symbol keeps the section hidden; a failure hides it
	 *  silently (the owner stays remembered, so roaming inside the function never
	 *  retries); a superseded answer is dropped by its generation. */
	private async fetchLocals(): Promise<void> {
		const symbol = this.localsOwner;
		const path = this.targetPath;
		const provide = this.provideText;
		const generation = ++this.localsGen;
		const had = this.locals !== null;
		this.locals = null;
		if (symbol === null || path === null || provide === undefined) {
			if (had) this.render();
			return;
		}
		const text = provide();
		if (text === null) {
			if (had) this.render();
			return;
		}
		try {
			const defs = await symbolLocals(text, extOf(path), this.cursorLine);
			if (generation !== this.localsGen) return;
			this.locals = defs ?? [];
		} catch {
			return; // the parse failed — the section stays hidden
		}
		this.render();
	}

	/** Drop the locals and forget their owner: every outline reload (and every file
	 *  switch) starts the section over, and the in-flight answers die with the bump. */
	private resetLocals(): void {
		this.localsOwner = null;
		this.localsOwnerKnown = false;
		this.locals = null;
		this.localsGen++;
	}
}
