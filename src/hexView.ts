// The hex editor a binary file opens in: rows of offset, hex and ASCII columns, paged
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
//
// Selection is a hex editor's, not a text editor's: bytes are picked cell by cell in
// either pane (a drag, Shift+click, Shift+arrows, Ctrl+A), or marked start-to-end through
// the right-click menu or the Select Range dialog - a span of a huge file no drag could
// cross. Copy honours the pane it was made in (Ctrl+C from the hex pane copies
// space-free uppercase hex, from the ASCII pane the raw text); Copy Special offers the
// professional formats - hex, text, C array, Base64 - and the address of the clicked
// byte, or a selection's start-end span. Copy and paste are capped at 10 MiB (a
// reminder refuses anything larger), and Paste (Ctrl+V, edit mode) writes the
// clipboard's bytes - hex pairs from another instance's Copy, or raw text - over the
// file from the right-clicked byte, the selection's start or the caret, never past its
// end. A data inspector line under the rows reads the caret byte as u8..u64, floats
// and text.

import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { t, tf } from './i18n';
import { settings } from './settings';
import { attachWheel, type Disposable } from './scroll/input';
import { ScrollModel } from './scroll/model';
import { Scrollbar } from './scroll/scrollbar';
import { el, icon, notify, quickInput, showContextMenu, type MenuEntry } from './ui';

/** Rows are requested in slabs so scrolling doesn't fire a read per row. */
const SLAB_BYTES = 64 * 1024;
/** Search reads the file in these many bytes at a time. */
const SEARCH_CHUNK = 1024 * 1024;
/** The largest selection Copy reads at once and Paste writes at once - a clipboard
 *  payload, not a file dump; 10 MiB, and anything larger is refused with a reminder. */
const COPY_LIMIT = 10 * 1024 * 1024;

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

/** Offsets are hex, eight digits at the floor (the classic 4 GiB column) so the column
 *  never shifts while a file is viewed. */
export const OFFSET_DIGITS = 8;

/** The offset digits a file of `size` bytes needs: the eight-digit floor, one digit more
 *  for every 16× past 4 GiB. A nine-digit label in the eight-digit track would run under
 *  the first hex byte column, so the width follows the file, not the other way round. */
export function offsetDigitsFor(size: number): number {
	return Math.max(OFFSET_DIGITS, Math.max(0, size - 1).toString(16).length);
}

/** Tracks the ruler and every row share, laid out the way a classic hex editor's table
 *  is: a fixed offset column ruled off by a vertical line, 3ch per byte (4ch where a
 *  4/8-byte group starts, so the extra space reads as a group gap), a ruled 3ch gutter,
 *  and a compact ASCII pane of 1ch per byte. Nothing stretches - leftover page width
 *  stays empty on the right - so the table keeps the same shape at every window size. */
export function rowGridTemplate(bytesPerRow: number, digits = OFFSET_DIGITS): string {
	const group = groupSizeFor(bytesPerRow);
	const widths = [`${digits + 2}ch`];
	for (let i = 0; i < bytesPerRow; i++) widths.push(i % group === 0 && i > 0 ? '4ch' : '3ch');
	widths.push('3ch');
	for (let i = 0; i < bytesPerRow; i++) widths.push('1ch');
	return widths.join(' ');
}

export function hexByte(b: number): string {
	return b.toString(16).padStart(2, '0').toUpperCase();
}

/** A byte's address the way a cell tooltip shows it: the offset column's digits with the
 *  `0x` prefix the address box parses, so a hover reads back the same address either
 *  column states. */
export function hexAddress(offset: number, digits = OFFSET_DIGITS): string {
	return '0x' + offset.toString(16).padStart(digits, '0').toUpperCase();
}

/** Parses an address the address box, the range dialog and Go To all accept: `0x1A0`
 *  hex, `1A0h` Intel style, or plain decimal. Returns null when it is none of them. */
function parseAddress(text: string): number | null {
	const trimmed = text.trim();
	const hex = /^0x([0-9a-f]+)$/i.exec(trimmed) || /^([0-9a-f]+)h$/i.exec(trimmed);
	if (hex) return parseInt(hex[1]!, 16);
	if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	return null;
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
export function hexHeader(bytesPerRow: number, digits = OFFSET_DIGITS): HTMLElement {
	const group = groupSizeFor(bytesPerRow);
	const cells: (Node | string | null)[] = [el('span', 'hex-offset')];
	for (let i = 0; i < bytesPerRow; i++) {
		cells.push(el('span', i % group === 0 && i > 0 ? 'hex-cell hex-group-start' : 'hex-cell', [(i % 16).toString(16).toUpperCase()]));
	}
	cells.push(el('span', 'hex-gutter'));
	for (let i = 0; i < bytesPerRow; i++) cells.push(el('span', 'hex-ascii-cell', [(i % 16).toString(16).toUpperCase()]));
	const header = el('div', 'hex-row hex-header', cells);
	header.style.gridTemplateColumns = rowGridTemplate(bytesPerRow, digits);
	return header;
}

function hexRow(offset: number, bytes: Uint8Array, highlight: Uint8Array, cursor = -1, edited?: ReadonlyMap<number, number>, bytesPerRow = bytes.length, digits = OFFSET_DIGITS, selection?: readonly [number, number]): HTMLElement {
	const classes = (hit: boolean, at: boolean, changed: boolean, selected: boolean, extra = '') =>
		[hit ? 'hex-hit' : '', at ? 'hex-cursor' : '', changed ? 'hex-edited' : '', selected ? 'hex-selected' : '', extra].filter(Boolean).join(' ') || undefined;
	const inSelection = (i: number): boolean => !!selection && offset + i >= selection[0] && offset + i < selection[1];
	const cells: (Node | string | null)[] = [el('span', 'hex-offset', [offset.toString(16).padStart(digits, '0').toUpperCase()])];
	const group = groupSizeFor(bytesPerRow);
	for (let i = 0; i < bytes.length; i++) {
		const cell = el('span', classes(!!highlight[i], i === cursor, !!edited?.has(offset + i), inSelection(i), i % group === 0 && i > 0 ? 'hex-cell hex-group-start' : 'hex-cell'), [hexByte(bytes[i]!)]);
		cell.title = hexAddress(offset + i, digits);
		cells.push(cell);
	}
	for (let i = bytes.length; i < bytesPerRow; i++) cells.push(el('span', 'hex-cell hex-blank'));
	// Occupies the grid's gutter column - without a child there, auto-placement would
	// slide the ASCII block into the gutter and the panes would touch.
	cells.push(el('span', 'hex-gutter'));
	// The ASCII pane runs the full row width too: a short tail row's blanks and a
	// placeholder's blanks are invisible spacers, so a pointer over them still has a
	// positional cell to land on (a drag's mousemove must resolve mid-refill).
	for (let i = 0; i < bytesPerRow; i++) {
		const blank = i >= bytes.length;
		const cell = el('span', classes(!!highlight[i], i === cursor, !!edited?.has(offset + i), inSelection(i), blank ? 'hex-ascii-cell hex-blank' : 'hex-ascii-cell'), [blank ? '' : asciiChar(bytes[i]!)]);
		if (!blank) cell.title = hexAddress(offset + i, digits);
		cells.push(cell);
	}
	const row = el('div', 'hex-row', cells);
	// A CSS grid keeps the three columns strictly apart however wide the font is (see
	// rowGridTemplate): the ruler and every row share one template, so the header digits
	// sit exactly over their byte columns.
	row.style.gridTemplateColumns = rowGridTemplate(bytesPerRow, digits);
	return row;
}

/** The byte a hex or ASCII cell stands for, with the pane it belongs to - null anywhere
 *  else in the scroller (the offset column, the gutter, the gaps). Blank filler cells
 *  count too: they are positional, and an offset past the file's end clamps to its last
 *  byte at the caller. The row's own offset label states the base, so the lookup holds
 *  at every row width and over a placeholder mid-refill. */
function byteAtCell(node: HTMLElement): { offset: number; pane: 'hex' | 'ascii' } | null {
	const cell = node.closest<HTMLElement>('.hex-cell, .hex-ascii-cell');
	const rowEl = cell?.parentElement;
	if (!cell || !rowEl || rowEl.dataset.row === undefined) return null;
	const base = parseInt(rowEl.querySelector('.hex-offset')?.textContent ?? '', 16);
	if (!Number.isFinite(base)) return null;
	const pane: 'hex' | 'ascii' = cell.classList.contains('hex-ascii-cell') ? 'ascii' : 'hex';
	const cells = rowEl.querySelectorAll(pane === 'ascii' ? '.hex-ascii-cell' : '.hex-cell');
	const index = Array.prototype.indexOf.call(cells, cell);
	if (index < 0) return null;
	return { offset: base + index, pane };
}

/** Bytes as Latin-1 text - one code unit per byte, the way a hex editor's ASCII pane
 *  copies (no re-encoding, no lossy replacement characters). */
function bytesToLatin1(bytes: Uint8Array): string {
	let out = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return out;
}

/** The clipboard formats Copy Special offers; the i18n key names each one for the
 *  status line's confirmation. */
type CopyFormat = 'smart' | 'hex' | 'text' | 'c' | 'base64';
const COPY_FORMAT_KEYS: Record<CopyFormat, Parameters<typeof t>[0]> = {
	smart: 'hex.menu.copy',
	hex: 'hex.menu.copyHex',
	text: 'hex.menu.copyText',
	c: 'hex.menu.copyC',
	base64: 'hex.menu.copyBase64'
};

/** A byte count the way a size reminder reads it: whole KiB/MiB without a fraction,
 *  one decimal otherwise. */
function formatBytes(count: number): string {
	if (count < 1024) return `${count} B`;
	if (count < 1024 * 1024) return `${Number((count / 1024).toFixed(1))} KiB`;
	return `${Number((count / (1024 * 1024)).toFixed(1))} MiB`;
}

/** The bytes a paste writes: hex digit pairs - optionally 0x-prefixed and comma- or
 *  whitespace-separated, the formats this editor's own Copy Special produces - read as
 *  bytes, anything else as the text itself, one byte per character. One instance's
 *  copied hex therefore pastes as the same bytes in another (the same policy the search
 *  box's needle follows). */
function parseClipboardBytes(text: string): Uint8Array | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (/^((0x)?[0-9a-f]{2}[\s,]*)+$/i.test(trimmed)) {
		const digits = trimmed.replace(/0x/gi, '').replace(/[\s,]/g, '');
		const bytes = new Uint8Array(digits.length / 2);
		for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
		return bytes;
	}
	return new Uint8Array(Array.from(trimmed, (ch) => ch.charCodeAt(0) & 0xff));
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

/** Character cells one full row needs: the offset column (digits + 2), 3 per byte
 *  column plus 1 at each group boundary, the 3ch gutter, and 1 per ASCII character. */
function rowCells(bytesPerRow: number, digits = OFFSET_DIGITS): number {
	const group = groupSizeFor(bytesPerRow);
	return digits + 2 + bytesPerRow * 3 + (Math.ceil(bytesPerRow / group) - 1) + 3 + bytesPerRow;
}

/** The widest row of the ladder that fits `available` pixels at `charWidth` each - the
 *  WinHex-style widths 4/8/16/24/32/40/48/56/64, so the hex column fills the page and
 *  the ASCII column stays pinned to the right edge. Falls back to the narrowest. */
export function bytesPerRowFor(charWidth: number, available: number, digits = OFFSET_DIGITS): number {
	for (const bpr of [...ROW_LADDER].reverse()) {
		if (rowCells(bpr, digits) * charWidth <= available) return bpr;
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
	/** The wheel over the scroller (scroll/input.ts), disposed with the view. */
	private readonly wheel: Disposable;
	/** The viewport's position over the file's rows (scroll/model.ts): the rows, the caret
	 *  reveals, the page keys and the drawn scrollbar all go through it. */
	readonly scroll: ScrollModel;
	private readonly scrollbar: Scrollbar;
	private size = 0;
	private rows = 0;
	private rowHeight = 0;
	private bytesPerRow = 16;
	/** The offset column's digits for this file - eight, or more past 4 GiB (see
	 *  offsetDigitsFor), so every address fits the column it is printed in. */
	private offsetDigits = OFFSET_DIGITS;
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
	/* ---------- Selection ---------- */
	/** The selection's two ends (absolute offsets, either order); a drag pulls the head
	 *  over the anchor. -1 means "not placed yet". */
	private selAnchor = -1;
	private selHead = -1;
	/** The pane the selection was made in - plain Ctrl+C copies hex from the hex pane,
	 *  text from the ASCII pane, the way hex editors' copy follows the active pane. */
	private selPane: 'hex' | 'ascii' = 'hex';
	/** A mouse drag is pulling the selection's head. */
	private dragging = false;
	/** Ends a drag wherever the mouse button comes up; removed by destroy(). */
	private onWindowMouseUp: () => void = () => undefined;
	/** Guards the inspector's async refresh against a newer caret position. */
	private inspectorToken = 0;
	private readonly inspector: HTMLElement;

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
		// The viewport wraps the scroller so the drawn scrollbar can sit on its edge without
		// riding along with the rows' horizontal overflow.
		const viewport = el('div', 'hex-viewport', [this.scroller]);
		this.header = el('div', 'hex-header-wrap');
		this.status = el('div', 'hex-status', ['Loading…']);
		this.inspector = el('div', 'hex-inspector');
		this.root = el('div', 'hex-view', [toolbar, this.header, viewport, this.inspector, this.status]);
		this.root.tabIndex = 0;
		this.scroll = new ScrollModel(20);
		this.scroll.onChange(() => this.draw());
		this.scrollbar = new Scrollbar(viewport, this.scroll);
		this.scroller.addEventListener('scroll', () => {
			// The ruler follows a horizontal scroll (a pinned row wider than the window), so
			// its digits stay over their byte columns.
			this.header.scrollLeft = this.scroller.scrollLeft;
		});
		this.wheel = attachWheel(this.scroller, this.scroll);
		this.scroller.addEventListener('mousedown', (event) => {
			if (event.button !== 0) return;
			const target = byteAtCell(event.target as HTMLElement);
			if (!target) return;
			// The cells carry the selection model; the browser's own text selection has no
			// business over them.
			event.preventDefault();
			this.dragging = true;
			if (event.shiftKey && this.selAnchor >= 0) {
				this.setSelectionHead(target.offset, target.pane);
				return;
			}
			// A collapsed anchor paints nothing, so it is set without the full repaint a
			// selection change would do - only the caret's row refreshes (placeCursor),
			// and the drag's next mousemove still finds live cells under the pointer.
			// A click that REPLACES a selection is different: the old span's rows -
			// possibly nowhere near the caret's - must drop their highlight, so that
			// change takes the full repaint.
			const hadSelection = this.hasSelection();
			const clamped = Math.max(0, Math.min(target.offset, Math.max(0, this.size - 1)));
			this.selAnchor = clamped;
			this.selHead = clamped;
			this.selPane = target.pane;
			if (hadSelection) this.repaintSelection();
			else this.updateStatus();
			this.placeCursor(clamped);
		});
		this.scroller.addEventListener('mousemove', (event) => {
			if (!this.dragging) return;
			const target = byteAtCell(event.target as HTMLElement);
			if (target) this.setSelectionHead(target.offset, target.pane);
		});
		// The drag ends wherever the button comes up - over the view or past its edge.
		this.onWindowMouseUp = () => { this.dragging = false; };
		window.addEventListener('mouseup', this.onWindowMouseUp);
		this.scroller.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.dragging = false;
			this.showContextMenu(event, byteAtCell(event.target as HTMLElement));
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
		this.wheel.dispose();
		this.scrollbar.dispose();
		window.removeEventListener('mouseup', this.onWindowMouseUp);
		this.searchToken++;
		this.slabs.clear();
		this.slabValues.clear();
		this.root.remove();
	}

	/** Loads the first slab (which also learns the file size), sizes the virtual list. */
	async load(): Promise<void> {
		const first = await this.slab(0);
		if (!first) return;
		this.offsetDigits = offsetDigitsFor(this.size);
		// The row height must be measured before rows are known; an empty probe row does it.
		const probe = hexRow(0, new Uint8Array(0), new Uint8Array(0), -1, undefined, 16, this.offsetDigits);
		this.sizer.append(probe);
		this.rowHeight = probe.getBoundingClientRect().height || 20;
		probe.remove();
		this.relayout();
	}

	/** The bytes per row that fit the scroller, measured in the row font: a row needs
	 *  rowCells() character cells, so narrower windows step down the ladder. The probe
	 *  zeroes the row's own padding — 28 zeros in the row font, nothing else. */
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
		// jsdom reports zero sizes; default to a comfortable layout rather than the narrowest.
		if (!charWidth || !this.scroller.clientWidth) return 16;
		return bytesPerRowFor(charWidth, this.scroller.clientWidth - 24, this.offsetDigits);
	}

	/** Parses an address (`0x1A0`, `1A0h`, `416`) and scrolls to that byte, flashing the
	 *  cell so the landing point is obvious in a page-full of hex. */
	private gotoAddress(text: string): void {
		const value = parseAddress(text);
		if (value === null) {
			this.status.textContent = `Not an address: ${text.trim()}`;
			return;
		}
		this.jumpTarget = Math.max(0, Math.min(value, Math.max(0, this.size - 1)));
		this.scroll.autoscroll(Math.floor(this.jumpTarget / this.bytesPerRow), 'top');
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
		const firstByte = Math.floor(this.scroll.top) * this.bytesPerRow;
		const bpr = this.pickBytesPerRow();
		if (bpr !== this.bytesPerRow) this.sizer.querySelector('.hex-body')?.remove();
		this.bytesPerRow = bpr;
		// The header follows the row width; pinned to the scroller's content width so the
		// ASCII label lines up with the rows beside (not under) the scrollbar.
		this.header.replaceChildren(hexHeader(bpr, this.offsetDigits));
		this.header.style.width = this.scroller.clientWidth ? `${this.scroller.clientWidth}px` : '';
		this.header.scrollLeft = this.scroller.scrollLeft;
		if (!this.size || !this.rowHeight) return;
		this.rows = Math.ceil(this.size / bpr);
		// The model takes the new geometry; the byte at the viewport's top stays there
		// across a row-width change.
		this.scroll.setRowHeight(this.rowHeight);
		this.scroll.setRowCount(this.rows);
		this.scroll.setViewport(this.scroller.clientHeight);
		this.scroll.setTop(Math.floor(firstByte / bpr), 'layout');
		this.draw();
		this.updateStatus();
	}

	private updateStatus(): void {
		const parts = [`${this.size.toLocaleString()} bytes  ·  ${this.rows.toLocaleString()} rows  ·  ${this.bytesPerRow} bytes/row`];
		if (this.hasSelection()) {
			const from = this.selectionStart();
			const to = this.selectionEnd();
			parts.push(tf('hex.status.selected', hexAddress(from, this.offsetDigits), hexAddress(to, this.offsetDigits), (to - from + 1).toLocaleString()));
		}
		if (this.edits.size) parts.push(`${this.edits.size.toLocaleString()} byte${this.edits.size === 1 ? '' : 's'} changed (unsaved)`);
		this.status.textContent = parts.join('  ·  ');
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
		// per scroll, whatever the file's size.
		body.style.transform = `translateY(${this.scroll.rowTop(first)}px)`;
		// Drop the rows that scrolled out, keep the ones still visible.
		for (const node of Array.from(body.children)) {
			const row = Number((node as HTMLElement).dataset.row);
			if (row < first || row > last) node.remove();
		}
		for (let row = first; row <= last; row++) {
			if (body.querySelector(`[data-row="${row}"]`)) continue;
			const placeholder = hexRow(row * this.bytesPerRow, new Uint8Array(0), new Uint8Array(0), -1, undefined, this.bytesPerRow, this.offsetDigits);
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
				const filled = hexRow(row * this.bytesPerRow, rowBytes, highlight, this.cursorIn(row * this.bytesPerRow, rowBytes.length), this.edits, this.bytesPerRow, this.offsetDigits, this.selectionRange());
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
		// The load-time probe can measure before the theme's editor font applies (a fresh
		// window's fallback font lays rows a couple of pixels shorter), and the model then
		// misplaces every row by that fraction - magnified to whole rows at a scaled
		// document's bottom. The first drawn row is the truth; a real mismatch re-lays-out
		// once, after which the model matches the layout.
		const laidRow = body.firstElementChild as HTMLElement | null;
		const laid = laidRow ? laidRow.getBoundingClientRect().height : 0;
		if (laid > 1 && Math.abs(laid - this.rowHeight) > 0.25) {
			this.rowHeight = laid;
			this.relayout();
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

	/** Scrolls the least that keeps the row holding `offset` and its margin on screen
	 *  (Zed's `Autoscroll::fit`), then redraws the row. */
	private revealByte(offset: number): void {
		if (!this.scroll.autoscroll(Math.floor(offset / this.bytesPerRow), 'fit')) this.refreshRows([offset]);
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
		this.scroll.autoscroll(Math.floor(offset / this.bytesPerRow), 'focused');
		this.updateCount();
		this.draw();
	}

	/* ---------- Selection, marking & copy ---------- */

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

	/** The selection as hexRow takes it: [start, end + 1), or undefined when nothing is. */
	private selectionRange(): [number, number] | undefined {
		return this.hasSelection() ? [this.selectionStart(), this.selectionEnd() + 1] : undefined;
	}

	/** Collapses the selection onto a byte (a click, "Mark Selection Start"): the anchor
	 *  and head both land there until something extends the head. */
	private setSelectionAnchor(offset: number, pane: 'hex' | 'ascii'): void {
		const clamped = Math.max(0, Math.min(offset, Math.max(0, this.size - 1)));
		this.selAnchor = clamped;
		this.selHead = clamped;
		this.selPane = pane;
		this.repaintSelection();
	}

	/** Moves the selection's head (a drag, Shift+click, Shift+arrows, "Mark Selection
	 *  End"), placing the anchor first when nothing was selected yet - so marking the
	 *  end before the start works too. */
	private setSelectionHead(offset: number, pane?: 'hex' | 'ascii'): void {
		if (pane) this.selPane = pane;
		const clamped = Math.max(0, Math.min(offset, Math.max(0, this.size - 1)));
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

	/** Selection (or its absence) changed: the rows repaint with it, the status bar
	 *  reports the span and the inspector follows its first byte. */
	private repaintSelection(): void {
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		this.updateStatus();
		this.updateInspector();
	}

	/** The right-click menu over a byte: Copy in every format a hex editor offers, Paste
	 *  for the clipboard's bytes, and the marking entries - Mark Start / Mark End pick a
	 *  span's two ends wherever the two clicks land, the Select Range dialog does the
	 *  same by address. */
	private showContextMenu(event: MouseEvent, target: { offset: number; pane: 'hex' | 'ascii' } | null): void {
		const selected = this.hasSelection();
		const entries: MenuEntry[] = [
			{ label: t('hex.menu.copy'), keybinding: 'Ctrl+C', disabled: !selected, run: () => void this.copySelection('smart') },
			{ label: t('hex.menu.copyHex'), disabled: !selected, run: () => void this.copySelection('hex') },
			{ label: t('hex.menu.copyText'), disabled: !selected, run: () => void this.copySelection('text') },
			{ label: t('hex.menu.copyC'), disabled: !selected, run: () => void this.copySelection('c') },
			{ label: t('hex.menu.copyBase64'), disabled: !selected, run: () => void this.copySelection('base64') },
			// The address of the right-clicked byte, or - with a selection - its start-end span.
			{ label: t('hex.menu.copyAddress'), disabled: !selected && !target, run: () => void this.copyAddress(target) },
			// Paste lands where the click was - the right-clicked byte - so a position can
			// be pasted over without walking the caret there first.
			{ label: t('hex.menu.paste'), keybinding: 'Ctrl+V', disabled: !this.editing, run: () => void this.pasteFromClipboard(target?.offset) },
			'separator',
			{ label: t('hex.menu.markStart'), disabled: !target, run: () => target && this.setSelectionAnchor(target.offset, target.pane) },
			{ label: t('hex.menu.markEnd'), disabled: !target, run: () => target && this.setSelectionHead(target.offset, target.pane) },
			{ label: t('hex.menu.selectRange'), run: () => void this.selectRange() },
			{ label: t('hex.menu.clearSelection'), disabled: !selected, run: () => this.clearSelection() },
			'separator',
			{ label: t('hex.menu.goto'), keybinding: 'Ctrl+G', run: () => { this.gotoBox.focus(); this.gotoBox.select(); } }
		];
		showContextMenu(event.clientX, event.clientY, entries);
	}

	/** The Select Range dialog: one quick input for the start address, then one for the
	 *  end - an address, or `+length` in decimal or hex. Selects [start, end] inclusive
	 *  and scrolls it into view, ready to copy. */
	private async selectRange(): Promise<void> {
		const startText = await quickInput({
			title: t('hex.range.startTitle'),
			placeholder: t('hex.range.startPlaceholder'),
			validate: (value) => (parseAddress(value) === null ? tf('hex.range.bad', value.trim()) : null)
		});
		if (startText === null) return;
		const start = Math.min(parseAddress(startText)!, Math.max(0, this.size - 1));
		const endText = await quickInput({
			title: t('hex.range.endTitle'),
			placeholder: t('hex.range.endPlaceholder'),
			validate: (value) => {
				const trimmed = value.trim();
				// `+256` / `+0x100` counts a length from the start; anything else is an address.
				// A length always fits: the end is clamped to the file's last byte.
				if (/^\+(0x[0-9a-f]+|\d+)$/i.test(trimmed)) return null;
				const end = parseAddress(trimmed);
				if (end === null) return tf('hex.range.bad', trimmed);
				return end < start ? tf('hex.range.reversed') : null;
			}
		});
		if (endText === null) return;
		const trimmed = endText.trim();
		const length = /^\+(0x[0-9a-f]+|\d+)$/i.exec(trimmed);
		const end = length
			? Math.min(start + Math.max(1, parseAddress(length[1]!)!) - 1, Math.max(0, this.size - 1))
			: Math.min(parseAddress(trimmed)!, Math.max(0, this.size - 1));
		this.selPane = 'hex';
		this.selAnchor = start;
		this.selHead = end;
		this.revealByte(start);
		this.repaintSelection();
		this.root.focus();
	}

	/** Copies the selection in one of the formats a hex editor's Copy Special offers.
	 *  'smart' honours the pane the selection was made in: hex bytes from the hex pane,
	 *  raw text from the ASCII pane. Selections past the 10 MiB limit are refused with a
	 *  reminder instead of being read. */
	async copySelection(format: CopyFormat): Promise<void> {
		if (!this.hasSelection()) return;
		const start = this.selectionStart();
		const count = this.selectionEnd() - start + 1;
		if (count > COPY_LIMIT) {
			notify('error', tf('hex.copy.tooLarge', formatBytes(count), formatBytes(COPY_LIMIT)));
			return;
		}
		const bytes = await this.readRange(start, count);
		if (!bytes) {
			notify('error', t('hex.copy.readFailed'));
			return;
		}
		let text: string;
		if (format === 'base64') text = btoa(bytesToLatin1(bytes));
		else if (format === 'c') text = Array.from(bytes, (b) => '0x' + hexByte(b)).join(', ');
		else if (format === 'text' || (format === 'smart' && this.selPane === 'ascii')) text = bytesToLatin1(bytes);
		else text = Array.from(bytes, hexByte).join('');
		try {
			await writeText(text);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		this.status.textContent = `${this.status.textContent}  ·  ${tf('hex.copy.done', text.length.toLocaleString(), t(COPY_FORMAT_KEYS[format]))}`;
	}

	/** Copies the address the right-click states: a selection's span as its start-end
	 *  addresses, or - when the click was on a lone byte with nothing selected - that
	 *  byte's address alone. */
	private async copyAddress(target: { offset: number } | null): Promise<void> {
		const text = this.hasSelection()
			? `${hexAddress(this.selectionStart(), this.offsetDigits)}-${hexAddress(this.selectionEnd(), this.offsetDigits)}`
			: target ? hexAddress(Math.min(target.offset, Math.max(0, this.size - 1)), this.offsetDigits) : null;
		if (text === null) return;
		try {
			await writeText(text);
		} catch (error) {
			notify('error', String(error));
		}
	}

	/** Paste, between instances and from anywhere: the clipboard's bytes (its hex when
	 *  it is hex pairs - this editor's own Copy Special formats - else its text, one byte
	 *  per character) are written over the file starting at `at` (the byte the menu's
	 *  Paste was clicked on), else the selection's start, else the caret - never past the
	 *  file's end. Edit mode only - pasting is a write. */
	private async pasteFromClipboard(at?: number): Promise<void> {
		let text: string;
		try {
			text = await readText();
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const bytes = parseClipboardBytes(text);
		if (!bytes) return;
		if (bytes.length > COPY_LIMIT) {
			notify('error', tf('hex.paste.tooLarge', formatBytes(bytes.length), formatBytes(COPY_LIMIT)));
			return;
		}
		const where = at ?? (this.hasSelection() ? this.selectionStart() : this.cursor);
		if (where === undefined || where < 0 || !this.size) return;
		const offset = Math.min(where, this.size - 1);
		const applied = Math.min(bytes.length, this.size - offset);
		if (applied <= 0) return;
		if (applied < bytes.length) {
			notify('warning', tf('hex.paste.truncated', applied.toLocaleString(), bytes.length.toLocaleString(), hexAddress(this.size - 1, this.offsetDigits)));
		}
		this.applyBytes(offset, bytes.subarray(0, applied));
		this.selAnchor = -1;
		this.selHead = -1;
		// The changed bytes can span every visible row, so the body is rebuilt whole (and
		// drawn before the caret lands - refreshRows skips itself when no body exists).
		this.sizer.querySelector('.hex-body')?.remove();
		this.draw();
		this.placeCursor(offset + applied);
		this.updateStatus();
	}

	/** Writes bytes over the file as edits (one undo entry per byte, the way typing
	 *  builds them); typing the on-disk byte back removes that offset's edit again. */
	private applyBytes(offset: number, values: Uint8Array): void {
		for (let i = 0; i < values.length; i++) {
			const at = offset + i;
			const value = values[i]!;
			const from = this.edits.get(at) ?? this.diskByte(at);
			if (from === value) continue;
			const created = !this.edits.has(at);
			if (value === this.diskByte(at)) this.edits.delete(at);
			else this.edits.set(at, value);
			this.undoStack.push({ offset: at, from, to: value, created });
		}
		if (this.edits.size) this.markDirty();
		else this.markClean();
	}

	/** Reads `count` bytes at `start` straight from the file - the slab cache serves
	 *  rows, not multi-megabyte clipboard payloads - with unsaved edits overlaid the
	 *  way the rows show them. */
	private async readRange(start: number, count: number): Promise<Uint8Array | null> {
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64((await invoke<FileChunk>('read_file_chunk', { path: this.path, offset: start, len: count })).base64);
		} catch {
			return null;
		}
		for (let i = 0; i < bytes.length; i++) {
			const edited = this.edits.get(start + i);
			if (edited !== undefined) bytes[i] = edited;
		}
		return bytes;
	}

	/* ---------- Data inspector ---------- */

	/** The data inspector line under the rows: the bytes at the caret (or a selection's
	 *  first byte) read as u8..u64, floats and text - the panel every professional hex
	 *  editor pins beside the bytes. */
	private updateInspector(): void {
		const at = this.hasSelection() ? this.selectionStart() : this.cursor;
		if (at < 0 || !this.size) {
			this.inspectorToken++;
			this.inspector.replaceChildren();
			return;
		}
		const clamped = Math.min(at, this.size - 1);
		const token = ++this.inspectorToken;
		void this.windowAt(clamped).then((bytes) => {
			if (token !== this.inspectorToken || !bytes.length) return;
			this.renderInspector(clamped, bytes);
		});
	}

	/** Up to 8 bytes at `offset` as the rows show them (edits overlaid), for the inspector. */
	private async windowAt(offset: number): Promise<Uint8Array> {
		const rowStart = Math.floor(offset / this.bytesPerRow) * this.bytesPerRow;
		const row = await this.rowBytes(rowStart);
		if (!row) return new Uint8Array(0);
		return this.displayBytes(row, rowStart).subarray(offset - rowStart, offset - rowStart + 8);
	}

	private renderInspector(at: number, bytes: Uint8Array): void {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const hexValue = (v: number | bigint, digits: number) => '0x' + v.toString(16).toUpperCase().padStart(digits, '0');
		const fields: [label: string, value: string][] = [
			['u8', hexValue(view.getUint8(0), 2)],
			['i8', String(view.getInt8(0))]
		];
		if (bytes.length >= 2) {
			fields.push(['u16le', hexValue(view.getUint16(0, true), 4)], ['u16be', hexValue(view.getUint16(0, false), 4)]);
		}
		if (bytes.length >= 4) {
			fields.push(['u32le', hexValue(view.getUint32(0, true), 8)], ['u32be', hexValue(view.getUint32(0, false), 8)], ['f32', String(Math.fround(view.getFloat32(0, true)))]);
		}
		if (bytes.length >= 8) {
			fields.push(['u64le', hexValue(view.getBigUint64(0, true), 16)], ['f64', String(view.getFloat64(0, true))]);
		}
		fields.push([t('hex.inspector.text'), Array.from(bytes.subarray(0, Math.min(4, bytes.length)), asciiChar).join('')]);
		const cells: (Node | string)[] = [el('span', 'hex-inspector-at', [hexAddress(at, this.offsetDigits)])];
		for (const [label, value] of fields) cells.push(el('span', 'hex-inspector-field', [el('span', 'hex-inspector-label', [label]), value]));
		this.inspector.replaceChildren(...cells);
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
			this.updateInspector();
		}
	}

	private placeCursor(offset: number): void {
		const clamped = Math.max(0, Math.min(offset, this.size - 1));
		const before = this.cursor;
		this.stagedNibble = null;
		this.cursor = clamped;
		this.revealByte(clamped);
		this.refreshRows([before, clamped]);
		this.updateInspector();
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
		// Selecting and copying bytes are read-only actions; the same keys work in both
		// modes.
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
			if (!this.size) return;
			event.preventDefault();
			this.selPane = 'hex';
			this.selAnchor = 0;
			this.selHead = this.size - 1;
			this.repaintSelection();
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
			// Nothing selected: leave the key to whatever the browser would copy.
			if (!this.hasSelection()) return;
			event.preventDefault();
			void this.copySelection('smart');
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
			// Pasting writes bytes - edit mode only, so in read-only the key is left alone.
			if (!this.editing) return;
			event.preventDefault();
			void this.pasteFromClipboard();
			return;
		}
		if (event.key === 'Escape' && this.hasSelection()) {
			event.preventDefault();
			this.clearSelection();
			return;
		}
		if (this.navigate(event)) return;
		if (!this.editing) return;
		let handled = true;
		switch (event.key) {
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
				// Typing over a selection starts at its first byte, the way a text editor's
				// typing replaces the selection.
				if (this.hasSelection()) {
					const start = this.selectionStart();
					this.selAnchor = -1;
					this.selHead = -1;
					this.repaintSelection();
					this.placeCursor(start);
				}
				this.typeNibble(parseInt(digit, 16));
			}
		}
		if (handled) event.preventDefault();
	}

	/** The arrow, Home/End and Page keys. With Shift they extend the selection from its
	 *  head; without it the caret moves (and a selection collapses onto the end it is
	 *  walked off, as text editors do). The caret walks in read-only mode too - the
	 *  inspector follows it. Returns whether the key was one of these. */
	private navigate(event: KeyboardEvent): boolean {
		// Modifier chords are the workbench's, not the caret's: Ctrl+PageUp/Down switch
		// editor tabs, Alt+ArrowLeft/Right are Go Back / Forward. Only Ctrl+Home/End stay —
		// every hex editor walks them to the file's ends.
		if (event.altKey) return false;
		const ctrl = event.ctrlKey || event.metaKey;
		if (ctrl && event.key !== 'Home' && event.key !== 'End') return false;
		const bpr = this.bytesPerRow;
		const from = Math.max(0, this.hasSelection() ? this.selHead : this.cursor);
		let target: number;
		switch (event.key) {
			case 'ArrowLeft': target = from - 1; break;
			case 'ArrowRight': target = from + 1; break;
			case 'ArrowUp': target = from - bpr; break;
			case 'ArrowDown': target = from + bpr; break;
			case 'Home': target = ctrl ? 0 : Math.floor(from / bpr) * bpr; break;
			case 'End': target = ctrl ? Math.max(0, this.size - 1) : Math.floor(from / bpr) * bpr + bpr - 1; break;
			case 'PageUp': case 'PageDown': {
				// Zed's MovePageDown: the caret walks a viewport less one row, and the reveal
				// below (fit) brings the view after it — a caret at the bottom margin pages the
				// view a full screen each press.
				const rows = this.scroll.visibleRows;
				target = from + bpr * rows * (event.key === 'PageDown' ? 1 : -1);
				break;
			}
			default: return false;
		}
		event.preventDefault();
		const clamped = Math.max(0, Math.min(target, Math.max(0, this.size - 1)));
		if (event.shiftKey) {
			// Extending with nothing selected anchors at the caret, as text editors do.
			if (!this.hasSelection() && this.selAnchor < 0) this.selAnchor = from;
			this.setSelectionHead(clamped);
			return true;
		}
		if (this.hasSelection()) {
			// Collapsing onto a selection end is not a page move: the viewport stays.
			const to = target < from ? this.selectionStart() : this.selectionEnd();
			this.selAnchor = -1;
			this.selHead = -1;
			this.placeCursor(to);
			this.repaintSelection();
			return true;
		}
		this.placeCursor(clamped);
		return true;
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
		this.applyBytes(offset, Uint8Array.of(value));
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
		this.updateInspector();
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
		this.updateInspector();
		return true;
	}

	/** Synchronously decoded slabs, so byte edits can read neighbours without a race. */
	private readonly slabValues = new Map<number, Uint8Array>();
}
