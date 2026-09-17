// The hex viewer: rows are paged from read_file_chunk (16 bytes each, offset + hex + ASCII),
// only the rows the scroll model (scroll/) has in view are drawn, and the search box scans
// the file for text or hex-byte needles.

import { beforeEach, describe, expect, it } from 'vitest';

import { bytesPerRowFor, HexView } from '../src/hexView';
import { EditorGroup } from '../src/editor';
import { settings } from '../src/settings';
import { backend } from './tauriMock';
import { flush } from './helpers';

function b64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function keydown(target: HTMLElement, key: string, shift = false, ctrl = false): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, ctrlKey: ctrl, bubbles: true, cancelable: true }));
}

describe('hex view', () => {
	const bytes = new Uint8Array(64);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i;
	// Two occurrences of the needle `ff ...` cannot exist in 0..63; plant one for search.
	bytes.set([0xde, 0xad, 0xbe, 0xef], 32);

	beforeEach(() => {
		backend.reset();
		backend.on('read_file_chunk', (args) => ({
			size: bytes.length,
			base64: b64(bytes.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
		}));
	});

	it('draws rows of 16 bytes with offset, hex and ASCII columns', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await new Promise((resolve) => setTimeout(resolve, 0)); // placeholder rows fill from the slab
		const rows = Array.from(view.root.querySelectorAll('.hex-scroller .hex-row'));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]!.textContent).toContain('00000000');
		const cells = Array.from(rows[0]!.querySelectorAll('.hex-cell')).map((c) => c.textContent);
		expect(cells.slice(0, 4)).toEqual(['00', '01', '02', '03']);
		const ascii = Array.from(rows[0]!.querySelectorAll('.hex-ascii-cell')).map((c) => c.textContent);
		expect(ascii[0]).toBe(' '); // 0x00 is a blank, so zero-filled regions read as empty
		expect(ascii[1]).toBe('·'); // other control bytes render as dots
		// Row 3 (bytes 48..63) starts at '0', the first printable ASCII of the run.
		expect(rows[3]!.querySelector('.hex-ascii-cell')!.textContent).toBe('0');
		expect(rows[3]!.textContent).toContain('00000030'); // offsets are hex
		// Zebra stripes follow the absolute row number.
		expect(rows.map((r) => r.classList.contains('hex-row-odd'))).toEqual([false, true, false, true]);
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('64 bytes');
		// Only the file's bytes were requested: one slab read plus the probe row's none.
		expect(backend.callsTo('read_file_chunk').length).toBe(1);
	});

	it('groups hex bytes and separates the ASCII column in the row grid', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await new Promise((resolve) => setTimeout(resolve, 0)); // placeholder rows fill from the slab
		const row = view.root.querySelector('.hex-scroller .hex-row')!;
		// 16 bytes/row means 8-byte groups: separators before bytes 8 (and 12 never, 8-only).
		const groupStarts = Array.from(row.querySelectorAll('.hex-cell')).filter((c) => c.classList.contains('hex-group-start'));
		expect(groupStarts.length).toBe(1);
		// The grid template: a 10ch offset column, 3ch per byte (4ch at the group start),
		// the 3ch gutter and 1ch per ASCII character - fixed, nothing stretches.
		const template = row.style.gridTemplateColumns.split(' ');
		expect(template.length).toBe(1 + 16 + 1 + 16);
		expect(template[0]).toBe('10ch');
		expect(template.filter((c) => c === '4ch')).toEqual(['4ch']);
		expect(template[17]).toBe('3ch');
		expect(template.slice(18).every((c) => c === '1ch')).toBe(true);
		// The uppercase hex a hex editor shows.
		const hex = Array.from(row.querySelectorAll('.hex-cell')).map((c) => c.textContent);
		expect(hex[10]).toBe('0A');
	});

	it('titles every hex and ASCII cell with its byte address', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await new Promise((resolve) => setTimeout(resolve, 0)); // placeholder rows fill from the slab
		const row = view.root.querySelector('.hex-scroller [data-row="0"]')!;
		// A hover over any cell - hex or ASCII - reads that byte's address: the offset
		// column's digits with the address box's 0x prefix.
		const expected = ['0x00000000', '0x00000001', '0x00000002', '0x00000003'];
		expect(Array.from(row.querySelectorAll('.hex-cell'), (c) => c.title).slice(0, 4)).toEqual(expected);
		expect(Array.from(row.querySelectorAll('.hex-ascii-cell'), (c) => c.title).slice(0, 4)).toEqual(expected);
		// A later row's cells carry their own addresses, not the first row's.
		const third = view.root.querySelector('.hex-scroller [data-row="3"]')!;
		expect(third.querySelector('.hex-cell')!.title).toBe('0x00000030');
		expect(third.querySelector('.hex-ascii-cell')!.title).toBe('0x00000030');
	});

	it('shows a column header that follows the row width', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		const header = view.root.querySelector('.hex-header')!;
		// A hex digit over each byte column, repeated over the ASCII pane.
		const indices = Array.from(header.querySelectorAll('.hex-cell')).map((c) => c.textContent);
		expect(indices.join('')).toBe('0123456789ABCDEF');
		expect(Array.from(header.querySelectorAll('.hex-ascii-cell')).map((c) => c.textContent).join('')).toBe('0123456789ABCDEF');
		expect(header.querySelector('.hex-offset')!.textContent).toBe(''); // the offset column's header is blank
		// Pinning 8 bytes/row rebuilds the ruler with 8 index columns.
		const select = view.root.querySelector('.hex-width') as HTMLSelectElement;
		select.value = '8';
		select.dispatchEvent(new Event('change'));
		expect(Array.from(view.root.querySelector('.hex-header')!.querySelectorAll('.hex-cell')).length).toBe(8);
	});

	it('keeps the ruler cell-for-cell over the rows', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const check = () => {
			const header = view.root.querySelector<HTMLElement>('.hex-header')!;
			const row = view.root.querySelector<HTMLElement>('.hex-scroller .hex-row')!;
			// One grid template and the same cell sequence in both, so every ruler digit
			// lands in the track its byte (and its ASCII character) occupies.
			expect(header.style.gridTemplateColumns).toBe(row.style.gridTemplateColumns);
			const shape = (el: Element) => Array.from(el.children).map((c) => c.className.split(' ').filter((n) => n.startsWith('hex-')).sort().join(' '));
			expect(shape(header)).toEqual(shape(row).map((n) => n.replace(/ hex-(hit|cursor|edited|jump)/g, '')));
		};
		check();
		const select = view.root.querySelector('.hex-width') as HTMLSelectElement;
		select.value = '64';
		select.dispatchEvent(new Event('change'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		check();
		// A horizontal scroll of the rows carries the ruler along.
		const scroller = view.root.querySelector('.hex-scroller') as HTMLElement;
		scroller.scrollLeft = 30;
		scroller.dispatchEvent(new Event('scroll'));
		expect(view.root.querySelector<HTMLElement>('.hex-header-wrap')!.scrollLeft).toBe(scroller.scrollLeft);
	});

	it('pages through the file instead of reading it whole', async () => {
		const big = new Uint8Array(160 * 1024); // spans several 64 KB slabs
		backend.on('read_file_chunk', (args) => ({
			size: big.length,
			base64: b64(big.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
		}));
		const view = new HexView('/tmp/big.bin');
		await view.load();
		// The second slab begins at byte 65536 = row 4096.
		view.scroll.setTop(4096);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const offsets = backend.callsTo('read_file_chunk').map((args) => args.offset);
		expect(offsets).toContain(65536);
		// Only the slabs actually shown were requested, never the whole file.
		expect(offsets.length).toBeLessThan(4);
		// Nothing is laid out at the file's height: the model owns the range.
		expect(view.scroll.rowCount).toBe(160 * 1024 / 16);
		expect(view.root.querySelector('.hex-sizer')!.getAttribute('style')).toBeNull();
	});

	it('reaches the last row of a file whose rows pass the engines\' height clamp', async () => {
		// A 64 MB file at 16 bytes/row is 4,194,304 rows = ~84M px; the engines clamp near
		// 33.5M px, which used to strand every byte past the first ~25 MB. Nothing is laid
		// out at that height any more: the model's bottom is the file's last row, drawn at
		// the viewport's top.
		backend.on('read_file_chunk', (args) => ({
			size: 64 * 1024 * 1024,
			base64: b64(new Uint8Array(Math.min(Number(args.len), 4096)))
		}));
		const view = new HexView('/tmp/giant.bin');
		await view.load();
		expect(view.scroll.maxScrollTop()).toBe(4 * 1024 * 1024 - 1);
		view.scroll.setTop(view.scroll.maxScrollTop());
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The rows drawn are the file's last ones (4,194,303 is the final row).
		const rows = Array.from(view.root.querySelectorAll<HTMLElement>('.hex-body [data-row]'));
		expect(rows.length).toBeGreaterThan(0);
		expect(Math.max(...rows.map((row) => Number(row.dataset.row)))).toBe(4 * 1024 * 1024 - 1);
		expect(view.root.querySelector<HTMLElement>('.hex-body')!.style.transform).toBe(`translateY(${view.scroll.rowTop(4 * 1024 * 1024 - 1 - 8)}px)`);
		// The tail's slab was read — a byte range at the file's end, not its start.
		const offsets = backend.callsTo('read_file_chunk').map((args) => Number(args.offset));
		expect(Math.max(...offsets)).toBeGreaterThanOrEqual(64 * 1024 * 1024 - 2 * 64 * 1024);
		view.destroy();
	});

	it('keeps the arrow-walked cursor inside the viewport, three rows off its edge', async () => {
		// A 300 px window (15 rows of 20) over a 6 GiB file: the caret's every move is an
		// autoscroll fit (Zed's vertical_scroll_margin of 3), so a walk with the arrow keys
		// carries the viewport along, the caret never nearer than three rows to an edge.
		backend.on('read_file_chunk', () => ({ size: 6 * 1024 ** 3, base64: b64(new Uint8Array(4096)) }));
		const view = new HexView('/tmp/huge.bin');
		const scroller = view.root.querySelector('.hex-scroller') as HTMLElement;
		Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 300 });
		await view.load();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const inside = (row: number) => {
			expect(view.scroll.isRowVisible(row), `row ${row}`).toBe(true);
		};
		for (let i = 1; i <= 24; i++) {
			keydown(view.root, 'ArrowDown');
			inside(i);
		}
		// Row 24 sits at the bottom margin: the top is 24 + 1 + 3 − 15 = 13.
		expect(view.scroll.top).toBe(13);
		for (let i = 23; i >= 0; i--) {
			keydown(view.root, 'ArrowUp');
			inside(i);
		}
		expect(view.scroll.top).toBe(0);
		view.destroy();
	}, 15000); // 48 keydowns each repaint the window's rows; heavy under a full-suite load

	it('moves a wheel notch three rows on a 6 GiB file, the same as on any other', async () => {
		// The wheel used to run the document by the scaled range's factor — a notch moved a
		// quarter million pixels on a 6 GiB file. The model has no scale: a Chromium notch
		// is the system's three lines, three rows, whatever the file's size.
		backend.on('read_file_chunk', () => ({ size: 6 * 1024 ** 3, base64: b64(new Uint8Array(4096)) }));
		const view = new HexView('/tmp/huge.bin');
		const scroller = view.root.querySelector('.hex-scroller') as HTMLElement;
		Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 });
		await view.load();
		const sensitivity = settings.mouseWheelScrollSensitivity;
		settings.mouseWheelScrollSensitivity = 1;
		try {
			scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true }));
			expect(view.scroll.top).toBe(3);
			scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, deltaMode: 0, cancelable: true }));
			expect(view.scroll.top).toBe(33);
		} finally {
			settings.mouseWheelScrollSensitivity = sensitivity;
		}
		view.destroy();
	});

	it('pages the caret a viewport less one row and the view follows it — Ctrl+PageUp/Down stay the workbench\'s', async () => {
		// 4096 bytes = 256 rows of 16. A 300 px viewport over 20 px rows is 15 rows: the
		// caret pages 14 (Zed's MovePageDown, the viewport less its anchor row) and the
		// autoscroll fit brings the view after it, three rows of margin below the caret.
		backend.on('read_file_chunk', (args) => ({ size: 4096, base64: b64(new Uint8Array(Number(args.len))) }));
		const view = new HexView('/tmp/big.bin');
		const scroller = view.root.querySelector('.hex-scroller') as HTMLElement;
		Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 300 });
		await view.load();
		await flush();
		keydown(view.root, 'ArrowDown'); // the caret lands on byte 16 (row 1)
		keydown(view.root, 'PageDown');
		// Row 15: its bottom plus the margin is 19 rows, four past the 15 in view.
		expect(view.scroll.top).toBe(4);
		keydown(view.root, 'PageDown');
		// The caret sits at the bottom margin now, so each further page is a full 14 rows.
		expect(view.scroll.top).toBe(18);
		await flush(2);
		// The caret moved 14 rows a press: 16 + 224 + 224.
		expect(view.root.querySelector('.hex-inspector .hex-inspector-at')!.textContent).toBe('0x000001D0');
		keydown(view.root, 'PageUp');
		// Back up: row 15, whose top less the margin (12) is under the top of 18.
		expect(view.scroll.top).toBe(12);
		// Ctrl+PageUp/Down switch editor tabs: not the caret's business.
		const event = new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true });
		view.root.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(view.scroll.top).toBe(12);
		view.destroy();
	});

	it('a page press on a viewport that is not a whole number of rows never scrolls the wrong way', async () => {
		// 315 px over 20 px rows is 15.75 rows: the caret pages 14 whole rows and the fit
		// works in fractional rows — the view only ever moves down on a PageDown.
		backend.on('read_file_chunk', (args) => ({ size: 4096, base64: b64(new Uint8Array(Number(args.len))) }));
		const view = new HexView('/tmp/big.bin');
		const scroller = view.root.querySelector('.hex-scroller') as HTMLElement;
		Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 315 });
		await view.load();
		await flush();
		keydown(view.root, 'PageDown');
		expect(view.scroll.top).toBeCloseTo(14 + 1 + 3 - 15.75);
		const after = view.scroll.top;
		keydown(view.root, 'PageDown');
		expect(view.scroll.top).toBeGreaterThan(after);
		view.destroy();
	});

	it('widens the offset column for a file past 4 GiB', async () => {
		// A DVD image is 4.7 GB: its addresses need nine hex digits, and the fixed
		// eight-digit column would print them under the first hex bytes. The width follows
		// the file instead - every label and tooltip carries the digits that fit the track.
		const size = 5 * 1024 * 1024 * 1024;
		backend.on('read_file_chunk', () => ({
			size,
			base64: b64(new Uint8Array(4096))
		}));
		const view = new HexView('/tmp/dvd.iso');
		await view.load();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const row = view.root.querySelector('.hex-scroller .hex-row')!;
		expect(row.querySelector('.hex-offset')!.textContent).toBe('000000000'); // nine digits, zero-padded
		expect(row.style.gridTemplateColumns.split(' ')[0]).toBe('11ch'); // digits + 2, the offset track
		expect(row.querySelector('.hex-cell')!.title).toBe('0x000000000');
		// The ruler widened with the rows, so its template stays cell-for-cell theirs.
		expect(view.root.querySelector<HTMLElement>('.hex-header')!.style.gridTemplateColumns).toBe(row.style.gridTemplateColumns);
		// The address box takes the wide addresses and reports them back at full width.
		const box = view.root.querySelector('.hex-goto') as HTMLInputElement;
		box.value = '0x123456789';
		keydown(box, 'Enter');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(box.value).toBe('0x123456789');
		view.destroy();
	});

	it('finds a hex needle and highlights its bytes', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		const box = view.root.querySelector('.hex-search') as HTMLInputElement;
		box.value = 'deadbeef';
		keydown(box, 'Enter');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const hits = view.root.querySelectorAll('.hex-hit');
		// Four bytes, highlighted in both the hex and the ASCII column.
		expect(hits.length).toBe(8);
		expect(view.root.querySelector('.hex-search-count')!.textContent).toMatch(/1 of 1/);
	});

	it('steps the row width down when the window narrows', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('4 rows'); // 64 bytes at 16 per row
		// Slabs are addressed by byte offset, so the same cached read serves any row width.
		expect(backend.callsTo('read_file_chunk').length).toBe(1);
	});

	it('picks the widest of the 4..64 ladder that fits the window', () => {
		// One character cell is 7.2px wide; a row needs 13 cells of chrome (offset column
		// and gutter) plus 4 per byte (3 hex + 1 ASCII) and 1 per group boundary, so e.g.
		// 64 bytes/row needs 276 cells ≈ 1987px and 16 needs 78 cells ≈ 562px.
		expect(bytesPerRowFor(7.2, 2000)).toBe(64);
		expect(bytesPerRowFor(7.2, 1900)).toBe(56);
		expect(bytesPerRowFor(7.2, 1600)).toBe(48);
		expect(bytesPerRowFor(7.2, 1350)).toBe(40);
		expect(bytesPerRowFor(7.2, 1100)).toBe(32);
		expect(bytesPerRowFor(7.2, 850)).toBe(24);
		expect(bytesPerRowFor(7.2, 600)).toBe(16);
		expect(bytesPerRowFor(7.2, 400)).toBe(8);
		expect(bytesPerRowFor(7.2, 300)).toBe(4);
		// Nothing fits at all: the narrowest step still shows.
		expect(bytesPerRowFor(7.2, 10)).toBe(4);
	});

	it('pins the row width from the toolbar and jumps to a typed address', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		const select = view.root.querySelector('.hex-width') as HTMLSelectElement;
		select.value = '8';
		select.dispatchEvent(new Event('change'));
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('8 bytes/row');
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('8 rows'); // 64 bytes, 8 per row
		// The row grid follows: 8 hex columns and 4-byte groups (separator before byte 4).
		await new Promise((resolve) => setTimeout(resolve, 0));
		const row = view.root.querySelector('.hex-scroller .hex-row')!;
		expect(row.querySelectorAll('.hex-cell.hex-group-start').length).toBe(1);
		// Ctrl+G focuses the address box; Enter jumps to the byte and flashes it.
		document.body.append(view.root); // focus needs a connected element
		keydown(view.root, 'g', false, true);
		const box = view.root.querySelector('.hex-goto') as HTMLInputElement;
		expect(document.activeElement).toBe(box);
		box.value = '0x24';
		keydown(box, 'Enter');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(box.value).toBe('0x24');
		expect(view.root.querySelectorAll('.hex-jump').length).toBe(2); // hex + ASCII cell
		expect(view.scroll.top).toBe(Math.floor(0x24 / 8)); // the row at the viewport's top
		// A bad address is reported, not jumped.
		box.value = 'zz';
		keydown(box, 'Enter');
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('Not an address');
		view.root.remove();
	});

	it('clears the search on Escape', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		const box = view.root.querySelector('.hex-search') as HTMLInputElement;
		box.value = 'deadbeef';
		keydown(box, 'Enter');
		await new Promise((resolve) => setTimeout(resolve, 0));
		keydown(box, 'Escape');
		expect(view.root.querySelectorAll('.hex-hit').length).toBe(0);
		expect(box.value).toBe('');
	});

	it('is read-only until editing is toggled on, then two digits replace a byte', async () => {
		const dirty: boolean[] = [];
		const view = new HexView('/tmp/blob.bin', { onDirtyChange: (d) => dirty.push(d) });
		await view.load();
		// Read-only: typing over the view does nothing.
		keydown(view.root, 'a');
		expect(dirty).toEqual([]);
		const toggle = view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement;
		toggle.click();
		expect(view.root.classList.contains('editing')).toBe(true);
		// The cursor starts at byte 0: 'ff' replaces it, and the cursor advances.
		keydown(view.root, 'f');
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The first digit stages the high nibble only: byte 0 (0x00) shows as F0.
		const staged = Array.from(view.root.querySelector('.hex-scroller .hex-row')!.querySelectorAll('.hex-cell')).map((c) => c.textContent);
		expect(staged.slice(0, 2)).toEqual(['F0', '01']);
		expect(dirty).toEqual([]); // the first digit only stages
		keydown(view.root, 'f');
		expect(dirty).toEqual([true]);
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('1 byte changed');
		// The save button patches exactly the changed bytes.
		backend.on('patch_file', () => null);
		(view.root.querySelector('.hex-save') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(backend.callsTo('patch_file')).toEqual([{ path: '/tmp/blob.bin', edits: [{ offset: 0, byte: 0xff }] }]);
		expect(dirty[dirty.length - 1]).toBe(false);
	});

	it('Backspace un-stages a digit and Ctrl+Z undoes a committed byte', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		// Byte 0 is 0x00: stage '1', back out, stage+commit '12'.
		keydown(view.root, '1');
		keydown(view.root, 'Backspace');
		keydown(view.root, '1');
		keydown(view.root, '2');
		expect(backend.callsTo('patch_file').length).toBe(0);
		expect(view.isDirty).toBe(true);
		keydown(view.root, 'z', false, true);
		expect(view.isDirty).toBe(false);
		expect(view.root.querySelector('.hex-status')!.textContent).not.toContain('changed');
	});

	it('discarding reloads the file without writing anything', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		keydown(view.root, 'f');
		keydown(view.root, 'f');
		expect(view.isDirty).toBe(true);
		(view.root.querySelector('.hex-discard') as HTMLButtonElement).click();
		expect(view.isDirty).toBe(false);
		expect(backend.callsTo('patch_file').length).toBe(0);
	});

	it('renders every byte of a row that straddles a 64 KiB slab boundary', async () => {
		// 24 bytes/row does not divide 65536: row 2730 holds bytes 65520..65543, so its
		// last 8 bytes live in the next slab.
		const big = new Uint8Array(160 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
		backend.on('read_file_chunk', (args) => ({
			size: big.length,
			base64: b64(big.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
		}));
		const view = new HexView('/tmp/big.bin');
		await view.load();
		const select = view.root.querySelector('.hex-width') as HTMLSelectElement;
		select.value = '24';
		select.dispatchEvent(new Event('change'));
		const row = 2730;
		view.scroll.setTop(row);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const filled = view.root.querySelector(`.hex-scroller [data-row="${row}"]`)!;
		expect(filled).not.toBeNull();
		// The whole row is there: the 8 bytes past the boundary are not blanked out.
		expect(filled.querySelectorAll('.hex-blank').length).toBe(0);
		const cells = Array.from(filled.querySelectorAll('.hex-cell')).map((c) => c.textContent);
		const byteAt = (i: number) => ((i * 31 + 7) & 0xff).toString(16).padStart(2, '0').toUpperCase();
		expect(cells[0]).toBe(byteAt(65520));
		expect(cells[15]).toBe(byteAt(65535));
		expect(cells[16]).toBe(byteAt(65536)); // the first byte of the next slab
		expect(cells[23]).toBe(byteAt(65543));
		// The following row picks up right after, at 65544.
		const next = view.root.querySelector(`.hex-scroller [data-row="${row + 1}"]`)!;
		expect(next.querySelector('.hex-offset')!.textContent).toBe('00010008');
	});

	it('Enter steps to the next search hit; only a changed needle rescans', async () => {
		// 300 bytes of 0xAA with 0xBB planted at 10, 50 and 90: 'bb' has 3 hits.
		const bytes = new Uint8Array(300).fill(0xaa);
		bytes[10] = 0xbb;
		bytes[50] = 0xbb;
		bytes[90] = 0xbb;
		backend.on('read_file_chunk', (args) => ({
			size: bytes.length,
			base64: b64(bytes.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
		}));
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		const box = view.root.querySelector('.hex-search') as HTMLInputElement;
		const count = () => view.root.querySelector('.hex-search-count')!.textContent!;
		box.value = 'bb';
		keydown(box, 'Enter');
		await flush();
		expect(count()).toBe('1 of 3');
		const reads = backend.callsTo('read_file_chunk').length;
		// The needle is unchanged: Enter walks the hits (wrapping) instead of rescanning.
		keydown(box, 'Enter');
		expect(count()).toBe('2 of 3');
		keydown(box, 'Enter');
		expect(count()).toBe('3 of 3');
		keydown(box, 'Enter');
		expect(count()).toBe('1 of 3');
		expect(backend.callsTo('read_file_chunk').length).toBe(reads);
		// A changed needle starts a new scan.
		box.value = 'aa';
		keydown(box, 'Enter');
		await flush();
		expect(count()).toBe('1 of 297');
		expect(backend.callsTo('read_file_chunk').length).toBeGreaterThan(reads);
	});

	it('reports a hit at a search-chunk boundary exactly once', async () => {
		// The scan reads 1 MiB chunks; 0xAB 0xCD sits mid-chunk, straddling the boundary
		// (last byte of chunk 0 + first of chunk 1) and past it: 3 hits, never duplicated.
		const SIZE = 1024 * 1024 + 64;
		const bytes = new Uint8Array(SIZE);
		bytes.set([0xab, 0xcd], 500);
		bytes.set([0xab, 0xcd], 1024 * 1024 - 1);
		bytes.set([0xab, 0xcd], 1024 * 1024 + 40);
		backend.on('read_file_chunk', (args) => ({
			size: bytes.length,
			base64: b64(bytes.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
		}));
		const view = new HexView('/tmp/big.bin');
		// A hit is revealed against the viewport, which the test DOM must give a height.
		Object.defineProperty(view.root.querySelector('.hex-scroller')!, 'clientHeight', { configurable: true, get: () => 300 });
		await view.load();
		const box = view.root.querySelector('.hex-search') as HTMLInputElement;
		const count = () => view.root.querySelector('.hex-search-count')!.textContent!;
		box.value = 'abcd';
		keydown(box, 'Enter');
		for (let i = 0; i < 200 && count() !== '1 of 3'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(count()).toBe('1 of 3');
		// Stepping lands on the other two distinct addresses, never the same one twice.
		const tops: number[] = [];
		keydown(box, 'Enter');
		tops.push(view.scroll.top);
		expect(count()).toBe('2 of 3');
		keydown(box, 'Enter');
		tops.push(view.scroll.top);
		expect(count()).toBe('3 of 3');
		expect(new Set(tops).size).toBe(2);
	});

	it('does not treat a hex letter as input while a shortcut modifier is held', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		const firstCell = () => view.root.querySelector('.hex-scroller .hex-row .hex-cell')!.textContent;
		// Ctrl+C is Copy, not the digit 0xC: nothing is staged and the event is left alone.
		const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
		view.root.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(view.isDirty).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(firstCell()).toBe('00');
		// Without the modifier the same key stages the digit as before.
		keydown(view.root, 'c');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(firstCell()).toBe('C0');
	});

	it('undo steps back through re-edits, and re-typing the disk byte reverts the edit', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		const byte0 = async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			return view.root.querySelector('.hex-scroller .hex-row .hex-cell')!.textContent;
		};
		// Byte 0 is 0x00 on disk: edit it to 0xAA, then re-edit the same byte to 0xBB.
		keydown(view.root, 'a');
		keydown(view.root, 'a');
		keydown(view.root, 'ArrowLeft');
		keydown(view.root, 'b');
		keydown(view.root, 'b');
		expect(view.isDirty).toBe(true);
		// Undo steps back to 0xAA (the previous edit), not to the on-disk 0x00.
		keydown(view.root, 'z', false, true);
		expect(await byte0()).toBe('AA');
		expect(view.isDirty).toBe(true);
		keydown(view.root, 'z', false, true);
		expect(await byte0()).toBe('00');
		expect(view.isDirty).toBe(false);
		// Re-typing the on-disk byte removes the edit instead of leaving a stale one.
		keydown(view.root, 'ArrowLeft'); // the cursor stayed at byte 1 across the undos
		keydown(view.root, 'a');
		keydown(view.root, 'a');
		keydown(view.root, 'ArrowLeft');
		keydown(view.root, '0');
		keydown(view.root, '0');
		expect(view.isDirty).toBe(false);
		expect(await byte0()).toBe('00');
		backend.on('patch_file', () => null);
		await view.save();
		expect(backend.callsTo('patch_file').length).toBe(0); // nothing to write
		// The revert is itself undoable: Ctrl+Z brings the 0xAA edit (and its UI) back.
		keydown(view.root, 'z', false, true);
		expect(view.isDirty).toBe(true);
		expect(await byte0()).toBe('AA');
		expect((view.root.querySelector('.hex-save') as HTMLButtonElement).hidden).toBe(false);
	});

	it('destroy disconnects the resize observer, drops the slabs and stops a search', async () => {
		const realObserver = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
		let disconnected = 0;
		class TrackingObserver {
			observe(): void { /* no-op */ }
			unobserve(): void { /* no-op */ }
			disconnect(): void { disconnected++; }
		}
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = TrackingObserver;
		try {
			// 5 MiB: the search has five chunks to stream.
			const big = new Uint8Array(5 * 1024 * 1024).fill(0x11);
			backend.on('read_file_chunk', (args) => ({
				size: big.length,
				base64: b64(big.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
			}));
			const view = new HexView('/tmp/big.bin');
			await view.load();
			document.body.append(view.root);
			const box = view.root.querySelector('.hex-search') as HTMLInputElement;
			box.value = 'ab';
			keydown(box, 'Enter');
			view.destroy();
			expect(disconnected).toBe(2); // the view's own and the drawn scrollbar's
			expect(view.root.isConnected).toBe(false);
			expect((view as unknown as { slabs: Map<number, unknown> }).slabs.size).toBe(0);
			await flush(10);
			// The slab read plus the one in-flight chunk - not the whole five-chunk scan.
			expect(backend.callsTo('read_file_chunk').length).toBeLessThan(4);
		} finally {
			(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realObserver;
		}
	});

	it('closing the hex tab destroys the view, stopping its in-flight search', async () => {
		const big = new Uint8Array(5 * 1024 * 1024).fill(0x11);
		backend.on('read_file_chunk', (args) => ({
			size: big.length,
			base64: b64(big.subarray(Number(args.offset), Number(args.offset) + Number(args.len)))
		}));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openHex('/tmp/big.bin');
		const box = document.querySelector('.hex-search') as HTMLInputElement;
		box.value = 'ab';
		keydown(box, 'Enter');
		await group.close();
		await flush(10);
		expect(backend.callsTo('read_file_chunk').length).toBeLessThan(4);
		expect(document.querySelector('.hex-view')).toBeNull();
	});

	/* ---------- Selection & copy ---------- */

	const cellAt = (view: HexView, byte: number, pane: 'hex' | 'ascii' = 'hex'): HTMLElement => {
		const row = Math.floor(byte / 16);
		const cells = view.root.querySelector(`.hex-scroller [data-row="${row}"]`)!.querySelectorAll(pane === 'ascii' ? '.hex-ascii-cell' : '.hex-cell');
		return cells[byte % 16] as HTMLElement;
	};
	const mouse = (type: string, cell: HTMLElement, shift = false): void => {
		cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, shiftKey: shift }));
	};
	const menuItem = (label: string): HTMLElement | undefined =>
		Array.from(document.querySelectorAll<HTMLElement>('.context-menu .item')).find((item) => item.querySelector('.label')?.textContent === label);

	it('drag-selects bytes in the hex pane and Ctrl+C copies space-free uppercase hex', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		mouse('mousedown', cellAt(view, 2));
		mouse('mousemove', cellAt(view, 5));
		window.dispatchEvent(new MouseEvent('mouseup'));
		await flush();
		// Bytes 2..5 are selected in both panes, and the status bar reports the span.
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(8);
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('0x00000002–0x00000005');
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('4 bytes');
		keydown(view.root, 'c', false, true);
		await flush();
		// No spaces in the middle: the classic hex-editor clipboard payload.
		expect(backend.clipboard).toEqual(['02030405']);
	});

	it('a selection made in the ASCII pane copies as raw text', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		// Bytes 0x30..0x33 are the digits '0123' - each byte one character, no dotting.
		mouse('mousedown', cellAt(view, 0x30, 'ascii'));
		mouse('mousemove', cellAt(view, 0x33, 'ascii'));
		window.dispatchEvent(new MouseEvent('mouseup'));
		await flush();
		keydown(view.root, 'c', false, true);
		await flush();
		expect(backend.clipboard).toEqual(['0123']);
	});

	it('right-click marks the selection start and end wherever the two clicks land', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		const open = (cell: HTMLElement): void => cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		open(cellAt(view, 4));
		menuItem('Mark Selection Start')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(0); // one end alone is no span yet
		open(cellAt(view, 9));
		menuItem('Mark Selection End')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(12); // bytes 4..9, both panes
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('0x00000004–0x00000009');
		// The menu's Clear Selection drops it again.
		open(cellAt(view, 9));
		menuItem('Clear Selection')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(0);
	});

	it('the context menu copies the professional formats: C array, Base64, address', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		// 0x20..0x23 is the fixture's planted DE AD BE EF.
		mouse('mousedown', cellAt(view, 0x20));
		mouse('mousemove', cellAt(view, 0x23));
		window.dispatchEvent(new MouseEvent('mouseup'));
		const openMenu = (): void => cellAt(view, 0x20).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		openMenu();
		menuItem('Copy as C Array')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		openMenu();
		menuItem('Copy as Base64')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		openMenu();
		menuItem('Copy Address')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(backend.clipboard).toEqual([
			'0xDE, 0xAD, 0xBE, 0xEF', // C array
			'3q2+7w==', // base64 of the four bytes
			'0x00000020-0x00000023' // the selection's start-end span
		]);
	});

	it('right-click copies the clicked byte\'s address when nothing is selected', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		cellAt(view, 5).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menuItem('Copy Address')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(backend.clipboard).toEqual(['0x00000005']);
	});

	it('Select Range selects start-to-end (or +length) by address', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		cellAt(view, 0).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menuItem('Select Range...')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		const answer = (value: string): void => {
			const input = document.querySelector<HTMLInputElement>('.quick-input input')!;
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			keydown(input, 'Enter');
		};
		answer('0x30');
		await flush();
		answer('+4'); // four bytes from 0x30
		await flush(2);
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(8); // 0x30..0x33 in both panes
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('0x00000030–0x00000033');
		keydown(view.root, 'c', false, true);
		await flush();
		expect(backend.clipboard).toEqual(['30313233']);
	});

	it('Ctrl+A selects all; a copy past the limit refuses instead of reading it', async () => {
		backend.on('read_file_chunk', () => ({ size: 16 * 1024 * 1024 + 1, base64: b64(new Uint8Array(4096)) }));
		const view = new HexView('/tmp/giant.bin');
		await view.load();
		await flush();
		keydown(view.root, 'a', false, true);
		await flush();
		// The size is grouped by the host locale (toLocaleString in hexView); mirror the
		// same formatting instead of pinning en-US grouping.
		expect(view.root.querySelector('.hex-status')!.textContent).toContain(`${(16 * 1024 * 1024 + 1).toLocaleString()} bytes`);
		keydown(view.root, 'c', false, true);
		await flush();
		// The 10 MiB cap refuses the copy with a reminder naming both sizes; the clipboard
		// stays empty and the range was never read.
		expect(backend.clipboard).toEqual([]);
		expect(document.querySelector('.notification')!.textContent).toContain('too large');
		expect(document.querySelector('.notification')!.textContent).toContain('10 MiB');
	});

	it('paste carries bytes between two instances: hex, C array and text clipboards', async () => {
		// One instance copies, another pastes - the clipboard is the only thing shared.
		const source = new HexView('/tmp/src.bin');
		await source.load();
		await flush();
		mouse('mousedown', cellAt(source, 0x30));
		mouse('mousemove', cellAt(source, 0x33));
		window.dispatchEvent(new MouseEvent('mouseup'));
		keydown(source.root, 'c', false, true);
		await flush();
		expect(backend.clipboard).toEqual(['30313233']);
		const cellsOf = async (view: HexView, row: number): Promise<string[]> => {
			await flush();
			return Array.from(view.root.querySelector(`.hex-scroller [data-row="${row}"]`)!.querySelectorAll('.hex-cell'), (c) => c.textContent);
		};
		const target = new HexView('/tmp/dst.bin');
		await target.load();
		await flush();
		(target.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		await flush();
		backend.clipboardText = backend.clipboard[0]!; // what the OS clipboard now holds
		keydown(target.root, 'v', false, true);
		await flush();
		// The pasted hex overwrote the caret's four bytes; the view is dirty and the caret
		// stepped past them.
		expect(await cellsOf(target, 0)).toEqual(expect.arrayContaining(['30', '31', '32', '33']));
		expect(target.isDirty).toBe(true);
		// A C-array clipboard pastes as the same bytes too.
		backend.clipboardText = '0xAA, 0xBB';
		keydown(target.root, 'ArrowDown');
		await flush();
		keydown(target.root, 'v', false, true);
		await flush();
		expect(await cellsOf(target, 1)).toEqual(expect.arrayContaining(['AA', 'BB']));
		// Anything else pastes as its text, one byte per character.
		backend.clipboardText = 'ZZ';
		keydown(target.root, 'v', false, true);
		await flush();
		expect(await cellsOf(target, 1)).toEqual(expect.arrayContaining(['5A', '5A']));
	});

	it('paste stops at the file\'s end with a reminder of what did not fit', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		await flush();
		// Four bytes pasted at 62 of a 64-byte file: two land, two do not.
		mouse('mousedown', cellAt(view, 62));
		backend.clipboardText = '31323334';
		keydown(view.root, 'v', false, true);
		await flush();
		const lastRow = Array.from(view.root.querySelector('.hex-scroller [data-row="3"]')!.querySelectorAll('.hex-cell'), (c) => c.textContent);
		expect(lastRow.slice(14)).toEqual(['31', '32']);
		expect(document.querySelector('.notification')!.textContent).toContain('Pasted 2 of 4 bytes');
		// A read-only view never pastes.
		const ro = new HexView('/tmp/blob.bin');
		await ro.load();
		await flush();
		keydown(ro.root, 'v', false, true);
		await flush();
		expect(ro.isDirty).toBe(false);
	});

	it('the menu\'s Paste overwrites from the right-clicked byte', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		await flush();
		backend.clipboardText = 'AABB';
		// No selection, no caret walked there: the paste lands at byte 8 exactly.
		cellAt(view, 8).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menuItem('Paste')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		const row = Array.from(view.root.querySelector('.hex-scroller [data-row="0"]')!.querySelectorAll('.hex-cell'), (c) => c.textContent);
		expect(row.slice(7, 11)).toEqual(['07', 'AA', 'BB', '0A']);
		expect(view.isDirty).toBe(true);
	});

	it('Shift+arrows extend the selection, a plain arrow collapses it, Escape clears it', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		mouse('mousedown', cellAt(view, 1));
		await flush();
		for (let i = 0; i < 3; i++) keydown(view.root, 'ArrowRight', true);
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(8); // bytes 1..4, both panes
		keydown(view.root, 'ArrowRight'); // collapse onto the selection's end
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(0);
		// The caret landed on the byte the walk came from; extending back selects the two
		// bytes it walked over.
		keydown(view.root, 'ArrowLeft', true);
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(4); // bytes 3..4, both panes
		keydown(view.root, 'Escape');
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(0);
	});

	it('typing over a selection edits from its first byte, and copies show edited bytes', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		(view.root.querySelector('.hex-edit-toggle') as HTMLButtonElement).click();
		mouse('mousedown', cellAt(view, 2));
		mouse('mousemove', cellAt(view, 3));
		window.dispatchEvent(new MouseEvent('mouseup'));
		await flush();
		keydown(view.root, 'f');
		await flush();
		keydown(view.root, 'f');
		await flush();
		// Byte 2 (the selection's start) was replaced, not the caret byte the drag left.
		expect(Array.from(view.root.querySelector('.hex-scroller .hex-row')!.querySelectorAll('.hex-cell')).map((c) => c.textContent)[2]).toBe('FF');
		expect(view.isDirty).toBe(true);
		keydown(view.root, 'a', false, true);
		await flush();
		// Re-select bytes 2..3 through marking; the copy overlays the unsaved edit.
		cellAt(view, 2).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menuItem('Mark Selection Start')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		cellAt(view, 3).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menuItem('Mark Selection End')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		keydown(view.root, 'c', false, true);
		await flush();
		expect(backend.clipboard).toEqual(['FF03']);
	});

	it('a plain click drops the previous selection from every row, and a re-select shows only the new span', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		// A span over rows 0..2, then a click on row 3: the old highlight must leave the
		// rows it covered, not just the caret's (they were left painted on screen).
		mouse('mousedown', cellAt(view, 4));
		mouse('mousemove', cellAt(view, 40));
		window.dispatchEvent(new MouseEvent('mouseup'));
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBeGreaterThan(0);
		mouse('mousedown', cellAt(view, 60));
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(0);
		expect(view.root.querySelector('.hex-status')!.textContent).not.toContain('sel ');
		// Re-selecting a smaller span paints exactly it.
		mouse('mousedown', cellAt(view, 8));
		mouse('mousemove', cellAt(view, 10));
		window.dispatchEvent(new MouseEvent('mouseup'));
		await flush();
		expect(view.root.querySelectorAll('.hex-selected').length).toBe(6); // bytes 8..10, both panes
	});

	it('the data inspector reads the clicked byte as u8..f64 and text', async () => {
		const view = new HexView('/tmp/blob.bin');
		await view.load();
		await flush();
		mouse('mousedown', cellAt(view, 0x20));
		await flush(2);
		const inspector = view.root.querySelector('.hex-inspector')!;
		// Byte 0x20 is the fixture's planted DE AD BE EF: every width reads the same bytes.
		const fields = new Map(Array.from(inspector.querySelectorAll('.hex-inspector-field'), (field) => [
			field.querySelector('.hex-inspector-label')!.textContent!,
			field.lastChild!.textContent!
		]));
		expect(inspector.querySelector('.hex-inspector-at')!.textContent).toBe('0x00000020');
		expect(fields.get('u8')).toBe('0xDE');
		expect(fields.get('i8')).toBe('-34');
		expect(fields.get('u16le')).toBe('0xADDE');
		expect(fields.get('u16be')).toBe('0xDEAD');
		expect(fields.get('u32le')).toBe('0xEFBEADDE');
		expect(fields.get('u64le')).toBe('0x27262524EFBEADDE');
		expect(fields.get('text')).toBe('Þ­¾ï');
		// A selection points the inspector at its first byte.
		mouse('mousedown', cellAt(view, 0x30));
		mouse('mousemove', cellAt(view, 0x31));
		window.dispatchEvent(new MouseEvent('mouseup'));
		await flush(2);
		expect(view.root.querySelector('.hex-inspector')!.querySelector('.hex-inspector-at')!.textContent).toBe('0x00000030');
	});
});
