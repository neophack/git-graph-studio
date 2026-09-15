// The Quick Open file source: the pre-lowered index kept across opens, the chunked scan that
// yields between slices, cancellation by a newer keystroke, and the background refresh.

import { describe, expect, it, vi } from 'vitest';

import { FilePickSource } from '../src/filePicker';
import { flush } from './helpers';

function source(files: string[]): FilePickSource {
	return new FilePickSource(() => Promise.resolve(files));
}

describe('FilePickSource', () => {
	it('returns the first files for an empty query, ranked items for a fuzzy one', async () => {
		const picks = source(['src/main.ts', 'src/app.ts', 'README.md']);
		await flush();
		const empty = await picks.query('', () => undefined, () => false);
		expect(empty.map((item) => item.value)).toEqual(['file:src/main.ts', 'file:src/app.ts', 'file:README.md']);

		const hits = await picks.query('main', () => undefined, () => false);
		expect(hits.map((item) => item.value)).toEqual(['file:src/main.ts']);
		expect(hits[0]!.description).toBe('src/main.ts');
	});

	it('loads on first query and keeps the index across queries', async () => {
		const load = vi.fn(() => Promise.resolve(['a.txt']));
		const picks = new FilePickSource(load);
		expect(load).not.toHaveBeenCalled();
		await picks.query('', () => undefined, () => false);
		expect(load).toHaveBeenCalledTimes(1);
		await picks.query('a', () => undefined, () => false);
		expect(load).toHaveBeenCalledTimes(1); // the index persists between keystrokes
	});

	it('shares one in-flight load between concurrent refreshes', async () => {
		const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(['a.txt']), 0)));
		const picks = new FilePickSource(load);
		const first = picks.refresh();
		const second = picks.refresh();
		expect(second).toBe(first);
		await first;
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('rebuilds only when the walked list actually changed', async () => {
		let files = ['a.txt'];
		const picks = new FilePickSource(() => Promise.resolve(files));
		await picks.refresh();
		files = ['b.txt'];
		await picks.refresh(); // same length, different content
		const items = await picks.query('', () => undefined, () => false);
		expect(items.map((i) => i.value)).toEqual(['file:b.txt']);

		await picks.setFiles(['b.txt']); // unchanged: a no-op
		expect((await picks.query('', () => undefined, () => false)).map((i) => i.value)).toEqual(['file:b.txt']);
	});

	it('delivers partial results between chunks and caps the list at the row budget', async () => {
		const files = Array.from({ length: 9000 }, (_, i) => `f${i}.txt`);
		const picks = source(files);
		const partials: string[][] = [];
		const final = await picks.query('f', (items) => partials.push(items.map((i) => i.label)), () => false);
		expect(partials.length).toBeGreaterThanOrEqual(2); // at least one partial before the end
		expect(final).toHaveLength(60);
		for (const partial of partials) expect(partial.length).toBeLessThanOrEqual(60);
	});

	it('stops scanning once a newer keystroke superseded the query', async () => {
		let queries = 0;
		const picks = new FilePickSource(() => {
			queries += 1;
			return Promise.resolve(Array.from({ length: 9000 }, (_, i) => `f${i}.txt`));
		});
		await flush();
		// Cancelled before the second chunk: the first chunk's top rows come back, capped.
		const cancelled = await picks.query('f', () => undefined, () => true);
		expect(cancelled.length).toBeGreaterThan(0);
		expect(cancelled.length).toBeLessThanOrEqual(60);
		expect(queries).toBe(1);
	});

	it('reports pending until the first list lands', async () => {
		let resolveLoad: ((files: string[]) => void) | null = null;
		const picks = new FilePickSource(() => new Promise((resolve) => {
			resolveLoad = resolve;
		}));
		const pending = picks.query('a', () => undefined, () => false);
		expect(picks.status()).toBe('Reading the file list…');
		resolveLoad!(['a.txt']);
		expect((await pending).map((i) => i.value)).toEqual(['file:a.txt']);
		expect(picks.status()).toBeNull();
	});

	it('survives a failed load and retries on the next query', async () => {
		let fails = true;
		const picks = new FilePickSource(() => (fails ? Promise.reject(new Error('walk failed')) : Promise.resolve(['b.txt'])));
		// The failed load resolves to nothing; the next query re-reads instead of caching the
		// failure forever.
		expect((await picks.query('b', () => undefined, () => false))).toEqual([]);
		fails = false;
		expect((await picks.query('b', () => undefined, () => false)).map((i) => i.value)).toEqual(['file:b.txt']);
	});
});
