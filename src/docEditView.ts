// The editable windowed editor for large text files: the document lives in the backend's
// rope (the viewer's own document store), and the webview only ever holds a small window of
// lines around the viewport in a CodeMirror instance. Editing, scrolling, undo and save all
// cost the same whether the file is 9 MB or 200 MB — the whole-document round trips that
// froze the full editor never happen; only the changed lines cross the IPC.
//
// Scrolling is the row model's (scroll/): the viewport's top is a whole-file line the model
// owns, projected onto CodeMirror's own scroller as `(top − first) × lineHeight`. A window
// slide replaces the text and re-projects the same top, so the view never moves when a
// fetch lands; the drawn scrollbar spans the whole file; and the wheel, the page keys and
// the reveals all go through the model — no scroll event is ever an input, except the
// scroller's own moves (CodeMirror keeping the caret in view), which are read back into it.

import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { attachWheel, type Disposable } from './scroll/input';
import { type AutoscrollStrategy, ScrollModel, VERTICAL_SCROLL_MARGIN } from './scroll/model';
import { Scrollbar } from './scroll/scrollbar';
import { defaultKeymap } from '@codemirror/commands';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { DocFindController, type DocFindHost, type DocFindMatch, type DocFindSpec } from './docFind';
import { toggleBlockComment, toggleLineComment } from './comments';
import { vscodeHighlighting } from './cmTheme';
import { el, notify } from './ui';
import { Channel, invoke } from '@tauri-apps/api/core';

interface OpenInfo {
	docId: number;
	lineCount: number;
	syntaxName: string;
	encoding: string;
	eol: 'lf' | 'crlf';
}

interface TextWindow {
	startLine: number;
	lineCount: number;
	lines: string[];
}

/** One save-progress report from `viewer_save` (`src-tauri/src/viewer/mod.rs`): bytes of
 *  the document streamed out so far, and the document's whole byte size. */
interface SaveProgress {
	written: number;
	total: number;
}

/** The window size, matching the backend's `MAX_WINDOW` so one `viewer_text` call fills it. */
const WINDOW = 500;
/** When the viewport comes within this many lines of the window's edge, the window slides. */
const EDGE = 120;
/** How long after the last keystroke the changed lines are sent to the backend's rope. */
const SYNC_DELAY_MS = 150;
/** How long after a window lands the scroller's own moves are treated as CodeMirror
 *  re-anchoring over the replaced text (a viewport re-render can collapse the content
 *  height a frame or two later and zero the scroller) and re-asserted against. */
const LANDING_SETTLE_MS = 500;
/** How long after a synced edit the hot-exit backup is written (backend-side, no payload). */
const BACKUP_DELAY_MS = 3000;

/* ---------- The whole-file find's window decorations ---------- */

/** One match inside the loaded window, in CodeMirror's UTF-16 positions. */
interface WindowMatch {
	from: number;
	to: number;
	current: boolean;
}

const setWindowMatches = StateEffect.define<WindowMatch[]>();

/** The match highlighting of the whole-file find: every match inside the loaded window,
 *  with the current one stronger — the same classes CodeMirror's own search paints, so
 *  both editors look alike under every theme. */
const windowMatchField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, transaction) {
		value = value.map(transaction.changes);
		for (const effect of transaction.effects) {
			if (effect.is(setWindowMatches)) {
				value = Decoration.set(
					effect.value.map((match) =>
						Decoration
							.mark({ class: match.current ? 'cm-searchMatch-selected' : 'cm-searchMatch' })
							.range(match.from, match.to)
					)
				);
			}
		}
		return value;
	},
	provide: (field) => EditorView.decorations.from(field)
});

/** A code-point column on a line to the UTF-16 offset CodeMirror addresses it by. */
function utf16Col(lineText: string, cp: number): number {
	if (cp <= 0) return 0;
	let units = 0;
	for (const char of Array.from(lineText).slice(0, cp)) units += char.length;
	return units;
}

/** A UTF-16 offset on a line to its code-point column — the unit `viewer_find` reports. */
function codePointCol(lineText: string, utf16: number): number {
	return Array.from(lineText.slice(0, utf16)).length;
}

export class EditableDocView {
	readonly root: HTMLElement;
	/** The viewport: the host fills it, the drawn scrollbar sits on its edge. */
	private readonly viewport: HTMLElement;
	private readonly host: HTMLElement;
	private cm: EditorView | null = null;
	private docId: number | null = null;
	private path = '';
	private lineCount = 0;
	private syntax = '';
	/** The 0-based line the current window starts at. */
	private first = 0;
	/** The window's lines exactly as the backend holds them (the last synced state). */
	private synced: string[] = [];
	private lineHeight = 19;
	/** The viewport's position over the whole document, in lines (scroll/model.ts). */
	readonly scroll: ScrollModel;
	private readonly scrollbar: Scrollbar;
	/** The scroller position the model was last projected to (after the DOM's own clamp),
	 *  so a scroll event carrying that value is known to be ours and not CodeMirror's. */
	private projected = 0;
	/** A window just landed: replacing the text resets CodeMirror's scroller, and that
	 *  reset is a layout artifact, not a position — reading it back would drag the model
	 *  to wherever the window starts (a drag to the file's end loses its place to it).
	 *  Until the landing settles, the scroller's own moves are re-asserted against (the
	 *  model's word stands, CodeMirror's re-anchor included); the timeout is the unwedge
	 *  and the settle's last word. */
	private landing = 0;
	/** A slide is queued or in flight: the model may run ahead of the window meanwhile, and
	 *  the landing re-checks the edges rather than piling a second slide on the first. */
	private sliding = false;
	private readonly sizer: ResizeObserver | null;
	private syncTimer: number | undefined;
	private backupTimer: number | undefined;
	/** Edits are sent strictly one at a time, chained through this promise. */
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	/** Set when a send failed: the next sync resends the whole window instead of a diff. */
	private needsFullResync = false;
	/** True only for the dispatches that put fetched window text into the view, so the
	 *  update listener can tell them from the user's edits. */
	private replacing = false;
	/** True from the first keystroke until the save that lands it: a file-change event in
	 *  that window (usually our own watcher echo) must not reload the document out from
	 *  under unsynced or just-typed edits. */
	private touched = false;
	/** The whole-file find/replace bar, mounted on first open (docFind.ts). */
	private findBar: DocFindController | null = null;
	/** The staged open's landing event subscription (the exact line count replacing the
	 *  estimate the scroller started with). */
	private unlisten: UnlistenFn | null = null;
	/** The wheel over CodeMirror's scroller (scroll/input.ts), attached with the editor. */
	private wheel: Disposable | null = null;

	/** The buffer became dirty (the editor group marks the tab). */
	onChanged: (() => void) | null = null;
	/** The cursor moved (the editor group refreshes the status bar's line and column). */
	onStatusChange: (() => void) | null = null;
	/** Ctrl+S inside the window. */
	onSaveRequest: (() => void) | null = null;
	/** The save's progress as the backend streams the rope out (`null` clears it). The
	 *  editor group forwards this straight to the status bar's save item. */
	onSaveProgress: ((progress: { written: number; total: number } | null) => void) | null = null;

	constructor(parent: HTMLElement) {
		this.root = el('div', 'doc-edit');
		this.viewport = el('div', 'doc-edit-viewport');
		this.host = el('div', 'doc-edit-host');
		this.viewport.appendChild(this.host);
		this.root.appendChild(this.viewport);
		parent.appendChild(this.root);
		this.scroll = new ScrollModel(this.lineHeight);
		this.scroll.onChange(() => {
			this.project();
			this.checkEdges();
		});
		this.scrollbar = new Scrollbar(this.viewport, this.scroll);
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout());
		this.sizer?.observe(this.viewport);
		// A huge file opens on its head with an estimated line count; the background tail's
		// landing delivers the exact one, and the model takes it in place.
		void listen<{ docId: number; lineCount: number }>('studio://viewer-lines', (event) => {
			if (this.docId === event.payload.docId) {
				this.lineCount = event.payload.lineCount;
				this.relayout();
			}
		}).then((unlisten) => {
			if (this.disposed) unlisten();
			else this.unlisten = unlisten;
		}).catch(() => undefined);
	}

	/** Open a file into the windowed editor. False when the backend refused it (binary,
	 *  unreadable) so the caller can fall back to its usual open path. */
	async openFile(path: string): Promise<boolean> {
		let info: OpenInfo;
		try {
			info = await invoke<OpenInfo>('viewer_open', { path });
		} catch {
			return false;
		}
		if (this.disposed) {
			void invoke('viewer_close', { docId: info.docId });
			return true;
		}
		this.docId = info.docId;
		this.path = path;
		this.lineCount = info.lineCount;
		this.syntax = info.syntaxName;
		this.buildEditor();
		await this.showWindow(0);
		return true;
	}

	/** The syntax name syntect picked, for the status bar's language item. */
	get languageName(): string | null {
		return this.syntax || null;
	}

	/** The window's CodeMirror view — the small editable slice, not the whole document. */
	get editorView(): EditorView | null {
		return this.cm;
	}

	private buildEditor(): void {
		this.cm = new EditorView({
			state: EditorState.create({
				// Absolute line numbers: the gutter's own 1-based number plus the window's offset.
				extensions: [
					lineNumbers({ formatNumber: (n) => String(n + this.first) }),
					highlightSpecialChars(),
					drawSelection(),
					EditorState.allowMultipleSelections.of(true),
					highlightActiveLine(),
					// The whole-file find's match highlighting (the bar itself is docFind.ts,
					// driven by `viewer_find` — CodeMirror's own search sees only the window).
					windowMatchField,
					keymap.of([
						{ key: 'Mod-f', preventDefault: true, run: () => (this.openFind(), true) },
						{ key: 'Mod-h', preventDefault: true, run: () => (this.openReplace(), true) },
						{ key: 'F3', preventDefault: true, run: () => (this.findStep(1), true) },
						{ key: 'Shift-F3', preventDefault: true, run: () => (this.findStep(-1), true) },
						{ key: 'Mod-s', preventDefault: true, run: () => (this.onSaveRequest?.(), true) },
						{ key: 'Mod-/', preventDefault: true, run: (view) => toggleLineComment(view, this.path) },
					{ key: 'Shift-Alt-a', preventDefault: true, run: (view) => toggleBlockComment(view, this.path) },
					{ key: 'Mod-z', preventDefault: true, run: () => (void this.undo(), true) },
						{ key: 'Mod-Z', preventDefault: true, run: () => (void this.redo(), true) },
						{ key: 'Mod-y', preventDefault: true, run: () => (void this.redo(), true) },
						// PageUp / PageDown are this editor's own (Zed's MovePageUp/Down): the caret
						// walks a viewport less one line and the model's autoscroll brings the
						// view after it, sliding the window when the landing line is outside it.
						// Shift keeps the caret move: a selection cannot span lines the window has
						// not loaded.
						{ key: 'PageUp', preventDefault: true, run: () => (this.pageBy(-1), true), shift: () => (this.pageBy(-1), true) },
						{ key: 'PageDown', preventDefault: true, run: () => (this.pageBy(1), true), shift: () => (this.pageBy(1), true) },
						// Alt-ArrowLeft / Alt-ArrowRight stay the workbench's Go Back / Forward;
						// PageUp / PageDown are the pair above.
						...defaultKeymap.filter((binding) => !['Alt-ArrowLeft', 'Alt-ArrowRight', 'PageUp', 'PageDown'].includes(binding.key ?? ''))
					]),
					vscodeHighlighting,
					// The caret's own moves keep Zed's margin from the viewport's edges: CodeMirror
					// scrolls its own scroller for them, and the scroll listener below reads
					// that back into the model.
					EditorView.scrollMargins.of(() => ({ top: VERTICAL_SCROLL_MARGIN * this.lineHeight, bottom: VERTICAL_SCROLL_MARGIN * this.lineHeight })),
					EditorView.updateListener.of((update) => {
						// A window swap rewrites the whole view: that is our own text arriving, not
						// the user typing — it must not dirty the document or schedule a sync.
						if (update.docChanged && !this.replacing) {
							this.touched = true;
							this.scheduleSync();
							// Typing against a window edge slides the window along with the cursor.
							const line = update.state.doc.lineAt(update.state.selection.main.head).number - 1;
							if (line < EDGE / 2 || line > this.synced.length - EDGE / 2) void this.ensureAround(this.first + line, false);
						}
						if (update.docChanged || update.selectionSet) this.onStatusChange?.();
					})
				]
			}),
			parent: this.host
		});
		this.lineHeight = this.cm.defaultLineHeight || 19;
		this.scroll.setRowHeight(this.lineHeight);
		const scrollDOM = this.cm.scrollDOM;
		// The wheel lands in the model; the scroller's vertical scroll is the model's
		// projection and stays its own (a caret reveal writes it too).
		this.wheel = attachWheel(scrollDOM, this.scroll, { ownVerticalScroll: true });
		scrollDOM.addEventListener('scroll', () => this.onScrollerMoved(), { passive: true });
		this.layout();
		this.measureRowHeight();
	}

	/** `defaultLineHeight` read before CodeMirror's first measure is the height oracle's
	 *  placeholder (14 px), not the font's real line — every projection until the first
	 *  window slide would be scaled by it. Read it again once measured. */
	private measureRowHeight(): void {
		const cm = this.cm;
		if (!cm) return;
		cm.requestMeasure({
			read: () => cm.defaultLineHeight,
			write: (rowHeight) => {
				if (this.disposed || this.cm !== cm || !rowHeight || rowHeight === this.lineHeight) return;
				this.lineHeight = rowHeight;
				this.scroll.setRowHeight(rowHeight);
				this.project();
			}
		});
	}

	/** Replace the window with lines `start..start+WINDOW` of the backend document. The
	 *  model's top is untouched: the new text is projected under the same position, so a
	 *  slide never moves the view (a reveal moves the model itself, before or after). */
	private async showWindow(start: number, cursorLine?: number, cursorColumn?: number): Promise<void> {
		if (!this.cm || this.docId === null) return;
		const docId = this.docId;
		const end = Math.min(start + WINDOW - 1, this.lineCount - 1);
		let fetched: TextWindow;
		try {
			fetched = await invoke<TextWindow>('viewer_text', { docId, start, end });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (this.disposed || this.docId !== docId || !this.cm) return;
		// Where the cursor sits now, captured before the replace resets it: an explicit
		// `cursorLine` (a reveal, an undo) wins over "keep the current position", and a slide
		// keeps both the line and the column. A jump to a *different* line lands at the
		// column it asked for, else column 0 — the old line's column is not where the user was.
		const head = this.cm.state.selection.main.head;
		const oldLine = this.cm.state.doc.lineAt(head);
		const target = cursorLine ?? this.first + oldLine.number - 1;
		const column = cursorColumn ?? (target === this.first + oldLine.number - 1 ? head - oldLine.from : 0);
		this.first = fetched.startLine;
		this.synced = fetched.lines;
		this.lineCount = fetched.lineCount;
		const text = fetched.lines.join('\n');
		this.replacing = true;
		this.landing = Date.now();
		try {
			this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: text } });
			const relative = Math.max(0, Math.min(target - this.first, fetched.lines.length - 1));
			const line = this.cm.state.doc.line(relative + 1);
			this.cm.dispatch({ selection: { anchor: Math.min(line.from + column, line.to) } });
		} finally {
			this.replacing = false;
		}
		this.relayout();
		window.setTimeout(() => {
			if (Date.now() - this.landing < LANDING_SETTLE_MS + 10) {
				this.landing = 0;
				// The settle's last word is the model's, in case the re-anchor's final move
				// came after the last re-assert.
				this.project();
			}
		}, LANDING_SETTLE_MS);
		// The swap moved the window under matches whose absolute lines did not change:
		// repaint the decorations for the lines now loaded.
		this.findBar?.repaint();
	}

	/** The document or the window changed shape: the model takes the line count, the
	 *  past-the-end padding follows the window, and the same top is projected again. The
	 *  line height is re-read after the measure too — the oracle's placeholder must not
	 *  outlive the first real layout. The projection runs in CodeMirror's measure phase:
	 *  a write before it would clamp against the replaced document's not-yet-laid-out
	 *  height and strand a long-range landing a row into its new window. */
	private relayout(): void {
		const cm = this.cm;
		if (!cm) return;
		this.lineHeight = cm.defaultLineHeight || this.lineHeight;
		this.scroll.setRowHeight(this.lineHeight);
		this.scroll.setRowCount(this.lineCount);
		this.padPastEnd();
		cm.requestMeasure({
			read: () => null,
			write: () => {
				this.project();
				// CodeMirror re-anchors its own scroll over the replaced text inside the
				// same measure; the projection is asserted once more after it, with the
				// layout real, so the model's word is the one that stands.
				window.setTimeout(() => this.project(), 0);
			}
		});
		this.measureRowHeight();
	}

	/** The viewport was (re)laid out: the model takes its height. */
	private layout(): void {
		this.scroll.setViewport(this.viewport.clientHeight);
		this.padPastEnd();
		this.project();
	}

	/** The last window scrolls past its end (Zed's scroll_beyond_last_line = one_page): the
	 *  content is padded by a viewport less a line, so the file's last line can sit at the
	 *  viewport's top like the model says. Any other window ends where the next slide
	 *  begins and needs no padding. */
	private padPastEnd(): void {
		const atEnd = this.first + this.synced.length >= this.lineCount;
		const pad = atEnd ? Math.max(0, this.scroll.viewportHeight - this.lineHeight) : 0;
		this.host.style.setProperty('--doc-edit-pad', `${Math.round(pad)}px`);
	}

	/** Write the model's top onto CodeMirror's scroller: `(top − first) × lineHeight`,
	 *  which the DOM clamps to the window while a slide is still on its way. */
	private project(): void {
		const cm = this.cm;
		if (!cm) return;
		const scrollDOM = cm.scrollDOM;
		const target = Math.max(0, Math.round((this.scroll.top - this.first) * this.lineHeight));
		if (scrollDOM.scrollTop !== target) scrollDOM.scrollTop = target;
		this.projected = scrollDOM.scrollTop;
	}

	/** CodeMirror's scroller moved on its own — a caret reveal, a selection drag past the
	 *  edge: read the new position back into the model. A value the projection wrote (or
	 *  the DOM's clamp of it) is ours and changes nothing, and while a landing settles the
	 *  move is CodeMirror re-anchoring over replaced text — asserted against, not read. */
	private onScrollerMoved(): void {
		const cm = this.cm;
		if (!cm) return;
		const actual = cm.scrollDOM.scrollTop;
		if (actual === this.projected) return;
		if (Date.now() - this.landing < LANDING_SETTLE_MS) {
			this.project();
			return;
		}
		this.projected = actual;
		this.scroll.setTop(this.first + actual / this.lineHeight, 'autoscroll');
	}

	/** The window slides when the viewport nears its edge: one queued flush-then-fetch
	 *  (a slide racing an undo would otherwise overwrite the newer window with stale
	 *  lines), re-checked when it lands in case the viewport moved on meanwhile. The model
	 *  may run ahead of the window in between — the projection clamps, the fetch catches up. */
	private checkEdges(): void {
		if (!this.cm || this.docId === null || this.sliding || !this.viewportNearEdge()) return;
		this.sliding = true;
		void this.enqueue(async () => {
			try {
				// Re-read after the steps ahead in the queue (a reveal's own slide, say): the
				// viewport may sit comfortably inside the window by now.
				if (!this.viewportNearEdge()) return;
				if (!(await this.sendDiff()) || this.disposed || !this.cm || this.docId === null) return;
				const middle = Math.floor(this.scroll.top) + Math.floor(this.scroll.visibleLines / 2);
				const target = Math.max(0, Math.min(middle - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
				if (target !== this.first) await this.showWindow(target);
			} finally {
				this.sliding = false;
			}
			this.checkEdges();
		});
	}

	/** Whether the viewport stands within the edge band of the window, with lines beyond. */
	private viewportNearEdge(): boolean {
		if (this.lineCount <= this.synced.length) return false;
		const top = this.scroll.top;
		const windowEnd = this.first + this.synced.length;
		const nearTop = top < this.first + EDGE && this.first > 0;
		const nearBottom = top + this.scroll.visibleLines > windowEnd - EDGE && windowEnd < this.lineCount;
		return nearTop || nearBottom;
	}

	/** Bring `line` (0-based) into the window and the viewport. A `jump` (a reveal, a
	 *  go-to-line, a find match) also puts the cursor on it, at `column` (0-based), and
	 *  scrolls by `strategy` (Zed's autoscroll: `center` for a go-to-line, `fit` for a
	 *  match); the follow-the-cursor slide typing triggers at a window edge leaves the
	 *  cursor where the user has it. */
	private async ensureAround(line: number, jump = true, column = 0, strategy: AutoscrollStrategy = 'center'): Promise<void> {
		if (!this.cm || this.docId === null) return;
		const relative = line - this.first;
		const inside = relative >= EDGE / 2 && relative <= this.synced.length - EDGE / 2;
		const windowFor = (): number => Math.max(0, Math.min(line - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
		// Already comfortably inside, or the whole file is the window, or the line sits near
		// an edge the window cannot move past (the file's first or last window): no slide —
		// refetching the same window would only throw away whatever the user has typed
		// since the last sync — just the cursor and the scroll position.
		if (inside || this.lineCount <= this.synced.length || windowFor() === this.first) {
			if (jump) {
				this.placeCursor(line, column);
				this.scroll.autoscroll(line, strategy);
			}
			return;
		}
		await this.enqueue(async () => {
			if (this.disposed || !this.cm || this.docId === null) return;
			// A follow-the-cursor slide re-reads its need after the steps ahead of it — one
			// per keystroke at the edge was queued, and the first one centres the window.
			if (!jump) {
				const now = line - this.first;
				if (now >= EDGE / 2 && now <= this.synced.length - EDGE / 2) return;
			}
			if (!(await this.sendDiff()) || this.disposed || !this.cm || this.docId === null) return;
			const target = windowFor();
			if (target !== this.first) await this.showWindow(target, jump ? line : undefined, jump ? column : undefined);
			else if (jump) this.placeCursor(line, column);
			if (jump) {
				this.scroll.autoscroll(line, strategy);
				this.cm?.focus();
			}
		});
	}

	/** Put the cursor on an absolute line (0-based) that is inside the current window. The
	 *  scroll is the caller's (the model's autoscroll), not CodeMirror's. */
	private placeCursor(line: number, column: number): void {
		const cm = this.cm;
		if (!cm) return;
		const relative = line - this.first;
		if (relative < 0 || relative >= cm.state.doc.lines) return;
		const target = cm.state.doc.line(relative + 1);
		cm.dispatch({ selection: { anchor: Math.min(target.from + column, target.to) } });
	}

	/** PageUp / PageDown (Zed's `move_page_down`): the caret walks a viewport less one line
	 *  and the model's `fit` brings the view after it — a caret at the bottom margin pages
	 *  the view a full screen each press. Every press is a queued step, so a burst of them
	 *  each starts from where the previous one actually put the caret, a slide in between
	 *  or not; a landing line outside the window slides the window there first. */
	private pageBy(direction: 1 | -1): void {
		if (!this.cm || this.docId === null) return;
		void this.enqueue(async () => {
			const cm = this.cm;
			if (!cm || this.disposed || this.docId === null || this.scroll.viewportHeight <= 0) return;
			const head = cm.state.selection.main.head;
			const line = cm.state.doc.lineAt(head);
			const current = this.first + line.number - 1;
			const column = head - line.from;
			const target = Math.max(0, Math.min(current + direction * this.scroll.visibleRows, this.lineCount - 1));
			const relative = target - this.first;
			if (relative < 0 || relative >= this.synced.length) {
				if (!(await this.sendDiff()) || this.disposed || !this.cm || this.docId === null) return;
				const windowStart = Math.max(0, Math.min(target - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
				await this.showWindow(windowStart, target, column);
			} else {
				this.placeCursor(target, column);
			}
			this.scroll.autoscroll(target, 'fit');
		});
	}

	/** After a pause in typing: compute what changed between the window and its last synced
	 *  lines, and send just that slice to the backend's rope. */
	private scheduleSync(): void {
		if (this.syncTimer !== undefined) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = undefined;
			void this.sync();
		}, SYNC_DELAY_MS);
	}

	/** Run `step` after every earlier step (a sync, a slide, a history jump, a save) has
	 *  fully landed — and let the next step wait behind it. Steps catch their own errors;
	 * the belt here only keeps the chain alive. */
	private enqueue<T>(step: () => Promise<T>): Promise<T | undefined> {
		const run = this.queue.then(step);
		this.queue = run.then(() => undefined, () => undefined);
		return run.catch(() => undefined);
	}

	/** One sync step, queued so edits apply in order; a failed send marks the window for a
	 *  whole-window resend on the next sync — never a silent loss. */
	private sync(): Promise<void> {
		return this.enqueue(async () => {
			await this.sendDiff();
		});
	}

	/** Send the window's pending change to the backend. Resolves true when the backend now
	 *  holds exactly what the window shows, false when the send failed — the window then
	 *  still has text the document lacks, and no step may refetch the window over it (a
	 *  slide, an undo, a reload) or write the document out (a save) until a resend lands. */
	private async sendDiff(): Promise<boolean> {
		const cm = this.cm;
		if (!cm || this.docId === null || this.disposed) return false;
		const current = cm.state.doc.sliceString(0).split('\n');
		let startLine: number;
		let endLine: number; // exclusive, in the *old* (backend) line space
		let text: string;
		if (this.needsFullResync) {
			startLine = this.first;
			endLine = this.first + this.synced.length;
			// The range `(endLine, 0)` swallows the window's last newline unless the window
			// reaches the file's end: give it back, or the line below merges into the window.
			text = current.join('\n') + (endLine < this.lineCount ? '\n' : '');
			this.needsFullResync = false;
		} else {
			let prefix = 0;
			const limit = Math.min(current.length, this.synced.length);
			while (prefix < limit && current[prefix] === this.synced[prefix]) prefix++;
			let suffix = 0;
			while (
				suffix < limit - prefix &&
				current[current.length - 1 - suffix] === this.synced[this.synced.length - 1 - suffix]
			) {
				suffix++;
			}
			const middle = current.slice(prefix, current.length - suffix);
			if (middle.length === 0 && current.length === this.synced.length) return true; // nothing changed
			startLine = this.first + prefix;
			endLine = this.first + this.synced.length - suffix;
			if (endLine < this.lineCount) {
				// A replacement that stops short of the file's end must re-join the following
				// line, so its text carries a trailing newline.
				text = middle.length === 0 ? '' : middle.join('\n') + '\n';
			} else if (prefix > 0) {
				// The change runs through the file's end, where there is no newline to
				// re-join — the previous line's own newline is the one that moves. Restating
				// that line from its start puts the newline on the right side of the change:
				// an Enter after the last line inserts "\n", a Backspace onto it removes it.
				startLine -= 1;
				text = [this.synced[prefix - 1]!, ...middle].join('\n');
			} else {
				// The whole document, start to end.
				text = middle.join('\n');
			}
		}
		const docId = this.docId;
		try {
			const result = await invoke<{ lineCount: number }>('viewer_edit', {
				docId,
				startLine,
				startCol: 0,
				endLine,
				endCol: 0,
				text
			});
			if (this.disposed || this.docId !== docId) return false;
			this.synced = current;
			this.lineCount = result.lineCount;
			this.relayout();
			this.onChanged?.();
			this.scheduleBackup();
			// An edit moved every match below it: recount (debounced by the bar itself).
			this.findBar?.refresh();
			return true;
		} catch (error) {
			notify('error', String(error));
			this.needsFullResync = true;
			this.scheduleSync();
			return false;
		}
	}

	private scheduleBackup(): void {
		if (this.backupTimer !== undefined) window.clearTimeout(this.backupTimer);
		this.backupTimer = window.setTimeout(() => {
			this.backupTimer = undefined;
			const docId = this.docId;
			if (docId !== null) void invoke('viewer_backup', { docId }).catch(() => undefined);
		}, BACKUP_DELAY_MS);
	}

	/** Write the document back to disk. False (with the error reported) when it failed. */
	save(): Promise<boolean> {
		if (this.docId === null) return Promise.resolve(false);
		if (this.syncTimer !== undefined) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = undefined;
		}
		// Queued with the syncs and history jumps: a save must land the buffer's pending
		// edit and then write exactly what the editor shows, never a step interleaved.
		return this.enqueue(async () => {
			if (this.disposed || this.docId === null) return false;
			// An edit the backend refused is not on disk after a save: the tab stays dirty.
			if (!(await this.sendDiff()) || this.disposed || this.docId === null) return false;
			try {
				// The indeterminate pulse shows immediately; the backend's own reports
				// (once the write starts) replace it with a real percentage.
				this.onSaveProgress?.({ written: 0, total: 0 });
				const onProgress = new Channel<SaveProgress>();
				onProgress.onmessage = (progress) => this.onSaveProgress?.(progress);
				await invoke('viewer_save', { docId: this.docId, onProgress });
				this.touched = false;
				const path = this.path;
				if (path) void invoke('backup_clear', { path }).catch(() => undefined);
				return true;
			} catch (error) {
				notify('error', String(error));
				return false;
			} finally {
				this.onSaveProgress?.(null);
			}
		}).then((saved) => saved ?? false);
	}

	async undo(): Promise<void> {
		await this.applyHistory('viewer_undo');
	}

	async redo(): Promise<void> {
		await this.applyHistory('viewer_redo');
	}

	/** Undo and redo run as queued steps — flush, backend jump, window refetch — so rapid
	 *  Ctrl+Z presses apply one after another instead of racing each other's fetches. */
	private applyHistory(command: 'viewer_undo' | 'viewer_redo'): Promise<void> {
		if (this.docId === null) return Promise.resolve();
		if (this.syncTimer !== undefined) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = undefined;
		}
		return this.enqueue(async () => {
			if (this.disposed || this.docId === null) return;
			if (!(await this.sendDiff()) || this.disposed || this.docId === null) return;
			try {
				const result = await invoke<{ firstLine: number; lineCount: number } | null>(command, { docId: this.docId });
				if (!result || this.disposed || this.docId === null) return;
				this.lineCount = result.lineCount;
				// Centre the window on the restored line, so the cursor lands well inside it
				// and the follow-the-cursor slide never fires a second, view-jarring swap on
				// top of this one; then centre the view on it too.
				const target = Math.max(0, Math.min(result.firstLine - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
				await this.showWindow(target, result.firstLine);
				this.scroll.autoscroll(result.firstLine, 'center');
				this.cm?.focus();
				this.onChanged?.();
			} catch (error) {
				notify('error', String(error));
			}
		});
	}

	/** Replace the whole document (a hot-exit backup is restored into it). */
	replaceText(contents: string): Promise<void> {
		if (this.docId === null) return Promise.resolve();
		return this.enqueue(async () => {
			if (this.disposed || this.docId === null) return;
			if (!(await this.sendDiff()) || this.disposed || this.docId === null) return;
			try {
				const result = await invoke<{ lineCount: number }>('viewer_edit', {
					docId: this.docId,
					startLine: 0,
					startCol: 0,
					endLine: this.lineCount,
					endCol: 0,
					text: contents
				});
				this.lineCount = result.lineCount;
				// Restored, unsaved text: a watcher event must not reload the disk over it.
				this.touched = true;
				await this.showWindow(0);
				this.scheduleBackup();
			} catch (error) {
				notify('error', String(error));
			}
		});
	}

	/** The file changed on disk under a clean editor: reload it — but only when it really
	 *  changed. The backend compares the file's stamp against what it last read or wrote, so
	 *  the watcher echo of our own save reports "unchanged" and the cursor stays put. */
	reload(): Promise<void> {
		if (this.docId === null) return Promise.resolve();
		return this.enqueue(async () => {
			if (this.disposed || this.docId === null) return;
			if (!(await this.sendDiff()) || this.disposed || this.docId === null) return;
			// Edits typed within the sync debounce, or not yet saved, keep the document as is.
			if (this.touched) return;
			try {
				const result = await invoke<{ changed: boolean; lineCount: number }>('viewer_reload', { docId: this.docId });
				if (this.disposed || this.docId === null || !result.changed) return;
				this.lineCount = result.lineCount;
				const cursor = this.cm ? this.cm.state.selection.main.head : 0;
				const cursorLine = this.cm
					? this.first + this.cm.state.doc.lineAt(cursor).number - 1
					: this.first;
				await this.showWindow(Math.min(this.first, Math.max(0, this.lineCount - 1)), Math.min(cursorLine, this.lineCount - 1));
			} catch {
				// Deleted meanwhile: the tab keeps its last contents, as VS Code does.
			}
		});
	}

	/** Move cursor and viewport to a 0-based line (and 0-based column). */
	async revealLine(line: number, column = 0): Promise<void> {
		await this.ensureAround(Math.max(0, Math.min(line, Math.max(0, this.lineCount - 1))), true, Math.max(0, column));
	}

	/** The cursor's absolute (whole-file) 1-based line and column, for the status bar. */
	status(): { line: number; column: number; selections: number; selected: number } {
		if (!this.cm) return { line: 1, column: 1, selections: 0, selected: 0 };
		const selection = this.cm.state.selection;
		const head = selection.main.head;
		const lineInfo = this.cm.state.doc.lineAt(head);
		return {
			line: this.first + lineInfo.number,
			column: head - lineInfo.from + 1,
			selections: selection.ranges.length,
			selected: selection.ranges.reduce((total, range) => total + (range.to - range.from), 0)
		};
	}

	/* ---------- The whole-file find/replace bar (docFind.ts) ---------- */

	/** The find bar, mounted into the view on first use: the same VS Code-shaped widget the
	 *  full editor serves, over `viewer_find`/`viewer_replace` instead of the window. */
	private ensureFindBar(): DocFindController {
		if (!this.findBar) {
			const host: DocFindHost = {
				docId: () => this.docId,
				position: () => {
					if (!this.cm) return { line: this.first, col: 0 };
					const head = this.cm.state.selection.main.head;
					const line = this.cm.state.doc.lineAt(head);
					return { line: this.first + line.number - 1, col: codePointCol(line.text, head - line.from) };
				},
				seedText: () => {
					if (!this.cm) return null;
					const selection = this.cm.state.selection.main;
					if (selection.empty) return null;
					const from = this.cm.state.doc.lineAt(selection.from);
					const to = this.cm.state.doc.lineAt(selection.to);
					if (from.number !== to.number) return null;
					return this.cm.state.sliceDoc(selection.from, selection.to);
				},
				revealMatch: (match) => {
					void this.ensureAround(match.line, true, match.startCol, 'fit').then(() => this.selectMatch(match));
				},
				paintMatches: (matches, current) => this.paintMatches(matches, current),
				replace: (spec, from, replacement, all) => this.replaceMatches(spec, from, replacement, all),
				focusEditor: () => this.cm?.focus()
			};
			this.findBar = new DocFindController(host, this.root, true);
		}
		return this.findBar;
	}

	/** Select a match that must be inside the loaded window (revealMatch slid it there). */
	private selectMatch(match: DocFindMatch): void {
		const cm = this.cm;
		if (!cm) return;
		const relative = match.line - this.first;
		if (relative < 0 || relative >= cm.state.doc.lines) return;
		const line = cm.state.doc.line(relative + 1);
		cm.dispatch({
			selection: {
				anchor: line.from + utf16Col(line.text, match.startCol),
				head: line.from + utf16Col(line.text, match.endCol)
			}
		});
	}

	/** Repaint the window's match decorations from whole-document matches. */
	private paintMatches(matches: DocFindMatch[], current: DocFindMatch | null): void {
		const cm = this.cm;
		if (!cm) return;
		const inWindow: WindowMatch[] = [];
		for (const match of matches) {
			const relative = match.line - this.first;
			if (relative < 0 || relative >= cm.state.doc.lines) continue;
			const line = cm.state.doc.line(relative + 1);
			inWindow.push({
				from: line.from + utf16Col(line.text, match.startCol),
				to: line.from + utf16Col(line.text, match.endCol),
				current: current !== null && current.line === match.line && current.startCol === match.startCol
			});
		}
		cm.dispatch({ effects: setWindowMatches.of(inWindow) });
	}

	/** Apply a find/replace through the backend — the queued flush → replace → re-window
	 *  pattern undo and redo use, so a replacement never interleaves with a pending edit. */
	private replaceMatches(spec: DocFindSpec, from: DocFindMatch | null, replacement: string, all: boolean): Promise<void> {
		if (this.docId === null) return Promise.resolve();
		if (this.syncTimer !== undefined) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = undefined;
		}
		return this.enqueue(async () => {
			if (this.disposed || this.docId === null || !this.cm) return;
			if (!(await this.sendDiff()) || this.disposed || this.docId === null) return;
			try {
				const result = await invoke<{ replacements: number; firstLine: number; lineCount: number }>('viewer_replace', {
					docId: this.docId,
					query: spec.query,
					replacement,
					caseSensitive: spec.caseSensitive,
					wholeWord: spec.wholeWord,
					regexp: spec.useRegex,
					// Replace All covers the whole document from the top; Replace covers the
					// current match, addressed by its whole-document position.
					fromLine: from ? from.line : 0,
					fromCol: from ? from.startCol : 0,
					max: all ? Number.MAX_SAFE_INTEGER : 1
				});
				if (this.disposed || this.docId === null || result.replacements === 0) return;
				this.lineCount = result.lineCount;
				// A replaced buffer is dirty however the watch reports it, and the tab must say so.
				this.touched = true;
				const target = Math.max(0, Math.min(result.firstLine - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
				await this.showWindow(target, result.firstLine, from ? from.startCol : 0);
				this.scroll.autoscroll(result.firstLine, 'center');
				this.cm?.focus();
				this.onChanged?.();
				this.scheduleBackup();
			} catch (error) {
				notify('error', String(error));
			}
		}) as Promise<void>;
	}

	openFind(): void {
		this.ensureFindBar().open(false);
	}

	openReplace(): void {
		this.ensureFindBar().open(true);
	}

	/** F3 / Shift+F3: step through matches, opening the bar when it is closed (VS Code's F3). */
	findStep(direction: 1 | -1): void {
		const bar = this.findBar;
		if (!bar || !bar.isOpen) {
			this.openFind();
			return;
		}
		bar.step(direction);
	}

	selectAll(): void {
		this.cm?.focus();
		this.cm?.dispatch({ selection: { anchor: 0, head: this.cm.state.doc.length } });
	}

	/** VS Code's comment toggles on the loaded window — the edit syncs to the rope like
	 *  any other, so the whole file comments correctly however far the window has slid. */
	toggleComment(kind: 'line' | 'block'): void {
		const cm = this.cm;
		if (!cm) return;
		cm.focus();
		if (kind === 'line') toggleLineComment(cm, this.path);
		else toggleBlockComment(cm, this.path);
	}

	focus(): void {
		this.cm?.focus();
	}

	dispose(): void {
		this.disposed = true;
		this.wheel?.dispose();
		this.scrollbar.dispose();
		this.sizer?.disconnect();
		if (this.syncTimer !== undefined) window.clearTimeout(this.syncTimer);
		if (this.backupTimer !== undefined) window.clearTimeout(this.backupTimer);
		this.unlisten?.();
		this.unlisten = null;
		// Close now, not after the sync queue: the buffer was either just saved (save
		// flushes first) or intentionally discarded, and a sync still in flight checks
		// `disposed` when it lands and drops its edit.
		const docId = this.docId;
		if (docId !== null) void invoke('viewer_close', { docId }).catch(() => undefined);
		this.findBar?.destroy();
		this.findBar = null;
		this.cm?.destroy();
		this.cm = null;
		this.root.remove();
	}
}
