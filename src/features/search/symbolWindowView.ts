// The Symbol Window sidebar page (module 5) — an outline window over the
// active editor's file: its includes/imports and the persistent index's per-file outline
// as one flat list. The workbench feeds it the active editor's path and cursor line
// (editorProviderViews' symbols, 0-based); a row click jumps to the declaration, and the
// row whose [line, endLine] span holds the cursor carries the highlight. The outline is
// one query per file change — the cursor only repaints a class.

import { symbolFileOutline } from '../../platform/ipc/symbols';

import { t } from '../../platform/i18n';
import { KIND_ICONS } from './contextView';
import { el, icon } from '../../platform/ui/index';

import type { FileOutlineImport, FileOutlineSymbol } from '../../platform/ipc/symbols';

import './symbolWindow.css';

/** The file's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
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

	onOpen?: (path: string, line: number) => void;

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
		const header = el('div', 'sw-header', [icon('symbol-structure'), this.title, this.filterInput]);
		this.body = el('div', 'sw-list');
		container.append(header, this.body);
		this.render();
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
			this.render();
			return;
		}
		if (path === this.loadedPath || path === this.loadingPath) {
			this.updateHighlight();
			return;
		}
		// A new file: drop the previous file's rows at once (they name another path) and
		// load, unless the page is hidden — its showView() refresh pulls then.
		this.generation++;
		this.loadedPath = null;
		this.loadingPath = null;
		this.failed = false;
		this.dirty = !this.visible();
		this.symbols = [];
		this.imports = [];
		this.render();
		if (!this.dirty) void this.load();
	}

	/** Re-pull the followed file's outline: a save or an external write may have moved it.
	 *  A hidden view records the debt; the showView hook re-asks with the view displayed. */
	refresh(): void {
		if (this.targetPath === null) return;
		if (!this.visible() || this.loadingPath !== null) {
			this.dirty = true;
			return;
		}
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
		if (this.loadedPath === null && !this.failed) return; // a load still owed (hidden page) — the list stays empty
		if (this.symbols.length === 0) {
			// No outline the index serves: null, failed, or a file it holds nothing for.
			this.body.appendChild(el('div', 'sw-empty', [t('symbols.window.noIndex')]));
			return;
		}
		const query = this.filterText;
		for (const symbol of this.symbols) {
			if (query !== '' && !symbol.name.toLowerCase().includes(query)) continue;
			this.body.appendChild(this.symbolRow(symbol));
		}
		this.updateHighlight();
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

	private symbolRow(symbol: FileOutlineSymbol): HTMLElement {
		const path = this.targetPath!;
		const row = el('div', 'sw-row');
		row.dataset['path'] = path;
		row.dataset['line'] = String(symbol.line);
		row.append(icon(KIND_ICONS[symbol.kind] ?? 'symbol-variable'));
		if (symbol.container) row.appendChild(el('span', 'sw-container', [`${symbol.container}·`]));
		row.appendChild(el('span', 'sw-name', [symbol.name]));
		row.appendChild(el('span', 'sw-line', [String(symbol.line + 1)]));
		row.addEventListener('click', () => this.onOpen?.(path, symbol.line + 1));
		this.renderedRows.push(row);
		this.renderedSymbols.push(symbol);
		return row;
	}

	/** The innermost symbol whose [line, endLine] holds the cursor's line carries the
	 *  `current` class — exactly one row, and only a change to which row that is
	 *  touches the DOM. A change also keeps the row on screen (the cursor follow:
	 *  the current function stays visible as the caret roams) — never on every
	 *  keystroke, which would jitter, and never on a hidden page, which has no layout. */
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
		if (next === this.currentRow) return;
		this.currentRow?.classList.remove('current');
		next?.classList.add('current');
		this.currentRow = next;
		if (next !== null && this.visible()) next.scrollIntoView({ block: 'nearest' });
	}
}
