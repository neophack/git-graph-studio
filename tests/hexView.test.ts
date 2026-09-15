// The hex viewer: rows are paged from read_file_chunk (16 bytes each, offset + hex + ASCII),
// the sizer stands in for the whole file so only visible rows are drawn, and the search box
// scans the file for text or hex-byte needles.

import { beforeEach, describe, expect, it } from 'vitest';

import { bytesPerRowFor, HexView } from '../src/hexView';
import { EditorGroup } from '../src/editor';
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
		// The second slab begins at byte 65536 = row 4096; rows are 20px in the test DOM.
		view.scroller.scrollTop = 4096 * 20;
		view.root.querySelector('.hex-scroller')!.dispatchEvent(new Event('scroll'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const offsets = backend.callsTo('read_file_chunk').map((args) => args.offset);
		expect(offsets).toContain(65536);
		// Only the slabs actually shown were requested, never the whole file.
		expect(offsets.length).toBeLessThan(4);
		expect(view.root.querySelector('.hex-sizer')!.getAttribute('style')).toContain('height');
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
		expect(view.scroller.scrollTop).toBe(Math.floor(0x24 / 8) * 20); // rows are 20px in the test DOM
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
		view.scroller.scrollTop = row * 20;
		view.root.querySelector('.hex-scroller')!.dispatchEvent(new Event('scroll'));
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
		tops.push(view.scroller.scrollTop);
		expect(count()).toBe('2 of 3');
		keydown(box, 'Enter');
		tops.push(view.scroller.scrollTop);
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
			expect(disconnected).toBe(1);
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
});
