// The editable windowed editor for large text files: the document lives in the backend's
// rope (the viewer's own document store), and the webview only ever holds a small window of
// lines around the viewport in a CodeMirror instance. Editing, scrolling, undo and save all
// cost the same whether the file is 9 MB or 200 MB — the whole-document round trips that
// froze the full editor never happen; only the changed lines cross the IPC.

import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { openSearchPanel, search } from '@codemirror/search';

import { createFindPanel } from './findWidget';
import { vscodeHighlighting } from './cmTheme';
import { el, notify } from './ui';
import { invoke } from '@tauri-apps/api/core';

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

/** The window size, matching the backend's `MAX_WINDOW` so one `viewer_text` call fills it. */
const WINDOW = 500;
/** When the viewport comes within this many lines of the window's edge, the window slides. */
const EDGE = 120;
/** How long after the last keystroke the changed lines are sent to the backend's rope. */
const SYNC_DELAY_MS = 150;
/** How long after a synced edit the hot-exit backup is written (backend-side, no payload). */
const BACKUP_DELAY_MS = 3000;
/** Two window slides must be at least this far apart, or typing at a window edge thrashes. */
const SWAP_COOLDOWN_MS = 250;

export class EditableDocView {
	readonly root: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly spacerTop: HTMLElement;
	private readonly spacerBottom: HTMLElement;
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
	private syncTimer: number | undefined;
	private backupTimer: number | undefined;
	/** Edits are sent strictly one at a time, chained through this promise. */
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	/** Set when a send failed: the next sync resends the whole window instead of a diff. */
	private needsFullResync = false;
	/** While a slide replaces the window and repositions the scroller, its own scroll events are ignored. */
	private swapping = false;
	/** Bumped by every relayout; a layout pass whose write arrives after a newer one was
	 *  scheduled is stale and must not write its captured scroll anchor. */
	private layoutSeq = 0;
	/** A scroll that wanted a slide but hit the cooldown parks a re-check here. A fast
	 *  scrollbar drag ends inside the cooldown all the time, and with the thumb released no
	 *  further scroll events ever fire — without the re-check the viewport stays parked over
	 *  a spacer, blank, until the user nudges it. */
	private swapCheckTimer: number | undefined;
	/** True only for the dispatches that put fetched window text into the view, so the
	 *  update listener can tell them from the user's edits. */
	private replacing = false;
	private lastSwapAt = 0;
	/** A jump (reveal, undo) sets the line the next layout must scroll to, overriding the
	 *  keep-the-top-line-steady anchor a plain slide uses. */
	private pendingScrollLine: number | null = null;
	/** True from the first keystroke until the save that lands it: a file-change event in
	 *  that window (usually our own watcher echo) must not reload the document out from
	 *  under unsynced or just-typed edits. */
	private touched = false;

	/** The buffer became dirty (the editor group marks the tab). */
	onChanged: (() => void) | null = null;
	/** The cursor moved (the editor group refreshes the status bar's line and column). */
	onStatusChange: (() => void) | null = null;
	/** Ctrl+S inside the window. */
	onSaveRequest: (() => void) | null = null;

	constructor(parent: HTMLElement) {
		this.root = el('div', 'doc-edit');
		this.scroller = el('div', 'doc-edit-scroll');
		this.spacerTop = el('div', 'doc-edit-spacer');
		this.host = el('div', 'doc-edit-host');
		this.spacerBottom = el('div', 'doc-edit-spacer');
		this.scroller.append(this.spacerTop, this.host, this.spacerBottom);
		this.root.appendChild(this.scroller);
		parent.appendChild(this.root);
		this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
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
					search({ top: true, createPanel: createFindPanel }),
					keymap.of([
						{ key: 'Mod-s', preventDefault: true, run: () => (this.onSaveRequest?.(), true) },
						{ key: 'Mod-z', preventDefault: true, run: () => (void this.undo(), true) },
						{ key: 'Mod-Z', preventDefault: true, run: () => (void this.redo(), true) },
						{ key: 'Mod-y', preventDefault: true, run: () => (void this.redo(), true) },
						// Alt-ArrowLeft / Alt-ArrowRight stay the workbench's Go Back / Forward.
						...defaultKeymap.filter((binding) => !['Alt-ArrowLeft', 'Alt-ArrowRight'].includes(binding.key ?? ''))
					]),
					vscodeHighlighting,
					EditorView.updateListener.of((update) => {
						// A window swap rewrites the whole view: that is our own text arriving, not
						// the user typing — it must not dirty the document, schedule a sync, or
						// start the edge-slide cooldown that would swallow the reveal behind it.
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
	}

	/** Replace the window with lines `start..start+WINDOW` of the backend document. */
	private async showWindow(start: number, cursorLine?: number, cursorColumn?: number): Promise<void> {
		if (!this.cm || this.docId === null) return;
		const docId = this.docId;
		// The viewport's top line is captured before the window moves, so the layout pass
		// below can put it back where it was — unless a jump claimed the slot first.
		const anchor = this.pendingScrollLine ?? Math.floor(this.scroller.scrollTop / this.lineHeight);
		this.pendingScrollLine = null;
		const end = Math.min(start + WINDOW - 1, this.lineCount - 1);
		let fetched: TextWindow;
		try {
			fetched = await invoke<TextWindow>('viewer_text', { docId, start, end });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (this.disposed || this.docId !== docId || !this.cm) return;
		this.swapping = true;
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
		try {
			this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: text } });
			const relative = Math.max(0, Math.min(target - this.first, fetched.lines.length - 1));
			const line = this.cm.state.doc.line(relative + 1);
			this.cm.dispatch({ selection: { anchor: Math.min(line.from + column, line.to) } });
		} finally {
			this.replacing = false;
		}
		this.relayout(anchor);
		// `swapping` normally clears inside relayout's write callback, which rides on
		// CodeMirror's next measure pass. If that pass is long delayed, the flag must not
		// wedge the scroller's event handling — but this is only an unwedge: until the
		// swap's own layout has applied, the scroll position still speaks the old window's
		// coordinates, so no scroll check may run from here.
		window.setTimeout(() => {
			this.swapping = false;
		}, 250);
	}

	/** Lay the window out from what CodeMirror actually rendered. The spacers and the host
	 *  height follow the measured content height divided by the line count — an estimated
	 *  line height drifts a fraction of a pixel per line, and at a 500-line window that
	 *  drift showed as lines piling onto the spacers at the file's end. `anchor`, when
	 *  given, is the 0-based line to keep at the viewport's top across a window slide.
	 *  A layout pass superseded by a newer swap applies nothing: its captured anchor is
	 *  the old window's, and writing it late would yank the viewport back up the file. */
	private relayout(anchor?: number): void {
		const cm = this.cm;
		if (!cm) return;
		const seq = ++this.layoutSeq;
		cm.requestMeasure({
			read: () => cm.contentHeight,
			write: (height) => {
				if (this.disposed || this.cm !== cm || seq !== this.layoutSeq) return;
				if (this.synced.length > 0 && height > 0) {
					this.lineHeight = height / this.synced.length;
					this.host.style.height = `${height}px`;
				}
				const below = Math.max(0, this.lineCount - this.first - this.synced.length);
				this.spacerTop.style.height = `${this.first * this.lineHeight}px`;
				this.spacerBottom.style.height = `${below * this.lineHeight}px`;
				if (anchor !== undefined) this.scroller.scrollTop = anchor * this.lineHeight;
				window.setTimeout(() => {
					this.swapping = false;
					// The swap repositioned the content under the viewport; re-check in case
					// the user scrolled on while the window was being fetched.
					this.onScroll();
				}, 0);
			}
		});
	}

	private onScroll(): void {
		if (!this.cm || this.lineCount <= this.synced.length) return;
		const visible = Math.ceil(this.scroller.clientHeight / this.lineHeight);
		const anchor = Math.floor(this.scroller.scrollTop / this.lineHeight);
		const windowEnd = this.first + this.synced.length;
		const nearTop = anchor < this.first + EDGE && this.first > 0;
		const nearBottom = anchor + visible > windowEnd - EDGE && windowEnd < this.lineCount;
		if (!nearTop && !nearBottom) return;
		// Neither an in-progress swap nor the cooldown may simply drop the request: a fast
		// drag ends inside them all the time, and this scroll event is the last thing that
		// knows where it ended.
		if (this.swapping || Date.now() - this.lastSwapAt < SWAP_COOLDOWN_MS) {
			this.scheduleSwapCheck();
			return;
		}
		void this.slideTo(anchor, visible);
	}

	/** Re-run the scroll check once the swap/cooldown is out of the way. The drag that was
	 *  rate-limited may have been its last movement — this is what fills the window it
	 *  ended on instead of leaving the viewport over a blank spacer. */
	private scheduleSwapCheck(): void {
		if (this.swapCheckTimer !== undefined) return;
		const wait = Math.max(0, SWAP_COOLDOWN_MS - (Date.now() - this.lastSwapAt));
		this.swapCheckTimer = window.setTimeout(() => {
			this.swapCheckTimer = undefined;
			this.onScroll();
		}, wait);
	}

	/** Slide the window so `anchor` (the line at the viewport's top) stays put. The flush
	 *  and the window replacement run as one queued step: two slides (or a slide racing an
	 *  undo) must never interleave, or the slower fetch overwrites the newer one with stale
	 *  lines and desyncs the editor from its document. */
	private slideTo(anchor: number, visible: number): Promise<void> {
		if (!this.cm || this.docId === null) return Promise.resolve();
		this.lastSwapAt = Date.now();
		return this.enqueue(async () => {
			if (!(await this.sendDiff()) || this.disposed || !this.cm || this.docId === null) return;
			const target = Math.max(0, Math.min(anchor + Math.floor(visible / 2) - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
			await this.showWindow(target);
		});
	}

	/** Bring `line` (0-based) into the middle of the window. A `jump` (a reveal, a
	 *  go-to-line) also puts the cursor on it, at `column` (0-based), and always slides; the
	 *  follow-the-cursor slide typing triggers at a window edge leaves the cursor where the
	 *  user has it and is rate-limited, since it fires on every keystroke there. */
	private async ensureAround(line: number, jump = true, column = 0): Promise<void> {
		if (!this.cm || this.docId === null) return;
		const relative = line - this.first;
		const visible = Math.max(1, Math.floor(this.scroller.clientHeight / this.lineHeight));
		const inside = relative >= EDGE / 2 && relative <= this.synced.length - EDGE / 2 && this.synced.length >= visible;
		// Already comfortably inside (or the whole file is the window): no slide, just the
		// cursor and the scroll position.
		if (inside || this.lineCount <= this.synced.length) {
			if (jump) this.placeCursor(line, column);
			if (!inside ||
				relative < Math.floor(this.scroller.scrollTop / this.lineHeight) - this.first ||
				relative > Math.floor((this.scroller.scrollTop + this.scroller.clientHeight) / this.lineHeight) - this.first) {
				this.scroller.scrollTop = Math.max(0, (line - Math.floor(visible / 2)) * this.lineHeight);
			}
			return;
		}
		const windowFor = (): number => Math.max(0, Math.min(line - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
		// At the file's first or last window the line sits near an edge the window cannot
		// move past: there is nothing to slide to, and refetching the same window would only
		// throw away whatever the user has typed since the last sync.
		if (windowFor() === this.first) {
			if (jump) {
				this.placeCursor(line, column);
				this.scroller.scrollTop = Math.max(0, (line - Math.floor(visible / 2)) * this.lineHeight);
			}
			return;
		}
		if (!jump && Date.now() - this.lastSwapAt < SWAP_COOLDOWN_MS) return;
		this.lastSwapAt = Date.now();
		await this.enqueue(async () => {
			if (!(await this.sendDiff()) || this.disposed || !this.cm || this.docId === null) return;
			const target = windowFor();
			if (target === this.first) {
				if (jump) this.placeCursor(line, column);
				return;
			}
			this.pendingScrollLine = Math.max(0, line - Math.floor(visible / 2));
			await this.showWindow(target, line, jump ? column : undefined);
			this.cm?.focus();
		});
	}

	/** Put the cursor on an absolute line (0-based) that is inside the current window. */
	private placeCursor(line: number, column: number): void {
		const cm = this.cm;
		if (!cm) return;
		const relative = line - this.first;
		if (relative < 0 || relative >= cm.state.doc.lines) return;
		const target = cm.state.doc.line(relative + 1);
		cm.dispatch({ selection: { anchor: Math.min(target.from + column, target.to) }, scrollIntoView: true });
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
				await invoke('viewer_save', { docId: this.docId });
				this.touched = false;
				const path = this.path;
				if (path) void invoke('backup_clear', { path }).catch(() => undefined);
				return true;
			} catch (error) {
				notify('error', String(error));
				return false;
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
				const visible = Math.max(1, Math.floor(this.scroller.clientHeight / this.lineHeight));
				// Centre the window on the restored line, so the cursor lands well inside it
				// and the follow-the-cursor slide never fires a second, view-jarring swap on
				// top of this one; the cooldown absorbs any edge-triggered slide for a moment.
				this.lastSwapAt = Date.now();
				this.pendingScrollLine = Math.max(0, result.firstLine - Math.floor(visible / 2));
				const target = Math.max(0, Math.min(result.firstLine - Math.floor(WINDOW / 2), Math.max(0, this.lineCount - WINDOW)));
				await this.showWindow(target, result.firstLine);
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

	openFind(): void {
		if (this.cm) openSearchPanel(this.cm);
	}

	selectAll(): void {
		this.cm?.focus();
		this.cm?.dispatch({ selection: { anchor: 0, head: this.cm.state.doc.length } });
	}

	focus(): void {
		this.cm?.focus();
	}

	dispose(): void {
		this.disposed = true;
		if (this.syncTimer !== undefined) window.clearTimeout(this.syncTimer);
		if (this.backupTimer !== undefined) window.clearTimeout(this.backupTimer);
		if (this.swapCheckTimer !== undefined) window.clearTimeout(this.swapCheckTimer);
		// Close now, not after the sync queue: the buffer was either just saved (save
		// flushes first) or intentionally discarded, and a sync still in flight checks
		// `disposed` when it lands and drops its edit.
		const docId = this.docId;
		if (docId !== null) void invoke('viewer_close', { docId }).catch(() => undefined);
		this.cm?.destroy();
		this.cm = null;
		this.root.remove();
	}
}
