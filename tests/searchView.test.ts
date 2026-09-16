// The Search view: the query box and its toggles, the backend call it makes, the grouped
// results it renders, and the replace-all flow (confirm dialog included).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { backend, Channel } from './tauriMock';
import { click, flush, key, notifications, notificationButton, texts, type } from './helpers';
import { SearchView, renderMatchLine, validateQuery, type FileMatches, type SearchEvent } from '../src/searchView';
import { settings } from '../src/settings';

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

		// The title's collapse-all / expand-all reach the same groups.
		click(view.container.querySelector('[title="Collapse All"]')!);
		expect(group.classList.contains('collapsed')).toBe(true);
		click(view.container.querySelector('[title="Expand All"]')!);
		expect(group.classList.contains('collapsed')).toBe(false);
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
		expect(replace).toHaveBeenCalledWith({ query: 'x', replacement: 'y', isRegex: false, caseSensitive: false, wordOnly: false, include: '', exclude: '' });
		expect(notifications().some((n) => n === "Replaced 1 occurrence across 1 file with 'y'.")).toBe(true);
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
