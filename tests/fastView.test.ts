// The fast code viewer's line fetching: a failed `viewer_lines` call must not wedge the
// affected lines — the next refresh re-requests them and the rows render.

import { describe, expect, it } from 'vitest';

import { FastView } from '../src/fastView';
import { backend } from './tauriMock';
import { flush } from './helpers';

const OPEN = { docId: 7, lineCount: 100, language: 'plaintext', syntaxName: 'Plain Text', symbols: [] };

const linesResult = (start: number, end: number) => ({
	startLine: start,
	lineCount: end - start + 1,
	lines: Array.from({ length: end - start + 1 }, (_, i) => [`line ${start + i}`, []] as [string, [number, number, string][]])
});

describe('the fast viewer', () => {
	it('retries a failed line fetch on the next refresh instead of leaving the rows blank', async () => {
		backend.on('viewer_open', () => OPEN);
		backend.on('viewer_close', () => undefined);
		let fail = true;
		backend.on('viewer_lines', ({ start, end }) => {
			if (fail) throw new Error('transient backend error');
			return linesResult(start as number, end as number);
		});
		const view = new FastView(document.getElementById('editorGroup')!);
		expect(await view.openFile('C:\\repo\\big.txt')).toBe(true);
		await flush();
		// The fetch ran and failed: nothing rendered yet.
		expect(backend.callsTo('viewer_lines').length).toBe(1);
		expect(view.root.querySelectorAll('.fast-row').length).toBe(0);

		fail = false;
		view.revealLine(0); // the same window — a refresh must re-request it
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(2);
		expect(view.root.querySelectorAll('.fast-row').length).toBeGreaterThan(0);
		view.dispose();
	});

	it('fills the viewport a drag ended on once the in-flight window lands', async () => {
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: 100_000 }));
		backend.on('viewer_close', () => undefined);
		// The first fetch hangs until the test releases it, the way a slow window on a huge
		// file does; later fetches answer immediately.
		let holdNext = true;
		let release: ((value: unknown) => void) | null = null;
		backend.on('viewer_lines', ({ start, end }) => {
			if (!holdNext) return linesResult(start as number, end as number);
			holdNext = false;
			return new Promise((resolve) => {
				release = resolve as (value: unknown) => void;
			});
		});
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.txt');
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(1);

		// Drag to the middle of the file while that first window is still in flight: the
		// scroll must not pile a second fetch on top of it.
		const held = release!;
		view.revealLine(50_000);
		await flush();
		expect(backend.callsTo('viewer_lines').length).toBe(1);

		// The drag ends (no more scroll events); the in-flight window lands far away. The
		// landing itself must fetch the lines the viewport is still missing.
		held(linesResult(0, 20));
		await flush();
		const calls = backend.callsTo('viewer_lines');
		expect(calls.length).toBe(2);
		expect(calls[1]).toMatchObject({ start: 49_990, end: 50_010 });
		expect(view.root.querySelector('.fast-row[data-line="50000"]')).not.toBeNull();
		view.dispose();
	});
});
