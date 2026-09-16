// The hex viewer a binary file opens in: rows of offset, hex and ASCII columns, paged
// through `read_file_chunk` so a multi-gigabyte file is never read whole, and a byte-search
// box that scans the file in chunks in the background and jumps between hits. The layout
// follows a hex editor's table: a ruled-off offset column, a one-digit ruler over the
// byte columns, hex bytes in 4/8-byte groups, and a compact ASCII pane behind a second
// rule; the row width is the widest of 4..64 bytes that fits the window (or one pinned
// in the toolbar). An address box (Ctrl+G) jumps to any byte offset, and every hex and
// ASCII cell titles itself with its byte's address so a hover reads it off either pane.
//
// The view is read-only until its Edit toggle is switched on; editing works the way hex
// editors classically do - a byte cursor walks the hex column with the arrow keys, typing
// two hex digits replaces the byte (the first digit is shown staged, the second commits it
// and advances), Ctrl+Z steps the edits back, and saving writes only the changed bytes.

import { invoke } from '@tauri-apps/api/core';
import { el, icon, VirtualScroll } from './ui';

/** Rows are requested in slabs so scrolling doesn't fire a read per row. */
const SLAB_BYTES = 64 * 1024;
/** Search reads the file in these many bytes at a time. */
const SEARCH_CHUNK = 1024 * 1024;

interface FileChunk {
	size: number;
	base64: string;
}

export function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The row widths the view offers - WinHex-style, from one-word rows up to 64 bytes. */
export const ROW_LADDER = [4, 8, 16, 24, 32, 40, 48, 56, 64] as const;

/** Bytes are shown in visually separated groups: 8-byte groups once a row is wide
 *  enough to have several, 4-byte groups otherwise (a 4-byte row is one group). */
export function groupSizeFor(bytesPerRow: number): number {
	return bytesPerRow >= 16 && bytesPerRow % 8 === 0 ? 8 : 4;
}

/** Offsets are hex, fixed at eight digits (4 GiB) so the column never shifts. */
export const OFFSET_DIGITS = 8;

/** Tracks the ruler and every row share, laid out the way a classic hex editor's table
 *  is: a fixed offset column ruled off by a vertical line, 3ch per byte (4ch where a
 *  4/8-byte group starts, so the extra space reads as a group gap), a ruled 3ch gutter,
 *  and a compact ASCII pane of 1ch per byte. Nothing stretches - leftover page width
 *  stays empty on the right - so the table keeps the same shape at every window size. */
export function rowGridTemplate(bytesPerRow: number): string {
	const group = groupSizeFor(bytesPerRow);
	const widths = [`${OFFSET_DIGITS + 2}ch`];
	for (let i = 0; i < bytesPerRow; i++) widths.push(i % group === 0 && i > 0 ? '4ch' : '3ch');
	widths.push('3ch');
	for (let i = 0; i < bytesPerRow; i++) widths.push('1ch');
	return widths.join(' ');
}

export function hexByte(b: number): string {
	return b.toString(16).padStart(2, '0').toUpperCase();
}

/** A byte's address the way a cell tooltip shows it: the offset column's fixed eight hex
 *  digits with the `0x` prefix the address box parses, so a hover reads back the same
 *  address either column states. */
export function hexAddress(offset: number): string {
	return '0x' + offset.toString(16).padStart(OFFSET_DIGITS, '0').toUpperCase();
}

/** The ASCII column's glyph for a byte: printable ASCII and Latin-1 as themselves, a
 *  0x00 as a blank so zero-filled regions read as empty space, and other control bytes
 *  as a dot. */
export function asciiChar(b: number): string {
	if (b === 0) return ' ';
	return (b >= 32 && b < 127) || b >= 160 ? String.fromCharCode(b) : '·';
}

/** The column ruler above the rows: a blank offset cell, one hex digit over each byte
 *  column (0..F, repeating past 16), and the same digits again over the ASCII pane so a
 *  character can be read back to its byte. */
export function hexHeader(bytesPerRow: number): HTMLElement {
	const group = groupSizeFor(bytesPerRow);
	const cells: (Node | string | null)[] = [el('span', 'hex-offset')];
	for (let i = 0; i < bytesPerRow; i++) {
		cells.push(el('span', i % group === 0 && i > 0 ? 'hex-cell hex-group-start' : 'hex-cell', [(i % 16).toString(16).toUpperCase()]));
	}
	cells.push(el('span', 'hex-gutter'));
	for (let i = 0; i < bytesPerRow; i++) cells.push(el('span', 'hex-ascii-cell', [(i % 16).toString(16).toUpperCase()]));
	const header = el('div', 'hex-row hex-header', cells);
	header.style.gridTemplateColumns = rowGridTemplate(bytesPerRow);
	return header;
}

function hexRow(offset: number, bytes: Uint8Array, highlight: Uint8Array, cursor = -1, edited?: ReadonlyMap<number, number>, bytesPerRow = bytes.length): HTMLElement {
	const classes = (hit: boolean, at: boolean, changed: boolean, extra = '') =>
		[hit ? 'hex-hit' : '', at ? 'hex-cursor' : '', changed ? 'hex-edited' : '', extra].filter(Boolean).join(' ') || undefined;
	const cells: (Node | string | null)[] = [el('span', 'hex-offset', [offset.toString(16).padStart(OFFSET_DIGITS, '0').toUpperCase()])];
	const group = groupSizeFor(bytesPerRow);
	for (let i = 0; i < bytes.length; i++) {
		const cell = el('span', classes(!!highlight[i], i === cursor, !!edited?.has(offset + i), i % group === 0 && i > 0 ? 'hex-cell hex-group-start' : 'hex-cell'), [hexByte(bytes[i]!)]);
		cell.title = hexAddress(offset + i);
		cells.push(cell);
	}
	for (let i = bytes.length; i < bytesPerRow; i++) cells.push(el('span', 'hex-cell hex-blank'));
	// Occupies the grid's gutter column - without a child there, auto-placement would
	// slide the ASCII block into the gutter and the panes would touch.
	cells.push(el('span', 'hex-gutter'));
	for (let i = 0; i < bytes.length; i++) {
		const cell = el('span', classes(!!highlight[i], i === cursor, !!edited?.has(offset + i), 'hex-ascii-cell'), [asciiChar(bytes[i]!)]);
		cell.title = hexAddress(offset + i);
		cells.push(cell);
	}
	const row = el('div', 'hex-row', cells);
	// A CSS grid keeps the three columns strictly apart however wide the font is (see
	// rowGridTemplate): the ruler and every row share one template, so the header digits
	// sit exactly over their byte columns.
	row.style.gridTemplateColumns = rowGridTemplate(bytesPerRow);
	return row;
}

/** Parse the search box: plain text, or a hex byte sequence when it is (only) hex digit
 * pairs - `ff0a` searches the two bytes, "ff" the letters. */
function parseNeedle(text: string): Uint8Array | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (/^([0-9a-f]{2}\s*)+$/i.test(trimmed)) {
		const digits = trimmed.replace(/\s+/g, '');
		const bytes = new Uint8Array(digits.length / 2);
		for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
		return bytes;
	}
	return new Uint8Array(Array.from(trimmed, (ch) => ch.charCodeAt(0) & 0xff));
}

function findNeedle(haystack: Uint8Array, needle: Uint8Array, from: number): number {
	outer: for (let i = from; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

/** Character cells one full row needs: the offset column (8 digits + 2), 3 per byte
 *  column plus 1 at each group boundary, the 3ch gutter, and 1 per ASCII character. */
function rowCells(bytesPerRow: number): number {
	const group = groupSizeFor(bytesPerRow);
	return OFFSET_DIGITS + 2 + bytesPerRow * 3 + (Math.ceil(bytesPerRow / group) - 1) + 3 + bytesPerRow;
}

/** The widest row of the ladder that fits `available` pixels at `charWidth` each - the
 *  WinHex-style widths 4/8/16/24/32/40/48/56/64, so the hex column fills the page and
 *  the ASCII column stays pinned to the right edge. Falls back to the narrowest. */
export function bytesPerRowFor(charWidth: number, available: number): number {
	for (const bpr of [...ROW_LADDER].reverse()) {
		if (rowCells(bpr) * charWidth <= available) return bpr;
	}
	return ROW_LADDER[0];
}

export interface HexViewHooks {
	/** The unsaved-edits state changed, so the editor's tab dot follows it. */
	onDirtyChange?(dirty: boolean): void;
}

export class HexView {
	readonly root: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly sizer: HTMLElement;
	private readonly status: HTMLElement;
	private readonly searchBox: HTMLInputElement;
	private readonly editButton: HTMLButtonElement;
	private readonly saveButton: HTMLButtonElement;
	private readonly discardButton: HTMLButtonElement;
	private readonly widthSelect: HTMLSelectElement;
	private readonly gotoBox: HTMLInputElement;
	private readonly header: HTMLElement;
	/** Watches the scroller for relayouts; disconnected by destroy(). */
	private readonly observer: ResizeObserver;
	private size = 0;
	private rows = 0;
	private rowHeight = 0;
	private bytesPerRow = 16;
	/** The scroll range for the file's rows — clamped and scaled past the layout engines'
	 *  height ceiling, so a multi-gigabyte file's tail stays reachable by scrolling. */
	private range = new VirtualScroll(0, 1);
	/** A row width the user picked in the toolbar (0 = follow the window width). */
	private forcedBytesPerRow = 0;
	/** The byte an address jump landed on, highlighted until the flash times out. */
	private jumpTarget = -1;
	private readonly slabs = new Map<number, Promise<Uint8Array | null>>();
	private searchNeedle: Uint8Array | null = null;
	/** The search box text the running/finished scan is for: Enter with it unchanged
	 *  steps to the next hit instead of rescanning. */
	private searchedText = '';
	private searchToken = 0;
	private hits: number[] = [];
	private hitIndex = -1;
	/* ---------- Editing ---------- */
	private editing = false;
	/** The byte the cursor sits on (absolute offset), -1 when it is nowhere yet. */
	private cursor = -1;
	/** The first typed hex digit, waiting for the second to commit the byte. */
	private stagedNibble: { offset: number; digit: number } | null = null;
	/** Changed bytes by absolute offset, what a save writes back. */
	private readonly edits = new Map<number, number>();
	private readonly undoStack: { offset: number; from: number; to: number; created: boolean }[] = [];

	constructor(private path: string, private hooks: HexViewHooks = {}) {
		this.searchBox = el('input', 'hex-search') as HTMLInputElement;
		this.searchBox.type = 'search';
		this.searchBox.placeholder = 'Find bytes (text or hex)';
		this.searchBox.spellcheck = false;
		this.searchBox.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				// Enter walks the hits of the needle already scanned; a changed needle rescans.
				if (event.shiftKey) this.gotoHit(this.hitIndex - 1);
				else if (this.hits.length && this.searchBox.value === this.searchedText) this.gotoHit(this.hitIndex + 1);
				else this.search();
			}
			if (event.key === 'Escape') this.clearSearch();
		});
		const count = el('span', 'hex-search-count');
		const next = el('button', 'button secondary', [icon('arrow-down')]);
		next.title = 'Next Match (Enter)';
		const prev = el('button', 'button secondary', [icon('arrow-up')]);
		prev.title = 'Previous Match (Shift+Enter)';
		next.addEventListener('click', () => (this.hits.length ? this.gotoHit(this.hitIndex + 1) : this.search()));
		prev.addEventListener('click', () => this.gotoHit(this.hitIndex - 1));
		this.editButton = el('button', 'button secondary hex-edit-toggle', [icon('lock')]) as HTMLButtonElement;
		this.editButton.title = 'Toggle Editing (read-only by default)';
		this.editButton.setAttribute('aria-label', 'Toggle editing');
		this.editButton.addEventListener('click', () => this.toggleEditing());
		this.saveButton = el('button', 'button secondary hex-save', [icon('save')]) as HTMLButtonElement;
		this.saveButton.title = 'Save Changes (Ctrl+S)';
		this.saveButton.hidden = true;
		this.saveButton.addEventListener('click', () => void this.save());
		this.discardButton = el('button', 'button secondary hex-discard', [icon('discard')]) as HTMLButtonElement;
		this.discardButton.title = 'Discard Changes';
		this.discardButton.hidden = true;
		this.discardButton.addEventListener('click', () => this.discard());
		// The row-width picker: Auto follows the window (the widest of 4..64 that fits),
		// a number pins it the way a hex editor's "bytes per row" setting does.
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
		// The address box: Enter jumps to a byte offset - hex with a 0x (or trailing h)
		// prefix, decimal otherwise - the way a hex editor's Go To dialog does.
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
		this.gotoBox.addEventListener('blur', () => {
			// Report the resolved address back so the box always shows a real offset.
			if (this.jumpTarget >= 0) this.gotoBox.value = '0x' + this.jumpTarget.toString(16).toUpperCase();
		});
		const toolbar = el('div', 'hex-toolbar', [this.searchBox, count, prev, next, el('span', 'hex-toolbar-sep'), this.gotoBox, this.widthSelect, el('span', 'hex-toolbar-sep'), this.editButton, this.saveButton, this.discardButton]);
		this.scroller = el('div', 'hex-scroller');
		this.sizer = el('div', 'hex-sizer');
		this.scroller.append(this.sizer);
		this.header = el('div', 'hex-header-wrap');
		this.status = el('div', 'hex-status', ['Loading…']);
		this.root = el('div', 'hex-view', [toolbar, this.header, this.scroller, this.status]);
		this.root.tabIndex = 0;
		this.scroller.addEventListener('scroll', () => {
			// The ruler follows a horizontal scroll (a pinned row wider than the window), so
			// its digits stay over their byte columns.
			this.header.scrollLeft = this.scroller.scrollLeft;
			this.draw();
		});
		this.scroller.addEventListener('mousedown', (event) => {
			if (!this.editing) return;
			const cell = (event.target as HTMLElement).closest('.hex-cell');
			if (!cell) return;
			const row = Number((cell.parentElement as HTMLElement).dataset.row);
			if (Number.isNaN(row)) return;
			this.placeCursor(row * this.bytesPerRow + Array.prototype.indexOf.call((cell.parentElement as HTMLElement).querySelectorAll('.hex-cell'), cell));
		});
		this.root.addEventListener('keydown', (event) => this.onKeydown(event));
		// The row width follows the window; Git Graph's own hex view does the same dance.
		// One relayout per animation frame however often a resize drag fires the observer.
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

	get isDirty(): boolean {
		return this.edits.size > 0;
	}

	/** The file this view shows was renamed on disk: slab reads and byte-patch saves follow
	 *  the new path (the decoded slabs stay valid - the content moved, it didn't change). */
	setPath(path: string): void {
		this.path = path;
	}

	/** Releases the view: the resize observer is disconnected, an in-flight search stops
	 *  at its current chunk, and the decoded slabs are dropped. The editor's tab close
	 *  runs this via `onClose`. */
	destroy(): void {
		this.observer.disconnect();
		this.searchToken++;
		this.slabs.clear();
		this.slabValues.clear();
		this.root.remove();
	}

	/** Loads the first slab (which also learns the file size), sizes the virtual list. */
	async load(): Promise<void> {
		const first = await this.slab(0);
		if (!first) return;
		// The row height must be measured before rows are known; an empty probe row does it.
		const probe = hexRow(0, new Uint8Array(0), new Uint8Array(0), -1, undefined, 16);
		this.sizer.append(probe);
		this.rowHeight = probe.getBoundingClientRect().height || 20;
		probe.remove();
		this.relayout();
	}

	/** The bytes per row that fit the scroller, measured in the row font: a row needs
	 *  rowCells() character cells, so narrower windows step down the ladder. */
	private pickBytesPerRow(): number {
		if (this.forcedBytesPerRow) return this.forcedBytesPerRow;
		const probe = el('span', 'hex-row');
		probe.style.visibility = 'hidden';
		probe.style.position = 'absolute';
		probe.textContent = '0'.repeat(28);
		this.scroller.append(probe);
		const charWidth = probe.getBoundingClientRect().width / 28;
		probe.remove();
		// jsdom reports zero sizes; default to a comfortable layout rather than the narrowest.
		if (!charWidth || !this.scroller.clientWidth) return 16;
		return bytesPerRowFor(charWidth, this.scroller.clientWidth - 24);
	}

	/** Parses an address (`0x1A0`, `1A0h`, `416`) and scrolls to that byte, flashing the
	 *  cell so the landing point is obvious in a page-full of hex. */
	private gotoAddress(text: string): void {
		const trimmed = text.trim();
		const hex = /^0x([0-9a-f]+)$/i.exec(trimmed) || /^([0-9a-f]+)h$/i.exec(trimmed);
		const value = hex ? parseInt(hex[1]!, 16) : /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
		if (Number.isNaN(value)) {
			this.status.textContent = `Not an address: ${trimmed}`;
			return;
		}
		this.jumpTarget = Math.max(0, Math.min(value, Math.max(0, this.size - 1)));
		this.scroller.scrollTop = this.range.scrollTopFor(Math.max(0, Math.floor(this.jumpTarget / this.bytesPerRow) * this.rowHeight), this.scroller.clientHeight);
		this.updateStatus();
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		this.gotoBox.value = '0x' + this.jumpTarget.toString(16).toUpperCase();
		// The flash outlasts the row's asynchronous fill, so it is applied in draw().
		const target = this.jumpTarget;
		setTimeout(() => {
			if (this.jumpTarget === target) {
				this.jumpTarget = -1;
				this.refreshRows([target]);
			}
		}, 1600);
	}

	/** Recomputes the row width and total height, keeping the top of the viewport
	 *  anchored to the same byte when the window resizes. */
	private relayout(): void {
		const clientHeight = this.scroller.clientHeight;
		const firstByte = this.rowHeight ? (this.range.documentTop(this.scroller.scrollTop, clientHeight) / this.rowHeight) * this.bytesPerRow : 0;
		const bpr = this.pickBytesPerRow();
		if (bpr !== this.bytesPerRow) this.sizer.querySelector('.hex-body')?.remove();
		this.bytesPerRow = bpr;
		// The header follows the row width; pinned to the scroller's content width so the
		// ASCII label lines up with the rows beside (not under) the scrollbar.
		this.header.replaceChildren(hexHeader(bpr));
		this.header.style.width = this.scroller.clientWidth ? `${this.scroller.clientWidth}px` : '';
		this.header.scrollLeft = this.scroller.scrollLeft;
		if (!this.size || !this.rowHeight) return;
		this.rows = Math.ceil(this.size / bpr);
		this.range = new VirtualScroll(this.rows, this.rowHeight);
		this.sizer.style.height = `${this.range.spacerHeight}px`;
		this.scroller.scrollTop = this.range.scrollTopFor(Math.floor(firstByte / bpr) * this.rowHeight, clientHeight);
		this.draw();
		this.updateStatus();
	}

	private updateStatus(): void {
		const base = `${this.size.toLocaleString()} bytes  ·  ${this.rows.toLocaleString()} rows  ·  ${this.bytesPerRow} bytes/row`;
		this.status.textContent = this.edits.size ? `${base}  ·  ${this.edits.size.toLocaleString()} byte${this.edits.size === 1 ? '' : 's'} changed (unsaved)` : base;
	}

	private slab(slabIndex: number): Promise<Uint8Array | null> {
		let promise = this.slabs.get(slabIndex);
		if (!promise) {
			const offset = slabIndex * SLAB_BYTES;
			if (offset >= this.size && this.size > 0) return Promise.resolve(null);
			promise = invoke<FileChunk>('read_file_chunk', { path: this.path, offset, len: SLAB_BYTES })
				.then((chunk) => {
					this.size = chunk.size;
					const bytes = decodeBase64(chunk.base64);
					// Kept decoded so byte edits can read neighbours synchronously.
					this.slabValues.set(slabIndex, bytes);
					return bytes;
				})
				.catch(() => null);
			this.slabs.set(slabIndex, promise);
		}
		return promise;
	}

	/** A row's bytes: from one slab, or - when the row straddles the 64 KiB boundary (a
	 *  row width like 24 doesn't divide it) - with the tail of the next slab joined on. */
	private async rowBytes(offset: number): Promise<Uint8Array | null> {
		const slabIndex = Math.floor(offset / SLAB_BYTES);
		const first = await this.slab(slabIndex);
		if (!first) return null;
		const head = first.subarray(offset - slabIndex * SLAB_BYTES, offset - slabIndex * SLAB_BYTES + this.bytesPerRow);
		if (head.length >= this.bytesPerRow) return head;
		const tail = await this.slab(slabIndex + 1);
		if (!tail) return head;
		const joined = new Uint8Array(Math.min(this.bytesPerRow, head.length + tail.length));
		joined.set(head);
		joined.set(tail.subarray(0, joined.length - head.length), head.length);
		return joined;
	}

	/** The slab's bytes as they should be shown: edited bytes overlaid, and a staged
	 *  nibble replacing the cursor byte's high half while its second digit is pending. */
	private displayBytes(bytes: Uint8Array, startOffset: number): Uint8Array {
		if (!this.edits.size && !this.stagedNibble) return bytes;
		const copy = new Uint8Array(bytes);
		for (let i = 0; i < copy.length; i++) {
			const edited = this.edits.get(startOffset + i);
			if (edited !== undefined) copy[i] = edited;
		}
		const staged = this.stagedNibble;
		if (staged) {
			const i = staged.offset - startOffset;
			if (i >= 0 && i < copy.length) copy[i] = (staged.digit << 4) | (copy[i]! & 0x0f);
		}
		return copy;
	}

	/** Repaints the visible rows (plus a small overscan). Placeholder rows go in
	 *  synchronously so scrolling never shows a gap; each is filled from its slab when
	 *  the read resolves. */
	private draw(): void {
		if (!this.rowHeight || !this.rows) return;
		const scrollTop = this.scroller.scrollTop;
		const height = this.scroller.clientHeight || 400;
		const top = this.range.documentTop(scrollTop, height);
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
		// Drop the rows that scrolled out, keep the ones still visible.
		for (const node of Array.from(body.children)) {
			const row = Number((node as HTMLElement).dataset.row);
			if (row < first || row > last) node.remove();
		}
		for (let row = first; row <= last; row++) {
			if (body.querySelector(`[data-row="${row}"]`)) continue;
			const placeholder = hexRow(row * this.bytesPerRow, new Uint8Array(0), new Uint8Array(0), -1, undefined, this.bytesPerRow);
			placeholder.dataset.row = String(row);
			// Zebra stripes by absolute row number, so the banding is stable as the virtual list scrolls.
			if (row % 2) placeholder.classList.add('hex-row-odd');
			// DOM order stays row order: insert before the first already-placed later row.
			const after = Array.from(body.children).find((child) => Number((child as HTMLElement).dataset.row) > row);
			body.insertBefore(placeholder, after ?? null);
			void this.rowBytes(row * this.bytesPerRow).then((bytes) => {
				if (!bytes || !body.contains(placeholder) || this.sizer.querySelector('.hex-body') !== body) return;
				const rowBytes = this.displayBytes(bytes, row * this.bytesPerRow);
				if (!rowBytes.length) return;
				let highlight = new Uint8Array(0);
				if (this.searchNeedle) {
					highlight = new Uint8Array(rowBytes.length);
					const pos = findNeedle(rowBytes, this.searchNeedle, 0);
					if (pos >= 0) highlight.fill(1, pos, pos + this.searchNeedle.length);
				}
				const filled = hexRow(row * this.bytesPerRow, rowBytes, highlight, this.cursorIn(row * this.bytesPerRow, rowBytes.length), this.edits, this.bytesPerRow);
				filled.dataset.row = String(row);
				if (row % 2) filled.classList.add('hex-row-odd');
				// The address-jump flash lands on the row whenever its bytes arrive.
				if (this.jumpTarget >= row * this.bytesPerRow && this.jumpTarget < row * this.bytesPerRow + rowBytes.length) {
					const i = this.jumpTarget - row * this.bytesPerRow;
					// Children: offset, hex cells, gutter, ascii cells.
					filled.children[1 + i]!.classList.add('hex-jump');
					filled.children[2 + this.bytesPerRow + i]!.classList.add('hex-jump');
				}
				placeholder.replaceWith(filled);
			});
		}
	}

	/** The cursor byte's index within a row starting at `offset`, or -1. */
	private cursorIn(offset: number, length: number): number {
		return this.cursor >= offset && this.cursor < offset + length ? this.cursor - offset : -1;
	}

	/** Removes a drawn row so the next `draw()` refills it (the cursor moved onto or
	 *  off it, or one of its bytes changed). */
	private refreshRows(offsets: number[]): void {
		const body = this.sizer.querySelector('.hex-body');
		if (!body) return;
		for (const offset of offsets) {
			body.querySelector(`[data-row="${Math.floor(offset / this.bytesPerRow)}"]`)?.remove();
		}
		this.draw();
	}

	/** Scrolls until the row holding `offset` is on screen, then redraws. */
	private revealByte(offset: number): void {
		const row = Math.floor(offset / this.bytesPerRow);
		const top = row * this.rowHeight;
		const clientHeight = this.scroller.clientHeight;
		const at = this.range.documentTop(this.scroller.scrollTop, clientHeight);
		if (top < at) this.scroller.scrollTop = this.range.scrollTopFor(Math.max(0, top - 4 * this.rowHeight), clientHeight);
		else if (top + this.rowHeight > at + clientHeight) this.scroller.scrollTop = this.range.scrollTopFor(top + this.rowHeight - clientHeight + 4 * this.rowHeight, clientHeight);
		else this.refreshRows([offset]);
	}

	/* ---------- Search ---------- */

	private updateCount(): void {
		const label = this.root.querySelector('.hex-search-count')!;
		label.textContent = this.searchNeedle ? (this.hits.length ? `${this.hitIndex + 1} of ${this.hits.length}` : this.hits.length === 0 ? 'No results' : 'Searching…') : '';
	}

	private clearSearch(): void {
		this.searchToken++;
		this.searchNeedle = null;
		this.searchedText = '';
		this.hits = [];
		this.hitIndex = -1;
		this.searchBox.value = '';
		this.updateCount();
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
	}

	/** Starts a scan of the whole file for the search box's needle (an unchanged needle
	 *  is repeated with Enter instead - see the search box's keydown handler). */
	private search(): void {
		const needle = parseNeedle(this.searchBox.value);
		if (!needle) {
			this.clearSearch();
			return;
		}
		this.searchToken++;
		const token = this.searchToken;
		this.searchNeedle = needle;
		this.searchedText = this.searchBox.value;
		this.hits = [];
		this.hitIndex = -1;
		this.updateCount();
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		void (async () => {
			let offset = 0;
			let carry = new Uint8Array(0);
			while (offset < this.size && token === this.searchToken) {
				let chunk: Uint8Array;
				try {
					chunk = decodeBase64((await invoke<FileChunk>('read_file_chunk', { path: this.path, offset, len: SEARCH_CHUNK })).base64);
				} catch {
					return;
				}
				if (token !== this.searchToken) return;
				const joined = new Uint8Array(carry.length + chunk.length);
				joined.set(carry);
				joined.set(chunk, carry.length);
				for (let pos = findNeedle(joined, needle, 0); pos >= 0; pos = findNeedle(joined, needle, pos + 1)) {
					this.hits.push(offset - carry.length + pos);
				}
				// A match can straddle the boundary; carry the tail back into the next round.
				carry = joined.subarray(Math.max(0, joined.length - needle.length + 1));
				offset += chunk.length;
				this.updateCount();
			}
			if (token !== this.searchToken) return;
			this.updateCount();
			// Land on the first hit - unless the user already stepped through the
			// partial results while the scan was still running.
			if (this.hits.length && this.hitIndex < 0) this.gotoHit(0);
		})();
	}

	/** Scrolls to hit `index` (wrapping) and repaints with the highlight the rows need. */
	private gotoHit(index: number): void {
		if (!this.hits.length || !this.searchNeedle) return;
		this.hitIndex = ((index % this.hits.length) + this.hits.length) % this.hits.length;
		const offset = this.hits[this.hitIndex]!;
		this.scroller.scrollTop = this.range.scrollTopFor(Math.max(0, (Math.floor(offset / this.bytesPerRow) - 4) * this.rowHeight), this.scroller.clientHeight);
		this.updateCount();
		this.draw();
	}

	/* ---------- Editing ---------- */

	/** Switches between the read-only default and the editing mode (the toggle never
	 *  drops unsaved edits; saving and discarding are their own buttons). */
	private toggleEditing(): void {
		this.editing = !this.editing;
		this.stagedNibble = null;
		this.root.classList.toggle('editing', this.editing);
		this.editButton.replaceChildren(icon(this.editing ? 'unlock' : 'lock'));
		this.editButton.title = this.editing ? 'Switch Back to Read-Only' : 'Toggle Editing (read-only by default)';
		if (this.editing && this.cursor < 0 && this.size) this.placeCursor(0);
		if (!this.editing && this.cursor >= 0) {
			const had = this.cursor;
			this.cursor = -1;
			this.refreshRows([had]);
		}
	}

	private placeCursor(offset: number): void {
		const clamped = Math.max(0, Math.min(offset, this.size - 1));
		const before = this.cursor;
		this.stagedNibble = null;
		this.cursor = clamped;
		this.revealByte(clamped);
		this.refreshRows([before, clamped]);
		this.root.focus();
	}

	private onKeydown(event: KeyboardEvent): void {
		// Ctrl+G focuses the address box even in read-only mode - Go To is a navigation,
		// not an edit.
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
			event.preventDefault();
			this.gotoBox.focus();
			this.gotoBox.select();
			return;
		}
		if (!this.editing) return;
		const bpr = this.bytesPerRow;
		let handled = true;
		switch (event.key) {
			case 'ArrowLeft': this.placeCursor(this.cursor - 1); break;
			case 'ArrowRight': this.placeCursor(this.cursor + 1); break;
			case 'ArrowUp': this.placeCursor(this.cursor - bpr); break;
			case 'ArrowDown': this.placeCursor(this.cursor + bpr); break;
			case 'Home': this.placeCursor(Math.floor(this.cursor / bpr) * bpr); break;
			case 'End': this.placeCursor(Math.floor(this.cursor / bpr) * bpr + bpr - 1); break;
			case 'PageUp': this.placeCursor(this.cursor - bpr * 16); break;
			case 'PageDown': this.placeCursor(this.cursor + bpr * 16); break;
			case 'Backspace':
				// A staged nibble un-stages; a committed byte reverts to what it was.
				if (this.stagedNibble) {
					this.stagedNibble = null;
					this.refreshRows([this.cursor]);
				} else {
					this.undo();
				}
				break;
			case 'z': case 'Z':
				if (!(event.ctrlKey || event.metaKey)) { handled = false; break; }
				this.undo();
				break;
			default: {
				// A modifier means a shortcut (Ctrl+C copies, Ctrl+A selects all...),
				// not a hex digit typed over the cursor byte.
				if (event.ctrlKey || event.metaKey || event.altKey) {
					handled = false;
					break;
				}
				const digit = /^[0-9a-f]$/i.exec(event.key)?.[0];
				if (digit === undefined) {
					handled = false;
					break;
				}
				this.typeNibble(parseInt(digit, 16));
			}
		}
		if (handled) event.preventDefault();
	}

	/** Types one hex digit over the cursor: the first digit stages (and shows) the new
	 *  high nibble, the second commits the byte and steps the cursor to the next one. */
	private typeNibble(digit: number): void {
		if (this.cursor < 0) return;
		const staged = this.stagedNibble;
		if (staged && staged.offset === this.cursor) {
			this.commitByte(this.cursor, (staged.digit << 4) | digit);
			this.stagedNibble = null;
			this.placeCursor(this.cursor + 1);
		} else {
			this.stagedNibble = { offset: this.cursor, digit };
			this.refreshRows([this.cursor]);
		}
	}

	/** Records a byte change (also the undo entry point's target). The undo entry's
	 *  `from` is the byte's current effective value (an earlier edit's, else the disk's),
	 *  and typing the on-disk byte back removes the edit - that offset is clean again. */
	private commitByte(offset: number, value: number): void {
		const from = this.edits.get(offset) ?? this.diskByte(offset);
		if (from === value) return;
		const created = !this.edits.has(offset);
		if (value === this.diskByte(offset)) this.edits.delete(offset);
		else this.edits.set(offset, value);
		this.undoStack.push({ offset, from, to: value, created });
		if (this.edits.size) this.markDirty();
		else this.markClean();
	}

	/** The byte as it is on disk - from the slab cache, so an edit can be un-done. */
	private diskByte(offset: number): number {
		const slabIndex = Math.floor(offset / SLAB_BYTES);
		const cached = this.slabValues.get(slabIndex);
		if (cached) return cached[offset - slabIndex * SLAB_BYTES]!;
		// The slab backing a committed edit is always one the view already showed.
		return this.edits.get(offset) ?? 0;
	}

	private undo(): void {
		const last = this.undoStack.pop();
		if (!last) return;
		// The change that first touched a byte removes it again when undone; a re-edit
		// only steps back to the byte's previous edited value.
		if (last.created) this.edits.delete(last.offset);
		else this.edits.set(last.offset, last.from);
		if (!this.edits.size) this.markClean();
		else this.markDirty();
		this.refreshRows([last.offset]);
	}

	private discard(): void {
		this.edits.clear();
		this.undoStack.length = 0;
		this.stagedNibble = null;
		this.markClean();
		// The slabs hold the disk's bytes again as the source of truth.
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
	}

	private markDirty(): void {
		this.saveButton.hidden = false;
		this.discardButton.hidden = false;
		this.hooks.onDirtyChange?.(true);
		this.updateStatus();
	}

	private markClean(): void {
		this.saveButton.hidden = true;
		this.discardButton.hidden = true;
		this.hooks.onDirtyChange?.(false);
		this.updateStatus();
	}

	/** Writes the changed bytes back in place; returns whether the file is now clean. */
	async save(): Promise<boolean> {
		if (!this.edits.size) return true;
		const edits = Array.from(this.edits, ([offset, byte]) => ({ offset, byte }));
		try {
			await invoke('patch_file', { path: this.path, edits });
		} catch (error) {
			this.status.textContent = `Save failed: ${String(error)}`;
			return false;
		}
		this.edits.clear();
		this.undoStack.length = 0;
		this.stagedNibble = null;
		this.markClean();
		// What is on disk changed; drop the cached slabs and redraw from the file.
		this.slabs.clear();
		this.slabValues.clear();
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		return true;
	}

	/** Synchronously decoded slabs, so byte edits can read neighbours without a race. */
	private readonly slabValues = new Map<number, Uint8Array>();
}
