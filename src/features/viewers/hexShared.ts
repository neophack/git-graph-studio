// The vocabulary the two hex surfaces share — the single-file hex editor (hexView.ts) and
// the byte-aligned two-pane comparison (hexCompare.ts): the offset column's formatting,
// the row grid both lay their cells in, the copy formats and their 10 MiB cap, the
// 64 KiB slab paging both read through, and the row-width probes both measure with.
// A leaf: platform types only, no view imports it back.

import { t } from '../../platform/i18n';
import { el, formatBytes as formatBytesBase } from '../../platform/ui';

/** Rows are requested in slabs so scrolling doesn't fire a read per row — the paging unit
 *  both views read their bytes through. */
export const SLAB_BYTES = 64 * 1024;
/** The largest selection Copy reads at once and Paste writes at once - a clipboard
 *  payload, not a file dump; 10 MiB, and anything larger is refused with a reminder. */
export const COPY_LIMIT = 10 * 1024 * 1024;

export function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The row widths the views offer - WinHex-style, from one-word rows up to 64 bytes. */
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
 *  is: a fixed offset column ruled off by a vertical line, 3ch per byte with a dedicated
 *  1ch gap track opening every 4/8-byte group, a ruled 3ch gutter, and a compact ASCII
 *  pane of 1ch per byte. The gap is its own track rather than extra width folded into
 *  the group's first byte column - a byte cell that were widened would center its digits
 *  in the middle of that width, splitting the group gap into two smaller, uneven-looking
 *  gaps straddling the byte instead of one gap between the groups. Nothing stretches -
 *  leftover page width stays empty on the right - so the table keeps the same shape at
 *  every window size. */
export function rowGridTemplate(bytesPerRow: number, digits = OFFSET_DIGITS): string {
	const group = groupSizeFor(bytesPerRow);
	const widths = [`${digits + 2}ch`];
	for (let i = 0; i < bytesPerRow; i++) {
		if (i % group === 0 && i > 0) widths.push('1ch');
		widths.push('3ch');
	}
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
export function parseAddress(text: string): number | null {
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
		if (i % group === 0 && i > 0) cells.push(el('span', 'hex-group-gap'));
		cells.push(el('span', 'hex-cell', [(i % 16).toString(16).toUpperCase()]));
	}
	cells.push(el('span', 'hex-gutter'));
	for (let i = 0; i < bytesPerRow; i++) cells.push(el('span', 'hex-ascii-cell', [(i % 16).toString(16).toUpperCase()]));
	const header = el('div', 'hex-row hex-header', cells);
	header.style.gridTemplateColumns = rowGridTemplate(bytesPerRow, digits);
	return header;
}

/** Bytes as Latin-1 text - one code unit per byte, the way a hex editor's ASCII pane
 *  copies (no re-encoding, no lossy replacement characters). */
export function bytesToLatin1(bytes: Uint8Array): string {
	let out = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return out;
}

/** The clipboard formats Copy Special offers; the i18n key names each one for the
 *  status line's confirmation. */
export type CopyFormat = 'smart' | 'hex' | 'text' | 'c' | 'base64';
export const COPY_FORMAT_KEYS: Record<CopyFormat, Parameters<typeof t>[0]> = {
	smart: 'hex.menu.copy',
	hex: 'hex.menu.copyHex',
	text: 'hex.menu.copyText',
	c: 'hex.menu.copyC',
	base64: 'hex.menu.copyBase64'
};

/** A byte count the way the hex views' size reminders read it: whole KiB/MiB without a
 *  fraction, one decimal otherwise (the shared formatter with the hex views' spelling). */
export function formatBytes(count: number): string {
	return formatBytesBase(count, { iec: true, trim: true });
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

/** The row font's character width, measured by a hidden 28-zero probe appended to the
 *  scroller (both views' width picks run it; jsdom reports zero, the callers fall back). */
export function measureCharWidth(scroller: HTMLElement): number {
	const probe = el('span', 'hex-row');
	probe.style.visibility = 'hidden';
	probe.style.position = 'absolute';
	probe.style.padding = '0';
	probe.textContent = '0'.repeat(28);
	scroller.append(probe);
	const charWidth = probe.getBoundingClientRect().width / 28;
	probe.remove();
	return charWidth;
}

/** One row's bytes across the 64 KiB slab boundary (a row width like 24 doesn't divide
 *  it): the slab's slice, or - when the row straddles into the next slab - with that
 *  slab's head joined on, so no byte of the row is lost. `next` supplies the following
 *  slab (whichever cache or file the calling view reads through). */
export async function rowBytesAcross(offset: number, bytesPerRow: number, first: Uint8Array, next: () => Promise<Uint8Array | null>): Promise<Uint8Array> {
	const slabIndex = Math.floor(offset / SLAB_BYTES);
	const head = first.subarray(offset - slabIndex * SLAB_BYTES, offset - slabIndex * SLAB_BYTES + bytesPerRow);
	if (head.length >= bytesPerRow) return head;
	const tail = await next();
	if (!tail) return head;
	const joined = new Uint8Array(Math.min(bytesPerRow, head.length + tail.length));
	joined.set(head);
	joined.set(tail.subarray(0, joined.length - head.length), head.length);
	return joined;
}
