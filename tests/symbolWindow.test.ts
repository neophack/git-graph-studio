// The Symbol Window sidebar page (module 5): the active file's includes/imports and its
// indexed outline, the click-through jump at the 1-based line, the cursor-following
// highlight with its one-query-per-file rule, the filter, the hidden page's deferred
// load — and the workbench wiring (the palette command, the activity bar entry, the
// zh-cn title pairs).

import { beforeEach, describe, expect, it } from 'vitest';

import { SymbolWindowView } from '../src/features/search/symbolWindowView';
import { commands } from '../src/platform/commands';
import { trText } from '../src/platform/i18n';
import { updateSetting } from '../src/platform/settings';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, texts } from './helpers';

const FILE = 'C:\\repo\\src\\main.c';

const OUTLINE = {
	symbols: [
		{ kind: 'struct', name: 'Config', container: null, line: 0, endLine: 9 },
		{ kind: 'method', name: 'load', container: 'Config', line: 3, endLine: 6 },
		{ kind: 'function', name: 'main', container: null, line: 12, endLine: 20 }
	],
	imports: [
		{ name: 'stdio.h', line: 0 },
		{ name: 'config.h', line: 3 }
	]
};

/** A fresh host element the view mounts into — its own display is untouched, so the
 *  view reads as visible (the workbench is what hides its views with display:none). */
function mountView(): { host: HTMLElement; view: SymbolWindowView } {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const view = new SymbolWindowView(host);
	return { host, view };
}

function rowOf(host: HTMLElement, name: string): HTMLElement {
	return Array.from(host.querySelectorAll<HTMLElement>('.sw-row')).find((row) => row.querySelector('.sw-name')?.textContent === name)!;
}

beforeEach(async () => {
	backend.reset();
	updateSetting('locale', 'en');
});

describe('rendering the outline', () => {
	it('lists the symbols in line order with containers, imports and 1-based lines', async () => {
		backend.on('symbol_file_outline', ({ path }) => {
			expect(path).toBe(FILE);
			return OUTLINE;
		});
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);

		expect(texts('.sw-row .sw-name', host)).toEqual(['Config', 'load', 'main']);
		// The method's row carries its enclosing type as the faint prefix.
		expect(rowOf(host, 'load').querySelector('.sw-container')!.textContent).toBe('Config·');
		expect(rowOf(host, 'Config').querySelector('.sw-container')).toBeNull();
		// The row line column is 1-based; the dataset carries the 0-based source line.
		expect(texts('.sw-row .sw-line', host)).toEqual(['1', '4', '13']);
		expect(rowOf(host, 'load').dataset['line']).toBe('3');
		expect(rowOf(host, 'load').dataset['path']).toBe(FILE);
		// The imports section renders every import name once.
		expect(texts('.sw-section-label', host)).toEqual(['Includes / Imports']);
		expect(texts('.sw-import-row .sw-name', host)).toEqual(['stdio.h', 'config.h']);
		// The header names the file.
		expect(host.querySelector<HTMLElement>('.sw-title')!.textContent).toBe('main.c');
	});

	it('clicks open the declaration at the 1-based line', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		const opened: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opened.push({ path, line });
		click(rowOf(host, 'main'));
		expect(opened).toEqual([{ path: FILE, line: 13 }]);
	});

	// The symbol window's include row is itself a jump — the editor lands on the
	// include's own line (the outline line is 0-based; a 0 line is the file's first).
	it('an include row jumps to the include line in the same file', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		const opened: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opened.push({ path, line });
		const includeRow = (name: string) =>
			Array.from(host.querySelectorAll<HTMLElement>('.sw-import-row')).find((row) => row.querySelector('.sw-name')?.textContent === name)!;
		click(includeRow('config.h'));
		expect(opened).toEqual([{ path: FILE, line: 4 }]);
		click(includeRow('stdio.h'));
		expect(opened[1]).toEqual({ path: FILE, line: 1 }, 'line 0 is the file\'s first line');
	});

	it('a file without imports renders no imports section', async () => {
		backend.on('symbol_file_outline', () => ({ symbols: OUTLINE.symbols, imports: [] }));
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		expect(host.querySelector('.sw-imports')).toBeNull();
		expect(host.querySelector('.sw-section')).toBeNull();
		expect(texts('.sw-row .sw-name', host)).toEqual(['Config', 'load', 'main']);
	});

	it('collapses and reopens the imports section', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		click(host.querySelector('.sw-section')!);
		expect(host.querySelectorAll('.sw-import-row')).toHaveLength(0);
		expect(texts('.sw-section-label', host)).toEqual(['Includes / Imports']);
		click(host.querySelector('.sw-section')!);
		expect(host.querySelectorAll('.sw-import-row')).toHaveLength(2);
	});
});

describe('the filter', () => {
	it('narrows the rows by a case-insensitive substring and restores on clear', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);

		const filter = host.querySelector<HTMLInputElement>('.sw-filter')!;
		filter.value = 'LOA';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(texts('.sw-row .sw-name', host)).toEqual(['load']);

		filter.value = '';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(texts('.sw-row .sw-name', host)).toEqual(['Config', 'load', 'main']);
	});
});

describe('the cursor highlight', () => {
	it('marks the one row whose span holds the cursor and never re-queries for the same file', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1);

		// Line 4 (0-based) sits inside load()'s [3, 6] — that row and only that row.
		view.setFile(FILE, 4);
		await flush(2);
		expect(rowOf(host, 'load').classList.contains('current')).toBe(true);
		expect(rowOf(host, 'Config').classList.contains('current')).toBe(false);
		expect(rowOf(host, 'main').classList.contains('current')).toBe(false);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1, 'the cursor moved, the index was not asked');

		// The highlight climbs to Config (a cursor inside the struct but above the method),
		// then leaves every row when the line is inside no span.
		view.setFile(FILE, 1);
		expect(rowOf(host, 'Config').classList.contains('current')).toBe(true);
		expect(rowOf(host, 'load').classList.contains('current')).toBe(false);
		const configRow = rowOf(host, 'Config');
		view.setFile(FILE, 100);
		expect(configRow.classList.contains('current')).toBe(false);
		expect(host.querySelectorAll('.sw-row.current')).toHaveLength(0);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1);

		// A cursor roaming inside one symbol repaints nothing at all.
		const loadRow = rowOf(host, 'load');
		view.setFile(FILE, 5);
		view.setFile(FILE, 4);
		expect(rowOf(host, 'load')).toBe(loadRow);
		expect(loadRow.classList.contains('current')).toBe(true);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1);
	});

	it('re-queries on refresh(): the same file may have changed on disk', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { view } = mountView();
		view.setFile(FILE);
		await flush(4);
		view.refresh();
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(2);
	});
});

describe('the scroll follow', () => {
	/** scrollIntoView is stubbed to a no-op in tests/setup.ts; the swaps below record
	 *  which element the view asked the browser to keep on screen (preview.test.ts's move). */
	function recordingScroll(): { calls: HTMLElement[]; restore: () => void } {
		const calls: HTMLElement[] = [];
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) {
			calls.push(this as HTMLElement);
		};
		return { calls, restore: () => { Element.prototype.scrollIntoView = original; } };
	}

	it('scrolls the newly highlighted row into view, and only when it changes', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE, 4);
		await flush(4);
		const { calls, restore } = recordingScroll();
		try {
			// A cursor roaming inside one symbol changes nothing — no scroll at all.
			view.setFile(FILE, 5);
			view.setFile(FILE, 6);
			expect(calls).toHaveLength(0);
			// The highlight leaves load for main: exactly one scroll, onto main's row.
			view.setFile(FILE, 13);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toBe(rowOf(host, 'main'));
			// A cursor roaming inside main scrolls nothing.
			view.setFile(FILE, 15);
			expect(calls).toHaveLength(1);
			// Back to load: one more scroll onto the load row.
			view.setFile(FILE, 4);
			expect(calls).toHaveLength(2);
			expect(calls[1]).toBe(rowOf(host, 'load'));
		} finally {
			restore();
		}
	});

	it('a hidden page changes its highlight without scrolling', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE, 4);
		await flush(4);
		const { calls, restore } = recordingScroll();
		try {
			host.style.display = 'none';
			view.setFile(FILE, 13);
			expect(rowOf(host, 'main').classList.contains('current')).toBe(true);
			expect(calls).toHaveLength(0, 'a display:none page has no layout to scroll');
			// Shown again, the next change scrolls as usual.
			host.style.display = 'flex';
			view.setFile(FILE, 1);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toBe(rowOf(host, 'Config'));
		} finally {
			restore();
		}
	});
});

describe('the hidden page defers its load', () => {
	it('marks a new file dirty while display:none and loads when the refresh hook asks', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1);

		// The workbench hides the page (as showView does) before the active editor moves.
		host.style.display = 'none';
		view.setFile('C:\\repo\\src\\other.c');
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1, 'a hidden page asks for nothing');

		// showView() reveals the page and then calls the refresh hook.
		host.style.display = 'flex';
		view.refresh();
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(2);
		expect(backend.callsTo('symbol_file_outline')[1]!['path']).toBe('C:\\repo\\src\\other.c');
		expect(texts('.sw-row .sw-name', host)).toEqual(['Config', 'load', 'main'], 'the new file served');
	});
});

describe('the empty and failed states', () => {
	it('rests empty without an active editor', () => {
		const { host } = mountView();
		expect(host.querySelector('.sw-empty')!.textContent).toContain('Open a file');
		expect(host.querySelector('.sw-row')).toBeNull();
	});

	it('shows the no-index text when the outline answers null or fails', async () => {
		backend.on('symbol_file_outline', () => null);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		expect(host.querySelector('.sw-empty')!.textContent).toContain('No symbols indexed');

		backend.on('symbol_file_outline', () => {
			throw new Error('index gone');
		});
		view.refresh();
		await flush(4);
		expect(host.querySelector('.sw-empty')!.textContent).toContain('No symbols indexed');
	});

	it('shows the no-index text for an outline without symbols', async () => {
		backend.on('symbol_file_outline', () => ({ symbols: [], imports: [] }));
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		expect(host.querySelector('.sw-empty')!.textContent).toContain('No symbols indexed');
	});
});

describe('the workbench wiring', () => {
	/** The proven boot table (tests/menuI18n.test.ts): the workbench constructor and boot
	 *  against these handlers reach a settled shell without any unhandled invoke. */
	let workbench: Workbench;

	beforeEach(async () => {
		backend.on('boot_context', () => ({ file: null, actions: [], repo: 'C:\\repo' }));
		backend.on('open_folder', ({ path }) => ({ root: path, isRepo: true }));
		backend.on('boot_stage', () => null);
		backend.on('list_dir', () => []);
		backend.on('list_files', () => []);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
		backend.on('scm_status', () => []);
		backend.on('scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: null }]);
		backend.on('scm_remotes', () => []);
		backend.on('scm_tags', () => []);
		backend.on('scm_stashes', () => []);
		backend.on('ext_list', () => []);
		backend.on('keybindings_read', () => null);
		backend.on('settings_read', () => null);
		backend.on('backup_list', () => []);
		backend.on('git_output_log', () => []);
		backend.on('graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null, errors: [null], commits: [] }));
		backend.on('symbol_file_outline', () => OUTLINE);
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		workbench?.dispose();
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
	});

	it('registers the view command in the palette, the activity bar entry, and the zh-cn pairs', async () => {
		const command = commands.get('workbench.showSymbolWindow');
		expect(command).toBeDefined();
		expect(command!.keybinding).toBe('Alt+L');
		expect(commands.paletteItems().some((item) => item.value === 'workbench.showSymbolWindow')).toBe(true);

		// The activity bar's entry mirrors the view id and carries the new tooltip's pair.
		const item = workbench.activityItems['symbolWindow'];
		expect(item).toBeDefined();
		expect(item.dataset['view']).toBe('symbolWindow');

		updateSetting('locale', 'zh-cn');
		expect(trText('Symbol Window')).toBe('符号窗口');
		expect(trText('Symbols (Alt+L)')).toBe('符号 (Alt+L)');
		updateSetting('locale', 'en');
	});

	it('feeds the view from the editor group: the shown page loads, a hidden one defers, no editor clears it', async () => {
		// The booted page is hidden (the boot's view is the Explorer): an active editor's
		// payload marks it dirty and asks for nothing yet.
		workbench.symbolWindow.setFile(FILE, 4);
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(0);
		// showView('symbolWindow') reveals the page and its refresh hook pulls.
		workbench.showView('symbolWindow');
		await flush(4);
		expect(backend.callsTo('symbol_file_outline')).toHaveLength(1);
		expect(backend.callsTo('symbol_file_outline')[0]!['path']).toBe(FILE);
		expect(workbench.views.symbolWindow.querySelector('.sw-row')!.dataset['path']).toBe(FILE);
		// No active editor clears the page.
		workbench.symbolWindow.setFile(null);
		expect(workbench.views.symbolWindow.querySelector('.sw-empty')!.textContent).toContain('Open a file');
	});
});
