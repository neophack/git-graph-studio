// The data table a `.csv` / `.tsv` opens in: the backend sniffed its shape from the first
// kilobytes (delimiter, header, per-column numeric flags — `csv_open`) and keeps parsing
// in the background; this view polls the published count (`csv_count`) to grow the row
// model's range and fetches only the visible window of rows (`csv_rows`) — a
// multi-million-row export is browsable while it is still being parsed. Every cell that
// parsed as a number renders (and sorts) as one; everything else keeps its original text.
//
// The toolbar's mode chips switch the body between the table and the plot. The plot reads
// the numeric columns back as decimated series (`csv_series`) — one x axis (a numeric
// column, or the row's own position) under every selected column — and zooms: the wheel
// drives the window, the refetch redraws the window at full resolution, the y axis
// rescales to what it now shows. A header click sorts the table (the order computes and
// memoizes on the backend; rows keep numbering in file order whatever the sort shows).
//
// "Text" swaps the tab to the file's plain text form, editable (the caller owns the
// editor swap — the same swap a CAN trace's Text button drives, and the same one-button
// journey back). Ctrl+F over the table is the text form's business.

import { type CsvCellValue, type CsvCount, type CsvOpenResult, type CsvRowLine, type CsvSort, csvClose, csvCount, csvOpen, csvRows, csvSeries } from '../../platform/ipc/csv';
import { attachPageKeys, attachWheel, type Disposable } from '../../scroll/input';
import { ScrollModel } from '../../scroll/model';
import { Scrollbar } from '../../scroll/scrollbar';
import { attachTouchScroll, canCoarsePointer } from '../../scroll/touch';
import { CsvPlot, plotSeriesCls } from './csvPlot';
import { basename, el, icon } from '../../platform/ui/index';
import { t, tf } from '../../platform/i18n';

/** Fixed row height keeps the scroll math allocation-free (shell.css `.csv-row`). */
const ROW_HEIGHT = 22;
/** The narrow form's row height under a coarse pointer — a finger's target. */
const ROW_HEIGHT_TOUCH = 32;
/** Rows kept rendered above and below the viewport, so small scrolls don't flash empty. */
const OVERSCAN = 10;
/** Rows per backend fetch (viewport + overscan), bounded so one response stays small. */
const MAX_WINDOW = 500;
/** How often the view asks the background walk how far it has come. */
const POLL_MS = 400;
/** Every table column draws at one fixed width; the horizontal scrollbar spans them. */
const COL_WIDTH = 150;
/** The row-number gutter's width. */
const NO_WIDTH = 64;
/** Plot series refetch debounce after a zoom or pan settles. */
const REFETCH_MS = 150;

/** A numeric cell as the table prints it: the double the JSON delivered, at its
 *  shortest round-trip (`String`'s own choice); non-finite spellings (`NaN`, the
 *  exports' missing samples) verbatim. */
function fmtCell(v: number): string {
	return String(v);
}

/** One `<option>` with its value — the X select's shared builder. */
function selectOption(value: string, label: string): HTMLOptionElement {
	const option = el('option', undefined, [label]) as HTMLOptionElement;
	option.value = value;
	return option;
}

/** How many numeric columns auto-select for the plot on first open. */
const AUTO_SERIES = 4;

export interface CsvViewOptions {
	/** "Text" swaps this tab to the file's plain text form, editable (the caller owns
	 *  the editor swap). */
	onEditText?: () => void;
}

export class CsvView {
	readonly root: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly headInner: HTMLElement;
	/** The viewport's position over the parsed rows (scroll/model.ts). */
	readonly scroll: ScrollModel;
	private readonly scrollbar: Scrollbar;
	private readonly sizer: ResizeObserver | null;
	private readonly live: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly liveDot: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly banner: HTMLElement;
	private readonly pathChip: HTMLElement;
	/** The mode chips — Table and Plot, a pressed state on the active one. */
	private readonly tableChip: HTMLButtonElement;
	private readonly plotChip: HTMLButtonElement;
	private readonly textButton: HTMLButtonElement;
	/** The table pane and its pieces; the plot pane lives beside it, shown by mode. */
	private readonly tablePane: HTMLElement;
	private readonly emptyHint: HTMLElement;
	private readonly headWrap: HTMLElement;
	/** The plot pane and its controls. */
	private readonly plotPane: HTMLElement;
	private readonly xSelect: HTMLSelectElement;
	private readonly yChips: HTMLElement;
	private readonly plotReset: HTMLButtonElement;
	private readonly plotHint: HTMLElement;
	private readonly plotHost: HTMLElement;
	private plot: CsvPlot | null = null;
	/** The open document and the walk's progress. */
	private doc: CsvOpenResult | null = null;
	private parsed = 0;
	private done = false;
	private failed = false;
	/** The columns as the walk knows them: names and numeric flags. */
	private columns: { name: string | null; numeric: boolean }[] = [];
	/** The header's sort state — `null` while the rows sit in file order, then the
	 *  column and its direction, cycling none → asc → desc → none per click. */
	private sort: CsvSort | null = null;
	/** The row count the scroll model spans (the parsed rows, whatever sort shows). */
	private rowCount = 0;
	/** Bumped on every sort change: a fetch that lands from the old row space ages out. */
	private fetchGen = 0;
	/** The visible window the last refresh computed — what a landing fetch checks itself
	 *  against before placing rows. */
	private windowFirst = 0;
	private windowLast = Infinity;
	/** Row cache, 0-based row-space position → rendered row element. */
	private cache = new Map<number, HTMLElement>();
	private fetching = new Set<number>();
	/** One `csv_rows` request in flight at a time (the CAN raw view's single-flight
	 *  fetch: a fast drag marks `refetch` instead of piling requests onto the backend). */
	private fetchInFlight = false;
	private refetch = false;
	private timer: number | null = null;
	private disposed = false;
	/** The wheel and the page keys over the scroller (scroll/input.ts), disposed with the view. */
	private readonly wheel: Disposable;
	private readonly pageKeys: Disposable;
	private readonly touchScroll: Disposable;

	/* plot state */
	private mode: 'table' | 'plot' = 'table';
	/** The x axis: `null` = the row's own position; else a numeric column index. */
	private xCol: number | null = null;
	/** The selected y columns, in pick order — the series' palette order. */
	private yCols: number[] = [];
	/** The view window over the x axis (the zoom's state); null = the whole file. */
	private viewX: { x0: number; x1: number } | null = null;
	/** The data's own x range, as the last series answer named it — the reset's full-span
	 *  window normalizes back to `null` bounds against it. */
	private fullX: { min: number; max: number } | null = null;
	/** Bumped on every selection or window change: a stale series answer drops. */
	private seriesGen = 0;
	private refetchTimer: number | null = null;

	constructor(private path: string, options: CsvViewOptions = {}) {
		this.pathChip = el('span', 'can-path', [this.path]);
		this.pathChip.title = this.path;
		this.tableChip = el('button', 'button secondary csv-mode-chip', [icon('table'), ` ${t('csv.table')}`]) as HTMLButtonElement;
		this.tableChip.title = t('csv.table.title');
		this.plotChip = el('button', 'button secondary csv-mode-chip', [icon('graph-line'), ` ${t('csv.plot')}`]) as HTMLButtonElement;
		this.plotChip.title = t('csv.plot.title');
		this.tableChip.addEventListener('click', () => this.setMode('table'));
		this.plotChip.addEventListener('click', () => this.setMode('plot'));
		this.textButton = el('button', 'button secondary can-text', [icon('edit'), ` ${t('csv.text')}`]) as HTMLButtonElement;
		this.textButton.title = t('csv.text.title');
		this.textButton.addEventListener('click', () => options.onEditText?.());
		this.liveDot = el('span', 'can-live-dot');
		this.liveText = el('span', 'can-live-text', [t('csv.live.opening')]);
		this.live = el('span', 'can-live can-live-parsing', [this.liveDot, this.liveText]);
		this.progressFill = el('i');
		this.progress = el('div', 'can-progress', [this.progressFill]);
		const toolbar = el('div', 'hex-toolbar can-toolbar csv-toolbar', [this.pathChip, this.tableChip, this.plotChip, this.live, this.textButton]);
		// The table pane: the header row (horizontally synced with the body's scroll) over
		// the virtual-scroll viewport.
		this.headWrap = el('div', 'csv-head-wrap');
		this.headInner = el('div', 'csv-head');
		this.headWrap.appendChild(this.headInner);
		this.banner = el('div', 'can-error csv-banner');
		this.banner.hidden = true;
		this.scroller = el('div', 'csv-scroll');
		this.rows = el('div', 'csv-rows');
		this.scroller.appendChild(this.rows);
		this.emptyHint = el('div', 'csv-empty', [t('csv.empty')]);
		this.emptyHint.hidden = true;
		const viewport = el('div', 'csv-viewport', [this.scroller, this.emptyHint]);
		this.tablePane = el('div', 'csv-table-pane', [this.headWrap, this.banner, viewport]);
		// The plot pane: the column pickers over the chart. The picker row's select and
		// chips fill in as the walk names numeric columns.
		this.xSelect = el('select', 'csv-x-select') as HTMLSelectElement;
		this.xSelect.title = t('csv.plot.xAxis');
		this.xSelect.setAttribute('aria-label', t('csv.plot.xAxis'));
		this.xSelect.addEventListener('change', () => {
			const value = this.xSelect.value;
			this.xCol = value === '' ? null : Number(value);
			this.resetView();
			void this.fetchSeries();
		});
		this.yChips = el('div', 'csv-y-chips');
		this.plotReset = el('button', 'button secondary csv-plot-reset', [icon('clear-all'), ` ${t('csv.plot.reset')}`]) as HTMLButtonElement;
		this.plotReset.title = t('csv.plot.reset.title');
		this.plotReset.addEventListener('click', () => this.resetView());
		this.plotHint = el('div', 'csv-plot-hint', [t('csv.plot.hint')]);
		this.plotHint.hidden = true;
		this.plotHost = el('div', 'csv-plot-host-slot');
		this.plotPane = el('div', 'csv-plot-pane', [
			el('div', 'csv-plot-bar', [
				el('span', 'csv-plot-label', [t('csv.plot.xAxis')]),
				this.xSelect,
				el('span', 'csv-plot-label', [t('csv.plot.series')]),
				this.yChips,
				this.plotReset
			]),
			this.plotHint,
			this.plotHost
		]);
		this.root = el('div', 'can-view csv-view', [toolbar, this.progress, this.tablePane, this.plotPane]);
		this.plotPane.hidden = true;
		this.root.addEventListener('keydown', (event) => {
			// Ctrl+F has no table find: the text form is where the file's text is searched.
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				options.onEditText?.();
			}
		});
		this.scroll = new ScrollModel(ROW_HEIGHT);
		this.scroll.onChange(() => this.refresh());
		this.scrollbar = new Scrollbar(viewport, this.scroll);
		this.wheel = attachWheel(this.scroller, this.scroll);
		this.pageKeys = attachPageKeys(this.scroller, this.scroll);
		this.touchScroll = attachTouchScroll(this.scroller, this.scroll);
		// The table owns its drags: a finger over it scrolls the rows, so the phone's page
		// pager steps aside (swipeNav's list).
		viewport.setAttribute('data-owns-gestures', '');
		this.scroller.addEventListener('scroll', () => this.syncHead());
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout());
		this.sizer?.observe(this.scroller);
		if (canCoarsePointer()) {
			this.root.style.setProperty('--csv-row-h', `${ROW_HEIGHT_TOUCH}px`);
			this.scroll.setRowHeight(ROW_HEIGHT_TOUCH);
		}
		void this.load();
	}

	/* ---------- modes ---------- */

	private setMode(mode: 'table' | 'plot'): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.syncModeChips();
		this.tablePane.hidden = mode !== 'table';
		this.plotPane.hidden = mode !== 'plot';
		if (mode === 'plot') {
			this.mountPlot();
			void this.fetchSeries();
		} else {
			this.layout();
		}
	}

	private syncModeChips(): void {
		this.tableChip.classList.toggle('can-chip-on', this.mode === 'table');
		this.tableChip.setAttribute('aria-pressed', String(this.mode === 'table'));
		this.plotChip.classList.toggle('can-chip-on', this.mode === 'plot');
		this.plotChip.setAttribute('aria-pressed', String(this.mode === 'plot'));
	}

	private setLive(text: string): void {
		this.liveText.textContent = text;
	}

	/* ---------- the document ---------- */

	/** Opens the document — the backend returns as soon as the sniff is done and keeps
	 *  parsing in the background; this view polls the walk's progress until it is done. */
	private async load(): Promise<void> {
		let doc: CsvOpenResult;
		try {
			doc = await csvOpen(this.path);
		} catch (error) {
			this.fail(tf('csv.openFailed', basename(this.path), String(error)));
			return;
		}
		if (this.disposed) {
			void csvClose(doc.docId);
			return;
		}
		this.doc = doc;
		this.poll();
	}

	/** One progress poll: grow the scroll range with the newly parsed rows, refresh the
	 *  columns (the header and the plot picker follow), schedule the next poll until the
	 *  walk reports itself done. */
	private async poll(): Promise<void> {
		const doc = this.doc;
		if (!doc || this.disposed || this.done) return;
		try {
			const count = await csvCount(doc.docId);
			if (this.disposed || !this.doc || this.doc.docId !== doc.docId) return;
			this.applyCount(count);
			if (count.done) {
				this.done = true;
				if (count.error && this.parsed === 0) this.fail(`${t('csv.parseError')} '${basename(this.path)}': ${count.error}`);
				else if (count.error) this.setLive(`${count.parsed.toLocaleString()} ${t('csv.live.rows')} · ${tf('csv.live.parseStopped', count.error)}`);
				else this.paintLiveDone(count);
				return;
			}
		} catch {
			// A transient poll failure (the view closing mid-walk) just stops the loop; the
			// row fetches surface real errors of their own.
			return;
		}
		this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
	}

	/** The chip while the walk runs: count, file percentage and speed; the settled shape —
	 *  "N rows · M columns" — once done. */
	private paintLiveDone(count: CsvCount): void {
		this.live.classList.remove('can-live-parsing');
		this.progress.classList.add('can-progress-done');
		this.setLive(tf('csv.live.done', count.parsed.toLocaleString(), count.columns.length.toLocaleString()));
	}

	private applyCount(count: CsvCount): void {
		this.parsed = count.parsed;
		if (!count.done) {
			const total = count.totalBytes || 0;
			const at = count.bytes || 0;
			const pct = total > 0 ? Math.min(100, Math.floor((at / total) * 100)) : null;
			this.setLive(`${count.parsed.toLocaleString()} ${t('csv.live.rows')} · ${t('csv.live.parsing')}${pct !== null ? ` ${pct}%` : ''}`);
			if (pct !== null) this.progressFill.style.width = `${pct}%`;
		}
		const columnsChanged = count.columns.length !== this.columns.length || count.columns.some((c, i) => c.name !== this.columns[i]?.name || c.numeric !== this.columns[i]?.numeric);
		if (columnsChanged) {
			this.columns = count.columns;
			this.renderHead();
			this.syncPlotPickers();
		}
		if (count.parsed !== this.rowCount) {
			this.rowCount = count.parsed;
			this.scroll.setRowCount(count.parsed);
			this.layout();
		}
		this.emptyHint.hidden = !(this.done && this.parsed === 0 && !this.failed);
	}

	private fail(text: string): void {
		this.failed = true;
		this.done = true;
		this.banner.textContent = text;
		this.banner.hidden = false;
		this.live.classList.remove('can-live-parsing');
		this.liveDot.classList.add('can-live-dot-failed');
		this.progress.classList.add('can-progress-done');
		this.setLive(t('csv.live.failed'));
	}

	/* ---------- the table ---------- */

	/** The header row: the sticky No. gutter, then one cell per column — its name (or the
	 *  localized "Column N"), the numeric mark, and the sort arrow. A click cycles the
	 *  sort; the current sort's column reads pressed. */
	private renderHead(): void {
		const cells: HTMLElement[] = [el('span', 'csv-no csv-hcell', [t('csv.row')])];
		this.columns.forEach((column, i) => {
			const arrow = this.sort?.column === i ? (this.sort.descending ? 'arrow-down' : 'arrow-up') : null;
			const bits: (string | HTMLElement)[] = [];
			if (arrow) bits.push(icon(arrow, 'csv-sort-arrow'));
			bits.push(column.name ?? tf('csv.column', i + 1));
			if (column.numeric) bits.push(icon('symbol-number', 'csv-num-mark'));
			const cell = el('button', 'csv-hcell csv-hcol' + (this.sort?.column === i ? ' csv-hsort' : ''), bits) as HTMLButtonElement;
			cell.type = 'button';
			cell.title = this.sort?.column === i
				? (this.sort!.descending ? t('csv.sort.desc.title') : t('csv.sort.asc.title'))
				: t('csv.sort.click.title');
			cell.setAttribute('aria-label', cell.title);
			cell.addEventListener('click', () => this.cycleSort(i));
			cells.push(cell);
		});
		this.headInner.replaceChildren(...cells);
		this.paintWidth();
		this.syncHead();
	}

	private cycleSort(column: number): void {
		if (this.sort?.column !== column) this.sort = { column, descending: false };
		else if (!this.sort.descending) this.sort = { column, descending: true };
		else this.sort = null;
		// The rows on screen belong to the old row space; start from the top of the new one.
		this.fetchGen++;
		this.cache.forEach((node) => node.remove());
		this.cache.clear();
		this.fetching.clear();
		this.fetchInFlight = false;
		this.refetch = false;
		this.rowCount = this.parsed;
		this.scroll.setTop(0);
		this.renderHead();
		this.refresh();
	}

	/** The table's total width: the gutter plus one fixed width per column, never under
	 *  the viewport (a narrow table stretches like the CAN grid's `min-width: 100%`). */
	private totalWidth(): number {
		return Math.max(this.scroller.clientWidth, NO_WIDTH + this.columns.length * COL_WIDTH);
	}

	private paintWidth(): void {
		const width = `${this.totalWidth()}px`;
		this.headInner.style.width = width;
		this.rows.style.width = width;
		const cols = `${NO_WIDTH}px repeat(${this.columns.length}, minmax(${COL_WIDTH}px, 1fr))`;
		// One shared custom property carries the grid template to the header and every
		// rendered row, so a column-count change is one write.
		this.headInner.style.setProperty('--csv-cols', cols);
		this.rows.style.setProperty('--csv-cols', cols);
	}

	/** The header follows the body's horizontal scroll (the body scrolls natively; the
	 *  header sits outside it and translates by its scrollLeft). */
	private syncHead(): void {
		this.headInner.style.transform = `translateX(${-this.scroller.scrollLeft}px)`;
	}

	/** The viewport was (re)laid out: the model takes its height, and the rows follow. */
	private layout(): void {
		this.scroll.setViewport(this.scroller.clientHeight);
		this.paintWidth();
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
		// The generation this fetch belongs to: a sort change while it is out ages it out
		// on landing — its rows are positions in a row space that no longer exists.
		const gen = this.fetchGen;
		csvRows(docId, start, end, this.sort)
			.then((lines) => {
				if (gen !== this.fetchGen) return;
				this.fetchInFlight = false;
				if (!this.disposed && this.doc?.docId === docId) {
					// The backend serves only its parsed prefix: a window that reaches past it
					// comes back short (or empty) rather than waiting. Every requested index is
					// released here regardless, so the walk's growth re-fills them.
					for (let index = start; index < end; index++) this.fetching.delete(index);
					lines.forEach((line, offset) => {
						const index = start + offset;
						if (index < this.windowFirst || index > this.windowLast) return;
						if (this.cache.has(index)) return;
						const row = this.renderRow(index, line);
						this.cache.set(index, row);
						this.place(row, index);
					});
				}
				// The viewport (or the parsed prefix) moved on while this fetch was out: pick up
				// whatever it still wants — no scroll event is coming to ask again on its own.
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
		row.style.top = `${this.scroll.rowTop(index)}px`;
		// Rows arrive out of order; insert before the first row with a larger index.
		const key = (node: HTMLElement) => Number(node.dataset.row);
		let after: HTMLElement | null = null;
		for (const node of Array.from(this.rows.children) as HTMLElement[]) {
			if (key(node) > index) {
				after = node;
				break;
			}
		}
		this.rows.insertBefore(row, after);
	}

	private renderRow(index: number, line: CsvRowLine): HTMLElement {
		const cells: HTMLElement[] = [el('span', 'csv-no csv-cell', [String(line.index + 1)])];
		line.cells.forEach((value, c) => cells.push(this.renderCell(value, this.columns[c]?.numeric === true)));
		const row = el('div', 'csv-row', cells);
		row.dataset.row = String(index);
		return row;
	}

	private renderCell(value: CsvCellValue, numeric: boolean): HTMLElement {
		const text = typeof value === 'number' ? fmtCell(value) : value;
		const cell = el('span', 'csv-cell' + (numeric ? ' csv-cell-num' : ''), [text]);
		if (text.length > 24) cell.title = text;
		return cell;
	}

	/* ---------- the plot ---------- */

	/** The pickers follow the walk: the x select offers the numeric columns beside the
	 *  row axis; the y chips offer every numeric column, the first few pre-selected. */
	private syncPlotPickers(): void {
		const numeric = this.columns.map((c, i) => ({ i, name: c.name, numeric: c.numeric })).filter((c) => c.numeric);
		// The x select: Row axis + every numeric column. The current pick survives a
		// rebuild when its column still exists.
		const current = this.xCol;
		const options = [selectOption('', t('csv.plot.rowAxis')), ...numeric.map((c) => selectOption(String(c.i), this.columnName(c.i)))];
		this.xSelect.replaceChildren(...options);
		if (current !== null && numeric.some((c) => c.i === current)) this.xSelect.value = String(current);
		else this.xSelect.value = '';
		// The y chips: one per numeric column. First open auto-selects a handful.
		this.yChips.replaceChildren(...numeric.map((c) => {
			const chip = el('button', 'can-chip csv-y-chip') as HTMLButtonElement;
			chip.type = 'button';
			chip.append(el('i', 'can-swatch ' + plotSeriesCls(this.yOrder(c.i))), this.columnName(c.i));
			const selected = this.yCols.includes(c.i);
			chip.classList.toggle('can-chip-on', selected);
			chip.setAttribute('aria-pressed', String(selected));
			chip.title = t('csv.plot.seriesToggle');
			chip.addEventListener('click', () => this.toggleSeries(c.i));
			return chip;
		}));
		this.plotHint.hidden = numeric.length > 0;
		// A selected column that stopped being numeric (never happens in practice — the
		// walk only grows the counts) leaves the selection; prune it honestly.
		this.yCols = this.yCols.filter((c) => numeric.some((n) => n.i === c));
	}

	/** The palette position of column `c` in the selection, for its swatch. */
	private yOrder(column: number): number {
		return Math.max(0, this.yCols.indexOf(column));
	}

	private columnName(column: number): string {
		return this.columns[column]?.name ?? tf('csv.column', column + 1);
	}

	private toggleSeries(column: number): void {
		const at = this.yCols.indexOf(column);
		if (at === -1) this.yCols.push(column);
		else this.yCols.splice(at, 1);
		this.syncPlotPickers();
		void this.fetchSeries();
	}

	/** The default selection on first show: the row axis under the first few numeric
	 *  columns — a data export plots itself without a single click. */
	private mountPlot(): void {
		if (this.plot) return;
		this.plot = new CsvPlot({
			xLabel: '',
			onView: (x0, x1) => {
				// A window spanning the whole data range is no window at all — the reset
				// (and a zoom-out that reaches the edge) fetches without bounds, the zooms
				// fetch theirs.
				const full = this.fullX;
				this.viewX = full && x0 <= full.min + 1e-12 && x1 >= full.max - 1e-12 ? null : { x0, x1 };
				this.scheduleSeriesRefetch();
			}
		});
		this.plotHost.appendChild(this.plot.root);
		if (this.yCols.length === 0) {
			this.yCols = this.columns.map((c, i) => ({ i, numeric: c.numeric })).filter((c) => c.numeric).slice(0, AUTO_SERIES).map((c) => c.i);
			this.syncPlotPickers();
		}
	}

	private resetView(): void {
		this.viewX = null;
		if (this.plot) this.plot.reset();
	}

	/** The zoom/pan moved: the redraw comes from a fresh fetch of exactly that window —
	 *  debounced, so a wheel flurry makes one request. */
	private scheduleSeriesRefetch(): void {
		if (this.refetchTimer !== null) clearTimeout(this.refetchTimer);
		this.refetchTimer = window.setTimeout(() => {
			this.refetchTimer = null;
			void this.fetchSeries();
		}, REFETCH_MS);
	}

	private async fetchSeries(): Promise<void> {
		const doc = this.doc;
		if (!doc || this.disposed || this.mode !== 'plot') return;
		const ys = [...this.yCols];
		const x = this.xCol;
		const range = this.viewX;
		const gen = ++this.seriesGen;
		try {
			const result = await csvSeries(doc.docId, x, ys, range?.x0 ?? null, range?.x1 ?? null);
			if (gen !== this.seriesGen || this.disposed || this.mode !== 'plot') return;
			if (!this.plot) this.mountPlot();
			const xWindow = range ?? (Number.isFinite(result.xMin) ? { x0: result.xMin, x1: result.xMax } : { x0: 0, x1: 1 });
			if (Number.isFinite(result.xMin)) this.fullX = { min: result.xMin, max: result.xMax };
			this.plot!.setData(
				result.series.map((s, i) => ({
					column: s.column,
					name: s.name ?? tf('csv.column', s.column + 1),
					cls: plotSeriesCls(i),
					points: s.points,
					stats: s.stats
				})),
				result.xMin,
				result.xMax,
				xWindow
			);
		} catch (error) {
			if (gen !== this.seriesGen || this.disposed) return;
			this.fail(String(error));
		}
	}

	dispose(): void {
		this.disposed = true;
		this.wheel.dispose();
		this.pageKeys.dispose();
		this.touchScroll.dispose();
		this.scrollbar.dispose();
		this.plot?.dispose();
		this.sizer?.disconnect();
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.refetchTimer !== null) clearTimeout(this.refetchTimer);
		if (this.doc) void csvClose(this.doc.docId);
		this.root.remove();
	}
}
