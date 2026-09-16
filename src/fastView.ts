// The fast code viewer: a backend-rope document (ropey + syntect, pure Rust) rendered through
// a hand-rolled virtual scroller. Only the visible lines exist as DOM, and only the visible
// lines are highlighted — a million-line file opens as fast as its bytes can be read. A cold
// window (dragged far past every highlight checkpoint) is painted as plain text the moment
// its lines arrive and colored by `viewer_highlight` a beat later; the outline pane fills
// from `viewer_symbols` once the rows are up, so neither ever blocks the first paint.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { DocFindController, type DocFindHost, type DocFindMatch } from './docFind';
import { t } from './i18n';
import { settings } from './settings';
import { attachPageKeys, attachSmoothWheel, el, icon, notify, VirtualScroll, type SmoothWheelHandle } from './ui';

interface Symbol {
	kind: 'function' | 'method' | 'class' | 'struct' | 'interface' | 'enum' | 'module' | 'type';
	name: string;
	line: number;
}

interface OpenResult {
	docId: number;
	lineCount: number;
	language: string;
	syntaxName: string;
	/** Set locally: this document serves through the indexed command family. */
	indexed?: boolean;
}

interface LinesResult {
	startLine: number;
	lineCount: number;
	lines: [string, [number, number, string][]][];
	/** True when the lines above are plain text — the tokens are owed by `viewer_highlight`. */
	tokensPending: boolean;
}

/** Fixed line height keeps scroll math allocation-free; matches .cm-scroller's 19px so the
 *  viewer's text sits on exactly the same metrics as the editable editor. */
const LINE_HEIGHT = 19;
/** Lines kept rendered above and below the viewport, so small scrolls don't flash empty. */
const OVERSCAN = 10;
/** Rendered rows per refresh (viewport + overscan), the same budget the backend allows. */
const MAX_WINDOW = 500;
/** The outline pane's fixed item height (shell.css `.fast-outline-item`), for its virtual list. */
const OUTLINE_ITEM_HEIGHT = 22;

/** The codicon VS Code's outline uses per symbol kind. */
const SYMBOL_ICONS: Record<Symbol['kind'], string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-structure',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	module: 'symbol-module',
	type: 'symbol-parameter'
};

/** Scope-stack substrings → the theme's `--syntax-*` tokens (each theme defines them; the
 *  fallbacks are Dark+), checked most-specific first. The mapping matches cmTheme.ts so a
 *  file looks the same in the viewer, the editor, and under every theme. */
const SCOPE_COLORS: [string, string][] = [
	['comment', 'var(--syntax-comment, #6A9955)'],
	['string', 'var(--syntax-string, #CE9178)'],
	['constant.numeric', 'var(--syntax-number, #B5CEA8)'],
	['entity.name.function', 'var(--syntax-function, #DCDCAA)'],
	['support.function', 'var(--syntax-function, #DCDCAA)'],
	['entity.name.type', 'var(--syntax-type, #4EC9B0)'],
	['support.class', 'var(--syntax-type, #4EC9B0)'],
	['support.type', 'var(--syntax-type, #4EC9B0)'],
	['storage.type', 'var(--syntax-keyword, #569CD6)'],
	['storage', 'var(--syntax-keyword, #569CD6)'],
	['keyword', 'var(--syntax-keyword, #569CD6)'],
	['constant.language', 'var(--syntax-keyword, #569CD6)'],
	['constant.character', 'var(--syntax-char, #D7BA7D)'],
	['variable.language', 'var(--syntax-keyword, #569CD6)'],
	['variable.parameter', 'var(--syntax-parameter, #9CDCFE)'],
	['entity.other.attribute-name', 'var(--syntax-parameter, #9CDCFE)'],
	['tag', 'var(--syntax-keyword, #569CD6)'],
	['punctuation', 'var(--syntax-punctuation, #D4D4D4)']
];

function scopeColor(scope: string): string {
	for (const [needle, color] of SCOPE_COLORS) {
		if (scope.includes(needle)) return color;
	}
	return 'var(--vscode-editor-foreground, #D4D4D4)';
}

export interface FastViewOptions {
	/** "Edit" in the toolbar: swap this view for a real editor (the caller owns that flow). */
	onEdit?: () => void;
}

export class FastView {
	/** The view's root element — edit mode hides it while CodeMirror owns the pane. */
	readonly root: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly outline: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly spacer: HTMLElement;
	private readonly rows: HTMLElement;
	private open: OpenResult | null = null;
	/** The window-fetch command of the open document's family (rope or indexed). */
	private linesCommand: Parameters<typeof invoke>[0] = 'viewer_lines';
	/** True while the open document serves through the indexed, memory-bounded backend. */
	private indexed = false;
	/** The outline's symbols, fetched after the rows are up (`viewer_symbols`). */
	private symbols: Symbol[] = [];
	/** Line cache, 0-based → rendered row element. Missing lines are fetched on demand. */
	private cache = new Map<number, HTMLElement>();
	private fetching = new Set<number>();
	/** One window fetch in flight at a time. A fast drag fires a refresh per scroll event;
	 *  letting each issue its own fetch piles stale windows onto the backend ahead of the one
	 *  the viewport is waiting for. Later refreshes while a fetch is pending just mark
	 *  `refetch`, and the landing fetch picks up whatever is still missing. */
	private fetchInFlight = false;
	private refetch = false;
	/** The range a pending window owes tokens for, and whether `viewer_highlight` is out for
	 *  it — the same single-flight discipline as the line fetch, one color pass at a time. */
	private wantedTokens: [number, number] | null = null;
	private tokensInFlight = false;
	/** The outline's virtual list: its spacer, and the items currently materialised by index. */
	private outlineList: HTMLElement | null = null;
	private outlineItems = new Map<number, HTMLElement>();
	private lineHeight = LINE_HEIGHT;
	/** The scroll range for the document's lines — clamped and scaled past the layout
	 *  engines' height ceiling, so a multi-million-line file reaches its last line. */
	private range = new VirtualScroll(0, LINE_HEIGHT);
	/** The document-space offset the viewport is at (equals `scrollTop` until the range
	 *  scales; the row placement follows it from there). */
	private docTop = 0;
	/** The visible window the last refresh computed — what a landing fetch checks itself
	 *  against before placing rows. */
	private windowFirst = 0;
	private windowLast = Infinity;
	private disposed = false;
	/** The pane has no height while the tab is being opened, so the first refresh sees a zero
	 *  viewport and fetches too few lines; this fires again once layout gives the scroller its
	 *  real size, and on every later resize. (Absent under jsdom, where nothing lays out.) */
	private readonly sizer: ResizeObserver | null;
	/** The smooth wheel glide over the scroller (ui.ts), disposed with the view. */
	private readonly wheel: SmoothWheelHandle;
	/** PageUp/PageDown over the scroller (ui.ts): exactly one viewport of document rows per
	 *  press — the native page key would leap a viewport of *scrollbar* pixels, which a
	 *  scaled range multiplies into whole screens skipped at once. */
	private readonly pageKeys: SmoothWheelHandle;
	/** The whole-file find bar (docFind.ts) — read-only surface, find without replace. */
	private findBar: DocFindController | null = null;
	/** The staged open's landing event subscription (the exact line count replacing the
	 *  estimate the scroller started with). */
	private unlisten: UnlistenFn | null = null;
	/** The find's matches per rendered line, in the code-point columns `viewer_find` reports. */
	private matchMarks = new Map<number, [number, number][]>();
	/** The match the find bar names current, for the stronger mark. */
	private currentMatch: DocFindMatch | null = null;

	constructor(parent: HTMLElement, options: FastViewOptions = {}) {
		this.root = el('div', 'fast-view');
		this.toolbar = el('div', 'fast-toolbar');
		this.outline = el('div', 'fast-outline');
		this.scroller = el('div', 'fast-scroll');
		this.spacer = el('div', 'fast-spacer');
		this.rows = el('div', 'fast-rows');
		this.scroller.append(this.spacer, this.rows);
		const main = el('div', 'fast-main');
		main.append(this.outline, this.scroller);
		this.toolbar.hidden = true;
		this.outline.hidden = true;
		this.root.append(this.toolbar, main);
		parent.appendChild(this.root);
		if (options.onEdit) {
			const edit = el('button', 'fast-edit-btn', [icon('edit'), el('span', '', [t('viewer.edit')])]);
			edit.title = t('viewer.editTitle');
			edit.addEventListener('click', options.onEdit);
			this.toolbar.appendChild(edit);
		}
		this.scroller.addEventListener('scroll', () => this.refresh(), { passive: true });
		this.outline.addEventListener('scroll', () => this.refreshOutline(), { passive: true });
		this.wheel = attachSmoothWheel(this.scroller, {
			enabled: () => settings.smoothScrolling,
			sensitivity: () => settings.mouseWheelScrollSensitivity,
			fastSensitivity: () => settings.fastScrollSensitivity,
			zoom: () => this.range.documentPxPerScrollPx(this.scroller.clientHeight)
		});
		this.pageKeys = attachPageKeys(this.scroller, {
			range: () => this.range,
			rowHeight: () => this.lineHeight,
			// The jsdom DOM fires no scroll event for the write; the window due now must
			// not wait for one.
			paged: () => this.refresh()
		});
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { this.refresh(); this.refreshOutline(); });
		this.sizer?.observe(this.scroller);
		this.sizer?.observe(this.outline);
		// A huge file opens on its head with an estimated line count; the background tail's
		// landing delivers the exact one, and the scroller takes it in place.
		void listen<{ docId: number; lineCount: number }>('studio://viewer-lines', (event) => {
			if (this.open?.docId === event.payload.docId) this.resyncLineCount(event.payload.lineCount);
		}).then((unlisten) => {
			if (this.disposed) unlisten();
			else this.unlisten = unlisten;
		}).catch(() => undefined);
	}

	/** Open a file in the viewer. `indexed` serves it through the memory-bounded backend
	 *  (line index + windows read on demand) instead of the rope — the mode enormous files
	 *  and minified single-line monsters open in. Returns false when the backend refused it
	 *  (binary, missing…) so the caller can fall back to its normal open path. */
	async openFile(path: string, options: { indexed?: boolean } = {}): Promise<boolean> {
		const openCommand = options.indexed ? 'indexed_open' : 'viewer_open';
		const closeCommand = options.indexed ? 'indexed_close' : 'viewer_close';
		this.indexed = options.indexed ?? false;
		this.linesCommand = options.indexed ? 'indexed_lines' : 'viewer_lines';
		let info: OpenResult;
		try {
			info = await invoke<OpenResult>(openCommand, { path });
		} catch (error) {
			return false;
		}
		if (this.disposed) {
			void invoke(closeCommand, { docId: info.docId });
			return true;
		}
		if (this.open) void invoke(this.open.indexed ? 'indexed_close' : 'viewer_close', { docId: this.open.docId });
		this.open = { ...info, indexed: this.indexed };
		this.symbols = [];
		this.wantedTokens = null;
		this.cache.clear();
		this.fetching.clear();
		this.rows.textContent = '';
		// An empty toolbar (no Edit button configured) would show as a blank strip.
		this.toolbar.hidden = this.toolbar.childElementCount === 0;
		this.outline.hidden = true;
		this.outline.textContent = '';
		this.outlineList = null;
		this.outlineItems.clear();
		this.resyncLineCount(info.lineCount);
		// The outline scans the whole file; it is the backend's second delivery, asked for
		// only once the rows are on screen. The indexed tier has no outline (no rope, no
		// syntax walk), so the pane simply stays hidden there.
		const docId = info.docId;
		if (!this.indexed) {
			void invoke<Symbol[]>('viewer_symbols', { docId })
				.then((symbols) => {
					if (this.disposed || this.open?.docId !== docId) return;
					this.symbols = symbols;
					this.renderOutline(symbols);
				})
				.catch(() => undefined);
		}
		return true;
	}

	get docId(): number | null {
		return this.open?.docId ?? null;
	}

	get lineCount(): number {
		return this.open?.lineCount ?? 0;
	}

	/** The syntax name syntect picked, for the status bar's language item. */
	get languageName(): string | null {
		return this.open?.syntaxName ?? null;
	}

	revealLine(line: number): void {
		if (!this.open) return;
		const target = Math.max(0, Math.min(line, this.open.lineCount - 1));
		const clientHeight = this.scroller.clientHeight;
		const docTop = Math.max(0, (target - Math.floor(clientHeight / this.lineHeight / 2)) * this.lineHeight);
		this.scroller.scrollTop = this.range.scrollTopFor(docTop, clientHeight);
		this.refresh();
	}

	/** Pull the newly visible window from the backend. Runs on every scroll event; the line
	 *  cache makes it a no-op unless the viewport actually moved. */
	private refresh(): void {
		if (!this.open || this.disposed) return;
		const clientHeight = this.scroller.clientHeight;
		const scrollTop = this.scroller.scrollTop;
		const docTop = this.range.documentTop(scrollTop, clientHeight, this.scroller.scrollHeight);
		// Under a scaled range the rows are placed viewport-relative (their document-space
		// offsets would themselves be clamped away) and must follow every scroll; unscaled
		// they stay document-space and the engine scrolls them natively.
		if (docTop !== this.docTop) {
			this.docTop = docTop;
			if (this.range.scaled) {
				for (const [line, node] of this.cache) node.style.top = `${Math.round(line * this.lineHeight - docTop + scrollTop)}px`;
			}
		}
		const visible = Math.ceil(clientHeight / this.lineHeight);
		const first = Math.max(0, Math.floor(docTop / this.lineHeight) - OVERSCAN);
		const last = Math.min(this.open.lineCount - 1, first + visible + OVERSCAN * 2);
		this.windowFirst = first;
		this.windowLast = last;
		const wanted: number[] = [];
		for (let line = first; line <= last; line++) {
			if (!this.cache.has(line) && !this.fetching.has(line)) wanted.push(line);
		}
		// Keep the DOM bounded: rows scrolled far away are dropped.
		for (const [line, node] of this.cache) {
			if (line < first - OVERSCAN * 2 || line > last + OVERSCAN * 2) {
				node.remove();
				this.cache.delete(line);
			}
		}
		if (wanted.length === 0) return;
		if (this.fetchInFlight) {
			this.refetch = true;
			return;
		}
		const start = wanted[0]!;
		const end = Math.min(wanted[wanted.length - 1]!, start + MAX_WINDOW - 1);
		for (let line = start; line <= end; line++) this.fetching.add(line);
		this.fetchInFlight = true;
		const docId = this.open.docId;
		invoke<LinesResult>(this.linesCommand, { docId, start, end })
			.then((result) => {
				this.fetchInFlight = false;
				if (!this.disposed && this.open?.docId === docId) {
					result.lines.forEach(([text, tokens], index) => {
						const line = result.startLine + index;
						this.fetching.delete(line);
						// A fetch lands after the viewport moved on (a scaled drag covers
						// millions of lines in one bound): a row outside the current window
						// is dropped, not placed — its viewport-relative offset would mean
						// nothing.
						if (line < this.windowFirst || line > this.windowLast) return;
						if (this.cache.has(line)) return;
						const row = this.renderRow(line, text, tokens);
						this.cache.set(line, row);
						this.place(row, line);
					});
					// A cold window owes its colors: the rows are up as plain text, now ask
					// for the tokens without holding the content hostage to them.
					if (result.tokensPending) this.queueTokens(result.startLine, result.startLine + result.lines.length - 1);
				}
				// The viewport moved while this window was in flight (a drag — or another file
				// opened past it): fetch what the current position is still missing, since no
				// scroll event will come to ask for it.
				if (this.refetch) {
					this.refetch = false;
					this.refresh();
				}
			})
			.catch((error) => {
				this.fetchInFlight = false;
				this.refetch = false;
				// Release the range: kept in `fetching`, these lines would never be retried.
				for (let line = start; line <= end; line++) this.fetching.delete(line);
				notify('error', String(error));
			});
	}

	/** Remember that `start..end` is on screen without its tokens and pump the single
	 *  outstanding `viewer_highlight` if none is out. */
	private queueTokens(start: number, end: number): void {
		this.wantedTokens = [start, end];
		this.pumpTokens();
	}

	private pumpTokens(): void {
		if (this.tokensInFlight || !this.wantedTokens || !this.open || this.disposed) return;
		const [start, end] = this.wantedTokens;
		this.wantedTokens = null;
		this.tokensInFlight = true;
		const docId = this.open.docId;
		invoke<LinesResult>('viewer_highlight', { docId, start, end })
			.then((result) => {
				this.tokensInFlight = false;
				if (this.disposed || this.open?.docId !== docId) return;
				result.lines.forEach(([text, tokens], index) => {
					const line = result.startLine + index;
					const existing = this.cache.get(line);
					if (!existing) return; // scrolled away — the refetch colors it instead
					const row = this.renderRow(line, text, tokens);
					existing.replaceWith(row);
					this.cache.set(line, row);
				});
				this.pumpTokens();
			})
			.catch((error) => {
				this.tokensInFlight = false;
				// A superseded walk is a cancelled one (a newer window bumped the backend's
				// generation): whatever range was queued while it ran is still wanted — pump
				// it rather than dropping it, or those rows would stay plain forever. A real
				// error just gives up on coloring this window.
				if (String(error).includes('superseded')) {
					this.pumpTokens();
				} else {
					this.wantedTokens = null;
					notify('error', String(error));
				}
			});
	}

	private place(row: HTMLElement, line: number): void {
		// Viewport-relative under a scaled range: the line's document offset, pulled back by
		// how far the scroll position and that offset differ (`+ scrollTop` is what keeps
		// the row on screen — without it a scaled scroll lands everything far above the
		// viewport, blank). Unscaled, document-space, exactly as before.
		row.style.top = this.range.scaled ? `${Math.round(line * this.lineHeight - this.docTop + this.scroller.scrollTop)}px` : `${line * this.lineHeight}px`;
		// Rows arrive out of order; insert before the first row with a larger line.
		const key = (node: HTMLElement) => Number(node.dataset.line);
		let after: HTMLElement | null = null;
		for (const node of Array.from(this.rows.children) as HTMLElement[]) {
			if (key(node) > line) {
				after = node;
				break;
			}
		}
		this.rows.insertBefore(row, after);
	}

	private renderRow(line: number, text: string, tokens: [number, number, string][]): HTMLElement {
		const row = el('div', 'fast-row');
		row.dataset.line = String(line);
		const gutter = el('span', 'fast-gutter', [String(line + 1)]);
		const code = el('span', 'fast-code');
		const chars = Array.from(text); // token offsets are code points, not UTF-16 units
		let at = 0;
		for (const [start, end, scope] of tokens) {
			if (start > at) this.appendRun(code, chars, at, start, line);
			const span = el('span');
			span.style.color = scopeColor(scope);
			this.appendRun(span, chars, start, end, line);
			code.appendChild(span);
			at = end;
		}
		if (at < chars.length) this.appendRun(code, chars, at, chars.length, line);
		row.append(gutter, code);
		return row;
	}

	/** Append `chars[from..to)` to `parent`, wrapping the find-marked sub-ranges in `<mark>`
	 *  elements — nested inside a token span so the syntax colour shows through the mark. */
	private appendRun(parent: HTMLElement, chars: string[], from: number, to: number, line: number): void {
		const marks = this.matchMarks.get(line) ?? [];
		let at = from;
		while (at < to) {
			const hit = marks.find(([start, end]) => start <= at && at < end);
			const stop = hit
				? Math.min(hit[1], to)
				: marks.reduce((next, [start]) => (start > at ? Math.min(next, start) : next), to);
			const text = chars.slice(at, stop).join('');
			if (hit) {
				const current = this.currentMatch !== null
					&& this.currentMatch.line === line
					&& this.currentMatch.startCol === hit[0];
				const mark = el('mark', current ? 'fast-match current' : 'fast-match');
				mark.textContent = text;
				parent.appendChild(mark);
			} else {
				parent.appendChild(document.createTextNode(text));
			}
			at = stop;
		}
	}

	/** The outline pane is virtual like the rows: a big source file carries thousands of
	 *  symbols (the backend caps them at 20,000), and building a DOM node for each would
	 *  cost more than the open itself. Only the items in view exist. */
	private renderOutline(symbols: Symbol[]): void {
		this.outline.textContent = '';
		this.outlineItems.clear();
		if (symbols.length === 0) {
			this.outline.hidden = true;
			this.outlineList = null;
			return;
		}
		this.outline.hidden = false;
		this.outline.appendChild(el('div', 'fast-outline-title', ['Outline']));
		this.outlineList = el('div', 'fast-outline-list');
		this.outlineList.style.height = `${symbols.length * OUTLINE_ITEM_HEIGHT}px`;
		this.outline.appendChild(this.outlineList);
		this.refreshOutline();
	}

	/** Materialise the outline items in (and just around) the pane's viewport. */
	private refreshOutline(): void {
		const list = this.outlineList;
		if (!this.open || !list) return;
		const symbols = this.symbols;
		// Under jsdom the pane has no height: everything up to the overscan is rendered.
		const visible = Math.ceil((this.outline.clientHeight || OUTLINE_ITEM_HEIGHT * OVERSCAN) / OUTLINE_ITEM_HEIGHT);
		const first = Math.max(0, Math.floor(this.outline.scrollTop / OUTLINE_ITEM_HEIGHT) - OVERSCAN);
		const last = Math.min(symbols.length - 1, first + visible + OVERSCAN * 2);
		for (const [index, node] of this.outlineItems) {
			if (index < first || index > last) {
				node.remove();
				this.outlineItems.delete(index);
			}
		}
		for (let index = first; index <= last; index++) {
			if (this.outlineItems.has(index)) continue;
			const symbol = symbols[index]!;
			const glyph = icon(SYMBOL_ICONS[symbol.kind] ?? 'symbol-method');
			const item = el('div', 'fast-outline-item', [glyph, el('span', '', [symbol.name])]);
			item.title = `${symbol.name} — line ${symbol.line + 1}`;
			item.style.top = `${index * OUTLINE_ITEM_HEIGHT}px`;
			item.addEventListener('click', () => this.revealLine(symbol.line));
			this.outlineItems.set(index, item);
			list.appendChild(item);
		}
	}

	/** Rows for lines the backend re-highlighted after an edit: drop them so the next scroll
	 *  refetches fresh tokens. */
	invalidate(fromLine: number): void {
		for (const [line, node] of this.cache) {
			if (line >= fromLine) {
				node.remove();
				this.cache.delete(line);
			}
		}
		this.refresh();
	}

	resyncLineCount(lineCount: number): void {
		if (this.open) this.open.lineCount = lineCount;
		this.range = new VirtualScroll(lineCount, this.lineHeight, Math.max(0, this.scroller.clientHeight - this.lineHeight));
		this.range.lay(this.spacer);
		this.refresh();
	}

	/* ---------- The whole-file find bar (docFind.ts), find without replace ---------- */

	/** Open the find bar: Ctrl+F for a file too large for an editable document at all. */
	openFind(): void {
		if (!this.findBar) {
		const host: DocFindHost = {
			docId: () => this.open?.docId ?? null,
			findCommand: () => (this.indexed ? 'indexed_find' : 'viewer_find'),
			position: () => ({ line: Math.max(0, Math.floor(this.docTop / this.lineHeight)), col: 0 }),
				revealMatch: (match) => {
					this.currentMatch = match;
					this.revealLine(match.line);
				},
				paintMatches: (matches, current) => {
					this.matchMarks = new Map();
					for (const match of matches) {
						const list = this.matchMarks.get(match.line) ?? [];
						list.push([match.startCol, match.endCol]);
						this.matchMarks.set(match.line, list);
					}
					this.currentMatch = current;
					// Rows are cached DOM: drop them so the next refresh renders the marks.
					this.invalidate(0);
				},
				focusEditor: () => this.scroller.focus()
			};
			this.findBar = new DocFindController(host, this.root, false);
		}
		this.findBar.open(false);
	}

	dispose(): void {
		this.disposed = true;
		this.sizer?.disconnect();
		this.wheel.dispose();
		this.pageKeys.dispose();
		this.unlisten?.();
		this.unlisten = null;
		this.findBar?.destroy();
		this.findBar = null;
		if (this.open) void invoke(this.open.indexed ? 'indexed_close' : 'viewer_close', { docId: this.open.docId });
		this.root.remove();
	}
}
