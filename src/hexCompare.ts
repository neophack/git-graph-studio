// The hex comparison two binary files open in, built on the hex viewer's layout: two
// address-aligned panes (offset | hex | ASCII each) sharing one virtual scroll, every byte
// compared with the byte at the same offset on the other side - no diff algorithm, no
// alignment, exactly the way Beyond Compare compares binaries. Differing bytes are tinted
// on both sides; a background scan streams both files once in fixed-size chunks (never
// holding more than two chunks) to collect the difference regions the prev/next arrows
// navigate, so a multi-gigabyte pair compares in bounded memory.
//
// Selection is one shared span over the address space, not per-pane: a drag (or Shift+click)
// in either pane picks bytes by absolute offset, and both sides paint the same [start, end]
// highlighted - the same address is selected on the other side automatically, since that is
// what comparing two files at the same offset means. The right-click menu copies in the hex
// viewer's own formats (hex, text, C array, Base64) from whichever pane the click landed
// on - the two sides can differ, so Copy always names its source file.

import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { t, tf } from './i18n';
import { attachPageKeys, attachWheel, type Disposable } from './scroll/input';
import { ScrollModel } from './scroll/model';
import { Scrollbar } from './scroll/scrollbar';
import { el, icon, notify, showContextMenu, type MenuEntry } from './ui';
import {
	COPY_FORMAT_KEYS, COPY_LIMIT, OFFSET_DIGITS, ROW_LADDER, asciiChar, bytesPerRowFor, bytesToLatin1, decodeBase64, formatBytes,
	groupSizeFor, hexAddress, hexByte, hexHeader, offsetDigitsFor, rowGridTemplate, type CopyFormat
} from './hexView';

/** Visible rows are filled from 64 KiB slabs, so scrolling reads a slab at a time. */
const SLAB_BYTES = 64 * 1024;
/** The difference scan streams both sides in 1 MiB chunks; its reads bypass the slab cache. */
const SCAN_CHUNK = 1024 * 1024;
/** Decoded slabs kept per side (3 MiB); the least recently loaded is dropped beyond it. */
const SLAB_CACHE_LIMIT = 48;
/** Equal bytes that still merge two difference regions into one navigable "difference". */
const DIFF_COALESCE = 16;

interface FileChunk {
	size: number;
	base64: string;
}

/** One difference region of the shared address space: bytes [start, end) that differ (a
 *  run of differing bytes possibly bridged by short equal stretches; the tail beyond the
 *  smaller file's end is one region when the sizes differ). */
export interface DiffRegion {
	start: number;
	end: number;
}

/** One side's slab cache: in-flight and decoded slabs by index, insertion-ordered so the
 *  oldest evicts first. */
interface Slabs {
	pending: Map<number, Promise<Uint8Array | null>>;
	values: Map<number, Uint8Array>;
}

/** One pane's row: offset, hex cells, gutter, ASCII - the hex viewer's grid with a
 *  differing byte's cells tinted instead of a search hit. `selection` is the shared span
 *  (absolute offsets, [start, end)) both panes paint identically - the same address range
 *  reads as selected on either side. */
function compareRow(offset: number, bytes: Uint8Array, diff: Uint8Array, bytesPerRow: number, digits = OFFSET_DIGITS, selection?: readonly [number, number]): HTMLElement {
	const inSelection = (i: number): boolean => !!selection && offset + i >= selection[0] && offset + i < selection[1];
	const cells: (Node | string | null)[] = [el('span', 'hex-offset', [offset.toString(16).padStart(digits, '0').toUpperCase()])];
	const group = groupSizeFor(bytesPerRow);
	for (let i = 0; i < bytesPerRow; i++) {
		if (i % group === 0 && i > 0) cells.push(el('span', 'hex-group-gap'));
		const cls = ['hex-cell', i < bytes.length && diff[i] ? 'hex-diff' : '', i < bytes.length && inSelection(i) ? 'hex-selected' : ''].filter(Boolean).join(' ');
		// A blank is an invisible spacer and carries no text: a hidden '00' would surface
		// as phantom bytes at the file's end the moment anything makes it visible.
		const cell = el('span', i < bytes.length ? cls : 'hex-cell hex-blank', [i < bytes.length ? hexByte(bytes[i]!) : '']);
		// Only a pane's real bytes carry an address; the blanks past a file's end are filler.
		if (i < bytes.length) cell.title = hexAddress(offset + i, digits);
		cells.push(cell);
	}
	cells.push(el('span', 'hex-gutter'));
	for (let i = 0; i < bytes.length; i++) {
		const cls = ['hex-ascii-cell', diff[i] ? 'hex-diff' : '', inSelection(i) ? 'hex-selected' : ''].filter(Boolean).join(' ');
		const cell = el('span', cls, [asciiChar(bytes[i]!)]);
		cell.title = hexAddress(offset + i, digits);
		cells.push(cell);
	}
	const row = el('div', 'hex-row', cells);
	row.style.gridTemplateColumns = rowGridTemplate(bytesPerRow, digits);
	return row;
}

/** The byte a compare row's hex or ASCII cell stands for, with the side (left/right pane)
 *  and pane (hex/ASCII) it belongs to - null anywhere else in the scroller (the offset
 *  column, the gutter, the gaps). The row's own offset label states the base - as in the
 *  hex viewer's byteAtCell - so the lookup holds at every row width and over a placeholder
 *  mid-refill. */
function byteAtCompareCell(node: HTMLElement): { offset: number; side: 'left' | 'right'; pane: 'hex' | 'ascii' } | null {
	const cell = node.closest<HTMLElement>('.hex-cell, .hex-ascii-cell');
	const rowEl = cell?.closest<HTMLElement>('.hex-row');
	const cmpRow = rowEl?.parentElement;
	if (!cell || !rowEl || !cmpRow?.classList.contains('hex-cmp-row')) return null;
	const base = parseInt(rowEl.querySelector('.hex-offset')?.textContent ?? '', 16);
	if (!Number.isFinite(base)) return null;
	const pane: 'hex' | 'ascii' = cell.classList.contains('hex-ascii-cell') ? 'ascii' : 'hex';
	const cells = rowEl.querySelectorAll(pane === 'ascii' ? '.hex-ascii-cell' : '.hex-cell');
	const index = Array.prototype.indexOf.call(cells, cell);
	if (index < 0) return null;
	const side: 'left' | 'right' = cmpRow.children[0] === rowEl ? 'left' : 'right';
	return { offset: base + index, side, pane };
}

export interface HexCompareLabels {
	left: string;
	right: string;
}

export class HexCompareView {
	readonly root: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly sizer: HTMLElement;
	private readonly status: HTMLElement;
	private readonly counter: HTMLElement;
	private readonly gotoBox: HTMLInputElement;
	private readonly widthSelect: HTMLSelectElement;
	private readonly ruler: HTMLElement;
	private readonly leftSlabs: Slabs = { pending: new Map(), values: new Map() };
	private readonly rightSlabs: Slabs = { pending: new Map(), values: new Map() };
	private sizeLeft = 0;
	private sizeRight = 0;
	private rows = 0;
	private rowHeight = 0;
	private bytesPerRow = 16;
	/** The offset column's digits for the larger of the two files (see offsetDigitsFor),
	 *  so past-4-GiB addresses still fit the column both panes print them in. */
	private offsetDigits = OFFSET_DIGITS;
	private forcedBytesPerRow = 0;
	/** The viewport's position over the comparison's rows (scroll/model.ts) — one model,
	 *  both panes: row `n` is offset n×bytesPerRow of either file. */
	readonly scroll: ScrollModel;
	private readonly scrollbar: Scrollbar;
	/** The scan's difference regions, in address order; empty until (and unless) it finds any. */
	private regions: DiffRegion[] = [];
	private regionIndex = -1;
	private differingBytes = 0;
	private scanToken = 0;
	private scanned = 0;
	private scanDone = false;
	private destroyed = false;
	/** Watches the scroller for relayouts; disconnected by destroy(). */
	private readonly observer: ResizeObserver;
	/** The wheel and the page keys over the scroller (scroll/input.ts), disposed with the view. */
	private readonly wheel: Disposable;
	private readonly pageKeys: Disposable;
	/* ---------- Selection ---------- */
	/** The selection's two ends (absolute offsets, either order) - one shared span the
	 *  hex viewer applies to both panes alike (see compareRow); -1 means "not placed yet". */
	private selAnchor = -1;
	private selHead = -1;
	/** The side and pane the selection was made in - a plain Copy reads that side's bytes
	 *  and, for 'smart', follows the pane the way the hex viewer's own Copy does (hex from
	 *  the hex pane, text from the ASCII pane). A right-click menu overrides both with
	 *  wherever it landed, so Copy always names the file it is about to read from. */
	private selSide: 'left' | 'right' = 'left';
	private selPane: 'hex' | 'ascii' = 'hex';
	/** A mouse drag is pulling the selection's head. */
	private dragging = false;
	/** Ends a drag wherever the mouse button comes up; removed by destroy(). */
	private readonly onWindowMouseUp: () => void = () => { this.dragging = false; };

	constructor(private leftPath: string, private rightPath: string, private labels: HexCompareLabels = { left: leftPath, right: rightPath }) {
		const prev = el('button', 'button secondary', [icon('arrow-up')]);
		prev.title = 'Previous Difference (Shift+F7)';
		prev.addEventListener('click', () => this.gotoRegion(this.regionIndex - 1));
		const next = el('button', 'button secondary', [icon('arrow-down')]);
		next.title = 'Next Difference (F7)';
		next.addEventListener('click', () => this.gotoRegion(this.regionIndex + 1));
		this.counter = el('span', 'hex-search-count', ['Scanning…']);
		this.gotoBox = el('input', 'hex-goto') as HTMLInputElement;
		this.gotoBox.type = 'text';
		this.gotoBox.placeholder = 'Go to address (e.g. 0x1A0)';
		this.gotoBox.spellcheck = false;
		this.gotoBox.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key !== 'Enter') return;
			event.preventDefault();
			this.gotoAddress(this.gotoBox.value);
		});
		this.widthSelect = el('select', 'hex-width') as HTMLSelectElement;
		this.widthSelect.title = 'Bytes per row';
		this.widthSelect.setAttribute('aria-label', 'Bytes per row');
		const auto = el('option', undefined, ['Auto']) as HTMLOptionElement;
		auto.value = '0';
		this.widthSelect.append(auto);
		for (const bpr of ROW_LADDER) {
			const option = el('option', undefined, [String(bpr)]) as HTMLOptionElement;
			option.value = String(bpr);
			this.widthSelect.append(option);
		}
		this.widthSelect.addEventListener('change', () => {
			this.forcedBytesPerRow = Number(this.widthSelect.value) || 0;
			this.sizer.querySelector('.hex-body')?.remove();
			this.relayout();
		});
		const toolbar = el('div', 'hex-toolbar', [prev, next, this.counter, el('span', 'hex-toolbar-sep'), this.gotoBox, this.widthSelect]);
		this.scroller = el('div', 'hex-scroller');
		this.sizer = el('div', 'hex-sizer');
		this.scroller.append(this.sizer);
		const viewport = el('div', 'hex-viewport', [this.scroller]);
		this.ruler = el('div', 'hex-header-wrap');
		this.status = el('div', 'hex-status', ['Loading…']);
		this.root = el('div', 'hex-view hex-compare', [toolbar, this.ruler, viewport, this.status]);
		this.root.tabIndex = 0;
		this.scroll = new ScrollModel(20);
		this.scroll.onChange(() => this.draw());
		this.scrollbar = new Scrollbar(viewport, this.scroll);
		this.root.addEventListener('keydown', (event) => {
			if (event.key === 'F7') {
				event.preventDefault();
				this.gotoRegion(event.shiftKey ? this.regionIndex - 1 : this.regionIndex + 1);
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
				const span = Math.max(this.sizeLeft, this.sizeRight);
				if (!span) return;
				event.preventDefault();
				this.selAnchor = 0;
				this.selHead = span - 1;
				this.repaintSelection();
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
				if (!this.hasSelection()) return;
				event.preventDefault();
				void this.copySelection('smart', this.selSide, this.selPane);
				return;
			}
			if (event.key === 'Escape' && this.hasSelection()) {
				event.preventDefault();
				this.clearSelection();
			}
		});
		this.scroller.addEventListener('scroll', () => {
			this.ruler.scrollLeft = this.scroller.scrollLeft;
		});
		this.scroller.addEventListener('mousedown', (event) => {
			if (event.button !== 0) return;
			const target = byteAtCompareCell(event.target as HTMLElement);
			if (!target) return;
			// The cells carry the selection model; the browser's own text selection has no
			// business over them.
			event.preventDefault();
			this.dragging = true;
			if (event.shiftKey && this.selAnchor >= 0) {
				this.setSelectionHead(target.offset, target.side, target.pane);
				return;
			}
			const clamped = this.clampOffset(target.offset);
			this.selAnchor = clamped;
			this.selHead = clamped;
			this.selSide = target.side;
			this.selPane = target.pane;
			this.repaintSelection();
			this.root.focus();
		});
		this.scroller.addEventListener('mousemove', (event) => {
			if (!this.dragging) return;
			const target = byteAtCompareCell(event.target as HTMLElement);
			if (target) this.setSelectionHead(target.offset, target.side, target.pane);
		});
		// The drag ends wherever the button comes up - over the view or past its edge.
		window.addEventListener('mouseup', this.onWindowMouseUp);
		this.scroller.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.dragging = false;
			this.showContextMenu(event, byteAtCompareCell(event.target as HTMLElement));
		});
		this.wheel = attachWheel(this.scroller, this.scroll);
		this.pageKeys = attachPageKeys(this.scroller, this.scroll);
		let pending = 0;
		this.observer = new ResizeObserver(() => {
			if (pending) return;
			pending = requestAnimationFrame(() => {
				pending = 0;
				this.relayout();
			});
		});
		this.observer.observe(this.scroller);
	}

	/** Loads each side's first slab (learning the sizes) and sizes the virtual list. The
	 *  difference scan is a separate step (`scan`) so a host can have its view on screen
	 *  before the pair starts streaming. */
	async load(): Promise<void> {
		const [left, right] = await Promise.all([this.slab(this.leftSlabs, this.leftPath, 0), this.slab(this.rightSlabs, this.rightPath, 0)]);
		if (this.destroyed || !left || !right) return;
		this.offsetDigits = offsetDigitsFor(Math.max(this.sizeLeft, this.sizeRight));
		const probe = el('div', 'hex-cmp-row', [compareRow(0, new Uint8Array(0), new Uint8Array(0), 16, this.offsetDigits), compareRow(0, new Uint8Array(0), new Uint8Array(0), 16, this.offsetDigits)]);
		this.sizer.append(probe);
		this.rowHeight = probe.getBoundingClientRect().height || 20;
		probe.remove();
		this.relayout();
	}

	/** Stops the scan and drops the caches; the pane itself goes with its host. */
	destroy(): void {
		this.destroyed = true;
		this.scanToken++;
		this.observer.disconnect();
		this.scrollbar.dispose();
		this.wheel.dispose();
		this.pageKeys.dispose();
		window.removeEventListener('mouseup', this.onWindowMouseUp);
		this.leftSlabs.pending.clear();
		this.leftSlabs.values.clear();
		this.rightSlabs.pending.clear();
		this.rightSlabs.values.clear();
		this.root.remove();
	}

	/* ---------- Layout & drawing ---------- */

	/** The row width of one pane: half the scroller (both panes share the row), or the
	 *  width the user pinned. The probe zeroes the row's own padding — 28 zeros in the
	 *  row font, nothing else. */
	private pickBytesPerRow(): number {
		if (this.forcedBytesPerRow) return this.forcedBytesPerRow;
		const probe = el('span', 'hex-row');
		probe.style.visibility = 'hidden';
		probe.style.position = 'absolute';
		probe.style.padding = '0';
		probe.textContent = '0'.repeat(28);
		this.scroller.append(probe);
		const charWidth = probe.getBoundingClientRect().width / 28;
		probe.remove();
		if (!charWidth || !this.scroller.clientWidth) return 16;
		return bytesPerRowFor(charWidth, this.scroller.clientWidth / 2 - 24, this.offsetDigits);
	}

	private relayout(): void {
		const firstByte = Math.floor(this.scroll.top) * this.bytesPerRow;
		const bpr = this.pickBytesPerRow();
		if (bpr !== this.bytesPerRow) this.sizer.querySelector('.hex-body')?.remove();
		this.bytesPerRow = bpr;
		// The ruler is the hex viewer's, twice - one per pane - with the pane labels above.
		this.ruler.replaceChildren(el('div', 'hex-cmp-head', [
			el('div', 'hex-cmp-label', [this.labels.left]),
			el('div', 'hex-cmp-label', [this.labels.right])
		]), el('div', 'hex-cmp-ruler', [hexHeader(bpr, this.offsetDigits), hexHeader(bpr, this.offsetDigits)]));
		this.ruler.style.width = this.scroller.clientWidth ? `${this.scroller.clientWidth}px` : '';
		this.ruler.scrollLeft = this.scroller.scrollLeft;
		// An empty side still renders (as blank panes against the other's bytes); only two
		// empty files make for nothing to draw.
		if (!this.rowHeight || (!this.sizeLeft && !this.sizeRight)) return;
		this.rows = Math.ceil(Math.max(this.sizeLeft, this.sizeRight) / bpr);
		this.scroll.setRowHeight(this.rowHeight);
		this.scroll.setRowCount(this.rows);
		this.scroll.setViewport(this.scroller.clientHeight);
		this.scroll.setTop(Math.floor(firstByte / bpr), 'layout');
		this.draw();
		this.updateStatus();
	}

	private updateStatus(): void {
		const parts = [`${this.sizeLeft.toLocaleString()} ↔ ${this.sizeRight.toLocaleString()} bytes  ·  ${this.rows.toLocaleString()} rows  ·  ${this.bytesPerRow} bytes/row`];
		if (!this.scanDone) {
			const percent = Math.min(100, Math.floor((this.scanned / Math.max(1, Math.min(this.sizeLeft, this.sizeRight))) * 100));
			parts.push(`scanning ${percent}%`);
		} else if (this.regions.length === 0) {
			parts.push('identical');
		} else {
			parts.push(`${this.differingBytes.toLocaleString()} differing bytes in ${this.regions.length.toLocaleString()} region${this.regions.length === 1 ? '' : 's'}`);
		}
		// The selection is one shared address span - its report doesn't say which side, since
		// it means the same range on both.
		if (this.hasSelection()) {
			const from = this.selectionStart();
			const to = this.selectionEnd();
			parts.push(tf('hex.status.selected', hexAddress(from, this.offsetDigits), hexAddress(to, this.offsetDigits), (to - from + 1).toLocaleString()));
		}
		this.status.textContent = parts.join('  ·  ');
	}

	/** Repaints the visible rows (plus overscan): a placeholder row goes in synchronously,
	 *  each pane fills from its slab when the read lands. Row `n` always shows offset
	 *  n*bytesPerRow of both files - the panes never shift against each other. */
	private draw(): void {
		if (!this.rowHeight || !this.rows) return;
		const { first, last } = this.scroll.visibleRange(8);
		let body = this.sizer.querySelector<HTMLElement>('.hex-body');
		if (!body) {
			body = el('div', 'hex-body');
			body.style.position = 'absolute';
			body.style.left = '0';
			body.style.right = '0';
			body.style.top = '0';
			this.sizer.append(body);
		}
		// The body sits where the model puts its first row: viewport-relative, one transform
		// per scroll, whatever the files' size.
		body.style.transform = `translateY(${this.scroll.rowTop(first)}px)`;
		for (const node of Array.from(body.children)) {
			const row = Number((node as HTMLElement).dataset.row);
			if (row < first || row > last) node.remove();
		}
		for (let row = first; row <= last; row++) {
			if (body.querySelector(`[data-row="${row}"]`)) continue;
			const placeholder = el('div', 'hex-cmp-row', [
				compareRow(row * this.bytesPerRow, new Uint8Array(0), new Uint8Array(0), this.bytesPerRow, this.offsetDigits, this.selectionRange()),
				compareRow(row * this.bytesPerRow, new Uint8Array(0), new Uint8Array(0), this.bytesPerRow, this.offsetDigits, this.selectionRange())
			]);
			placeholder.dataset.row = String(row);
			if (row % 2) placeholder.classList.add('hex-row-odd');
			const after = Array.from(body.children).find((child) => Number((child as HTMLElement).dataset.row) > row);
			body.insertBefore(placeholder, after ?? null);
			const offset = row * this.bytesPerRow;
			void Promise.all([
				this.rowBytes(this.leftSlabs, this.leftPath, offset),
				this.rowBytes(this.rightSlabs, this.rightPath, offset)
			]).then(([left, right]) => {
				if (this.destroyed || !body.contains(placeholder) || this.sizer.querySelector('.hex-body') !== body) return;
				const leftBytes = left ?? new Uint8Array(0);
				const rightBytes = right ?? new Uint8Array(0);
				const filled = el('div', 'hex-cmp-row', [
					compareRow(offset, leftBytes, this.diffMask(offset, leftBytes.length), this.bytesPerRow, this.offsetDigits, this.selectionRange()),
					compareRow(offset, rightBytes, this.diffMask(offset, rightBytes.length), this.bytesPerRow, this.offsetDigits, this.selectionRange())
				]);
				filled.dataset.row = String(row);
				if (row % 2) filled.classList.add('hex-row-odd');
				placeholder.replaceWith(filled);
			});
		}
		// Same self-correction as the hex viewer's: the load-time probe can measure before
		// the theme's editor font applies; the first drawn row is the truth.
		const laidRow = body.firstElementChild as HTMLElement | null;
		const laid = laidRow ? laidRow.getBoundingClientRect().height : 0;
		if (laid > 1 && Math.abs(laid - this.rowHeight) > 0.25) {
			this.rowHeight = laid;
			this.relayout();
		}
	}

	/** Which of a pane's bytes at [offset, offset+length) differ: the regions overlapping
	 *  the span, found by binary search - the visible rows ask a handful of times each. */
	private diffMask(offset: number, length: number): Uint8Array {
		const mask = new Uint8Array(length);
		if (!this.regions.length) return mask;
		let low = 0;
		let high = this.regions.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (this.regions[mid]!.end <= offset) low = mid + 1;
			else high = mid;
		}
		for (let i = low; i < this.regions.length && this.regions[i]!.start < offset + length; i++) {
			const from = Math.max(this.regions[i]!.start, offset);
			const to = Math.min(this.regions[i]!.end, offset + length);
			mask.fill(1, from - offset, to - offset);
		}
		return mask;
	}

	private slab(store: Slabs, path: string, index: number): Promise<Uint8Array | null> {
		const cached = store.pending.get(index);
		if (cached) return cached;
		const offset = index * SLAB_BYTES;
		const size = store === this.leftSlabs ? this.sizeLeft : this.sizeRight;
		if (size && offset >= size) return Promise.resolve(null);
		const promise = invoke<FileChunk>('read_file_chunk', { path, offset, len: SLAB_BYTES })
			.then((chunk) => {
				if (store === this.leftSlabs) this.sizeLeft = chunk.size;
				else this.sizeRight = chunk.size;
				const bytes = decodeBase64(chunk.base64);
				store.pending.set(index, promise);
				store.values.set(index, bytes);
				// Insertion-ordered maps: the oldest slab beyond the limit is dropped.
				while (store.values.size > SLAB_CACHE_LIMIT) {
					const oldest = store.values.keys().next().value as number;
					store.values.delete(oldest);
					store.pending.delete(oldest);
				}
				return bytes;
			})
			.catch(() => null);
		store.pending.set(index, promise);
		return promise;
	}

	/** One side's bytes for a row: the slab's slice, or - when the row straddles the
	 *  64 KiB boundary (a row width like 24 doesn't divide it) - the next slab's head
	 *  joined on, so no byte of the row is lost. */
	private async rowBytes(store: Slabs, path: string, offset: number): Promise<Uint8Array | null> {
		const slabIndex = Math.floor(offset / SLAB_BYTES);
		const first = await this.slab(store, path, slabIndex);
		if (!first) return null;
		const head = first.subarray(offset - slabIndex * SLAB_BYTES, offset - slabIndex * SLAB_BYTES + this.bytesPerRow);
		if (head.length >= this.bytesPerRow) return head;
		const tail = await this.slab(store, path, slabIndex + 1);
		if (!tail) return head;
		const joined = new Uint8Array(Math.min(this.bytesPerRow, head.length + tail.length));
		joined.set(head);
		joined.set(tail.subarray(0, joined.length - head.length), head.length);
		return joined;
	}

	/* ---------- The difference scan ---------- */

	/** Streams both files once, address-aligned, collecting the difference regions. The
	 *  scan's own reads skip the slab cache entirely - only two chunks exist at a time, so
	 *  the pair's size never shows up in memory. */
	scan(): void {
		void this.runScan();
	}

	private async runScan(): Promise<void> {
		const token = ++this.scanToken;
		const common = Math.min(this.sizeLeft, this.sizeRight);
		const regions: DiffRegion[] = [];
		let differing = 0;
		let runStart = -1;
		let runEnd = 0;
		let offset = 0;
		const close = (end: number): void => {
			if (runStart >= 0) {
				regions.push({ start: runStart, end });
				runStart = -1;
			}
		};
		while (offset < common) {
			if (token !== this.scanToken) return;
			const [a, b] = await Promise.all([
				invoke<FileChunk>('read_file_chunk', { path: this.leftPath, offset, len: SCAN_CHUNK }).catch(() => null),
				invoke<FileChunk>('read_file_chunk', { path: this.rightPath, offset, len: SCAN_CHUNK }).catch(() => null)
			]);
			if (token !== this.scanToken) return;
			if (!a || !b) {
				this.status.textContent = 'The scan failed: one side could not be read.';
				return;
			}
			const left = decodeBase64(a.base64);
			const right = decodeBase64(b.base64);
			const length = Math.min(left.length, right.length);
			// A side truncated since load() reads as an empty chunk before `common` is
			// reached; advance is impossible, so stop the scan there instead of spinning.
			if (length === 0) break;
			for (let i = 0; i < length; i++) {
				const at = offset + i;
				if (left[i] !== right[i]) {
					differing++;
					if (runStart < 0) runStart = at;
					runEnd = at + 1;
				} else if (runStart >= 0 && at - runEnd >= DIFF_COALESCE) {
					close(runEnd);
				}
			}
			offset += length;
			this.scanned = offset;
			this.regions = regions;
			this.differingBytes = differing;
			this.updateStatus();
			this.updateCounter();
		}
		close(runEnd);
		// Bytes beyond the smaller file's end exist on one side only - one last region,
		// counted as differing to the last byte of the larger file.
		if (this.sizeLeft !== this.sizeRight) {
			regions.push({ start: common, end: Math.max(this.sizeLeft, this.sizeRight) });
			differing += Math.abs(this.sizeLeft - this.sizeRight);
		}
		this.regions = regions;
		this.differingBytes = differing;
		this.scanDone = true;
		this.updateStatus();
		this.updateCounter();
		// Beyond Compare lands on the first difference; so does the scan's first result.
		if (regions.length) this.gotoRegion(0);
		else this.counter.textContent = 'No differences';
	}

	private updateCounter(): void {
		if (!this.scanDone) {
			this.counter.textContent = `Scanning… ${this.regions.length} difference${this.regions.length === 1 ? '' : 's'} so far`;
			return;
		}
		this.counter.textContent = this.regions.length
			? `${Math.max(0, this.regionIndex) + 1} / ${this.regions.length} differences`
			: 'No differences';
	}

	/** Scrolls difference region `index` (wrapping) into view. */
	private gotoRegion(index: number): void {
		if (!this.regions.length) return;
		this.regionIndex = ((index % this.regions.length) + this.regions.length) % this.regions.length;
		const region = this.regions[this.regionIndex]!;
		this.scroll.autoscroll(Math.floor(region.start / this.bytesPerRow), 'focused');
		this.updateCounter();
		// The freshly scrolled-in rows must pick up their difference tints.
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		this.root.focus();
	}

	/** Parses an address (`0x1A0`, `1A0h`, `416`) and scrolls to its row. */
	private gotoAddress(text: string): void {
		const trimmed = text.trim();
		const hex = /^0x([0-9a-f]+)$/i.exec(trimmed) || /^([0-9a-f]+)h$/i.exec(trimmed);
		const value = hex ? parseInt(hex[1]!, 16) : /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
		if (Number.isNaN(value)) {
			this.status.textContent = `Not an address: ${trimmed}`;
			return;
		}
		const target = Math.max(0, Math.min(value, Math.max(0, Math.max(this.sizeLeft, this.sizeRight) - 1)));
		this.scroll.autoscroll(Math.floor(target / this.bytesPerRow), 'top');
		this.draw();
		this.gotoBox.value = '0x' + target.toString(16).toUpperCase();
	}

	/* ---------- Selection & copy ---------- */

	/** True when the anchor and head span at least one byte. */
	private hasSelection(): boolean {
		return this.selAnchor >= 0 && this.selHead >= 0 && this.selAnchor !== this.selHead;
	}

	private selectionStart(): number {
		return Math.min(this.selAnchor, this.selHead);
	}

	/** The selection's last byte, inclusive - the address the status bar reports. */
	private selectionEnd(): number {
		return Math.max(this.selAnchor, this.selHead);
	}

	/** The selection as compareRow takes it: [start, end + 1), or undefined when nothing is. */
	private selectionRange(): [number, number] | undefined {
		return this.hasSelection() ? [this.selectionStart(), this.selectionEnd() + 1] : undefined;
	}

	private clampOffset(offset: number): number {
		return Math.max(0, Math.min(offset, Math.max(0, Math.max(this.sizeLeft, this.sizeRight) - 1)));
	}

	/** Moves the selection's head (a drag, Shift+click) - the shared span both panes paint
	 *  the same way, so extending it from either side extends it on both. Placing the
	 *  anchor first when nothing was selected yet lets a shift-click on either pane start
	 *  a span from scratch. */
	private setSelectionHead(offset: number, side?: 'left' | 'right', pane?: 'hex' | 'ascii'): void {
		if (side) this.selSide = side;
		if (pane) this.selPane = pane;
		const clamped = this.clampOffset(offset);
		if (clamped === this.selHead && this.selAnchor >= 0) return;
		if (this.selAnchor < 0) this.selAnchor = clamped;
		this.selHead = clamped;
		this.repaintSelection();
	}

	private clearSelection(): void {
		if (this.selAnchor < 0 && this.selHead < 0) return;
		this.selAnchor = -1;
		this.selHead = -1;
		this.repaintSelection();
	}

	/** Selection (or its absence) changed: the rows repaint with it (both panes, the same
	 *  span) and the status bar reports it. */
	private repaintSelection(): void {
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		this.updateStatus();
	}

	/** The right-click menu over a byte: Copy in every format the hex viewer offers, read
	 *  from whichever side the click landed on (or, off a byte, the side the selection was
	 *  made in) - the two sides can hold different bytes at the same address, so every Copy
	 *  entry names its source file. */
	private showContextMenu(event: MouseEvent, target: { offset: number; side: 'left' | 'right'; pane: 'hex' | 'ascii' } | null): void {
		const selected = this.hasSelection();
		const side = target?.side ?? this.selSide;
		const pane = target?.pane ?? this.selPane;
		const sideLabel = side === 'left' ? this.labels.left : this.labels.right;
		const entries: MenuEntry[] = [
			{ label: `${t('hex.menu.copy')} — ${sideLabel}`, keybinding: 'Ctrl+C', disabled: !selected, run: () => void this.copySelection('smart', side, pane) },
			{ label: `${t('hex.menu.copyHex')} — ${sideLabel}`, disabled: !selected, run: () => void this.copySelection('hex', side, pane) },
			{ label: `${t('hex.menu.copyText')} — ${sideLabel}`, disabled: !selected, run: () => void this.copySelection('text', side, pane) },
			{ label: `${t('hex.menu.copyC')} — ${sideLabel}`, disabled: !selected, run: () => void this.copySelection('c', side, pane) },
			{ label: `${t('hex.menu.copyBase64')} — ${sideLabel}`, disabled: !selected, run: () => void this.copySelection('base64', side, pane) },
			// The address of the right-clicked byte, or - with a selection - its start-end
			// span; shared by both sides, so it names no file.
			{ label: t('hex.menu.copyAddress'), disabled: !selected && !target, run: () => void this.copyAddress(target) },
			'separator',
			{ label: t('hex.menu.clearSelection'), disabled: !selected, run: () => this.clearSelection() },
			'separator',
			{ label: t('hex.menu.goto'), keybinding: 'Ctrl+G', run: () => { this.gotoBox.focus(); this.gotoBox.select(); } }
		];
		showContextMenu(event.clientX, event.clientY, entries);
	}

	/** Copies the selection in one of the hex viewer's Copy Special formats, reading from
	 *  `side`'s file - 'smart' honours `pane`: hex bytes from the hex pane, raw text from
	 *  the ASCII pane. Selections past the 10 MiB limit are refused with a reminder instead
	 *  of being read. */
	async copySelection(format: CopyFormat, side: 'left' | 'right' = this.selSide, pane: 'hex' | 'ascii' = this.selPane): Promise<void> {
		if (!this.hasSelection()) return;
		const start = this.selectionStart();
		const count = this.selectionEnd() - start + 1;
		if (count > COPY_LIMIT) {
			notify('error', tf('hex.copy.tooLarge', formatBytes(count), formatBytes(COPY_LIMIT)));
			return;
		}
		const bytes = await this.readRange(side === 'left' ? this.leftPath : this.rightPath, start, count);
		if (!bytes) {
			notify('error', t('hex.copy.readFailed'));
			return;
		}
		let text: string;
		if (format === 'base64') text = btoa(bytesToLatin1(bytes));
		else if (format === 'c') text = Array.from(bytes, (b) => '0x' + hexByte(b)).join(', ');
		else if (format === 'text' || (format === 'smart' && pane === 'ascii')) text = bytesToLatin1(bytes);
		else text = Array.from(bytes, hexByte).join('');
		try {
			await writeText(text);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const sideLabel = side === 'left' ? this.labels.left : this.labels.right;
		this.status.textContent = `${this.status.textContent}  ·  ${tf('hex.copy.done', text.length.toLocaleString(), t(COPY_FORMAT_KEYS[format]))} (${sideLabel})`;
	}

	/** Copies the address the right-click states: a selection's span as its start-end
	 *  addresses, or - when the click was on a lone byte with nothing selected - that
	 *  byte's address alone. The address is shared by both sides, so this ignores which
	 *  pane was clicked. */
	private async copyAddress(target: { offset: number } | null): Promise<void> {
		const text = this.hasSelection()
			? `${hexAddress(this.selectionStart(), this.offsetDigits)}-${hexAddress(this.selectionEnd(), this.offsetDigits)}`
			: target ? hexAddress(this.clampOffset(target.offset), this.offsetDigits) : null;
		if (text === null) return;
		try {
			await writeText(text);
		} catch (error) {
			notify('error', String(error));
		}
	}

	/** One side's bytes for Copy: a plain range read, bypassing the row slab cache - a
	 *  selection's span is a one-off read, not the repeated small reads scrolling makes. */
	private async readRange(path: string, start: number, count: number): Promise<Uint8Array | null> {
		try {
			return decodeBase64((await invoke<FileChunk>('read_file_chunk', { path, offset: start, len: count })).base64);
		} catch {
			return null;
		}
	}
}
