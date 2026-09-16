// The hex comparison two binary files open in, built on the hex viewer's layout: two
// address-aligned panes (offset | hex | ASCII each) sharing one virtual scroll, every byte
// compared with the byte at the same offset on the other side - no diff algorithm, no
// alignment, exactly the way Beyond Compare compares binaries. Differing bytes are tinted
// on both sides; a background scan streams both files once in fixed-size chunks (never
// holding more than two chunks) to collect the difference regions the prev/next arrows
// navigate, so a multi-gigabyte pair compares in bounded memory.

import { invoke } from '@tauri-apps/api/core';

import { OFFSET_DIGITS, ROW_LADDER, asciiChar, bytesPerRowFor, decodeBase64, groupSizeFor, hexAddress, hexByte, hexHeader, rowGridTemplate } from './hexView';
import { settings } from './settings';
import { attachSmoothWheel, el, icon, VirtualScroll, type SmoothWheelHandle } from './ui';

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
 *  differing byte's cells tinted instead of a search hit. */
function compareRow(offset: number, bytes: Uint8Array, diff: Uint8Array, bytesPerRow: number): HTMLElement {
	const cells: (Node | string | null)[] = [el('span', 'hex-offset', [offset.toString(16).padStart(OFFSET_DIGITS, '0').toUpperCase()])];
	const group = groupSizeFor(bytesPerRow);
	for (let i = 0; i < bytesPerRow; i++) {
		const cls = ['hex-cell', i % group === 0 && i > 0 ? 'hex-group-start' : '', i < bytes.length && diff[i] ? 'hex-diff' : ''].filter(Boolean).join(' ');
		const cell = el('span', i < bytes.length ? cls : 'hex-cell hex-blank', [i < bytes.length ? hexByte(bytes[i]!) : '00']);
		// Only a pane's real bytes carry an address; the blanks past a file's end are filler.
		if (i < bytes.length) cell.title = hexAddress(offset + i);
		cells.push(cell);
	}
	cells.push(el('span', 'hex-gutter'));
	for (let i = 0; i < bytes.length; i++) {
		const cell = el('span', diff[i] ? 'hex-ascii-cell hex-diff' : 'hex-ascii-cell', [asciiChar(bytes[i]!)]);
		cell.title = hexAddress(offset + i);
		cells.push(cell);
	}
	const row = el('div', 'hex-row', cells);
	row.style.gridTemplateColumns = rowGridTemplate(bytesPerRow);
	return row;
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
	private forcedBytesPerRow = 0;
	/** The scroll range for the comparison's rows — clamped and scaled past the layout
	 *  engines' height ceiling, so the tail of a multi-gigabyte pair stays reachable. */
	private range = new VirtualScroll(0, 1);
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
	/** The smooth wheel glide over the scroller (ui.ts), disposed with the view. */
	private readonly wheel: SmoothWheelHandle;

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
		this.ruler = el('div', 'hex-header-wrap');
		this.status = el('div', 'hex-status', ['Loading…']);
		this.root = el('div', 'hex-view hex-compare', [toolbar, this.ruler, this.scroller, this.status]);
		this.root.tabIndex = 0;
		this.root.addEventListener('keydown', (event) => {
			if (event.key === 'F7') {
				event.preventDefault();
				this.gotoRegion(event.shiftKey ? this.regionIndex - 1 : this.regionIndex + 1);
			}
		});
		this.scroller.addEventListener('scroll', () => {
			this.ruler.scrollLeft = this.scroller.scrollLeft;
			this.draw();
		});
		this.wheel = attachSmoothWheel(this.scroller, {
			enabled: () => settings.smoothScrolling,
			sensitivity: () => settings.mouseWheelScrollSensitivity,
			fastSensitivity: () => settings.fastScrollSensitivity,
			zoom: () => this.range.documentPxPerScrollPx(this.scroller.clientHeight)
		});
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
		const probe = el('div', 'hex-cmp-row', [compareRow(0, new Uint8Array(0), new Uint8Array(0), 16), compareRow(0, new Uint8Array(0), new Uint8Array(0), 16)]);
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
		this.wheel.dispose();
		this.leftSlabs.pending.clear();
		this.leftSlabs.values.clear();
		this.rightSlabs.pending.clear();
		this.rightSlabs.values.clear();
		this.root.remove();
	}

	/* ---------- Layout & drawing ---------- */

	/** The row width of one pane: half the scroller (both panes share the row), or the
	 *  width the user pinned. */
	private pickBytesPerRow(): number {
		if (this.forcedBytesPerRow) return this.forcedBytesPerRow;
		const probe = el('span', 'hex-row');
		probe.style.visibility = 'hidden';
		probe.style.position = 'absolute';
		probe.textContent = '0'.repeat(28);
		this.scroller.append(probe);
		const charWidth = probe.getBoundingClientRect().width / 28;
		probe.remove();
		if (!charWidth || !this.scroller.clientWidth) return 16;
		return bytesPerRowFor(charWidth, this.scroller.clientWidth / 2 - 24);
	}

	private relayout(): void {
		const clientHeight = this.scroller.clientHeight;
		const firstByte = this.rowHeight ? (this.range.documentTop(this.scroller.scrollTop, clientHeight) / this.rowHeight) * this.bytesPerRow : 0;
		const bpr = this.pickBytesPerRow();
		if (bpr !== this.bytesPerRow) this.sizer.querySelector('.hex-body')?.remove();
		this.bytesPerRow = bpr;
		// The ruler is the hex viewer's, twice - one per pane - with the pane labels above.
		this.ruler.replaceChildren(el('div', 'hex-cmp-head', [
			el('div', 'hex-cmp-label', [this.labels.left]),
			el('div', 'hex-cmp-label', [this.labels.right])
		]), el('div', 'hex-cmp-ruler', [hexHeader(bpr), hexHeader(bpr)]));
		this.ruler.style.width = this.scroller.clientWidth ? `${this.scroller.clientWidth}px` : '';
		this.ruler.scrollLeft = this.scroller.scrollLeft;
		// An empty side still renders (as blank panes against the other's bytes); only two
		// empty files make for nothing to draw.
		if (!this.rowHeight || (!this.sizeLeft && !this.sizeRight)) return;
		this.rows = Math.ceil(Math.max(this.sizeLeft, this.sizeRight) / bpr);
		this.range = new VirtualScroll(this.rows, this.rowHeight, Math.max(0, clientHeight - this.rowHeight));
		this.range.lay(this.sizer);
		this.scroller.scrollTop = this.range.scrollTopFor(Math.floor(firstByte / bpr) * this.rowHeight, clientHeight);
		this.draw();
		this.updateStatus();
	}

	private updateStatus(): void {
		const sizes = `${this.sizeLeft.toLocaleString()} ↔ ${this.sizeRight.toLocaleString()} bytes  ·  ${this.rows.toLocaleString()} rows  ·  ${this.bytesPerRow} bytes/row`;
		if (!this.scanDone) {
			const percent = Math.min(100, Math.floor((this.scanned / Math.max(1, Math.min(this.sizeLeft, this.sizeRight))) * 100));
			this.status.textContent = `${sizes}  ·  scanning ${percent}%`;
			return;
		}
		if (this.regions.length === 0) {
			this.status.textContent = `${sizes}  ·  identical${this.differingBytes ? '' : ''}`;
			return;
		}
		this.status.textContent = `${sizes}  ·  ${this.differingBytes.toLocaleString()} differing bytes in ${this.regions.length.toLocaleString()} region${this.regions.length === 1 ? '' : 's'}`;
	}

	/** Repaints the visible rows (plus overscan): a placeholder row goes in synchronously,
	 *  each pane fills from its slab when the read lands. Row `n` always shows offset
	 *  n*bytesPerRow of both files - the panes never shift against each other. */
	private draw(): void {
		if (!this.rowHeight || !this.rows) return;
		const scrollTop = this.scroller.scrollTop;
		const height = this.scroller.clientHeight || 400;
		const top = this.range.documentTop(scrollTop, height, this.scroller.scrollHeight);
		const first = Math.max(0, Math.floor(top / this.rowHeight) - 8);
		const last = Math.min(this.rows - 1, Math.ceil((top + height) / this.rowHeight) + 8);
		let body = this.sizer.querySelector<HTMLElement>('.hex-body');
		if (!body) {
			body = el('div', 'hex-body');
			body.style.position = 'absolute';
			body.style.left = '0';
			body.style.right = '0';
			body.style.top = '0';
			this.sizer.append(body);
		}
		// The body sits at the document offset of its first row, pulled back by how far the
		// scroll position and that offset differ under a scaled range (nothing unscaled,
		// where the document offset is the content offset).
		body.style.transform = `translateY(${first * this.rowHeight - top + scrollTop}px)`;
		for (const node of Array.from(body.children)) {
			const row = Number((node as HTMLElement).dataset.row);
			if (row < first || row > last) node.remove();
		}
		for (let row = first; row <= last; row++) {
			if (body.querySelector(`[data-row="${row}"]`)) continue;
			const placeholder = el('div', 'hex-cmp-row', [
				compareRow(row * this.bytesPerRow, new Uint8Array(0), new Uint8Array(0), this.bytesPerRow),
				compareRow(row * this.bytesPerRow, new Uint8Array(0), new Uint8Array(0), this.bytesPerRow)
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
					compareRow(offset, leftBytes, this.diffMask(offset, leftBytes.length), this.bytesPerRow),
					compareRow(offset, rightBytes, this.diffMask(offset, rightBytes.length), this.bytesPerRow)
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
		this.scroller.scrollTop = this.range.scrollTopFor(Math.max(0, (Math.floor(region.start / this.bytesPerRow) - 4) * this.rowHeight), this.scroller.clientHeight);
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
		this.scroller.scrollTop = this.range.scrollTopFor(Math.floor(target / this.bytesPerRow) * this.rowHeight, this.scroller.clientHeight);
		this.draw();
		this.gotoBox.value = '0x' + target.toString(16).toUpperCase();
	}
}
