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

describe('the fast viewer whole-file find (docFind.ts)', () => {
	/** Wait out the find bar's 250 ms debounce with real time. */
	async function settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 300));
		await flush();
	}

	it('counts matches over the whole file, steps through them, and never offers replace', async () => {
		const file = ['needle one', 'plain', 'needle two', 'plain'];
		backend.on('viewer_open', () => ({ ...OPEN, lineCount: file.length }));
		backend.on('viewer_close', () => undefined);
		backend.on('viewer_lines', ({ start, end }) => ({
			startLine: start,
			lineCount: file.length,
			lines: file.slice(start, end + 1).map((text) => [text, []] as [string, [number, number, string][]])
		}));
		// The faithful viewer_find mock: single-line matches, 0-based lines, code-point columns.
		backend.on('viewer_find', ({ query }: { query: string }) => {
			const needle = String(query).toLowerCase();
			const matches: { line: number; startCol: number; endCol: number }[] = [];
			file.forEach((line, index) => {
				const chars = Array.from(line.toLowerCase());
				let at = 0;
				while (at + needle.length <= chars.length) {
					if (chars.slice(at, at + needle.length).join('') === needle) {
						matches.push({ line: index, startCol: at, endCol: at + needle.length });
						at += needle.length;
					} else at++;
				}
			});
			return { matches, capped: false };
		});
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\repo\huge.txt');
		await flush();
		view.openFind();
		await flush();
		const bar = view.root.querySelector('.cm-find-widget') as HTMLElement;
		expect(bar.hidden).toBe(false);
		const input = bar.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'needle';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(bar.querySelector('.cm-find-count')!.textContent).toBe('1 of 2');
		// The current match carries the stronger mark on its rendered row.
		const current = view.root.querySelector('mark.fast-match.current');
		expect(current?.textContent).toBe('needle');
		const next = [...bar.querySelectorAll('.cm-find-btn')].find((b) => (b as HTMLElement).title.startsWith('Next Match')) as HTMLElement;
		next.click();
		await settle();
		// Stepped to the match on line 2 — its row re-rendered with the current mark.
		expect(view.root.querySelector('mark.fast-match.current')?.textContent).toBe('needle');
		// A read-only surface: no replace row controls at all.
		expect(bar.querySelector('.cm-replace-row')!.childElementCount).toBe(0);
		view.dispose();
	});
});
