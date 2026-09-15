// Performance guards for the hot paths the workbench hits per keystroke and per activation:
// Quick Open's fuzzy scan over a 20,000-entry index (a mid-sized repository) and the picker's
// capped query. Each case measures with performance.now(), prints the number, and asserts a
// generous budget — far above the real cost, low enough to catch an accidental O(n²) (a scorer
// that re-lowercases per file) by an order of magnitude.

import { describe, expect, it } from 'vitest';

import { FilePickSource } from '../src/filePicker';
import { makeQuery, scoreFile, type FileEntry } from '../src/fuzzy';

/** Deterministic index-seeded pseudo-randomness (a mulberry32-style hash): unlike an LCG,
 *  whose low bits cycle with a period of a few bits, the hash spreads every index evenly over
 *  [0, 1), so all folders/stems/extensions actually occur in the generated list. */
function rand(n: number): number {
	let t = n + 0x6d2b79f5;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic pseudo-random file paths with a realistic shape: a few top-level folders,
 *  nested packages, mixed-case names, and the usual extension mix of a TypeScript/Rust repo. */
function syntheticFiles(count: number): string[] {
	const folders = ['src', 'plugin/out', 'plugin/web', 'plugin/media', 'plugin/native/core/src', 'src-tauri/src', 'tests', 'plugin/lib/parser', 'plugin/lib/renderer'];
	const stems = ['main', 'index', 'graph', 'commit', 'branch', 'utils', 'view', 'model', 'panel', 'status', 'diff', 'repo', 'config', 'settings', 'terminal', 'editor'];
	const extensions = ['.ts', '.tsx', '.js', '.rs', '.css', '.json', '.html'];
	const pick = <T>(array: T[], i: number, salt: number): T => array[Math.floor(rand(i * 8 + salt) * array.length)]!;
	const files: string[] = [];
	for (let i = 0; i < count; i++) {
		const folder = pick(folders, i, 0);
		const stem = pick(stems, i, 1) + (rand(i * 8 + 2) < 0.25 ? `-${Math.floor(rand(i * 8 + 3) * 100)}` : '');
		files.push(`${folder}/${stem}${rand(i * 8 + 4) < 0.25 ? '.test' : ''}${pick(extensions, i, 5)}`);
	}
	return files;
}

const FILES = syntheticFiles(20000);
const ENTRIES: FileEntry[] = FILES.map((path) => {
	const label = path.slice(path.lastIndexOf('/') + 1);
	return { path, label, labelLower: label.toLowerCase(), pathLower: path.toLowerCase() };
});

function scan(query: string): { hits: number; ms: number } {
	const fuzzyQuery = makeQuery(query);
	const started = performance.now();
	let hits = 0;
	for (const entry of ENTRIES) if (scoreFile(entry, fuzzyQuery)) hits++;
	return { hits, ms: performance.now() - started };
}

describe('quick open performance', () => {
	it('scores a 20,000-entry index per keystroke within the budget', () => {
		for (const [query, expectHits] of [['gra', true], ['src/ma', true], ['zzq', false]] as const) {
			const { hits, ms } = scan(query);
			// "zzq" is the worst case on purpose: a query that matches nothing still scans
			// every entry, with no early exit to hide behind.
			if (expectHits) expect(hits, `the "${query}" scan matches something`).toBeGreaterThan(0);
			else expect(hits, 'the miss query matches nothing').toBe(0);
			console.log(`[perf] scoreFile 20k entries, query "${query}": ${ms.toFixed(1)} ms (${hits} hits)`);
			expect(ms, `query "${query}" stays under the per-keystroke budget`).toBeLessThan(500);
		}
	});

	it('answers a full capped picker query within the budget', async () => {
		const picks = new FilePickSource(() => Promise.resolve(FILES));
		await picks.refresh();
		const started = performance.now();
		const items = await picks.query('graph', () => undefined, () => false);
		const ms = performance.now() - started;
		console.log(`[perf] FilePickSource.query over 20k entries: ${ms.toFixed(1)} ms, ${items.length} rows`);
		expect(items.length).toBe(60);
		expect(ms).toBeLessThan(1500);
	});
});

/* ---------- Views over large data sets ---------- */

/** Deterministic choice from an array, index-seeded like `syntheticFiles`. */
function pick<T>(array: T[], i: number, salt: number): T {
	return array[Math.floor(rand(i * 8 + salt) * array.length)]!;
}

import { SearchView, type FileMatches, type SearchEvent } from '../src/searchView';
import { SourceControlView } from '../src/scm';
import { Channel, backend } from './tauriMock';
import { flush } from './helpers';

/** `files` files with `perFile` matches each, streamed to the Search view as one batch. */
function searchResults(files: number, perFile: number): FileMatches[] {
	const out: FileMatches[] = [];
	for (let f = 0; f < files; f++) {
		const matches = [];
		for (let m = 0; m < perFile; m++) matches.push({ line: m + 1, column: 3, length: 4, text: `  todo item ${m} in file ${f}` });
		out.push({ path: `src/${pick(['a', 'b', 'c', 'd'], f, 1)}/file${f}.ts`, matches });
	}
	return out;
}

describe('view performance over large result sets', () => {
	it('renders a 50,000-row search result set as a plain DOM tree within the budget', { timeout: 60_000 }, async () => {
		const results = searchResults(200, 250);
		backend.on('search_workspace', async (args) => {
			const channel = args['onEvent'] as Channel<SearchEvent>;
			channel.send({ kind: 'batch', files: results });
			channel.send({ kind: 'done', scanned: 200, truncated: false, cancelled: false });
			return null;
		});
		backend.on('search_cancel', () => null);
		const view = new SearchView(document.body.appendChild(document.createElement('div')));
		(view.container.querySelector('.search-row input') as HTMLInputElement).value = 'todo';
		view.container.querySelector('.search-row input')!.dispatchEvent(new Event('input', { bubbles: true }));

		const started = performance.now();
		await view.runSearch();
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
		await flush();
		const ms = performance.now() - started;
		const rendered = view.container.querySelectorAll('.search-rows .search-match').length;
		console.log(`[perf] SearchView 50,000 rows as plain DOM: ${ms.toFixed(1)} ms to build the tree, ${rendered} rows in the DOM`);
		expect(view.container.querySelector('.search-summary')!.textContent).toBe('50000 results in 200 files');
		// Plain DOM, no windowing: the whole tree is in the DOM.
		expect(rendered).toBe(50000);
		// jsdom builds DOM an order of magnitude slower than a browser (a real browser paints
		// this tree in a few hundred ms), and the suite's workers share the machine: the budget
		// guards against a quadratic regression, not a slow run.
		expect(ms).toBeLessThan(40000);

		// Folding is a class flip on the file's group - never a rebuild of the tree.
		const foldStarted = performance.now();
		const head = view.container.querySelector<HTMLElement>('.search-file-head')!;
		head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const foldMs = performance.now() - foldStarted;
		console.log(`[perf] SearchView fold + unfold of a 250-match file: ${foldMs.toFixed(1)} ms`);
		expect(view.container.querySelector('.search-file-group')!.classList.contains('collapsed')).toBe(false);
		expect(foldMs).toBeLessThan(100);
	});

	it('renders a 5,000-change Source Control view within the budget', { timeout: 60_000 }, async () => {
		const changes = [];
		for (let i = 0; i < 5000; i++) {
			changes.push({ path: `src/${pick(['core', 'ui', 'net'], i, 2)}/module${i}.rs`, oldPath: null, staged: i % 3 === 0 ? 'modified' : null, unstaged: i % 3 === 0 ? null : 'modified', untracked: i % 7 === 0, conflicted: false });
		}
		backend.on('scm_status', () => changes);
		const view = new SourceControlView(document.body.appendChild(document.createElement('div')));
		view.setRepo('C:\repo');
		const started = performance.now();
		await view.refresh();
		const ms = performance.now() - started;
		console.log(`[perf] SourceControlView 5,000 changes: ${ms.toFixed(1)} ms`);
		// The list is virtual: a window of rows in the DOM, the badge counting the whole set.
		expect(document.querySelectorAll('.scm-group .row').length).toBeLessThan(120);
		expect(document.querySelector('.pane-header .badge')!.textContent).toBe('5000');
		// jsdom builds DOM an order of magnitude slower than a browser, and the suite's workers
		// share the machine: the budgets guard against a quadratic regression, not a slow run.
		expect(ms).toBeLessThan(8000);

		// The tree mode nests the same set.
		const treeStarted = performance.now();
		view.setViewMode('tree');
		await flush();
		console.log(`[perf] SourceControlView tree of 5,000 changes: ${(performance.now() - treeStarted).toFixed(1)} ms`);
		expect(performance.now() - treeStarted).toBeLessThan(10000);
	});
});
