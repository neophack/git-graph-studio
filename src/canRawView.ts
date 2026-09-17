// The raw CAN log view a `.blf` / `.asc` trace opens in: every frame as a row, on screen
// the moment the tab paints. The backend parse runs in the background and appends frames
// as it walks (`can_log_open`); this view polls the published count (`can_log_count`) to
// extend the row model's range (scroll/) and fetches only the visible window of rows
// (`can_log_frames`) — a multi-gigabyte log is browsable while it is still being parsed.
//
// The toolbar carries CANoe's Trace-window filters — identifiers (hex ids or `from-to`
// ranges), channel, direction and frame type — shipped to the backend on every poll and
// fetch: the filtered row space is a backend-owned match index over the same columns, so a
// filter narrows the whole log, not just the frames already on screen. Rows keep numbering
// in log order whatever the filter removed.
//
// The rest of the chrome stays out of the way: one live chip in the toolbar (frame count,
// percentage and speed while the walk runs) and two actions — "Statistics" opens the
// analysis as its own tab (the caller owns that flow), "Convert" exports the log to the
// other format. Neither blocks browsing — both run on the backend's blocking pool.

import { invoke } from '@tauri-apps/api/core';

import { convertCanLog, idFilterRanges, idHex } from './canLogView';
import { attachPageKeys, attachWheel, type Disposable } from './scroll/input';
import { ScrollModel } from './scroll/model';
import { Scrollbar } from './scroll/scrollbar';
import { basename, el, icon } from './ui';

interface CanOpenResult {
	docId: number;
	totalBytes: number;
}

export interface CanFrameLine {
	/** The frame's position in the whole log — the "No." column, whatever filter narrowed
	 *  the view (the lines arrive in filtered order but number in log order). */
	index: number;
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
	/** The frames that pass the current filter — the row model's length while one is on;
	 *  absent when a scripted backend predates filtering (then `parsed` is the count). */
	matched?: number;
	done: boolean;
	error: string | null;
	bytes?: number;
	totalBytes?: number;
	/** The channels the walk has named so far, ascending — the channel select's options. */
	channels?: number[];
}

/** One find's answer (`can_log_find`): the hit positions of the current row space (capped)
 *  and the true total behind them. */
interface CanFindResult {
	positions: number[];
	total: number;
	capped: boolean;
}

/** The raw view's filter, one field per toolbar control — CANoe's Trace-window set. Sent
 *  on every poll and fetch; `null` while every control sits on its "all" default, so the
 *  unfiltered browse skips the backend's match index entirely. */
interface CanFrameFilter {
	/** Channels to keep; empty = every channel. */
	channels: number[];
	direction: 'all' | 'rx' | 'tx';
	/** The frame types the Type column badges: can, canfd, error, remote. */
	kind: 'all' | 'can' | 'canfd' | 'error' | 'remote';
	/** Inclusive `[from, to]` id ranges; empty = every id. */
	idRanges: number[][];
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

/** One `<option>` with its value — the filter selects' shared builder. */
function selectOption(value: string, label: string): HTMLOptionElement {
	const option = el('option', undefined, [label]) as HTMLOptionElement;
	option.value = value;
	return option;
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
	/** The filter toolbar: identifier box plus the channel, direction and type selects. */
	private readonly idBox: HTMLInputElement;
	private readonly channelSelect: HTMLSelectElement;
	private readonly dirSelect: HTMLSelectElement;
	private readonly kindSelect: HTMLSelectElement;
	/** "No frames match the filter" across the viewport when a filter leaves nothing. */
	private readonly emptyHint: HTMLElement;
	private doc: CanOpenResult | null = null;
	/** The frame count the backend has published so far — the raw parse progress. */
	private parsed = 0;
	/** The row count the scroll model spans: `matched` while a filter is on, else `parsed`. */
	private rowCount = 0;
	/** The filter the next poll and fetch carry; null while the bar sits on its defaults. */
	private filter: CanFrameFilter | null = null;
	/** Bumped on every filter change: a fetch that lands from the row space before the
	 *  change would place its rows at meaningless offsets, so it is aged out. */
	private fetchGen = 0;
	/** The find bar over the viewport's top right (the shared `.cm-find-widget` look):
	 *  search only — a trace is a measurement, nothing in it is replaced. */
	private readonly findBar: HTMLElement;
	private readonly findBox: HTMLInputElement;
	private readonly findCount: HTMLElement;
	/** The find's hit positions in the current row space (capped by the backend), the true
	 *  total behind them, and the current hit's index into the list. */
	private hits: number[] = [];
	private hitTotal = 0;
	private hitsCapped = false;
	private hitIndex = -1;
	/** The hits as a set, so a row can test itself as it renders. */
	private hitSet: Set<number> = new Set();
	/** Every find bumps this; an answer whose generation is stale is dropped. */
	private findGen = 0;
	private findTimer: number | null = null;
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
		// A `.blf` is binary: the form its button swaps to is the hex editor; an `.asc` is
		// text and really does switch to the text editor.
		const binaryLog = /\.blf$/i.test(path);
		const textButton = el('button', 'button secondary can-text', [icon(binaryLog ? 'file-binary' : 'edit'), binaryLog ? ' Hex' : ' Text']) as HTMLButtonElement;
		textButton.title = binaryLog ? 'View and edit this file as bytes (hex editor)' : 'View and edit this log as plain text';
		textButton.addEventListener('click', () => options.onEditText?.());
		// CANoe's Trace-window filter set: identifiers, channel, direction, frame type. All
		// four sit on "all" defaults, and only a non-default state makes a spec — the
		// unfiltered browse stays the backend's fast path.
		this.idBox = el('input', 'hex-search can-filter') as HTMLInputElement;
		this.idBox.type = 'search';
		this.idBox.placeholder = 'Filter IDs (0x100, 1A0-1FF)';
		this.idBox.spellcheck = false;
		this.idBox.addEventListener('input', () => this.onFilterChange());
		this.channelSelect = el('select', 'can-channel') as HTMLSelectElement;
		this.channelSelect.title = 'Channel filter';
		this.channelSelect.setAttribute('aria-label', 'Channel filter');
		this.channelSelect.append(selectOption('', 'All channels'));
		this.channelSelect.addEventListener('change', () => this.onFilterChange());
		this.dirSelect = el('select', 'can-dir') as HTMLSelectElement;
		this.dirSelect.title = 'Direction filter';
		this.dirSelect.setAttribute('aria-label', 'Direction filter');
		this.dirSelect.append(selectOption('all', 'All directions'), selectOption('rx', 'Rx'), selectOption('tx', 'Tx'));
		this.dirSelect.addEventListener('change', () => this.onFilterChange());
		this.kindSelect = el('select', 'can-type') as HTMLSelectElement;
		this.kindSelect.title = 'Frame type filter';
		this.kindSelect.setAttribute('aria-label', 'Frame type filter');
		this.kindSelect.append(selectOption('all', 'All types'), selectOption('can', 'CAN'), selectOption('canfd', 'CAN FD'), selectOption('error', 'Error'), selectOption('remote', 'Remote'));
		this.kindSelect.addEventListener('change', () => this.onFilterChange());
		const pathChip = el('span', 'can-path', [this.path]);
		pathChip.title = this.path;
		// The find bar's toolbar entry — Ctrl+F anywhere in the view opens it too.
		const findButton = el('button', 'button secondary can-find-open', [icon('search')]) as HTMLButtonElement;
		findButton.title = 'Find (Ctrl+F)';
		findButton.addEventListener('click', () => this.openFind());
		const toolbar = el('div', 'hex-toolbar can-toolbar', [
			pathChip,
			this.idBox,
			this.channelSelect,
			this.dirSelect,
			this.kindSelect,
			el('span', 'hex-toolbar-sep'),
			findButton,
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
		this.emptyHint = el('div', 'can-raw-empty', ['No frames match the filter']);
		this.emptyHint.hidden = true;
		const viewport = el('div', 'can-raw-viewport', [this.scroller, this.emptyHint]);
		// Search only: the query matches a frame's id or its payload bytes (hex, the way
		// the log writes them), the count is "n of m", Enter / F3 step, Escape closes —
		// no replace controls, a trace is a measurement.
		this.findBox = el('input', 'cm-find-input') as HTMLInputElement;
		this.findBox.placeholder = 'Find id or data (hex)';
		this.findBox.spellcheck = false;
		this.findBox.addEventListener('input', () => this.scheduleFind());
		this.findBox.addEventListener('keydown', (event) => this.findKeydown(event));
		this.findCount = el('span', 'cm-find-count');
		const findButtonIn = (name: string, title: string, run: () => void) => {
			const node = el('button', 'cm-find-btn', [icon(name)]);
			node.title = title;
			node.addEventListener('click', run);
			return node;
		};
		this.findBar = el('div', 'cm-find-widget can-find', [
			el('div', 'cm-find-row', [
				el('span', 'cm-find-spacer'),
				this.findBox,
				this.findCount,
				findButtonIn('arrow-up', 'Previous Match (Shift+Enter)', () => this.stepFind(-1)),
				findButtonIn('arrow-down', 'Next Match (Enter)', () => this.stepFind(1)),
				findButtonIn('close', 'Close (Escape)', () => this.closeFind())
			])
		]);
		this.findBar.hidden = true;
		viewport.appendChild(this.findBar);
		this.root = el('div', 'can-view can-raw-view', [toolbar, this.progress, header, this.banner, viewport]);
		this.root.addEventListener('keydown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				event.stopPropagation();
				this.openFind();
			}
		});
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
	 *  done — the progress strip empties with it. While a filter is on the count is the
	 *  matches, "N of M" against the whole log. */
	private paintProgress(count: CanLogCount): void {
		const total = count.totalBytes || 0;
		const at = count.bytes || 0;
		const pct = total > 0 ? Math.min(100, Math.floor((at / total) * 100)) : null;
		const shown = count.matched ?? count.parsed;
		const ofAll = this.filter ? ` of ${count.parsed.toLocaleString()}` : '';
		if (count.done) {
			this.live.classList.remove('can-live-parsing');
			this.progress.classList.add('can-progress-done');
			this.setLive(`${shown.toLocaleString()}${ofAll} frames`);
			return;
		}
		const now = performance.now();
		let speed = '';
		if (this.mark && now > this.mark.at) {
			const rate = ((count.parsed - this.mark.parsed) * 1000) / (now - this.mark.at);
			if (rate > 0) speed = ` · ${compact(rate)} f/s`;
		}
		this.mark = { at: now, parsed: count.parsed };
		this.setLive(`${shown.toLocaleString()}${ofAll} frames · parsing…${pct !== null ? ` ${pct}%` : ''}${speed}`);
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

	/** One progress poll: extend the scroll range with the newly parsed (and, with a
	 *  filter, matching) frames, refresh the visible window, and schedule the next poll
	 *  until the walk reports itself done. */
	private async poll(): Promise<void> {
		const doc = this.doc;
		if (!doc || this.disposed || this.done) return;
		try {
			const count = await invoke<CanLogCount>('can_log_count', { docId: doc.docId, filter: this.filter });
			if (this.disposed || !this.doc || this.doc.docId !== doc.docId) return;
			this.applyCount(count);
			if (count.done) {
				this.done = true;
				if (count.error && this.parsed === 0) this.fail(`Failed to parse '${basename(this.path)}': ${count.error}`);
				else if (count.error) this.setLive(`${count.parsed.toLocaleString()} frames · parse stopped: ${count.error}`);
				// A find over the still-growing log saw only the parsed prefix; the finished
				// walk gets one rescan so the count and the jumps cover the whole file.
				if (!count.error) this.scheduleFind(0);
				return;
			}
		} catch {
			// A transient poll failure (the view closing mid-walk) just stops the loop; the
			// frame fetches surface real errors of their own.
			return;
		}
		this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
	}

	/** One out-of-band count call — the filter's own poll tick, for when the walk already
	 *  finished and no loop is running to pick the change up. */
	private async recount(): Promise<void> {
		const doc = this.doc;
		if (!doc || this.disposed || this.failed) return;
		try {
			const count = await invoke<CanLogCount>('can_log_count', { docId: doc.docId, filter: this.filter });
			if (!this.disposed && this.doc?.docId === doc.docId) this.applyCount(count);
		} catch {
			// Transient (the view closing mid-call); while the walk still runs, the poll
			// loop retries on its own.
		}
	}

	/** A count answer applied: the scroll spans the filtered `matched` (equal to `parsed`
	 *  unfiltered), the channel list fills the select, the live chip and the empty hint
	 *  follow. */
	private applyCount(count: CanLogCount): void {
		this.parsed = count.parsed;
		this.paintProgress(count);
		const rows = count.matched ?? count.parsed;
		if (rows !== this.rowCount) {
			this.rowCount = rows;
			// The model's range grows with the parse; the row the user is looking at
			// stays put, the scrollbar's thumb shrinks.
			this.scroll.setRowCount(rows);
			this.layout();
		}
		this.syncChannels(count.channels ?? []);
		this.updateEmptyHint();
	}

	/** The channel list follows the walk — channels join the select as their first frames
	 *  parse, and an existing selection stays selected. */
	private syncChannels(channels: number[]): void {
		const current = this.channelSelect.value;
		const options = this.channelSelect.options;
		if (options.length === channels.length + 1 && Array.from(options).every((option, i) => option.value === (i === 0 ? '' : String(channels[i - 1])))) return;
		this.channelSelect.replaceChildren(selectOption('', 'All channels'), ...channels.map((channel) => selectOption(String(channel), `Channel ${channel}`)));
		this.channelSelect.value = channels.includes(Number(current)) ? current : '';
	}

	/** The hint says "nothing matches" only while a filter is actually on — an unfiltered,
	 *  still-empty view is the parse's business, reported by the live chip. */
	private updateEmptyHint(): void {
		this.emptyHint.hidden = !(this.filter !== null && this.rowCount === 0 && !this.failed);
	}

	/** A filter control changed: rebuild the spec, drop the rows of the old row space and
	 *  start from the top of the new one. The count call carries the change; while the walk
	 *  still runs, the poll loop picks the new spec up on its next tick. */
	private onFilterChange(): void {
		const idRanges = idFilterRanges(this.idBox.value);
		const channels = this.channelSelect.value === '' ? [] : [Number(this.channelSelect.value)];
		const direction = this.dirSelect.value as CanFrameFilter['direction'];
		const kind = this.kindSelect.value as CanFrameFilter['kind'];
		const active = Boolean(idRanges) || channels.length > 0 || direction !== 'all' || kind !== 'all';
		this.filter = active ? { channels, direction, kind, idRanges: idRanges ?? [] } : null;
		// The rows on screen belong to the old row space; a fetch in flight from before the
		// change is aged out by generation so it cannot land in the new one.
		this.fetchGen++;
		this.cache.forEach((node) => node.remove());
		this.cache.clear();
		this.fetching.clear();
		this.fetchInFlight = false;
		this.refetch = false;
		this.rowCount = 0;
		this.scroll.setTop(0);
		this.scroll.setRowCount(0);
		this.updateEmptyHint();
		// The find's hit positions address the old row space; the open bar rescans the new
		// one on its own, the count shows the scan pending.
		this.findGen++;
		if (this.findTimer !== null) {
			clearTimeout(this.findTimer);
			this.findTimer = null;
		}
		this.hits = [];
		this.hitSet = new Set();
		this.hitIndex = -1;
		this.hitTotal = 0;
		this.hitsCapped = false;
		if (!this.findBar.hidden) {
			this.findCount.textContent = '…';
			if (this.doc && this.findBox.value.trim() !== '') this.scheduleFind(0);
		}
		if (!this.doc || this.failed) return;
		this.refresh();
		void this.recount();
	}

	/** Opens the find bar: focused and selected, a kept query re-runs at once. */
	private openFind(): void {
		this.findBar.hidden = false;
		this.findBox.focus();
		this.findBox.select();
		if (this.findBox.value.trim() !== '') this.scheduleFind(0);
	}

	private closeFind(): void {
		this.findBar.hidden = true;
		this.findGen++;
		if (this.findTimer !== null) {
			clearTimeout(this.findTimer);
			this.findTimer = null;
		}
		this.hits = [];
		this.hitSet = new Set();
		this.hitIndex = -1;
		this.hitTotal = 0;
		this.hitsCapped = false;
		this.paintHits();
		this.scroller.focus();
	}

	/** Typing re-runs the backend scan this late: a giant log's pass takes a moment, and
	 *  every keystroke rescanning it would starve the window reads. */
	private scheduleFind(delay = 250): void {
		if (this.findTimer !== null) clearTimeout(this.findTimer);
		if (this.findBar.hidden || !this.doc) return;
		this.findTimer = window.setTimeout(() => {
			this.findTimer = null;
			void this.runFind();
		}, delay);
	}

	/** One scan of the row space as the backend sees it (the live filter included). */
	private async runFind(): Promise<void> {
		const doc = this.doc;
		const query = this.findBox.value.trim();
		const gen = ++this.findGen;
		if (!doc || query === '') {
			this.hits = [];
			this.hitSet = new Set();
			this.hitIndex = -1;
			this.hitTotal = 0;
			this.hitsCapped = false;
			this.findBox.classList.remove('invalid');
			this.findCount.classList.remove('invalid');
			this.findCount.textContent = '';
			this.paintHits();
			return;
		}
		let result: CanFindResult;
		try {
			result = await invoke<CanFindResult>('can_log_find', { docId: doc.docId, query, filter: this.filter });
		} catch (error) {
			if (gen !== this.findGen || this.disposed) return;
			this.hits = [];
			this.hitSet = new Set();
			this.hitIndex = -1;
			this.hitTotal = 0;
			this.hitsCapped = false;
			this.paintHits();
			const message = String(error);
			if (message.includes('not a hexadecimal')) {
				this.findBox.classList.add('invalid');
				this.findCount.textContent = 'Not hex';
				this.findCount.classList.add('invalid');
			} else {
				this.findCount.textContent = '';
				this.findCount.title = message;
			}
			return;
		}
		if (gen !== this.findGen || this.disposed) return;
		this.findBox.classList.remove('invalid');
		this.findCount.classList.remove('invalid');
		this.findCount.title = '';
		this.hits = result.positions;
		this.hitTotal = result.total;
		this.hitsCapped = result.capped;
		this.hitSet = new Set(this.hits);
		// The first hit at or after the viewport's top, wrapping — typing lands on the
		// nearest hit, the way every find bar does.
		this.hitIndex = this.hits.findIndex((position) => position >= this.scroll.top);
		if (this.hitIndex === -1 && this.hits.length > 0) this.hitIndex = 0;
		this.refreshFindCount();
		this.paintHits();
		if (this.hitIndex >= 0) this.revealHit();
	}

	/** Jump to the next (`1`) or previous (`-1`) hit, wrapping — Enter / F3's job. */
	private stepFind(delta: number): void {
		if (this.hits.length === 0) return;
		this.hitIndex = (this.hitIndex + delta + this.hits.length) % this.hits.length;
		this.revealHit();
		this.paintHits();
		this.refreshFindCount();
	}

	/** The current hit becomes the viewport's top row — the model clamps it in. */
	private revealHit(): void {
		const position = this.hits[this.hitIndex];
		if (position === undefined) return;
		this.scroll.setTop(position);
		// Already at the top: no change event fires, and the row (and its current-mark)
		// still has to land.
		this.refresh();
	}

	private refreshFindCount(): void {
		if (this.hits.length === 0) {
			this.findCount.textContent = this.findBox.value.trim() === '' ? '' : 'No matches';
			return;
		}
		const current = (this.hitIndex + 1).toLocaleString();
		this.findCount.textContent = this.hitsCapped
			? `${current} of ${this.hits.length.toLocaleString()}+`
			: `${current} of ${this.hitTotal.toLocaleString()}`;
	}

	/** Repaint the hit marks over the rendered rows: a hit tints, the current one outlines. */
	private paintHits(): void {
		const current = this.hits[this.hitIndex];
		for (const [index, node] of this.cache) {
			node.classList.toggle('can-raw-hit', this.hitSet.has(index));
			node.classList.toggle('can-raw-cur', index === current);
		}
	}

	private findKeydown(event: KeyboardEvent): void {
		// The workbench must not see the bar's keys (the panel's, the palette's).
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			this.closeFind();
			return;
		}
		if (event.key === 'Enter' || event.key === 'F3') {
			event.preventDefault();
			this.stepFind(event.shiftKey ? -1 : 1);
		}
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
		// The generation this fetch belongs to: a filter change while it is out ages it
		// out on landing — its rows are positions in a row space that no longer exists.
		const gen = this.fetchGen;
		invoke<CanFrameLine[]>('can_log_frames', { docId, start, end, filter: this.filter })
			.then((lines) => {
				if (gen !== this.fetchGen) return;
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
				if (gen !== this.fetchGen) return;
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
			// The "No." is the frame's own place in the log (`line.index`), not its position
			// among the matches — a filtered view still numbers the frames it shows the way
			// the whole log does.
			el('span', 'can-raw-no', [String(line.index + 1)]),
			el('span', 'can-raw-time', [line.tS.toFixed(6)]),
			el('span', 'can-raw-ch', [String(line.channel)]),
			id,
			dir,
			typeBadge(line),
			el('span', 'can-raw-dlc', [String(dlcShown)]),
			data
		];
		const row = el('div', 'can-raw-row can-raw-grid' + (line.error ? ' can-row-error' : ''), cells);
		// The find's marks travel with the row: a hit tints, the current one outlines.
		if (this.hitSet.has(index)) row.classList.add('can-raw-hit');
		if (this.hits[this.hitIndex] === index) row.classList.add('can-raw-cur');
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
		if (this.findTimer !== null) clearTimeout(this.findTimer);
		if (this.doc) void invoke('can_log_close', { docId: this.doc.docId });
		this.root.remove();
	}
}
