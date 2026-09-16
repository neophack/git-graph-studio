// The hex comparison: address-aligned panes over `read_file_chunk`, difference regions from
// a streaming scan, and the large-file behaviour - the initial view reads kilobytes whatever
// the size, the scan streams in bounded chunks, and nothing ever holds a file whole.

import { describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import { HexCompareView } from '../src/hexCompare';
import { backend } from './tauriMock';
import { click, texts } from './helpers';

/** The slab reads around the scan's own two streams: an allowance, not a budget. */
const SLAB_ALLOWANCE = 8 * 64 * 1024;

/** Resolve once `ready` holds (polled), failing the test after `ms`. */
async function waitForReady(ready: () => boolean, ms = 20000): Promise<void> {
	await Promise.race([
		(async (): Promise<void> => {
			while (!ready()) await new Promise((resolve) => setTimeout(resolve, 20));
		})(),
		new Promise((_, reject) => setTimeout(() => reject(new Error('condition not met in time')), ms))
	]);
}

function chunkServer(files: Record<string, Uint8Array>): void {
	backend.on('read_file_chunk', ({ path, offset, len }) => {
		const bytes = files[String(path)];
		if (!bytes) throw new Error(`${path}: not found`);
		const start = Math.min(Number(offset), bytes.length);
		const end = Math.min(start + Number(len), bytes.length);
		return { size: bytes.length, base64: Buffer.from(bytes.subarray(start, end)).toString('base64') };
	});
}

describe('hex compare', () => {
	it('marks differing bytes on both sides, address-aligned, and navigates the regions', async () => {
		// 64 bytes on the left; the right flips byte 3 and bytes 40-41 and runs 6 bytes longer.
		const left = Uint8Array.from({ length: 64 }, (_, i) => i);
		const right = Uint8Array.from({ length: 70 }, (_, i) => (i === 3 || i === 40 || i === 41 ? (i ^ 0xff) : i < 64 ? i : 0x5a));
		chunkServer({ 'C:\\l.bin': left, 'C:\\r.bin': right });
		const view = new HexCompareView('C:\\l.bin', 'C:\\r.bin', { left: 'left.bin', right: 'right.bin' });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		view.scan();
		await waitForReady(() => view.root.querySelector('.hex-status')!.textContent!.includes('differing bytes'));
		await waitForReady(() => view.root.querySelectorAll('.hex-cmp-row .hex-row').length > 0);

		// 1 + 2 flipped bytes plus the 6-byte size tail: 9 differing bytes in 3 regions.
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('9 differing bytes in 3 regions');
		// The panes are address-aligned: row 0 shows offset 0 on both sides, byte 3 differs.
		const first = view.root.querySelector<HTMLElement>('.hex-cmp-row[data-row="0"]')!;
		expect(texts('.hex-offset', first)).toEqual(['00000000', '00000000']);
		const sides = first.querySelectorAll('.hex-row');
		expect(sides[0]!.querySelectorAll('.hex-cell')[3]!.classList.contains('hex-diff')).toBe(true);
		expect(sides[1]!.querySelectorAll('.hex-cell')[3]!.classList.contains('hex-diff')).toBe(true);
		expect(sides[0]!.querySelectorAll('.hex-cell')[3]!.textContent).toBe('03');
		expect(sides[1]!.querySelectorAll('.hex-cell')[3]!.textContent).toBe('FC');
		// An equal byte carries no tint.
		expect(sides[0]!.querySelectorAll('.hex-cell')[4]!.classList.contains('hex-diff')).toBe(false);
		// Every cell titles itself with its byte's address - both panes, hex and ASCII alike.
		expect(sides[0]!.querySelectorAll('.hex-cell')[3]!.title).toBe('0x00000003');
		expect(sides[1]!.querySelectorAll('.hex-cell')[3]!.title).toBe('0x00000003');
		expect(sides[0]!.querySelectorAll('.hex-ascii-cell')[3]!.title).toBe('0x00000003');

		// The scan lands on the first difference (byte 3), the counter says 1 of 3.
		expect(view.root.querySelector('.hex-search-count')!.textContent).toBe('1 / 3 differences');
		// A 20-row viewport: a region is revealed near the top, three rows of lead.
		view.scroll.setViewport(400);
		view.scroll.setTop(0);
		// Next steps to the second region (bytes 40-41): row 2 less the lead.
		const next = view.root.querySelectorAll('button')[1]!;
		click(next);
		expect(view.root.querySelector('.hex-search-count')!.textContent).toBe('2 / 3 differences');
		// Both remaining regions sit near the top of a 5-row file: the jump clamps to 0.
		expect(view.scroll.top).toBe(Math.max(0, Math.floor(40 / 16) - 3));
		// Third: the size tail - the left pane runs out (blank cells), the right's bytes tint.
		click(next);
		expect(view.scroll.top).toBe(Math.max(0, Math.floor(64 / 16) - 3));
		await waitForReady(() => view.root.querySelector('.hex-cmp-row[data-row="4"]')?.querySelectorAll('.hex-row')[1]?.querySelectorAll('.hex-cell:not(.hex-blank)').length === 6);
		const tail = view.root.querySelector<HTMLElement>('.hex-cmp-row[data-row="4"]')!;
		const tailSides = tail.querySelectorAll('.hex-row');
		expect(tailSides[0]!.querySelectorAll('.hex-cell:not(.hex-blank)')).toHaveLength(0);
		expect(tailSides[1]!.querySelectorAll('.hex-cell.hex-diff')).toHaveLength(6);
		// The blanks past the left file's end are filler and carry no address; the right
		// side's bytes carry theirs (row 4 starts at byte 64).
		expect(tailSides[0]!.querySelectorAll('.hex-cell')[0]!.title).toBe('');
		expect(tailSides[1]!.querySelectorAll('.hex-cell:not(.hex-blank)')[0]!.title).toBe('0x00000040');

		// Short equal runs merge into one region: bytes 20 and 24 (gap 3 < 16) are one.
		const mergeLeft = Uint8Array.from({ length: 64 }, (_, i) => i);
		const mergeRight = Uint8Array.from({ length: 64 }, (_, i) => (i === 20 || i === 24 ? (i ^ 0xff) : i));
		chunkServer({ 'C:\\m.bin': mergeLeft, 'C:\\n.bin': mergeRight });
		const merged = new HexCompareView('C:\\m.bin', 'C:\\n.bin');
		document.getElementById('editorGroup')!.appendChild(merged.root);
		await merged.load();
		merged.scan();
		await waitForReady(() => merged.root.querySelector('.hex-status')!.textContent!.includes('differing bytes'));
		expect(merged.root.querySelector('.hex-status')!.textContent).toContain('2 differing bytes in 1 region');
		merged.destroy();
		view.destroy();
	});

	it('pages a viewport less one row per PageUp/PageDown', async () => {
		// Two equal 64 KiB files: 4096 rows of 16 bytes. A 400 px viewport over 20 px rows
		// is 20 rows: a page is 19 (Zed's ScrollAmount::Page keeps one anchor row), and
		// two presses are exactly two pages.
		chunkServer({ 'C:\\l.bin': new Uint8Array(64 * 1024), 'C:\\r.bin': new Uint8Array(64 * 1024) });
		const view = new HexCompareView('C:\\l.bin', 'C:\\r.bin');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		const scroller = view.root.querySelector<HTMLElement>('.hex-scroller')!;
		view.scroll.setViewport(400);
		scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(view.scroll.top).toBe(19);
		scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
		expect(view.scroll.top).toBe(38);
		scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', cancelable: true }));
		expect(view.scroll.top).toBe(19);
		// Ctrl+PageUp/Down stay the workbench's editor-tab keys.
		const event = new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, cancelable: true });
		scroller.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(view.scroll.top).toBe(19);
		view.destroy();
	});

	it('a binary pair from the explorer compare opens the hex view without reading either file whole', async () => {
		const left = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
		const right = Uint8Array.from({ length: 300 }, (_, i) => (i === 5 ? 0xff : i & 0xff));
		chunkServer({ 'C:\\repo\\a.bin': left, 'C:\\repo\\b.bin': right });
		backend.on('file_probe', () => ({ size: 300, binary: true }));
		let wholeReads = 0;
		backend.on('read_file', () => {
			wholeReads++;
			return { contents: null, binary: true, size: 300 };
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'paths:a::b', title: 'a.bin ↔ b.bin',
			left: { revision: '*', path: 'C:\\repo\\a.bin', label: 'C:\\repo\\a.bin', exists: true, local: true },
			right: { revision: '*', path: 'C:\\repo\\b.bin', label: 'C:\\repo\\b.bin', exists: true, local: true }
		});
		await waitForReady(() => document.querySelector('.hex-compare .hex-cmp-label') !== null);
		expect(wholeReads).toBe(0);
		expect(document.querySelector('.hex-compare .hex-cmp-label')!.textContent).toBe('C:\\repo\\a.bin');
		// Everything the view asked for was a bounded window - a slab or a scan chunk -
		// never the file whole (the pair here is tiny, but the widths are the same at any size).
		for (const call of backend.callsTo('read_file_chunk')) {
			expect(Number(call.len)).toBeLessThanOrEqual(1024 * 1024);
		}
	});

	it('streams a 128 MiB pair in bounded chunks: the viewport reads kilobytes, the scan never holds a file', { timeout: 180000 }, async () => {
		const SIZE = 128 * 1024 * 1024;
		const TAIL = 5; // the right file is 5 bytes longer
		// Two deterministic streams: the right side flips three planted ranges - 10, 4 and 1
		// bytes - plus the
		// size tail); every byte is computed on demand, so no copy of either file exists.
		const byteAt = (offset: number, side: 'l' | 'r'): number => {
			const base = ((offset ^ (offset >> 8)) * 2654435761 >>> 0) & 0xff;
			if (side === 'l') return base;
			const flipped = (offset >= 1000 && offset < 1010) || (offset >= 40_000_000 && offset < 40_000_004) || offset === SIZE - 1;
			return flipped ? base ^ 0xff : base;
		};
		let served = 0;
		let largestCall = 0;
		backend.on('read_file_chunk', ({ path, offset, len }) => {
			const side = String(path).endsWith('r.bin') ? 'r' : 'l';
			const start = Number(offset);
			const end = Math.min(start + Number(len), SIZE + (side === 'r' ? TAIL : 0));
			const bytes = Buffer.alloc(Math.max(0, end - start));
			for (let i = 0; i < bytes.length; i++) bytes[i] = byteAt(start + i, side as 'l' | 'r');
			served += bytes.length;
			largestCall = Math.max(largestCall, bytes.length);
			return { size: SIZE + (side === 'r' ? TAIL : 0), base64: bytes.toString('base64') };
		});
		const started = Date.now();
		const view = new HexCompareView('C:\\big-l.bin', 'C:\\big-r.bin', { left: 'big-l.bin', right: 'big-r.bin' });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		const firstPaint = Date.now();
		// The viewport is on screen after reading two slabs - kilobytes against a 128 MiB pair.
		const initialBytes = served;
		expect(initialBytes).toBeLessThanOrEqual(4 * 64 * 1024);
		expect(view.root.querySelector('.hex-cmp-row[data-row="0"]')).not.toBeNull();
		const rows = view.root.querySelectorAll('.hex-cmp-row').length;
		expect(rows).toBeLessThan(60);

		view.scan();
		// The scan finds the three planted ranges plus the 5-byte size tail.
		await waitForReady(() => view.root.querySelector('.hex-status')!.textContent!.includes('differing bytes'), 120000);
		const scanned = Date.now();
		const status = view.root.querySelector('.hex-status')!.textContent!;
		expect(status).toContain('20 differing bytes in 4 regions');
		// Two whole streams crossed the wire (the scan must look at every byte) - but no
		// single call ever asked for more than one chunk.
		const pairBytes = 2 * SIZE + TAIL;
		expect(served).toBeGreaterThanOrEqual(pairBytes);
		expect(served).toBeLessThan(pairBytes + SLAB_ALLOWANCE);
		expect(largestCall).toBeLessThanOrEqual(1024 * 1024);
		console.log(`hex compare: 128 MiB pair - first paint ${firstPaint - started}ms (${initialBytes} bytes read), full scan ${scanned - started}ms (${((2 * SIZE) / 1024 / 1024 / ((scanned - firstPaint) / 1000)).toFixed(0)} MiB/s of pair)`);

		// A jump to the far end reads its slab and paints the tail row - the one row where
		// the left pane has run out and only the right side still has bytes.
		const goto = view.root.querySelector<HTMLInputElement>('.hex-goto')!;
		goto.value = `0x${SIZE.toString(16)}`;
		goto.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await waitForReady(() => view.root.querySelector(`.hex-cmp-row[data-row="${SIZE / 16}"]`)?.querySelectorAll('.hex-row')[1]!.querySelectorAll('.hex-cell:not(.hex-blank)').length === 5);
		const tailRow = view.root.querySelector<HTMLElement>(`.hex-cmp-row[data-row="${SIZE / 16}"]`)!;
		const tailSides = tailRow.querySelectorAll('.hex-row');
		expect(tailSides[0]!.querySelectorAll('.hex-cell:not(.hex-blank)')).toHaveLength(0); // the left file ended 5 bytes ago
		expect(tailSides[1]!.querySelectorAll('.hex-cell:not(.hex-blank)')).toHaveLength(5);
		// A blank is an invisible spacer, never a hidden '00': nothing past a file's end
		// carries bytes that could surface as phantom data at the end of the view.
		expect(Array.from(tailRow.querySelectorAll('.hex-blank')).every((cell) => cell.textContent === '')).toBe(true);
		// The whole size tail is a difference region, tinted on the side that still has it.
		expect(tailSides[1]!.querySelectorAll('.hex-cell.hex-diff')).toHaveLength(5);
		view.destroy();
	});

	it('keeps the tail reachable past the engines\' height clamp', async () => {
		// A 64 MiB pair at 16 bytes/row is 4,194,304 rows ≈ 84M px; the engines clamp near
		// 33.5M px, which used to strand the tail behind a sizer the scrollbar could not move
		// past. Nothing is laid out at that height now: the model's bottom is the last row.
		const SIZE = 64 * 1024 * 1024;
		backend.on('read_file_chunk', ({ offset, len }) => {
			const start = Math.min(Number(offset), SIZE);
			const end = Math.min(start + Number(len), SIZE);
			return { size: SIZE, base64: Buffer.alloc(Math.max(0, end - start)).toString('base64') };
		});
		const view = new HexCompareView('C:\\g-l.bin', 'C:\\g-r.bin');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		expect(view.scroll.maxScrollTop()).toBe(SIZE / 16 - 1);
		view.scroll.setTop(view.scroll.maxScrollTop());
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The scrollbar's bottom is the pair's last row: the final rows draw.
		const rows = Array.from(view.root.querySelectorAll<HTMLElement>('.hex-body [data-row]'));
		expect(rows.length).toBeGreaterThan(0);
		expect(Math.max(...rows.map((row) => Number(row.dataset.row)))).toBe(SIZE / 16 - 1);
		view.destroy();
	});

	it('renders both panes of a row that straddles a 64 KiB slab boundary', async () => {
		// 24 bytes/row does not divide 65536: row 2730 holds bytes 65520..65543, so each
		// pane's last 8 cells come from the next slab.
		const SLAB = 64 * 1024;
		const left = new Uint8Array(SLAB + 1024);
		const right = new Uint8Array(SLAB + 1024);
		for (let i = 0; i < left.length; i++) left[i] = right[i] = (i * 31 + 7) & 0xff;
		right[SLAB + 4] = left[SLAB + 4]! ^ 0xff; // a difference just past the boundary
		chunkServer({ 'C:\\l.bin': left, 'C:\\r.bin': right });
		const view = new HexCompareView('C:\\l.bin', 'C:\\r.bin', { left: 'l.bin', right: 'r.bin' });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		view.scan();
		await waitForReady(() => view.root.querySelector('.hex-status')!.textContent!.includes('differing bytes'));
		const select = view.root.querySelector('.hex-width') as HTMLSelectElement;
		select.value = '24';
		select.dispatchEvent(new Event('change'));
		const rowIndex = Math.floor(SLAB / 24); // 2730
		view.scroll.setTop(rowIndex);
		const row = () => view.root.querySelector(`.hex-cmp-row[data-row="${rowIndex}"]`);
		await waitForReady(() => (row()?.querySelectorAll('.hex-cell:not(.hex-blank)').length ?? 0) > 0);
		const panes = row()!.querySelectorAll('.hex-row');
		// Both panes show the row whole - no blanked-out tail past the slab boundary.
		for (const pane of Array.from(panes)) {
			expect(pane.querySelectorAll('.hex-blank')).toHaveLength(0);
			expect(pane.querySelectorAll('.hex-cell')).toHaveLength(24);
		}
		// The differing byte 65540 is the row's 21st cell: shown and tinted on both sides.
		const byteAt = (i: number) => ((i * 31 + 7) & 0xff).toString(16).padStart(2, '0').toUpperCase();
		expect(panes[0]!.querySelectorAll('.hex-cell')[20]!.textContent).toBe(byteAt(SLAB + 4));
		expect(panes[0]!.querySelectorAll('.hex-cell')[20]!.classList.contains('hex-diff')).toBe(true);
		expect(panes[1]!.querySelectorAll('.hex-cell')[20]!.classList.contains('hex-diff')).toBe(true);
		view.destroy();
	});

	it('destroy disconnects the resize observer', async () => {
		const realObserver = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
		let disconnected = 0;
		class TrackingObserver {
			observe(): void { /* no-op */ }
			unobserve(): void { /* no-op */ }
			disconnect(): void { disconnected++; }
		}
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = TrackingObserver;
		try {
			chunkServer({ 'C:\\a.bin': Uint8Array.of(1, 2, 3), 'C:\\b.bin': Uint8Array.of(1, 2, 3) });
			const view = new HexCompareView('C:\\a.bin', 'C:\\b.bin');
			document.getElementById('editorGroup')!.appendChild(view.root);
			await view.load();
			view.destroy();
			expect(disconnected).toBe(2); // the view's own and the drawn scrollbar's
		} finally {
			(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realObserver;
		}
	});

	it('stops the difference scan when a file shrinks mid-scan', { timeout: 15000 }, async () => {
		const SIZE = 2 * 1024 * 1024;
		let shrunk = false;
		backend.on('read_file_chunk', ({ offset, len }) => {
			// Safety valve: the scan spinning on an empty chunk would read forever.
			if (backend.callsTo('read_file_chunk').length > 200) throw new Error('read loop runaway');
			const start = Number(offset);
			// Once the file has shrunk to 1 MiB on disk, reads past that clamp to nothing.
			const end = shrunk ? Math.min(start + Number(len), 1024 * 1024) : start + Number(len);
			return { size: SIZE, base64: Buffer.alloc(Math.max(0, end - start)).toString('base64') };
		});
		const view = new HexCompareView('C:\\l.bin', 'C:\\r.bin');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		view.scan();
		// The two slab reads are the load's; the next pair is the scan's first chunk.
		await waitForReady(() => backend.callsTo('read_file_chunk').length >= 4);
		shrunk = true;
		// The empty chunk must end the scan, not spin on it forever.
		await waitForReady(() => !view.root.querySelector('.hex-status')!.textContent!.includes('scanning'), 10000);
		const calls = backend.callsTo('read_file_chunk').length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(backend.callsTo('read_file_chunk').length).toBe(calls);
		expect(view.root.querySelector('.hex-status')!.textContent).toContain('identical');
		view.destroy();
	});

	it('renders the panes when one side is an empty file', async () => {
		const right = Uint8Array.from({ length: 48 }, (_, i) => i + 1);
		chunkServer({ 'C:\\empty.bin': new Uint8Array(0), 'C:\\r.bin': right });
		const view = new HexCompareView('C:\\empty.bin', 'C:\\r.bin', { left: 'empty.bin', right: 'r.bin' });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await view.load();
		view.scan();
		// The scan reports the 48-byte size tail...
		await waitForReady(() => view.root.querySelector('.hex-status')!.textContent!.includes('48 differing bytes in 1 region'));
		// ...and the panes render: the empty side blank, the other side's bytes tinted.
		const first = () => view.root.querySelector('.hex-cmp-row[data-row="0"]');
		await waitForReady(() => first()?.querySelectorAll('.hex-row')[1]?.querySelectorAll('.hex-cell:not(.hex-blank)').length === 16, 5000);
		const panes = first()!.querySelectorAll('.hex-row');
		expect(panes[0]!.querySelectorAll('.hex-cell:not(.hex-blank)')).toHaveLength(0);
		expect(panes[1]!.querySelectorAll('.hex-cell:not(.hex-blank)')).toHaveLength(16);
		expect(panes[1]!.querySelectorAll('.hex-cell.hex-diff')).toHaveLength(16);
		// All three rows of the 48-byte side exist in the virtual list.
		expect(view.root.querySelector('.hex-cmp-row[data-row="2"]')).not.toBeNull();
		view.destroy();
	});
});
