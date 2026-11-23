// The Symbol Window sidebar page (module 5): the active file's includes/imports and its
// indexed outline, the click-through jump at the 1-based line, the cursor-following
// highlight with its one-query-per-file rule, the filter, the hidden page's deferred
// load — the current function's locals section (asked once per covering symbol's
// identity over the host's live buffer), the container chain's indentation — and the
// workbench wiring (the palette command, the activity bar entry, the text hook, the
// zh-cn title pairs).

import { beforeEach, describe, expect, it } from 'vitest';

import { SymbolWindowView } from '../src/features/search/symbolWindowView';
import { commands } from '../src/platform/commands';
import { trText } from '../src/platform/i18n';
import { updateSetting } from '../src/platform/settings';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, key, texts, type } from './helpers';

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
		// The tree filter keeps the matching row's ancestor — 'load' under its Config.
		expect(texts('.sw-row .sw-name', host)).toEqual(['Config', 'load']);

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

describe('the current function locals', () => {
	const LOCALS = [
		{ kind: 'parameter', name: 'cfg', line: 3, column: 11, scopeEnd: 6 },
		{ kind: 'variable', name: 'tmp', line: 5, column: 2, scopeEnd: 6 }
	];
	const SOURCE = 'int load(Config *cfg) {\n\tint tmp = 0;\n\treturn tmp;\n}';

	it('renders the covering function\'s locals and jumps at the 1-based lines', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		backend.on('symbol_locals', () => LOCALS);
		const { host, view } = mountView();
		view.provideText = () => SOURCE;
		view.setFile(FILE);
		await flush(4);
		// No cursor yet: nothing covers it, nothing asks.
		expect(backend.callsTo('symbol_locals')).toHaveLength(0);

		view.setFile(FILE, 4);
		await flush(4);
		// The ask carried the live buffer, the file's extension and the 0-based cursor line.
		expect(backend.callsTo('symbol_locals')).toEqual([{ text: SOURCE, ext: 'c', line: 4 }]);
		expect(texts('.sw-locals .sw-section-label', host)).toEqual(['Current function']);
		expect(texts('.sw-locals .sw-name', host)).toEqual(['cfg', 'tmp']);
		// The row line column is 1-based.
		expect(texts('.sw-locals .sw-line', host)).toEqual(['4', '6']);
		const opened: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opened.push({ path, line });
		click(host.querySelectorAll<HTMLElement>('.sw-locals .sw-row')[1]!);
		expect(opened).toEqual([{ path: FILE, line: 6 }]);
	});

	it('never re-asks while the cursor roams inside the same function', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		backend.on('symbol_locals', () => LOCALS);
		const { host, view } = mountView();
		view.provideText = () => SOURCE;
		view.setFile(FILE, 4);
		await flush(4);
		expect(backend.callsTo('symbol_locals')).toHaveLength(1);
		view.setFile(FILE, 5);
		view.setFile(FILE, 6);
		await flush(4);
		expect(backend.callsTo('symbol_locals')).toHaveLength(1, 'the covering symbol\'s identity did not change');
		expect(texts('.sw-locals .sw-name', host)).toEqual(['cfg', 'tmp'], 'the section survived the roaming');
	});

	it('hides the section once the cursor leaves every symbol', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		backend.on('symbol_locals', () => LOCALS);
		const { host, view } = mountView();
		view.provideText = () => SOURCE;
		view.setFile(FILE, 4);
		await flush(4);
		expect(host.querySelector('.sw-locals')).not.toBeNull();
		view.setFile(FILE, 100);
		await flush(2);
		expect(host.querySelector('.sw-locals')).toBeNull();
		expect(backend.callsTo('symbol_locals')).toHaveLength(1, 'nothing covers the cursor, nothing asks');
	});

	it('hides the section when the host cannot supply text', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.provideText = () => null;
		view.setFile(FILE, 4);
		await flush(4);
		expect(host.querySelector('.sw-locals')).toBeNull();
		expect(backend.callsTo('symbol_locals')).toHaveLength(0, 'no text, no ask');
	});

	it('hides the section without a provider at all', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		const { host, view } = mountView();
		view.setFile(FILE, 4);
		await flush(4);
		expect(host.querySelector('.sw-locals')).toBeNull();
		expect(backend.callsTo('symbol_locals')).toHaveLength(0);
	});

	it('hides the section silently when the parse fails', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		backend.on('symbol_locals', () => {
			throw new Error('no parser');
		});
		const { host, view } = mountView();
		view.provideText = () => SOURCE;
		view.setFile(FILE, 4);
		await flush(4);
		expect(host.querySelector('.sw-locals')).toBeNull();
		// Roaming inside the same function does not retry the failed ask.
		view.setFile(FILE, 5);
		await flush(4);
		expect(backend.callsTo('symbol_locals')).toHaveLength(1);
	});

	it('clears the section on an outline refresh and on a file switch', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		backend.on('symbol_locals', () => LOCALS);
		const { host, view } = mountView();
		view.provideText = () => SOURCE;
		view.setFile(FILE, 4);
		await flush(4);
		expect(host.querySelector('.sw-locals')).not.toBeNull();
		expect(backend.callsTo('symbol_locals')).toHaveLength(1);

		// The reload drops the section; the covering symbol is still load, so exactly one
		// re-ask repopulates it.
		view.refresh();
		await flush(4);
		expect(backend.callsTo('symbol_locals')).toHaveLength(2);
		expect(host.querySelector('.sw-locals')).not.toBeNull();

		// A file switch drops the section at once, before the new outline answers.
		view.setFile('C:\\repo\\src\\other.c');
		expect(host.querySelector('.sw-locals')).toBeNull();
	});
});

describe('the relation graph root', () => {
	// The outline can carry a one-line entry declaring a name ON the cursor's own line
	// (a bare variable's row) while an enclosing function's span also holds the cursor.
	// The function is the root the relation window means — its ring is the meaningful
	// one; the variable sits inside it.
	it('roots the graph on the enclosing function, not on a same-line one-liner', async () => {
		backend.on('symbol_file_outline', () => ({
			symbols: [
				{ kind: 'function', name: 'load', container: null, line: 3, endLine: 6 },
				{ kind: 'variable', name: 'slot', container: null, line: 4, endLine: 4 }
			],
			imports: []
		}));
		backend.on('symbol_relation_children', ({ name }) => ({ nodes: [], truncated: false }));
		const { host, view } = mountView();
		view.setFile(FILE, 4);
		await flush(4);
		const asked = backend.callsTo('symbol_relation_children').map((call) => call['name']);
		expect(asked).toEqual(['load'], 'the enclosing function roots the graph');
		// The outline highlight keeps the VS Code rule — the innermost row, here the
		// one-liner's own row.
		expect(rowOf(host, 'slot').classList.contains('current')).toBe(true);
	});

	it('a one-liner is the root when nothing encloses the cursor', async () => {
		backend.on('symbol_file_outline', () => ({
			symbols: [{ kind: 'variable', name: 'slot', container: null, line: 4, endLine: 4 }],
			imports: []
		}));
		backend.on('symbol_relation_children', ({ name }) => ({ nodes: [], truncated: false }));
		const { view } = mountView();
		view.setFile(FILE, 4);
		await flush(4);
		const asked = backend.callsTo('symbol_relation_children').map((call) => call['name']);
		expect(asked).toEqual(['slot']);
	});

	it('the graph root follows the covering symbol identity, once per change', async () => {
		backend.on('symbol_file_outline', () => OUTLINE);
		backend.on('symbol_relation_children', ({ name }) => ({ nodes: [], truncated: false }));
		const { view } = mountView();
		view.setFile(FILE, 4);
		await flush(4);
		expect(backend.callsTo('symbol_relation_children').map((call) => call['name'])).toEqual(['load']);
		// Roaming inside the same function asks nothing; the next function asks once.
		view.setFile(FILE, 5);
		await flush(2);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(1);
		view.setFile(FILE, 13);
		await flush(2);
		expect(backend.callsTo('symbol_relation_children').map((call) => call['name'])).toEqual(['load', 'main']);
	});
});

describe('container indentation', () => {
	const NESTED = {
		symbols: [
			{ kind: 'class', name: 'Widget', container: null, line: 0, endLine: 90 },
			{ kind: 'method', name: 'paint', container: 'Widget', line: 2, endLine: 8 },
			{ kind: 'class', name: 'Inner', container: 'Widget', line: 10, endLine: 40 },
			{ kind: 'method', name: 'tick', container: 'Inner', line: 12, endLine: 16 },
			{ kind: 'method', name: 'free', container: 'Ghost', line: 20, endLine: 24 },
			{ kind: 'function', name: 'level0', container: null, line: 30, endLine: 80 },
			{ kind: 'function', name: 'level1', container: 'level0', line: 32, endLine: 70 },
			{ kind: 'function', name: 'level2', container: 'level1', line: 34, endLine: 60 },
			{ kind: 'function', name: 'level3', container: 'level2', line: 36, endLine: 50 },
			{ kind: 'function', name: 'level4', container: 'level3', line: 38, endLine: 48 }
		],
		imports: []
	};

	/** The row's depth read back off its inline padding (the 8px base plus 14px a level;
	 *  a top-level row carries no inline padding at all). */
	function depthOf(host: HTMLElement, name: string): number {
		const pad = rowOf(host, name)!.style.paddingLeft;
		return pad === '' ? 0 : Math.round((Number.parseFloat(pad) - 8) / 14);
	}

	it('indents members by their container chain, caps at three, tops unlisted containers', async () => {
		backend.on('symbol_file_outline', () => NESTED);
		const { host, view } = mountView();
		view.setFile(FILE);
		await flush(4);
		expect(depthOf(host, 'Widget')).toBe(0);
		expect(depthOf(host, 'paint')).toBe(1, 'Widget·paint sits one level under Widget');
		expect(depthOf(host, 'Inner')).toBe(1, 'the nested class sits at its container\'s member depth');
		expect(depthOf(host, 'tick')).toBe(2, 'Inner·tick names Inner, already listed at depth 1');
		expect(depthOf(host, 'free')).toBe(0, 'a container never listed above is the top level');
		expect(depthOf(host, 'level3')).toBe(3);
		expect(depthOf(host, 'level4')).toBe(3, 'the depth stops at three');
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

		it('wires provideText to the active editor\'s live buffer', async () => {
			expect(typeof workbench.symbolWindow.provideText).toBe('function');
			// The booted shell has no text editor active: the hook answers null.
			expect(workbench.symbolWindow.provideText!()).toBeNull();
		});

		it('hands the view the editor\'s cursor line as 0-based (the payload\'s Ln is 1-based)', async () => {
			const received: { path: string | null; line?: number }[] = [];
			const view = workbench.symbolWindow as unknown as { setFile: (path: string | null, line?: number) => void };
			const original = view.setFile;
			view.setFile = (path, line) => received.push({ path, line });
			const editors = workbench.editors as unknown as { onActiveChange: ((editor: unknown) => void) | null };
			try {
				// The editor group's payload carries the status bar's Ln (1-based, the
				// context window's `doc.line` base); the view's contract is 0-based.
				editors.onActiveChange?.({ kind: 'file', path: FILE, line: 7, column: 1 });
				await flush(2);
			} finally {
				view.setFile = original;
			}
			expect(received[received.length - 1]).toEqual({ path: FILE, line: 6 });
		});

		it('wires the jumps: an open joins the root, an absolute path passes through', async () => {
			expect(typeof workbench.symbolWindow.onOpen).toBe('function');
			const opens: { path: string; line?: number }[] = [];
			const editors = workbench.editors as unknown as { openFile: (path: string, options?: { line?: number }) => Promise<unknown> };
			const original = editors.openFile;
			editors.openFile = async (path, options) => {
				opens.push({ path, line: options?.line });
			};
			try {
				// The graph's cards speak the index's repo-relative path — the join lands.
				workbench.symbolWindow.onOpen!('src/a.c', 4);
				await flush(2);
				// The outline's rows speak the editor's absolute path — it passes through.
				workbench.symbolWindow.onOpen!(FILE, 7);
				await flush(2);
			} finally {
				editors.openFile = original;
			}
			expect(opens).toEqual([
				{ path: 'C:\\repo\\src\\a.c', line: 4 },
				{ path: FILE, line: 7 }
			]);
		});
	});


/* ---------- The collapsible tree and the sort (2026-11-23) ---------- */

const DEEP = {
	symbols: [
		{ kind: 'class', name: 'Widget', container: null, line: 0, endLine: 90 },
		{ kind: 'method', name: 'paint', container: 'Widget', line: 2, endLine: 8 },
		{ kind: 'class', name: 'Inner', container: 'Widget', line: 10, endLine: 40 },
		{ kind: 'method', name: 'tick', container: 'Inner', line: 12, endLine: 16 },
		{ kind: 'function', name: 'level0', container: null, line: 30, endLine: 80 },
		{ kind: 'function', name: 'level1', container: 'level0', line: 32, endLine: 70 },
		{ kind: 'function', name: 'level2', container: 'level1', line: 34, endLine: 60 },
		{ kind: 'function', name: 'level3', container: 'level2', line: 36, endLine: 50 }
	],
	imports: []
};

describe('the collapsible tree', () => {
	beforeEach(async () => {
		localStorage.clear();
		backend.reset();
		updateSetting('locale', 'en');
	});

	function mountDeep(): { host: HTMLElement; view: SymbolWindowView } {
		backend.on('symbol_file_outline', () => DEEP);
		const pair = mountView();
		pair.view.setFile(FILE);
		return pair;
	}

	function names(host: HTMLElement): string[] {
		return texts('.sw-row .sw-name', host);
	}

	function twistOf(host: HTMLElement, name: string): HTMLElement {
		const row = rowOf(host, name)!;
		return row.querySelector('.sw-fold')!;
	}

	it('a container row carries its twistie, and folding hides exactly its members', async () => {
		const { host } = mountDeep();
		await flush(4);
		expect(names(host)).toEqual(['Widget', 'paint', 'Inner', 'tick', 'level0', 'level1', 'level2', 'level3']);
		expect(twistOf(host, 'Widget')).toBeTruthy(); // the containers carry twists, the leaves a bare slot
		expect(rowOf(host, 'paint')!.querySelector('.sw-fold')).toBeNull();
		// Folding Widget hides its members, itself staying.
		click(twistOf(host, 'Widget'));
		expect(names(host)).toEqual(['Widget', 'level0', 'level1', 'level2', 'level3']);
		// The state survives a re-render (the filter runs one).
		const filter = host.querySelector<HTMLInputElement>('.sw-filter')!;
		filter.value = 'level';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		filter.value = '';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(names(host)).toEqual(['Widget', 'level0', 'level1', 'level2', 'level3']);
		// Unfolding restores the members.
		click(twistOf(host, 'Widget'));
		expect(names(host)).toHaveLength(8);
		host.remove();
	});

	it('Collapse All folds every container, Expand All opens them, Expand Special opens the asked levels', async () => {
		const { host, view } = mountDeep();
		await flush(4);
		view.collapseAll();
		// The folded containers' own rows hide with their parents — the tops and the
		// unfolded level-1 members stand alone.
		expect(names(host)).toEqual(['Widget', 'level0']);
		view.expandAll();
		expect(names(host)).toHaveLength(8);
		// All-fold, then special-open one level: the top containers open, their
		// containers' own members stay folded.
		view.collapseAll();
		const pending = view.expandSpecial();
		const input = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(input, '1');
		key(input, 'Enter');
		await pending;
		// One level: the top containers open — their members show, the members' own
		// containers (Inner, level1) stand folded.
		expect(names(host)).toEqual(['Widget', 'paint', 'Inner', 'level0', 'level1']);
		host.remove();
	});

	it('the sort cycles Line → Name → Type, the flats unfold and do not fold', async () => {
		const { host, view } = mountDeep();
		await flush(4);
		view.collapseAll();
		// The folded containers' own rows hide with their parents — the tops and the
		// unfolded level-1 members stand alone.
		expect(names(host)).toEqual(['Widget', 'level0']);
		const sort = host.querySelector<HTMLButtonElement>('.sw-sort')!;
		expect(sort.textContent).toContain('Line');
		click(sort);
		expect(sort.textContent).toContain('Name');
		// The name sort is the flat list — the folds do not apply.
		expect(names(host)).toEqual(['Inner', 'level0', 'level1', 'level2', 'level3', 'paint', 'tick', 'Widget']);
		// Collapsing is the line sort's own: the folds apply again.
		view.collapseAll();
		expect(names(host)).toHaveLength(8);
		click(sort);
		expect(sort.textContent).toContain('Type');
		click(sort);
		expect(sort.textContent).toContain('Line');
		// Back on the line sort the fold state stands as it was left.
		expect(names(host)).toEqual(['Widget', 'level0']);
		host.remove();
	});

	it('the fold state starts over on a file switch', async () => {
		const { host, view } = mountDeep();
		await flush(4);
		view.collapseAll();
		// The folded containers' own rows hide with their parents — the tops and the
		// unfolded level-1 members stand alone.
		expect(names(host)).toEqual(['Widget', 'level0']);
		view.setFile('C:\repo\src\other.c');
		await flush(4);
		view.setFile(FILE);
		await flush(4);
		expect(names(host)).toHaveLength(8);
		host.remove();
	});
});
