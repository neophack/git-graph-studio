// The raw CAN log view a `.blf` / `.asc` trace opens in: every frame as a row, on screen
// the moment the tab paints. The backend parse runs in the background and appends frames
// as it walks (`can_log_open`); this view polls the published count (`can_log_count`) to
// extend the row model's range (scroll/) and fetches only the visible window of rows
// (`can_log_frames`) — a multi-gigabyte log is browsable while it is still being parsed.
//
// The chrome stays out of the way: one live chip in the toolbar (frame count, percentage
// and speed while the walk runs) and two actions — "Statistics" opens the analysis as its
// own tab (the caller owns that flow), "Convert" exports the log to the other format.
// Neither blocks browsing — both run on the backend's blocking pool.

import { invoke } from '@tauri-apps/api/core';

import { convertCanLog, idHex } from './canLogView';
import { attachPageKeys, attachWheel, type Disposable } from './scroll/input';
import { ScrollModel } from './scroll/model';
import { Scrollbar } from './scroll/scrollbar';
import { basename, el, icon } from './ui';

interface CanOpenResult {
	docId: number;
	totalBytes: number;
}

export interface CanFrameLine {
	tS: number;
	channel: number;
	id: number;
	extended: boolean;
	fd: boolean;
	brs: boolean;
	esi: boolean;
	remote: boolean;
	error: boolean;
	tx: boolean;
	dlc: number;
	dataHex: string;
}

interface CanLogCount {
	parsed: number;
	done: boolean;
	error: string | null;
	bytes?: number;
	totalBytes?: number;
}

/** Fixed row height keeps the scroll math allocation-free (shell.css `.can-raw-row`). */
const ROW_HEIGHT = 20;
/** Rows kept rendered above and below the viewport, so small scrolls don't flash empty. */
const OVERSCAN = 10;
/** Rows per backend fetch (viewport + overscan), bounded so one response stays small. */
const MAX_WINDOW = 500;
/** How often the view asks the background walk how far it has come. */
const POLL_MS = 400;

/** The "Type" column's badge: what kind of frame the row carries. */
function typeBadge(line: CanFrameLine): HTMLElement {
	if (line.error) return el('span', 'can-raw-type can-badge can-badge-err', ['Error']);
	if (line.remote) return el('span', 'can-raw-type can-badge can-badge-rmt', ['Remote']);
	if (line.fd) {
		const text = 'CAN FD' + (line.brs ? ' BRS' : '') + (line.esi ? ' ESI' : '');
		return el('span', 'can-raw-type can-badge can-badge-fd', [text]);
	}
	return el('span', 'can-raw-type can-badge can-badge-can', ['CAN']);
}

/** `1234567` → `1,234,567`; a rate is compacted to `812k` / `1.2M` for the live chip. */
function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(Math.round(value));
}

export interface CanRawViewOptions {
	/** "Statistics" opens the analysis tab for the same file (the caller owns the tabs). */
	onAnalyze?: () => void;
	/** "Text" swaps this tab to the log's plain text form, editable (the caller owns the
	 * editor swap — a giant log cannot become a CodeMirror document). */
	onEditText?: () => void;
}

export class CanRawView {
	readonly root: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly rows: HTMLElement;
	/** The viewport's position over the parsed frames (scroll/model.ts). */
	readonly scroll: ScrollModel;
	private readonly scrollbar: Scrollbar;
	private readonly sizer: ResizeObserver | null;
	private readonly live: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly liveDot: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly banner: HTMLElement;
	private doc: CanOpenResult | null = null;
	/** The frame count the backend has published so far — the scroll range's length. */
	private parsed = 0;
	/** The visible window the last refresh computed — what a landing fetch checks itself
	 *  against before placing rows. */
	private windowFirst = 0;
	private windowLast = Infinity;
	private done = false;
	private failed = false;
	/** The previous poll's reading, so the live chip can show the walk's speed. */
	private mark: { at: number; parsed: number } | null = null;
	/** Row cache, 0-based frame index → rendered row element. Frames are append-only, so a
	 * cached row never goes stale; far-scrolled rows are dropped to bound the DOM. */
	private cache = new Map<number, HTMLElement>();
	private fetching = new Set<number>();
	/** One `can_log_frames` request in flight at a time. A fast drag (or a poll tick landing
	 *  mid-drag) fires a refresh per scroll event; letting each issue its own fetch piles
	 *  overlapping requests onto the backend — exactly while its CPU is busiest with the walk
	 *  — so later ones queue up and the view sits blank until parsing lets the backlog drain.
	 *  A later refresh while one is pending just marks `refetch`, and the landing fetch picks
	 *  up whatever the viewport still wants. */
	private fetchInFlight = false;
	private refetch = false;
	private timer: number | null = null;
	private disposed = false;
	/** The wheel and the page keys over the scroller (scroll/input.ts), disposed with the view. */
	private readonly wheel: Disposable;
	private readonly pageKeys: Disposable;

	constructor(private path: string, options: CanRawViewOptions = {}) {
		const analyzeButton = el('button', 'button secondary can-analyze', [icon('pulse'), ' Statistics']) as HTMLButtonElement;
		analyzeButton.title = 'Analyse this log (opens in a new tab; runs in the background)';
		analyzeButton.addEventListener('click', () => options.onAnalyze?.());
		const convertButton = el('button', 'button secondary can-convert', [icon('save-as'), ' Convert…']) as HTMLButtonElement;
		convertButton.title = 'Convert this log to the other format (Save As)';
		convertButton.addEventListener('click', () => {
			convertButton.disabled = true;
			void convertCanLog(this.path, null, (text) => this.setLive(text)).finally(() => (convertButton.disabled = false));
		});
		this.liveDot = el('span', 'can-live-dot');
		this.liveText = el('span', 'can-live-text', ['Opening…']);
		this.live = el('span', 'can-live can-live-parsing', [this.liveDot, this.liveText]);
		this.progressFill = el('i');
		this.progress = el('div', 'can-progress', [this.progressFill]);
		const textButton = el('button', 'button secondary can-text', [icon('edit'), ' Text']) as HTMLButtonElement;
		textButton.title = 'View and edit this log as plain text';
		textButton.addEventListener('click', () => options.onEditText?.());
		const pathChip = el('span', 'can-path', [this.path]);
		pathChip.title = this.path;
		const toolbar = el('div', 'hex-toolbar can-toolbar', [
			pathChip,
			el('span', 'hex-toolbar-sep'),
			textButton,
			analyzeButton,
			convertButton,
			this.live
		]);
		const heads = ['No.', 'Time', 'Ch', 'ID', 'Dir', 'Type', 'DLC', 'Data'];
		const headClasses = ['can-raw-no', 'can-raw-time', 'can-raw-ch', 'can-raw-id', 'can-raw-dir', 'can-raw-type-h', 'can-raw-dlc', ''];
		const header = el('div', 'can-raw-head can-raw-grid', heads.map((t, i) => el('span', headClasses[i], [t])));
		this.banner = el('div', 'can-error can-raw-banner');
		this.banner.hidden = true;
		this.scroller = el('div', 'can-raw-scroll');
		this.rows = el('div', 'can-raw-rows');
		this.scroller.appendChild(this.rows);
		const viewport = el('div', 'can-raw-viewport', [this.scroller]);
		this.root = el('div', 'can-view can-raw-view', [toolbar, this.progress, header, this.banner, viewport]);
		this.scroll = new ScrollModel(ROW_HEIGHT);
		this.scroll.onChange(() => this.refresh());
		this.scrollbar = new Scrollbar(viewport, this.scroll);
		this.wheel = attachWheel(this.scroller, this.scroll);
		this.pageKeys = attachPageKeys(this.scroller, this.scroll);
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout());
		this.sizer?.observe(this.scroller);
		void this.load();
	}

	private setLive(text: string): void {
		this.liveText.textContent = text;
	}

	/** The chip while the walk runs: count, file percentage and speed; just the count once
	 *  done — the progress strip empties with it. */
	private paintProgress(count: CanLogCount): void {
		const total = count.totalBytes || 0;
		const at = count.bytes || 0;
		const pct = total > 0 ? Math.min(100, Math.floor((at / total) * 100)) : null;
		if (count.done) {
			this.live.classList.remove('can-live-parsing');
			this.progress.classList.add('can-progress-done');
			this.setLive(`${count.parsed.toLocaleString()} frames`);
			return;
		}
		const now = performance.now();
		let speed = '';
		if (this.mark && now > this.mark.at) {
			const rate = ((count.parsed - this.mark.parsed) * 1000) / (now - this.mark.at);
			if (rate > 0) speed = ` · ${compact(rate)} f/s`;
		}
		this.mark = { at: now, parsed: count.parsed };
		this.setLive(`${count.parsed.toLocaleString()} frames · parsing…${pct !== null ? ` ${pct}%` : ''}${speed}`);
		if (pct !== null) this.progressFill.style.width = `${pct}%`;
	}

	/** Opens the document — the backend returns as soon as it exists and keeps parsing in
	 *  the background; this view then polls the walk's progress until it is done. */
	private async load(): Promise<void> {
		let doc: CanOpenResult;
		try {
			doc = await invoke<CanOpenResult>('can_log_open', { path: this.path });
		} catch (error) {
			this.fail(`Failed to open '${basename(this.path)}': ${String(error)}`);
			return;
		}
		if (this.disposed) {
			void invoke('can_log_close', { docId: doc.docId });
			return;
		}
		this.doc = doc;
		this.poll();
	}

	/** One progress poll: extend the scroll range with the newly parsed frames, refresh the
	 *  visible window, and schedule the next poll until the walk reports itself done. */
	private async poll(): Promise<void> {
		const doc = this.doc;
		if (!doc || this.disposed || this.done) return;
		try {
			const count = await invoke<CanLogCount>('can_log_count', { docId: doc.docId });
			if (this.disposed || !this.doc || this.doc.docId !== doc.docId) return;
			this.paintProgress(count);
			if (count.parsed !== this.parsed) {
				this.parsed = count.parsed;
				// The model's range grows with the parse; the row the user is looking at
				// stays put, the scrollbar's thumb shrinks.
				this.scroll.setRowCount(this.parsed);
				this.layout();
			}
			if (count.done) {
				this.done = true;
				if (count.error && this.parsed === 0) this.fail(`Failed to parse '${basename(this.path)}': ${count.error}`);
				else if (count.error) this.setLive(`${count.parsed.toLocaleString()} frames · parse stopped: ${count.error}`);
				return;
			}
		} catch {
			// A transient poll failure (the view closing mid-walk) just stops the loop; the
			// frame fetches surface real errors of their own.
			return;
		}
		this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
	}

	private fail(text: string): void {
		this.failed = true;
		this.done = true;
		this.banner.textContent = text;
		this.banner.hidden = false;
		this.live.classList.remove('can-live-parsing');
		this.liveDot.classList.add('can-live-dot-failed');
		this.progress.classList.add('can-progress-done');
		this.setLive('Failed');
	}

	/** Pull the newly visible window from the backend. Runs on every scroll event and every
	 *  progress tick; the row cache makes it a no-op unless something actually moved. */
	/** The viewport was (re)laid out: the model takes its height, and the rows follow. */
	private layout(): void {
		this.scroll.setViewport(this.scroller.clientHeight);
		this.refresh();
	}

	private refresh(): void {
		const doc = this.doc;
		if (!doc || this.disposed || this.failed) return;
		for (const [index, node] of this.cache) node.style.top = `${this.scroll.rowTop(index)}px`;
		const { first, last } = this.scroll.visibleRange(OVERSCAN);
		this.windowFirst = first;
		this.windowLast = last;
		const wanted: number[] = [];
		for (let index = first; index <= last; index++) {
			if (!this.cache.has(index) && !this.fetching.has(index)) wanted.push(index);
		}
		// Keep the DOM bounded: rows scrolled far away are dropped.
		for (const [index, node] of this.cache) {
			if (index < first - OVERSCAN * 2 || index > last + OVERSCAN * 2) {
				node.remove();
				this.cache.delete(index);
			}
		}
		if (wanted.length === 0) return;
		if (this.fetchInFlight) {
			this.refetch = true;
			return;
		}
		const start = wanted[0]!;
		const end = Math.min(wanted[wanted.length - 1]! + 1, start + MAX_WINDOW);
		for (let index = start; index < end; index++) this.fetching.add(index);
		this.fetchInFlight = true;
		const docId = doc.docId;
		invoke<CanFrameLine[]>('can_log_frames', { docId, start, end })
			.then((lines) => {
				this.fetchInFlight = false;
				if (!this.disposed && this.doc?.docId === docId) {
					// The backend serves only its parsed prefix: a window that reaches past it
					// comes back short (or empty) rather than waiting. Every requested index is
					// released here regardless — clearing only the ones a line arrived for would
					// strand the rest in `fetching` forever, never retried once the walk actually
					// gets there, leaving the view blank at that spot until the whole log finishes.
					for (let index = start; index < end; index++) this.fetching.delete(index);
					lines.forEach((line, offset) => {
						const index = start + offset;
						// A fetch lands after the viewport moved on (a scaled drag covers
						// millions of rows in one bound): a row outside the current window is
						// dropped, not placed — its viewport-relative offset would mean nothing.
						if (index < this.windowFirst || index > this.windowLast) return;
						if (this.cache.has(index)) return;
						const row = this.renderRow(index, line);
						this.cache.set(index, row);
						this.place(row, index);
					});
				}
				// The viewport (or the parsed prefix) moved on while this fetch was out: pick up
				// whatever it still wants, short response or not — no scroll event is coming to
				// ask again on its own.
				if (this.refetch) {
					this.refetch = false;
					this.refresh();
				}
			})
			.catch((error) => {
				this.fetchInFlight = false;
				this.refetch = false;
				for (let index = start; index < end; index++) this.fetching.delete(index);
				if (!this.disposed) this.fail(String(error));
			});
	}

	private place(row: HTMLElement, index: number): void {
		// Viewport-relative: where the model's top puts the row, whatever its index.
		row.style.top = `${this.scroll.rowTop(index)}px`;
		// Rows arrive out of order; insert before the first row with a larger index.
		const key = (node: HTMLElement) => Number(node.dataset.frame);
		let after: HTMLElement | null = null;
		for (const node of Array.from(this.rows.children) as HTMLElement[]) {
			if (key(node) > index) {
				after = node;
				break;
			}
		}
		this.rows.insertBefore(row, after);
	}

	private renderRow(index: number, line: CanFrameLine): HTMLElement {
		// The DLC column shows the payload the row actually carries (a FD length code like
		// 13 is the code, not the bytes); the code itself stays in the tooltip.
		const bytes = line.dataHex ? line.dataHex.split(' ').length : 0;
		const dlcShown = line.remote || line.error ? line.dlc : bytes;
		const dir = el('span', 'can-raw-dir' + (line.tx ? ' can-dir-tx' : ''), [line.tx ? 'Tx' : 'Rx']);
		dir.title = line.tx ? 'Transmitted' : 'Received';
		const id = el('span', 'can-raw-id' + (line.error ? ' can-warn' : ''), [idHex(line.id, line.extended) + (line.extended && !line.error ? 'x' : '')]);
		const data = el('span', 'can-raw-data', [line.dataHex]);
		const cells = [
			el('span', 'can-raw-no', [String(index + 1)]),
			el('span', 'can-raw-time', [line.tS.toFixed(6)]),
			el('span', 'can-raw-ch', [String(line.channel)]),
			id,
			dir,
			typeBadge(line),
			el('span', 'can-raw-dlc', [String(dlcShown)]),
			data
		];
		const row = el('div', 'can-raw-row can-raw-grid' + (line.error ? ' can-row-error' : ''), cells);
		row.dataset.frame = String(index);
		return row;
	}

	dispose(): void {
		this.disposed = true;
		this.wheel.dispose();
		this.pageKeys.dispose();
		this.scrollbar.dispose();
		this.sizer?.disconnect();
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.doc) void invoke('can_log_close', { docId: this.doc.docId });
		this.root.remove();
	}
}
