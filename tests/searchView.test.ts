// The Search view: the query box and its toggles, the backend call it makes, the grouped
// results it renders, and the replace-all flow (confirm dialog included).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { backend, Channel } from './tauriMock';
import { click, flush, key, menuItem, menuLabels, notifications, notificationButton, rightClick, texts, type } from './helpers';
import { SearchView, renderMatchLine, validateQuery, type FileMatches, type SearchEvent } from '../src/features/search';
import { settings } from '../src/platform/settings';

/** Answer `search_workspace` the way the backend does: every batch, then `done`, pushed over
 *  the channel the view passed in. */
function streams(batches: FileMatches[][], done: { scanned: number; truncated?: boolean; cancelled?: boolean } = { scanned: 1 }) {
	const search = vi.fn(async (args: Record<string, unknown>) => {
		const channel = args.onEvent as Channel<SearchEvent>;
		for (const files of batches) channel.send({ kind: 'batch', files });
		channel.send({ kind: 'done', scanned: done.scanned, truncated: done.truncated ?? false, cancelled: done.cancelled ?? false });
		return null;
	});
	backend.on('search_workspace', search);
	backend.on('search_cancel', () => null);
	return search;
}

/** The result list renders one frame after a batch; let the frame pass. */
async function frame(): Promise<void> {
	await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	await flush();
}

/** A two-root workspace's search: the named files stream for the first root, the second root
 *  scans empty. The results carry `root`, which the context menu's absolute paths reveal
 *  through — a single-folder search's results carry none (the backend derives the root). */
function rootedStream(files: FileMatches[]): void {
	backend.on('search_workspace', async (args) => {
		const channel = args.onEvent as Channel<SearchEvent>;
		if (args.repo === 'C:\\other') {
			channel.send({ kind: 'done', scanned: 0, truncated: false, cancelled: false });
			return null;
		}
		if (files.length > 0) channel.send({ kind: 'batch', files });
		channel.send({ kind: 'done', scanned: files.length, truncated: false, cancelled: false });
		return null;
	});
}

/** The search view over the two rooted roots, its query run. */
async function rootedView(query: string): Promise<SearchView> {
	const view = new SearchView(document.createElement('div'));
	view.setRoots(['C:\\repo', 'C:\\other']);
	type(view.container.querySelector('.search-row input') as HTMLInputElement, query);
	await view.runSearch();
	return view;
}

describe('Search view', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('validates regex queries before running them', () => {
		expect(validateQuery('fn(', { caseSensitive: false, wholeWord: false, useRegex: true, include: '', exclude: '' })).toMatch(/Invalid regular expression/);
		expect(validateQuery('fn\\(', { caseSensitive: false, wholeWord: false, useRegex: true, include: '', exclude: '' })).toBeNull();
		expect(validateQuery('plain (text)', { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' })).toBeNull();
	});

	it('renders a match line with the hit highlighted', () => {
		const row = renderMatchLine({ line: 1, column: 7, length: 2, text: 'alpha fn beta' });
		expect(row.textContent).toBe('alpha fn beta');
		expect(row.querySelector('.hit')!.textContent).toBe('fn');
	});

	it('searches the workspace and renders grouped results', async () => {
		const search = streams([[{ path: 'src/lib.rs', matches: [{ line: 3, column: 1, length: 2, text: 'fn alpha() {}' }] }]], { scanned: 12 });
		const view = new SearchView(document.createElement('div'));
		const opened: [string, number, number][] = [];
		view.onOpenMatch = (path, line, column) => opened.push([path, line, column]);

		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'fn');
		view.container.querySelector('.search-row input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await flush();

		expect(search).toHaveBeenCalledTimes(1);
		expect(search.mock.calls[0]![0]).toMatchObject({ query: 'fn', isRegex: false, caseSensitive: false, wordOnly: false });
		expect(search.mock.calls[0]![0]!.onEvent).toBeInstanceOf(Channel);
		expect(texts('.search-summary', view.container)).toEqual(['1 result in 1 file']);
		expect(texts('.search-file-head .label', view.container)).toEqual(['lib.rs']);
		click(view.container.querySelector('.search-match'));
		expect(opened).toEqual([['src/lib.rs', 3, 1]]);
	});

	it('reports a failed search as an error line', async () => {
		backend.on('search_workspace', async () => {
			throw 'Invalid pattern: bad';
		});
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'bad');
		await view.runSearch();
		expect(texts('.search-error', view.container)).toEqual(['Invalid pattern: bad']);
	});

	it('shows the truncation warning when the backend capped the results', async () => {
		streams([], { scanned: 10, truncated: true });
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'e');
		await view.runSearch();
		expect(texts('.search-warning', view.container)[0]).toMatch(/subset of all matches/);
	});

	it('folds the replace row away behind the chevron, as VS Code does', () => {
		const view = new SearchView(document.createElement('div'));
		const replaceRow = view.container.querySelector('.replace-row') as HTMLElement;
		expect(replaceRow.style.display).toBe('none');
		click(view.container.querySelector('.search-replace-toggle')!);
		expect(replaceRow.style.display).toBe('');
		expect(view.container.querySelector('.search-replace-toggle .twistie')!.className).toContain('chevron-down');
	});

	it('dims the folder after the file name and numbers match lines', async () => {
		streams([[{ path: 'src/lib.rs', matches: [{ line: 12, column: 4, length: 2, text: 'fn alpha' }] }]]);
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'fn');
		await view.runSearch();
		expect(texts('.search-file-head .label', view.container)).toEqual(['lib.rs']);
		expect(texts('.search-file-head .description', view.container)).toEqual(['src']);
		expect(texts('.search-match .line-no', view.container)).toEqual(['12']);
	});

	it('runs the progress bar while a search is in flight and fills the list batch by batch', async () => {
		let channel: Channel<SearchEvent> | null = null;
		backend.on('search_workspace', (args) => new Promise((resolve) => {
			channel = args.onEvent as Channel<SearchEvent>;
			(channel as unknown as { resolve: () => void }).resolve = () => resolve(null);
		}));
		backend.on('search_cancel', () => null);
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'fn');
		const pending = view.runSearch();
		const progress = view.container.querySelector('.search-progress')!;
		expect(progress.classList.contains('running')).toBe(true);

		// The first batch renders while the scan is still running - the summary counts so far.
		channel!.send({ kind: 'batch', files: [{ path: 'a.rs', matches: [{ line: 1, column: 1, length: 2, text: 'fn' }] }] });
		await frame();
		expect(progress.classList.contains('running')).toBe(true);
		expect(texts('.search-summary', view.container)).toEqual(['Searching… 1 result so far']);
		expect(texts('.search-file-head .label', view.container)).toEqual(['a.rs']);

		channel!.send({ kind: 'batch', files: [{ path: 'b.rs', matches: [{ line: 2, column: 1, length: 2, text: 'fn' }] }] });
		channel!.send({ kind: 'done', scanned: 40, truncated: false, cancelled: false });
		(channel as unknown as { resolve: () => void }).resolve();
		await pending;
		expect(progress.classList.contains('running')).toBe(false);
		expect(texts('.search-summary', view.container)).toEqual(['2 results in 2 files']);
		expect(texts('.search-file-head .label', view.container)).toEqual(['a.rs', 'b.rs']);
	});

	it('drops the batches of a superseded search and cancels the one in flight', async () => {
		const channels: Channel<SearchEvent>[] = [];
		backend.on('search_workspace', (args) => new Promise(() => {
			channels.push(args.onEvent as Channel<SearchEvent>);
		}));
		const cancel = vi.fn(() => null);
		backend.on('search_cancel', cancel);
		const view = new SearchView(document.createElement('div'));
		const input = view.container.querySelector('.search-row input') as HTMLInputElement;
		type(input, 'first');
		void view.runSearch();
		type(input, 'second');
		void view.runSearch();
		await flush();
		expect(channels).toHaveLength(2);

		// A late batch from the first search never reaches the list…
		channels[0]!.send({ kind: 'batch', files: [{ path: 'stale.rs', matches: [{ line: 1, column: 1, length: 5, text: 'first' }] }] });
		channels[1]!.send({ kind: 'batch', files: [{ path: 'fresh.rs', matches: [{ line: 1, column: 1, length: 6, text: 'second' }] }] });
		await frame();
		expect(texts('.search-file-head .label', view.container)).toEqual(['fresh.rs']);

		// …and clearing the box tells the backend to stop the running one.
		click(view.container.querySelector('[title="Clear Search Results"]'));
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector('.search-progress')!.classList.contains('running')).toBe(false);
	});

	it('clearing the query cancels the search in flight, and its late batches never land', async () => {
		const channels: Channel<SearchEvent>[] = [];
		backend.on('search_workspace', (args) => new Promise(() => {
			channels.push(args.onEvent as Channel<SearchEvent>);
		}));
		const cancel = vi.fn(() => null);
		backend.on('search_cancel', cancel);
		const view = new SearchView(document.createElement('div'));
		const input = view.container.querySelector('.search-row input') as HTMLInputElement;
		type(input, 'fn');
		void view.runSearch();
		await flush();
		expect(channels).toHaveLength(1);

		// Select-all + delete: the box empties, the welcome message returns, and the
		// abandoned search is cancelled like any other superseded one.
		type(input, '');
		await view.runSearch();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector('.search-progress')!.classList.contains('running')).toBe(false);
		expect(view.container.querySelector('.welcome-view')).not.toBeNull();

		// A late batch of the abandoned search must not repopulate the cleared list.
		channels[0]!.send({ kind: 'batch', files: [{ path: 'stale.rs', matches: [{ line: 1, column: 1, length: 2, text: 'fn' }] }] });
		await frame();
		expect(view.container.querySelectorAll('.search-file-head')).toHaveLength(0);
		expect(view.container.querySelector('.welcome-view')).not.toBeNull();
	});

	it('an invalid regex cancels the search in flight, and its late batches never wipe the error', async () => {
		const channels: Channel<SearchEvent>[] = [];
		backend.on('search_workspace', (args) => new Promise(() => {
			channels.push(args.onEvent as Channel<SearchEvent>);
		}));
		const cancel = vi.fn(() => null);
		backend.on('search_cancel', cancel);
		const view = new SearchView(document.createElement('div'));
		const input = view.container.querySelector('.search-row input') as HTMLInputElement;
		click(view.container.querySelector('[title="Use Regular Expression (Alt+R)"]')!);
		type(input, 'fn');
		void view.runSearch();
		await flush();
		expect(channels).toHaveLength(1);

		// Typing '[' makes the regex invalid: the error shows, the old search is cancelled.
		type(input, '[');
		await view.runSearch();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector('.search-progress')!.classList.contains('running')).toBe(false);
		expect(view.container.querySelectorAll('.search-error')).toHaveLength(1);

		// A late batch of the abandoned search neither repopulates the list nor wipes the error.
		channels[0]!.send({ kind: 'batch', files: [{ path: 'stale.rs', matches: [{ line: 1, column: 1, length: 2, text: 'fn' }] }] });
		await frame();
		expect(view.container.querySelectorAll('.search-file-head')).toHaveLength(0);
		expect(view.container.querySelectorAll('.search-error')).toHaveLength(1);
	});

	it('renders the whole tree as plain DOM and collapses a file in place', async () => {
		const matches = Array.from({ length: 100 }, (_, i) => ({ line: i + 1, column: 1, length: 1, text: 'x' }));
		streams([[{ path: 'big.txt', matches }]]);
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'x');
		await view.runSearch();

		// No windowing: the file header and every one of its matches are in the DOM.
		expect(view.container.querySelectorAll('.search-file-head').length).toBe(1);
		expect(view.container.querySelectorAll('.search-rows .search-match').length).toBe(100);

		// Folding flips the group's class and the twistie - no rows are added or removed.
		const group = view.container.querySelector('.search-file-group')!;
		click(view.container.querySelector('.search-file-head')!);
		expect(group.classList.contains('collapsed')).toBe(true);
		expect(view.container.querySelector('.search-file-head .twistie')!.className).toContain('chevron-right');
		expect(view.container.querySelectorAll('.search-rows .search-match').length).toBe(100);
		click(view.container.querySelector('.search-file-head')!);
		expect(group.classList.contains('collapsed')).toBe(false);
		expect(view.container.querySelector('.search-file-head .twistie')!.className).toContain('chevron-down');

		// The title's actions are VS Code's exactly: refresh, clear, collapse all — and no
		// expand-all (a tree that collapses in place offers no unfold-everything action).
		expect(view.container.querySelector('[title="Expand All"]')).toBeNull();
		click(view.container.querySelector('[title="Collapse All"]')!);
		expect(group.classList.contains('collapsed')).toBe(true);
	});

	it("right-click offers VS Code's result menu: Copy / Copy Path / Copy All / Reveal — the file row without the line's Copy", async () => {
		rootedStream([{ path: 'src/lib.rs', matches: [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }] }]);
		const view = await rootedView('fn');

		rightClick(view.container.querySelector('.search-match')!);
		expect(menuLabels()).toEqual(['Copy', 'Copy Path', 'Copy All', 'Reveal in File Explorer']);
		key(document, 'Escape');

		rightClick(view.container.querySelector('.search-file-head')!);
		expect(menuLabels()).toEqual(['Copy Path', 'Copy All', 'Reveal in File Explorer']);
		key(document, 'Escape');
	});

	it('Copy copies the line text, Copy Path the absolute path, Copy All every result path', async () => {
		rootedStream([
			{ path: 'src/lib.rs', matches: [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }] },
			{ path: 'src/main.rs', matches: [{ line: 1, column: 1, length: 2, text: 'fn main' }] }
		]);
		const view = await rootedView('fn');

		rightClick(view.container.querySelector('.search-match')!);
		click(menuItem('Copy Path'));
		await flush();
		expect(backend.clipboard).toEqual(['C:\\repo\\src\\lib.rs']);

		rightClick(view.container.querySelector('.search-match')!);
		click(menuItem('Copy All'));
		await flush();
		expect(backend.clipboard.at(-1)).toBe('C:\\repo\\src\\lib.rs\nC:\\repo\\src\\main.rs');

		rightClick(view.container.querySelector('.search-match')!);
		click(menuItem('Copy'));
		await flush();
		expect(backend.clipboard.at(-1)).toBe('alpha fn beta');
	});

	it('Reveal in File Explorer is desktop-only and reveals the absolute path', async () => {
		rootedStream([{ path: 'src/lib.rs', matches: [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }] }]);
		const view = await rootedView('fn');

		rightClick(view.container.querySelector('.search-match')!);
		expect(menuLabels()).toContain('Reveal in File Explorer');
		click(menuItem('Reveal in File Explorer'));
		await flush();
		expect(backend.revealed).toEqual(['C:\\repo\\src\\lib.rs']);

		// The remote workbench's marker (boot.ts sets it before main.ts loads): a browser page
		// has no desktop File Explorer to reveal into — the row hides, the rest stands.
		document.documentElement.setAttribute('data-remote-shell', '');
		try {
			rightClick(view.container.querySelector('.search-file-head')!);
			expect(menuLabels()).not.toContain('Reveal in File Explorer');
			expect(menuLabels()).toContain('Copy Path');
		} finally {
			document.documentElement.removeAttribute('data-remote-shell');
		}
		key(document, 'Escape');
	});

	it("a single-folder search carries its root: the results absolutize like a multi-root's", async () => {
		const search = streams([[{ path: 'src/lib.rs', matches: [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }] }]]);
		const view = new SearchView(document.createElement('div'));
		view.setRoots(['C:\\repo']);
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'fn');
		await view.runSearch();

		// One invocation, the folder itself passed as the repo: the backend derives the
		// same root either way, and the menu gains the absolute paths to copy and reveal.
		expect((search.mock.calls[0][0] as Record<string, unknown>).repo).toBe('C:\\repo');
		rightClick(view.container.querySelector('.search-match')!);
		expect(menuLabels()).toEqual(['Copy', 'Copy Path', 'Copy All', 'Reveal in File Explorer']);
		click(menuItem('Copy Path'));
		await flush();
		expect(backend.clipboard.at(-1)).toBe('C:\\repo\\src\\lib.rs');
		key(document, 'Escape');
	});

	it('a rootless search (no folder passed) keeps the derived-root fallback and hides Reveal', async () => {
		streams([[{ path: 'src/lib.rs', matches: [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }] }]]);
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row input') as HTMLInputElement, 'fn');
		await view.runSearch();

		rightClick(view.container.querySelector('.search-match')!);
		expect(menuLabels()).toEqual(['Copy', 'Copy Path', 'Copy All']);
		key(document, 'Escape');
	});

	it('replaces all after a confirmation', async () => {
		streams([[{ path: 'a.txt', matches: [{ line: 1, column: 1, length: 1, text: 'x' }] }]]);
		const replace = vi.fn(async () => ({ files: 1, replacements: 1 }));
		backend.on('replace_in_files', replace);
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelectorAll('.search-row input')[0] as HTMLInputElement, 'x');
		type(view.container.querySelectorAll('.search-row input')[1] as HTMLInputElement, 'y');
		await view.runSearch();
		const replacing = view.replaceAll();
		await flush();
		// Nothing ran yet: the confirmation is still up.
		expect(replace).not.toHaveBeenCalled();
		expect(notifications().at(-1)).toBe("Replace 1 occurrence across 1 file with 'y'?");
		click(notificationButton('Replace'));
		await replacing;
		await flush();
		expect(replace).toHaveBeenCalledWith({ query: 'x', replacement: 'y', isRegex: false, caseSensitive: false, wordOnly: false, include: '', exclude: '', preserveCase: false });
		expect(notifications().some((n) => n === "Replaced 1 occurrence across 1 file with 'y'.")).toBe(true);
	});
	it('a replace-all mid-debounce flushes the pending search first: the confirmation counts the query that will replace', async () => {
		const answers: Record<string, FileMatches[]> = {
			x: [{ path: 'a.txt', matches: [{ line: 1, column: 1, length: 1, text: 'x' }] }],
			yy: [{ path: 'b.txt', matches: [{ line: 2, column: 1, length: 2, text: 'yy' }] }]
		};
		backend.on('search_workspace', async (args) => {
			const channel = args.onEvent as Channel<SearchEvent>;
			const files = answers[args.query as string] ?? [];
			if (files.length > 0) channel.send({ kind: 'batch', files });
			channel.send({ kind: 'done', scanned: 1, truncated: false, cancelled: false });
			return null;
		});
		const replace = vi.fn(async () => ({ files: 1, replacements: 1 }));
		backend.on('replace_in_files', replace);
		const view = new SearchView(document.createElement('div'));
		const query = view.container.querySelector('.search-row.query-row input') as HTMLInputElement;
		type(query, 'x');
		await view.runSearch(); // the list holds 'x''s one match in a.txt
		type(query, 'yy'); // edited: the typed search sits on the debounce timer
		type(view.container.querySelectorAll('.search-row input')[1] as HTMLInputElement, 'z');
		const replacing = view.replaceAll();
		await flush();
		// The pending 'yy' search ran before the dialog, so the dialog counts b.txt — never
		// 'x''s stale a.txt count with 'yy' as the query that actually replaces.
		expect(texts('.search-file-head .label', view.container)).toEqual(['b.txt']);
		expect(notifications().at(-1)).toBe("Replace 1 occurrence across 1 file with 'z'?");
		click(notificationButton('Replace'));
		await replacing;
		expect(replace).toHaveBeenCalledWith({ query: 'yy', replacement: 'z', isRegex: false, caseSensitive: false, wordOnly: false, include: '', exclude: '', preserveCase: false });
	});

	it('focuses the query box', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new SearchView(host);
		view.focus();
		expect(document.activeElement).toBe(host.querySelector('.search-row input'));
	});

	it('focus selects the query, ready to be typed over', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new SearchView(host);
		const input = host.querySelector('.search-row.query-row input') as HTMLInputElement;
		type(input, 'previous');
		view.focus();
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe('previous'.length);
	});

	it('recalls executed searches with Up and Down — typed-but-never-run queries are not history', async () => {
		const search = streams([]);
		const view = new SearchView(document.createElement('div'));
		const input = view.container.querySelector('.search-row.query-row input') as HTMLInputElement;
		type(input, 'alpha');
		await view.runSearch();
		type(input, 'beta');
		await view.runSearch();
		// A half-typed query that never ran stays out of the history (Zed records project
		// searches on confirmation, not as they type).
		type(input, 'ga');
		key(input, 'ArrowUp'); // the last confirmed search
		expect(input.value).toBe('beta');
		key(input, 'ArrowUp');
		expect(input.value).toBe('alpha');
		key(input, 'ArrowDown');
		expect(input.value).toBe('beta');
		key(input, 'ArrowDown'); // past the newest: the unconfirmed draft returns
		expect(input.value).toBe('ga');
		expect(search).toHaveBeenCalledTimes(2);
	});

	it('the include field recalls its own history, not the query\'s', async () => {
		const view = new SearchView(document.createElement('div'));
		const query = view.container.querySelector('.search-row.query-row input') as HTMLInputElement;
		const include = view.container.querySelector('.search-filter-rows input') as HTMLInputElement;
		type(query, 'needle');
		type(include, '*.rs');
		await view.runSearch();
		type(include, '*.ts');
		await view.runSearch();
		key(include, 'ArrowUp');
		expect(include.value).toBe('*.rs');
		expect(query.value).toBe('needle'); // the query field's text is not the include history's
	});

	it('smart case: an uppercase query turns Match Case on and reaches the backend', async () => {
		const search = streams([]);
		const view = new SearchView(document.createElement('div'));
		const input = view.container.querySelector('.search-row.query-row input') as HTMLInputElement;
		type(input, 'Foo');
		await view.runSearch();
		expect(search.mock.calls.at(-1)![0]).toMatchObject({ query: 'Foo', caseSensitive: true });
		expect(view.container.querySelector('[title="Match Case (Alt+C)"]')!.classList.contains('active')).toBe(true);
		// An all-lowercase query turns it back off.
		type(input, 'foo');
		await view.runSearch();
		expect(search.mock.calls.at(-1)![0]).toMatchObject({ query: 'foo', caseSensitive: false });
		expect(view.container.querySelector('[title="Match Case (Alt+C)"]')!.classList.contains('active')).toBe(false);
	});

	it('smart case off: the query\'s case leaves the toggle alone', async () => {
		const held = settings.searchSmartCase;
		settings.searchSmartCase = false;
		try {
			const search = streams([]);
			const view = new SearchView(document.createElement('div'));
			const input = view.container.querySelector('.search-row.query-row input') as HTMLInputElement;
			type(input, 'Foo');
			await view.runSearch();
			expect(search.mock.calls.at(-1)![0]).toMatchObject({ query: 'Foo', caseSensitive: false });
			expect(view.container.querySelector('[title="Match Case (Alt+C)"]')!.classList.contains('active')).toBe(false);
		} finally {
			settings.searchSmartCase = held;
		}
	});

	it('seedQuery fills the box (escaped for a regex search) and runs the search', async () => {
		const search = streams([]);
		const view = new SearchView(document.createElement('div'));
		view.seedQuery('fn (');
		const input = view.container.querySelector('.search-row.query-row input') as HTMLInputElement;
		expect(input.value).toBe('fn (');
		// With the regex toggle on, the seed is escaped so the literal text is searched.
		click(view.container.querySelector('[title="Use Regular Expression (Alt+R)"]')!);
		view.seedQuery('fn (');
		expect(input.value).toBe('fn \\(');
		// The seeded search runs after the typing pause, as if it had been typed.
		await new Promise((resolve) => setTimeout(resolve, 350));
		await flush();
		expect(search).toHaveBeenCalled();
		expect(search.mock.calls.at(-1)![0]).toMatchObject({ query: 'fn \\(', isRegex: true });
	});
});

describe('Search view: Preserve Case, per-result replace, keyboard', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('the Preserve Case toggle lights, rides Alt+P and reaches both replace flows', async () => {
		streams([[{ path: 'a.txt', matches: [{ line: 1, column: 1, length: 3, text: 'foo' }] }]]);
		const replace = vi.fn(async () => ({ files: 1, replacements: 1 }));
		backend.on('replace_in_files', replace);
		const view = new SearchView(document.createElement('div'));
		const toggle = view.container.querySelector('[title="Preserve Case (Alt+P)"]')!;
		expect(toggle.classList.contains('active')).toBe(false);

		// The Alt+P chord flips it right in the query box.
		key(view.container.querySelector('.search-row.query-row input') as HTMLInputElement, 'p', { altKey: true });
		expect(toggle.classList.contains('active')).toBe(true);

		type(view.container.querySelectorAll('.search-row input')[0] as HTMLInputElement, 'foo');
		type(view.container.querySelectorAll('.search-row input')[1] as HTMLInputElement, 'bar');
		await view.runSearch();
		const replacing = view.replaceAll();
		await flush();
		click(notificationButton('Replace'));
		await replacing;
		expect(replace).toHaveBeenCalledWith({ query: 'foo', replacement: 'bar', isRegex: false, caseSensitive: false, wordOnly: false, include: '', exclude: '', preserveCase: true });
		// The search itself never reads the option.
		expect(view.container.querySelector('[title="Preserve Case (Alt+P)"]')!.classList.contains('active')).toBe(true);
	});

	it('the hover button replaces exactly the listed match and repaints the group from the remaining matches', async () => {
		streams([[
			{ path: 'src/a.rs', matches: [{ line: 3, column: 5, length: 2, text: 'fn alpha()' }] },
			{ path: 'src/b.rs', matches: [{ line: 1, column: 1, length: 2, text: 'fn main()' }] }
		]]);
		const one = vi.fn(async (args: Record<string, unknown>) => {
			expect(args).toMatchObject({ path: 'src/a.rs', line: 3, column: 5, query: 'fn', replacement: 'trait', preserveCase: false });
			// The line no longer matches `fn` after the splice: no matches remain on it.
			return [];
		});
		backend.on('search_replace_one', one);
		const view = new SearchView(document.createElement('div'));
		view.setRoots(['C:\\repo']);
		type(view.container.querySelector('.search-row.query-row input') as HTMLInputElement, 'fn');
		type(view.container.querySelectorAll('.search-row input')[1] as HTMLInputElement, 'trait');
		await view.runSearch();
		expect(texts('.search-summary', view.container)).toEqual(['2 results in 2 files']);

		click(view.container.querySelectorAll('.search-match .match-replace')[0]);
		await flush();
		expect(one).toHaveBeenCalledTimes(1);
		// The replaced row is gone; the file's group holds its other match, the summary follows.
		expect(texts('.search-file-head .label', view.container)).toEqual(['b.rs']);
		expect(texts('.search-summary', view.container)).toEqual(['1 result in 1 file']);
	});

	it('a per-result replace that empties a file drops its group; a changed-disk refusal reports', async () => {
		// A fresh batch per search: the real backend re-reads the file each scan, and the
		// view's local update (the splice in replaceOne) owns the batch's matches array.
		const search = vi.fn(async (args: Record<string, unknown>) => {
			const channel = args.onEvent as Channel<SearchEvent>;
			channel.send({ kind: 'batch', files: [{ path: 'a.txt', matches: [{ line: 1, column: 1, length: 1, text: 'x' }] }] });
			channel.send({ kind: 'done', scanned: 1, truncated: false, cancelled: false });
			return null;
		});
		backend.on('search_workspace', search);
		backend.on('search_cancel', () => null);
		const replaceOne = vi.fn(async () => [] as { line: number; column: number; length: number; text: string }[]);
		backend.on('search_replace_one', replaceOne);
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.search-row.query-row input') as HTMLInputElement, 'x');
		await view.runSearch();
		click(view.container.querySelector('.search-match .match-replace')!);
		await flush();
		expect(view.container.querySelectorAll('.search-file-group')).toHaveLength(0);

		// The file changed on disk since the search: the error surfaces, the tree stands.
		replaceOne.mockRejectedValue(new Error('no longer on disk'));
		type(view.container.querySelector('.search-row.query-row input') as HTMLInputElement, 'y');
		await view.runSearch();
		click(view.container.querySelector('.search-match .match-replace')!);
		await flush();
		expect(notifications().at(-1)).toContain('no longer on disk');
		expect(view.container.querySelectorAll('.search-file-group')).toHaveLength(1);
	});

	it('the result tree answers the keyboard: arrows walk, Enter opens, F4 jumps', async () => {
		streams([[
			{ path: 'a.txt', matches: [{ line: 1, column: 1, length: 1, text: 'x one' }, { line: 2, column: 1, length: 1, text: 'x two' }] },
			{ path: 'b.txt', matches: [{ line: 1, column: 1, length: 1, text: 'x three' }] }
		]]);
		const view = new SearchView(document.createElement('div'));
		const opened: [string, number, number][] = [];
		view.onOpenMatch = (path, line, column) => opened.push([path, line, column]);
		type(view.container.querySelector('.search-row.query-row input') as HTMLInputElement, 'x');
		await view.runSearch();
		const list = view.container.querySelector('.search-results') as HTMLElement;
		const rows = () => Array.from(view.container.querySelectorAll<HTMLElement>('.search-match'));

		// Nothing is focused yet: ArrowDown lands on the first row.
		key(list, 'ArrowDown');
		expect(rows()[0].classList.contains('kb-focused')).toBe(true);
		key(list, 'ArrowDown');
		expect(rows()[0].classList.contains('kb-focused')).toBe(false);
		expect(rows()[1].classList.contains('kb-focused')).toBe(true);
		// Enter opens the focused match; the walk steps into the next file naturally.
		key(list, 'Enter');
		expect(opened).toEqual([['a.txt', 2, 1]]);
		key(list, 'ArrowDown');
		expect(rows()[2].classList.contains('kb-focused')).toBe(true);

		// F4 jumps to (and opens) the next match, Shift+F4 the previous one.
		key(list, 'F4', { shiftKey: true });
		expect(opened.at(-1)).toEqual(['a.txt', 2, 1]);
		key(list, 'F4');
		expect(rows()[2].classList.contains('kb-focused')).toBe(true);
		expect(opened.at(-1)).toEqual(['b.txt', 1, 1]);

		// A new search clears the walk's focus with the old tree.
		await view.runSearch();
		expect(view.container.querySelector('.kb-focused')).toBeNull();
	});

	it('seedInclude sets the include glob and the search runs after the typing pause', async () => {
		const search = streams([]);
		const view = new SearchView(document.createElement('div'));
		view.seedQuery('fn');
		view.seedInclude('src/**');
		const include = view.container.querySelector('.search-filter-rows input') as HTMLInputElement;
		expect(include.value).toBe('src/**');
		await new Promise((resolve) => setTimeout(resolve, 350));
		await flush();
		expect(search).toHaveBeenCalled();
		expect(search.mock.calls.at(-1)![0]).toMatchObject({ query: 'fn', include: 'src/**' });
	});
});

describe('Search view: the VS Code widget details', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('the Preserve Case toggle rides the replace widget, hidden with its row', () => {
		const view = new SearchView(document.createElement('div'));
		const replaceWidget = view.container.querySelector('.replace-row .search-widget')!;
		// The toggle lives beside the Replace All button, inside the folded replace row.
		expect(replaceWidget.querySelector('[title="Preserve Case (Alt+P)"]')).not.toBeNull();
		expect(replaceWidget.querySelector('button[title*="Replace All"]')).toBeTruthy();
		// The query box no longer carries it.
		expect(view.container.querySelector('.query-row [title="Preserve Case (Alt+P)"]')).toBeNull();
	});

	it('the include / exclude fields carry their VS Code headers, placeholders shown on focus only', () => {
		const view = new SearchView(document.createElement('div'));
		view.toggleFilters();
		const rows = view.container.querySelectorAll('.search-filter-row');
		expect(rows).toHaveLength(2);
		expect(texts('.search-filter-row h4', view.container)).toEqual(['files to include', 'files to exclude']);
		const include = rows[0]!.querySelector('input') as HTMLInputElement;
		expect(include.placeholder).toBe('');
		include.dispatchEvent(new FocusEvent('focus'));
		expect(include.placeholder).toBe('e.g. *.ts, src/**/include');
		include.dispatchEvent(new FocusEvent('blur'));
		expect(include.placeholder).toBe('');
	});

	it('Ctrl+Down walks query → replace → include → exclude and wraps; Ctrl+Up walks back', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new SearchView(host);
		view.focusReplace();
		view.toggleFilters();
		const query = host.querySelector('.query-row input') as HTMLInputElement;
		const replace = host.querySelector('.replace-row input') as HTMLInputElement;
		const [include, exclude] = Array.from(host.querySelectorAll('.search-filter-row input')) as HTMLInputElement[];
		query.focus();
		key(query, 'ArrowDown', { ctrlKey: true });
		expect(document.activeElement).toBe(replace);
		key(replace, 'ArrowDown', { ctrlKey: true });
		expect(document.activeElement).toBe(include);
		key(include, 'ArrowDown', { ctrlKey: true });
		expect(document.activeElement).toBe(exclude);
		key(exclude, 'ArrowDown', { ctrlKey: true });
		expect(document.activeElement).toBe(query);
		key(query, 'ArrowUp', { ctrlKey: true });
		expect(document.activeElement).toBe(exclude);
		host.remove();
	});

	it('the Replace All button title explains the disabled state, as VS Code does', async () => {
		const view = new SearchView(document.createElement('div'));
		const button = view.container.querySelector('.replace-row .action-btn[title*="Replace All"], .replace-row button[title^="Replace All"]') as HTMLButtonElement;
		expect(button.title).toBe('Replace All (Submit Search to Enable)');
		expect(button.disabled).toBe(true);

		streams([[{ path: 'a.txt', matches: [{ line: 1, column: 1, length: 1, text: 'x' }] }]]);
		type(view.container.querySelector('.query-row input') as HTMLInputElement, 'x');
		await view.runSearch();
		expect(button.title).toBe('Replace All');
		expect(button.disabled).toBe(false);
	});

	it('an empty answer shows the no-results hint with an Open Settings link', async () => {
		streams([], { scanned: 3 });
		const view = new SearchView(document.createElement('div'));
		type(view.container.querySelector('.query-row input') as HTMLInputElement, 'nothing');
		await view.runSearch();
		const summary = view.container.querySelector('.search-summary')!;
		expect(summary.textContent).toContain('No results found. Review your configured exclusions and check your gitignore files');
		expect(summary.querySelector('.search-link')!.textContent).toBe('Open Settings');
	});

	it('no folder open: the welcome names it and offers Open Folder', () => {
		const view = new SearchView(document.createElement('div'));
		view.setEnabled(false);
		const welcome = view.container.querySelector('.welcome-view')!;
		expect(welcome.textContent).toContain('You have not opened or specified a folder');
		expect(welcome.querySelector('.search-link')!.textContent).toBe('Open Folder');
		// A folder opening flips back to the normal empty-query welcome.
		view.setEnabled(true);
		expect(view.container.querySelector('.welcome-view')!.textContent).toContain('Type to search');
	});

	it('the file header gains a hover Replace All in replace mode, rewriting exactly that file', async () => {
		const replace = vi.fn(async () => ({ files: 1, replacements: 2 }));
		backend.on('replace_in_files', replace);
		// The post-write re-search answers the file with one match left.
		let pass = 0;
		backend.on('search_workspace', async (args) => {
			const channel = args.onEvent as Channel<SearchEvent>;
			pass++;
			const matches = pass === 1
				? [{ line: 1, column: 1, length: 1, text: 'x one' }, { line: 2, column: 1, length: 1, text: 'x two' }]
				: [{ line: 2, column: 1, length: 1, text: 'y two' }];
			channel.send({ kind: 'batch', files: [{ path: 'src/a.rs', matches }] });
			channel.send({ kind: 'done', scanned: 1, truncated: false, cancelled: false });
			return null;
		});
		backend.on('search_cancel', () => null);
		const view = new SearchView(document.createElement('div'));
		view.setRoots(['C:\\repo']);
		click(view.container.querySelector('.search-replace-toggle')!);
		type(view.container.querySelector('.query-row input') as HTMLInputElement, 'x');
		await view.runSearch();

		click(view.container.querySelector('.search-file-head .file-replace')!);
		await flush();
		// The workspace replace ran with the file's own path as the include glob, in its root.
		expect(replace).toHaveBeenCalledTimes(1);
		expect(replace.mock.calls[0]![0]).toMatchObject({ query: 'x', include: 'src/a.rs', replacement: '', repo: 'C:\\repo' });
		// The tree re-listed what remains after the write.
		expect(texts('.search-file-head .badge', view.container)).toEqual(['1']);
		expect(texts('.search-match .hit', view.container)).toEqual(['y']);
	});

	it('replace mode adds the context menu replace rows: Replace on a match, Replace All on a file', async () => {
		rootedStream([{ path: 'src/lib.rs', matches: [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }] }]);
		// The single replace keeps its match (a fresh listing after the row's edit re-answers).
		const replaceOne = vi.fn(async () => [{ line: 3, column: 7, length: 2, text: 'alpha fn beta' }]);
		backend.on('search_replace_one', replaceOne);
		const replaceAll = vi.fn(async () => ({ files: 1, replacements: 1 }));
		backend.on('replace_in_files', replaceAll);
		const view = await rootedView('fn');

		// Replace mode off: the menus are the copy set only.
		rightClick(view.container.querySelector('.search-match')!);
		expect(menuLabels()).toEqual(['Copy', 'Copy Path', 'Copy All', 'Reveal in File Explorer']);
		key(document, 'Escape');

		click(view.container.querySelector('.search-replace-toggle')!);
		rightClick(view.container.querySelector('.search-match')!);
		expect(menuLabels()).toEqual(['Copy', 'Replace', 'Copy Path', 'Copy All', 'Reveal in File Explorer']);
		click(menuItem('Replace'));
		await flush();
		expect(replaceOne).toHaveBeenCalledTimes(1);
		key(document, 'Escape');

		rightClick(view.container.querySelector('.search-file-head')!);
		expect(menuLabels()).toEqual(['Replace All', 'Copy Path', 'Copy All', 'Reveal in File Explorer']);
		click(menuItem('Replace All'));
		await flush();
		expect(replaceAll).toHaveBeenCalledTimes(1);
		expect(replaceAll.mock.calls[0]![0]).toMatchObject({ include: 'src/lib.rs' });
		key(document, 'Escape');
	});
});
