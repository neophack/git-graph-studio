// Quick Open's content operations beyond the bare file scan: VS Code's `file.ts:123[:5]`
// goto suffix (parsed off before scoring, carried on the pick, opened at the position) and
// the "?" help mode that describes every prefix and switches to it on pick.

import { describe, expect, it, vi } from 'vitest';

import { FilePickSource, parseGotoSuffix, pickedFilePosition } from '../src/features/quickOpen';
import { quickOpenHelpItems } from '../src/workbench/workbench';
import { flush } from './helpers';

describe('the Quick Open goto suffix', () => {
	it('parses :line and :line:column off the term, and nothing without digits', () => {
		expect(parseGotoSuffix('main.ts:42')).toEqual({ term: 'main.ts', line: 42, column: null });
		expect(parseGotoSuffix('main.ts:42:7')).toEqual({ term: 'main.ts', line: 42, column: 7 });
		// A colon without digits is still a (futile) file search, never a jump.
		expect(parseGotoSuffix('main.ts:')).toEqual({ term: 'main.ts:', line: null, column: null });
		expect(parseGotoSuffix('main.ts:x')).toEqual({ term: 'main.ts:x', line: null, column: null });
		expect(parseGotoSuffix('main.ts')).toEqual({ term: 'main.ts', line: null, column: null });
		// The empty term lists files plain (the ':' prefix mode owns bare `:12` upstream).
		expect(parseGotoSuffix(':42')).toEqual({ term: '', line: 42, column: null });
	});

	it('the suffix never corrupts the match: the scorer sees the stripped term', async () => {
		const picks = new FilePickSource(() => Promise.resolve(['src/main.ts', 'src/app.ts']));
		await flush();
		const hits = await picks.query('main.ts:42', () => undefined, () => false);
		expect(hits.map((item) => item.label)).toEqual(['main.ts']);
		// The pick carries the position, folded into the value past the path (the NUL
		// separator no path carries).
		expect(hits[0]!.value).toBe('file:src/main.ts\u000042\u00001');
	});

	it('a column rides too, and a plain query keeps the bare file: value', async () => {
		const picks = new FilePickSource(() => Promise.resolve(['src/main.ts']));
		await flush();
		const withColumn = await picks.query('main:2:3', () => undefined, () => false);
		expect(withColumn[0]!.value).toBe('file:src/main.ts\u00002\u00003');
		const plain = await picks.query('main', () => undefined, () => false);
		expect(plain[0]!.value).toBe('file:src/main.ts');
	});

	it('pickedFilePosition reads the position back off a picked value', () => {
		expect(pickedFilePosition('file:src/main.ts')).toEqual({ path: 'src/main.ts', line: null, column: null });
		expect(pickedFilePosition('file:src/main.ts\u000042\u00007')).toEqual({ path: 'src/main.ts', line: 42, column: 7 });
	});

	it('a backend-scored source receives the stripped term too', async () => {
		const { backend } = await import('./tauriMock');
		const scored = vi.fn(() => [{ path: 'src/main.ts', label: 'main.ts', ranges: [] }]);
		backend.on('fuzzy_files', scored);
		const picks = new FilePickSource(() => Promise.resolve([]));
		const hits = await picks.query('main.ts:42', () => undefined, () => false);
		expect(scored.mock.calls[0]![0]).toEqual({ query: 'main.ts', limit: 60 });
		expect(hits[0]!.value).toBe('file:src/main.ts\u000042\u00001');
		backend.reset();
	});
});

describe('the Quick Open ? help mode', () => {
	it('describes every prefix and picks switch to it', () => {
		const items = quickOpenHelpItems();
		expect(items.map((item) => item.value)).toEqual(['mode:files', 'mode::', 'mode:@', 'mode:#', 'mode:>']);
		expect(items.map((item) => item.label)).toEqual([
			'Go to File...',
			'Go to Line/Column...',
			'Go to Symbol in File...',
			'Go to Symbol in Workspace...',
			'Command Palette...'
		]);
		// Every row carries its example spelling.
		for (const item of items) expect(item.description).toBeTruthy();
	});
});
