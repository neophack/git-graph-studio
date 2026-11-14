// The ELF image a `.elf` / `.axf` opens in: the backend parsed the file once
// (`elf_open` — header, segments, sections, the rough ROM/RAM split), this view shows
// the summary card and switches the body between the section table and the symbol
// table (`elf_symbols` windows the kept functions and objects — largest first, with a
// case-insensitive filter the backend applies). A binary has no text form; the hex
// viewer is one tab away for anyone who wants raw bytes.

import { type ElfOpenResult, type ElfSymbolLine, elfClose, elfOpen, elfSymbols } from '../../platform/ipc/elf';
import { attachWheel, type Disposable } from '../../scroll/input';
import { ScrollModel } from '../../scroll/model';
import { Scrollbar } from '../../scroll/scrollbar';
import { basename, el, icon } from '../../platform/ui/index';
import { t, tf } from '../../platform/i18n';

/** Fixed row height keeps the scroll math allocation-free. */
const ROW_HEIGHT = 22;
/** Rows kept rendered above and below the viewport. */
const OVERSCAN = 12;
/** Rows per backend fetch, bounded so one response stays small. */
const MAX_WINDOW = 500;

const hexAddr = (v: number): string => (v === 0 ? '—' : `0x${v.toString(16)}`);
const hexSize = (v: number): string => (v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB` : v >= 1024 ? `${(v / 1024).toFixed(1)} KB` : `${v} B`);

export class ElfView {
	readonly root: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly sectionsChip: HTMLButtonElement;
	private readonly symbolsChip: HTMLButtonElement;
	private readonly search: HTMLInputElement;
	private readonly summary: HTMLElement;
	private readonly segmentsPane: HTMLElement;
	private readonly sectionsPane: HTMLElement;
	private readonly symbolsPane: HTMLElement;
	/** The symbols' viewport position over the filtered rows (scroll/model.ts). */
	readonly scroll: ScrollModel;
	private readonly symRows: HTMLElement;
	private readonly symHead: HTMLElement;
	private readonly scrollbar: Scrollbar;
	private readonly sizer: ResizeObserver | null;
	private readonly wheel: Disposable;
	private doc: ElfOpenResult | null = null;
	private failed = false;
	private mode: 'sections' | 'symbols' = 'sections';
	private filter = '';
	private rowCount = 0;
	private fetchGen = 0;
	private windowFirst = 0;
	private windowLast = Infinity;
	private cache = new Map<number, HTMLElement>();
	private fetching = new Set<number>();
	private fetchInFlight = false;
	private refetch = false;
	private disposed = false;

	constructor(private path: string) {
		const pathChip = el('span', 'can-path', [this.path]);
		pathChip.title = this.path;
		this.liveText = el('span', 'can-live-text', [t('elf.live.opening')]);
		const live = el('span', 'can-live can-live-parsing', [el('span', 'can-live-dot'), this.liveText]);
		this.sectionsChip = el('button', 'button secondary elf-mode-chip', [icon('list-flat'), ` ${t('elf.sections')}`]) as HTMLButtonElement;
		this.sectionsChip.title = t('elf.sections.title');
		this.symbolsChip = el('button', 'button secondary elf-mode-chip', [icon('symbol-function'), ` ${t('elf.symbols')}`]) as HTMLButtonElement;
		this.symbolsChip.title = t('elf.symbols.title');
		this.sectionsChip.addEventListener('click', () => this.setMode('sections'));
		this.symbolsChip.addEventListener('click', () => this.setMode('symbols'));
		this.search = el('input', 'dbc-search elf-search') as HTMLInputElement;
		this.search.type = 'text';
		this.search.placeholder = t('elf.search');
		this.search.setAttribute('aria-label', t('elf.search'));
		this.search.addEventListener('input', () => {
			this.filter = this.search.value.trim();
			this.refetchWindow(0);
		});
		const toolbar = el('div', 'hex-toolbar can-toolbar', [pathChip, this.sectionsChip, this.symbolsChip, live, this.search]);
		this.summary = el('div', 'elf-summary');
		this.segmentsPane = el('div', 'elf-segments');
		// The section table.
		const secHead = el('div', 'elf-t-head elf-sec-head', [
			el('span', 'elf-hcell elf-a-name', [t('elf.col.name')]),
			el('span', 'elf-hcell elf-a-kind', [t('elf.col.kind')]),
			el('span', 'elf-hcell elf-a-addr', [t('elf.col.addr')]),
			el('span', 'elf-hcell elf-a-size', [t('elf.col.size')]),
			el('span', 'elf-hcell elf-a-flags', [t('elf.col.flags')])
		]);
		const secBody = el('div', 'elf-t-body');
		this.sectionsPane = el('div', 'elf-table elf-sections', [secHead, secBody]);
		// The symbol table: a sticky head over a virtual-scroll viewport.
		this.symHead = el('div', 'elf-t-head elf-sym-head', [
			el('span', 'elf-hcell elf-b-name', [t('elf.col.name')]),
			el('span', 'elf-hcell elf-b-addr', [t('elf.col.addr')]),
			el('span', 'elf-hcell elf-b-size', [t('elf.col.size')]),
			el('span', 'elf-hcell elf-b-kind', [t('elf.col.kind')]),
			el('span', 'elf-hcell elf-b-bind', [t('elf.col.bind')])
		]);
		this.symRows = el('div', 'elf-sym-rows');
		const scroller = el('div', 'elf-sym-scroll', [this.symRows]);
		const emptyHint = el('div', 'dbc-capped elf-sym-empty', [t('elf.symbols.empty')]);
		emptyHint.hidden = true;
		const viewport = el('div', 'elf-sym-viewport', [scroller, emptyHint]);
		this.symbolsPane = el('div', 'elf-table elf-symbols', [this.symHead, viewport]);
		this.scroll = new ScrollModel(ROW_HEIGHT);
		this.scroll.onChange(() => this.refresh());
		this.scrollbar = new Scrollbar(viewport, this.scroll);
		this.wheel = attachWheel(scroller, this.scroll);
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout());
		this.sizer?.observe(scroller);
		this.root = el('div', 'can-view elf-view', [toolbar, this.summary, this.segmentsPane, this.sectionsPane, this.symbolsPane]);
		this.symbolsPane.hidden = true;
		void this.load();
	}

	private async load(): Promise<void> {
		let doc: ElfOpenResult;
		try {
			doc = await elfOpen(this.path);
		} catch (error) {
			this.fail(tf('elf.openFailed', basename(this.path), String(error)));
			return;
		}
		if (this.disposed) {
			void elfClose(doc.docId);
			return;
		}
		this.doc = doc;
		this.liveText.parentElement?.classList.remove('can-live-parsing');
		this.setLive(tf('elf.live.done', doc.sections.length.toLocaleString(), doc.symbolsTotal.toLocaleString()));
		this.renderSummary();
		this.renderSegments();
		this.renderSections();
		if (this.mode === 'symbols') this.refetchWindow(0);
	}

	private setLive(text: string): void {
		this.liveText.textContent = text;
	}

	private fail(text: string): void {
		this.failed = true;
		this.liveText.parentElement?.classList.remove('can-live-parsing');
		this.setLive(t('elf.live.failed'));
		this.summary.replaceChildren(el('div', 'can-error dbc-banner', [text]));
	}

	/** The summary card: the header's facts and the footprint sums. */
	private renderSummary(): void {
		const doc = this.doc;
		if (!doc) return;
		const row = (label: string, value: string) =>
			el('div', 'elf-sum-row', [el('span', 'elf-sum-label', [label]), el('span', 'elf-sum-value', [value])]);
		const left = el('div', 'elf-sum-col', [
			row(t('elf.sum.class'), `${doc.classBits}-bit ${doc.littleEndian ? 'LE' : 'BE'}`),
			row(t('elf.sum.type'), doc.fileType),
			row(t('elf.sum.machine'), doc.machineName),
			row(t('elf.sum.entry'), hexAddr(doc.entry))
		]);
		const right = el('div', 'elf-sum-col', [
			row(t('elf.sum.rom'), hexSize(doc.romBytes)),
			row(t('elf.sum.ram'), hexSize(doc.ramBytes)),
			row(t('elf.sum.symbols'), doc.symbolsTotal.toLocaleString()),
			row(t('elf.sum.file'), hexSize(doc.totalBytes))
		]);
		const parts: HTMLElement[] = [left, right];
		if (doc.needed.length > 0) {
			parts.push(el('div', 'elf-sum-needed', [el('span', 'elf-sum-label', [t('elf.sum.needed')]), el('span', 'elf-sum-value', [doc.needed.join(', ')])]));
		}
		this.summary.replaceChildren(...parts);
	}

	private renderSegments(): void {
		const doc = this.doc;
		if (!doc || doc.segments.length === 0) {
			this.segmentsPane.hidden = true;
			return;
		}
		const head = el('div', 'elf-t-head elf-seg-head', [
			el('span', 'elf-hcell elf-c-kind', [t('elf.seg.kind')]),
			el('span', 'elf-hcell elf-c-flags', [t('elf.col.flags')]),
			el('span', 'elf-hcell elf-c-offset', [t('elf.seg.offset')]),
			el('span', 'elf-hcell elf-c-vaddr', [t('elf.seg.vaddr')]),
			el('span', 'elf-hcell elf-c-file', [t('elf.seg.file')]),
			el('span', 'elf-hcell elf-c-mem', [t('elf.seg.mem')])
		]);
		const rows = doc.segments.map((s) =>
			el('div', 'elf-t-row elf-seg-row', [
				el('span', 'elf-cell elf-c-kind', [s.kind]),
				el('span', 'elf-cell elf-c-flags', [s.flags || '—']),
				el('span', 'elf-cell elf-c-offset', [hexAddr(s.offset)]),
				el('span', 'elf-cell elf-c-vaddr', [hexAddr(s.vaddr)]),
				el('span', 'elf-cell elf-c-file', [hexSize(s.fileBytes)]),
				el('span', 'elf-cell elf-c-mem', [hexSize(s.memBytes)])
			])
		);
		this.segmentsPane.replaceChildren(el('div', 'elf-pane-title', [t('elf.segments')]), head, ...rows);
	}

	private renderSections(): void {
		const doc = this.doc;
		if (!doc) return;
		const secBody = this.sectionsPane.querySelector('.elf-t-body') as HTMLElement;
		if (doc.sections.length === 0) {
			this.sectionsPane.replaceChildren(el('div', 'dbc-capped', [t('elf.sections.empty')]));
			return;
		}
		const rows = doc.sections.map((s) => {
			const flags = (s.alloc ? 'A' : '') + (s.write ? 'W' : '') + (s.exec ? 'X' : '');
			return el('div', 'elf-t-row elf-sec-row', [
				el('span', 'elf-cell elf-a-name', [s.name || '—']),
				el('span', 'elf-cell elf-a-kind', [s.kind]),
				el('span', 'elf-cell elf-a-addr', [hexAddr(s.addr)]),
				el('span', 'elf-cell elf-a-size', [hexSize(s.size)]),
				el('span', 'elf-cell elf-a-flags', [flags || '—'])
			]);
		});
		secBody.replaceChildren(...rows);
	}

	/* ---------- modes ---------- */

	private setMode(mode: 'sections' | 'symbols'): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.syncChips();
		this.segmentsPane.hidden = mode !== 'sections';
		this.sectionsPane.hidden = mode !== 'sections';
		this.symbolsPane.hidden = mode !== 'symbols';
		if (mode === 'symbols') {
			this.refetchWindow(0);
			this.layout();
		}
	}

	private syncChips(): void {
		this.sectionsChip.classList.toggle('can-chip-on', this.mode === 'sections');
		this.sectionsChip.setAttribute('aria-pressed', String(this.mode === 'sections'));
		this.symbolsChip.classList.toggle('can-chip-on', this.mode === 'symbols');
		this.symbolsChip.setAttribute('aria-pressed', String(this.mode === 'symbols'));
	}

	/* ---------- the symbol table ---------- */

	private layout(): void {
		const scroller = this.symbolsPane.querySelector('.elf-sym-scroll') as HTMLElement | null;
		if (scroller) this.scroll.setViewport(scroller.clientHeight);
		this.refresh();
	}

	/** A new filter (or first show): clear the window, restart at the top. */
	private refetchWindow(top: number): void {
		this.fetchGen++;
		this.cache.forEach((node) => node.remove());
		this.cache.clear();
		this.fetching.clear();
		this.fetchInFlight = false;
		this.refetch = false;
		this.rowCount = 0;
		this.scroll.setRowCount(0);
		this.scroll.setTop(top);
		this.refresh();
	}

	private refresh(): void {
		const doc = this.doc;
		if (!doc || this.disposed || this.failed || this.mode !== 'symbols') return;
		for (const [index, node] of this.cache) node.style.top = `${this.scroll.rowTop(index)}px`;
		let { first, last } = this.scroll.visibleRange(OVERSCAN);
		if (last < first && this.rowCount === 0) {
			// The model holds no rows yet — the first answer names the total. Ask for the
			// viewport's worth anyway (a zero-height layout still gets one window).
			first = 0;
			last = Math.max(OVERSCAN, Math.ceil(this.scroll.visibleLines) + OVERSCAN) - 1;
		}
		this.windowFirst = first;
		this.windowLast = last;
		const wanted: number[] = [];
		for (let index = first; index <= last; index++) {
			if (!this.cache.has(index) && !this.fetching.has(index)) wanted.push(index);
		}
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
		const gen = this.fetchGen;
		elfSymbols(docId, start, end, this.filter === '' ? null : this.filter)
			.then((answer) => {
				if (gen !== this.fetchGen) return;
				this.fetchInFlight = false;
				if (!this.disposed && this.doc?.docId === docId) {
					if (answer.total !== this.rowCount) {
						this.rowCount = answer.total;
						this.scroll.setRowCount(answer.total);
					}
					for (let index = start; index < end; index++) this.fetching.delete(index);
					answer.lines.forEach((line, offset) => {
						const index = start + offset;
						if (index < this.windowFirst || index > this.windowLast) return;
						if (this.cache.has(index)) return;
						const row = this.renderSymbolRow(index, line);
						this.cache.set(index, row);
						this.place(row, index);
					});
					const empty = this.symbolsPane.querySelector('.elf-sym-empty') as HTMLElement | null;
					if (empty) empty.hidden = answer.total > 0;
				}
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
		const key = (n: HTMLElement) => Number(n.dataset.row);
		let after: HTMLElement | null = null;
		for (const n of Array.from(this.symRows.children) as HTMLElement[]) {
			if (key(n) > index) {
				after = n;
				break;
			}
		}
		this.symRows.insertBefore(row, after);
	}

	private renderSymbolRow(index: number, line: ElfSymbolLine): HTMLElement {
		const row = el('div', 'elf-t-row elf-sym-row', [
			el('span', 'elf-cell elf-b-name', [line.name || '—']),
			el('span', 'elf-cell elf-b-addr', [hexAddr(line.value)]),
			el('span', 'elf-cell elf-b-size', [hexSize(line.size)]),
			el('span', 'elf-cell elf-b-kind', [line.kind]),
			el('span', 'elf-cell elf-b-bind', [line.bind])
		]);
		row.dataset.row = String(index);
		return row;
	}

	dispose(): void {
		this.disposed = true;
		this.wheel.dispose();
		this.scrollbar.dispose();
		this.sizer?.disconnect();
		if (this.doc) void elfClose(this.doc.docId);
		this.root.remove();
	}
}
