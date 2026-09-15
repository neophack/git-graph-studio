// Multi-root workspaces (M3 3.8): the Explorer's virtual top level, and the Search view
// running its query root by root with results that remember which root they came from.

import { beforeEach, describe, expect, it } from 'vitest';

import { Explorer } from '../src/explorer';
import { SearchView } from '../src/searchView';
import { backend } from './tauriMock';
import { click, flush, texts } from './helpers';

describe('the multi-root explorer', () => {
	beforeEach(() => {
		const part = document.getElementById('editorGroup')!;
		part.innerHTML = '';
		document.body.querySelectorAll('.view').forEach((view) => view.remove());
		backend.on('list_dir', ({ path }) => {
			const dir = String(path);
			if (dir === 'C:\\ws\\alpha') return [{ name: 'a.txt', path: 'C:\\ws\\alpha\\a.txt', isDir: false, size: 1 }];
			if (dir === 'C:\\ws\\beta') return [{ name: 'b.txt', path: 'C:\\ws\\beta\\b.txt', isDir: false, size: 1 }];
			if (dir === 'C:\\ws') {
				return [
					{ name: 'alpha', path: 'C:\\ws\\alpha', isDir: true, size: 0 },
					{ name: 'beta', path: 'C:\\ws\\beta', isDir: true, size: 0 }
				];
			}
			return [];
		});
	});

	it('renders one expandable root row per workspace folder', async () => {
		const explorer = new Explorer(el0());
		explorer.setRoots(['C:\\ws\\alpha', 'C:\\ws\\beta']);
		await flush();
		const labels = texts('.tree > .row .label');
		expect(labels).toEqual(['alpha', 'beta']);
		// Both roots start expanded: their files show beneath their own root row.
		expect(texts('.tree .row .label')).toEqual(['alpha', 'a.txt', 'beta', 'b.txt']);
	});

	it('a single root keeps the plain tree (no virtual level)', async () => {
		const explorer = new Explorer(el0());
		explorer.setRoots(['C:\\ws']);
		await flush();
		expect(texts('.tree > .row .label')).toEqual(['alpha', 'beta']);
	});
});

describe('the multi-root search', () => {
	beforeEach(() => {
		const part = document.getElementById('editorGroup')!;
		part.innerHTML = '';
		document.body.querySelectorAll('.view').forEach((view) => view.remove());
	});

	it('searches each root in turn, tagging results with their root', async () => {
		const calls: (string | undefined)[] = [];
		backend.on('search_workspace', ({ repo, onEvent }) => {
			const root = repo as string | undefined;
			calls.push(root);
			const channel = onEvent as { onmessage: (event: unknown) => void };
			channel.onmessage({
				kind: 'batch',
				files: [{ path: 'src/main.rs', matches: [{ line: 1, column: 1, text: 'one', length: 3 }] }]
			});
			channel.onmessage({ kind: 'done', scanned: 1, truncated: false, cancelled: false });
			return null;
		});
		const search = new SearchView(el0());
		search.setEnabled(true);
		search.setRoots(['C:\\ws\\alpha', 'C:\\ws\\beta']);
		const opened: string[] = [];
		search.onOpenMatch = (path, _line, _column, root) => opened.push(`${root ?? ''}/${path}`);
		await search.runSearch();
		// Setting the query first, then running: the view searches on runSearch with its query.
		expect(calls).toEqual([]);
		// (runSearch with an empty query is a reset; type and run.)
		const input = document.querySelector('.view .search-input, .view input') as HTMLInputElement;
		input.value = 'one';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 400)); // the search debounces
		expect(calls).toEqual(['C:\\ws\\alpha', 'C:\\ws\\beta']);
		// The same relative path under two roots stays two results, opening in their own root.
		click(document.querySelector('.search-match'));
		expect(opened[0]).toBe('C:\\ws\\alpha/src/main.rs');
	});
});

function el0(): HTMLElement {
	const view = document.createElement('div');
	view.className = 'view';
	document.body.appendChild(view);
	return view;
}
