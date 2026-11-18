// The symbol index's frontend surfaces (M4): Quick Open's @ / # modes, Go-to-Definition's
// exact-name lookup with its multi-definition list, Find References' narrowed scan, the
// status bar's indexing item, the Context Window - and the M7 polish that landed with them
// (the density setting, the auto theme).

import { beforeEach, describe, expect, it } from 'vitest';

import { applyTheme, updateSetting } from '../src/platform/settings';
import { ContextView } from '../src/features/search';
import { EditorGroup } from '../src/features/editor';
import { StatusBar } from '../src/workbench/statusbar';
import { buildTree, subtreeCounts, SymbolDatabaseView } from '../src/features/search';
import { fileSymbolItems, workspaceSymbolItems } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, key, texts } from './helpers';
import { hoverKindHint, macroHoverDom, macroHoverEntries, macroHoverFor, macroValueAt, precedingComment, quickInfoDom, quickInfoFor, resetMacroHoverCache, resetQuickInfoCache, scopeQuickInfoFor, symbolBodyAt, wordRangeAt, hoverKeepAliveExtension, type MacroHoverSource } from '../src/features/editor/editorProviderViews';
import { buildPeekDom, definitionWindow } from '../src/features/editor/peek';
import type { WsSymbol } from '../src/platform/ipc/search';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

const REPO = 'C:\\repo';

beforeEach(async () => {
	localStorage.clear();
	document.body.innerHTML = `
		<div id="workbench"><div id="editorGroup"></div></div>
		<div id="statusbar"></div>
		<div id="notifications"></div>
		<div id="overlays"></div>`;
	document.head.querySelector('link#theme-css')?.remove();
	const link = document.createElement('link');
	link.id = 'theme-css';
	document.head.appendChild(link);
	backend.reset();
	await import('../src/features/editor');
});

function scriptFiles(contents: Record<string, string>): void {
	// Definition jumps arrive as joinPath(root, relative) - mixed separators on Windows -
	// so the lookup normalises both sides before matching a scripted file.
	const key = (path: string) => path.replaceAll('/', '\\');
	backend.on('read_file', ({ path }) => {
		const text = contents[key(String(path))];
		if (text === undefined) throw new Error(`${path}: not found`);
		return { contents: text, binary: false, size: text.length, encoding: 'utf8', eol: 'lf' };
	});
}

describe('Quick Open symbol modes', () => {
	it('lists and filters the file outline for "@"', () => {
		const empty = fileSymbolItems('', []);
		expect(empty).toHaveLength(1);
		expect(empty[0]!.value).toBe('');

		const symbols = [
			{ name: 'alpha', kind: 'function', line: 3 },
			{ name: 'beta', kind: 'method', line: 12 }
		];
		const all = fileSymbolItems('', symbols);
		expect(all.map((item) => item.label)).toEqual(['alpha', 'beta']);
		expect(all[0]!.value).toBe('line:4');

		const filtered = fileSymbolItems('ALP', symbols);
		expect(filtered.map((item) => item.label)).toEqual(['alpha']);
	});

	it('lists workspace symbols for "#" with a sym: value that carries the line', () => {
		const items = workspaceSymbolItems('be', [
			{ name: 'beta', kind: 'function', path: 'src/b.rs', line: 7 },
			{ name: 'gamma', kind: 'struct', path: 'src/g.rs', line: 1 }
		]);
		expect(items.map((item) => item.label)).toEqual(['beta']);
		expect(items[0]!.description).toBe('src/b.rs');
		expect(items[0]!.value).toBe(`sym:src/b.rs\u00007`);
	});
});

describe('Go to Definition through the index', () => {
	it('jumps straight to a single exact-name definition', async () => {
		scriptFiles({ [`${REPO}\\main.ts`]: 'const x = alpha();\n', [`${REPO}\\src\\a.ts`]: 'function alpha() {}\n' });
		backend.on('symbol_lookup', () => [{ kind: 'function', name: 'alpha', path: 'src/a.ts', line: 0 }]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.ts`);
		const view = group.activeView!;
		view.dispatch({ selection: { anchor: 10 } });
		await group.goToDefinition();
		await flush(4);
		expect(backend.callsTo('symbol_lookup')).toHaveLength(1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.ts');
	});

	it('offers a list when several declarations share the name', async () => {
		scriptFiles({
			[`${REPO}\\main.ts`]: 'const x = alpha();\n',
			[`${REPO}\\src\\a.ts`]: 'function alpha() {}\n',
			[`${REPO}\\src\\b.ts`]: 'function alpha() {}\n'
		});
		backend.on('symbol_lookup', () => [
			{ kind: 'function', name: 'alpha', path: 'src/a.ts', line: 2 },
			{ kind: 'function', name: 'alpha', path: 'src/b.ts', line: 8 }
		]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.ts`);
		group.activeView!.dispatch({ selection: { anchor: 10 } });
		void group.goToDefinition();
		await flush(6);
		const rows = texts('.quick-input .row .description');
		expect(rows).toEqual(['src/a.ts:3', 'src/b.ts:9']);

		// Picking the second definition opens that file at its line.
		const second = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .row'))[1]!;
		click(second);
		await flush(6);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.ts');
	});

	it('falls back to the substring query when no index answers', async () => {
		scriptFiles({ [`${REPO}\\main.ts`]: 'const x = alpha();\n', [`${REPO}\\src\\a.ts`]: 'function alpha() {}\n' });
		backend.on('symbol_lookup', () => {
			throw new Error('no index');
		});
		backend.on('workspace_symbols', () => [{ kind: 'function', name: 'alpha', path: 'src/a.ts', line: 0 }]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.ts`);
		group.activeView!.dispatch({ selection: { anchor: 10 } });
		await group.goToDefinition();
		await flush(4);
		expect(backend.callsTo('workspace_symbols')).toHaveLength(1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.ts');
	});
});

describe('Find References', () => {
	it('asks the narrowed scan first and only falls back on error', async () => {
		scriptFiles({ [`${REPO}\\main.ts`]: 'const x = alpha(); alpha();\n' });
		backend.on('symbol_references', () => [
			{ path: 'main.ts', matches: [{ line: 1, column: 10, length: 5, text: 'const x = alpha();' }] }
		]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.ts`);
		group.activeView!.dispatch({ selection: { anchor: 10 } });
		void group.findReferences();
		await flush(6);
		expect(backend.callsTo('symbol_references')).toHaveLength(1);
		expect(backend.callsTo('find_references')).toHaveLength(0);
		expect(document.querySelector<HTMLInputElement>('.quick-input input')!.placeholder).toBe("1 reference(s) to 'alpha'");
		key(document, 'Escape');
	});
});

describe('the status bar symbols item', () => {
	it('follows the index states and hides without a folder', () => {
		const bar = new StatusBar(document.getElementById('statusbar')!);
		const visible = (part: string) => Array.from(document.querySelectorAll<HTMLElement>('.status-left .status-item')).find((e) => !e.hidden && e.textContent!.includes(part))!;

		bar.setSymbols({ state: 'building', done: 3, total: 10, files: 0, symbols: 0 });
		expect(visible('Indexing symbols').textContent).toContain('3/10');

		bar.setSymbols({ state: 'ready', done: 10, total: 10, files: 10, symbols: 42 });
		const ready = visible('symbols');
		expect(ready.textContent).toContain('42');

		bar.setSymbols(null);
		expect(ready.hidden).toBe(true);
	});
});

describe('the Context Window', () => {
	it('rests empty, renders a definition, and opens it on click', () => {
		const view = new ContextView();
		document.getElementById('overlays')!.appendChild(view.element);
		view.element.hidden = false;
		expect(view.element.querySelector('.context-empty')!.textContent).toContain('cursor on a symbol');

		let opened: { path: string; line: number } | null = null;
		view.onOpenDefinition = (definition) => (opened = { path: definition.path, line: definition.line });
		view.show({ kind: 'function', name: 'alpha', path: `${REPO}\\src\\a.ts`, line: 2, fragment: 'fn alpha() {\n\tbeta();\n}' });
		expect(view.element.querySelector('.context-name')!.textContent).toBe('alpha');
		expect(view.element.querySelector('.context-kind')!.textContent).toBe('function');
		expect(view.element.querySelector('.context-location')!.textContent).toBe('a.ts:3');
		expect(view.element.querySelector('.context-code')!.textContent).toContain('beta();');

		click(view.element.querySelector<HTMLElement>('.context-location'));
		expect(opened).toEqual({ path: `${REPO}\\src\\a.ts`, line: 2 });
	});

	it('pins: the pin toggles and pauses the label', () => {
		const view = new ContextView();
		expect(view.isPinned()).toBe(false);
		click(view.actions.querySelector<HTMLButtonElement>('.action-btn'));
		expect(view.isPinned()).toBe(true);
		expect(view.element.classList.contains('pinned')).toBe(true);
		click(view.actions.querySelector<HTMLButtonElement>('.action-btn'));
		expect(view.isPinned()).toBe(false);
	});

	it('notes an ambiguous name instead of guessing', () => {
		const view = new ContextView();
		view.show(null, '3 symbols share this name');
		expect(view.element.querySelector('.context-empty')!.textContent).toContain('3 symbols share this name');
	});
});

describe('the Symbol Database page', () => {
	const outline: { path: string; symbols: { kind: string; name: string; line: number; refs: number }[] }[] = [
		{ path: 'src/a.rs', symbols: [
			{ kind: 'struct', name: 'Alpha', line: 0, refs: 1 },
			{ kind: 'function', name: 'gamma', line: 9, refs: 0 }
		] },
		{ path: 'src/deep/b.rs', symbols: [{ kind: 'function', name: 'beta', line: 3, refs: 2 }] },
		{ path: 'top.rs', symbols: [{ kind: 'function', name: 'main', line: 0, refs: 3 }] }
	];

	it('groups the outline into a sorted folder tree and counts subtrees', () => {
		const root = buildTree(outline);
		expect(root.folders.map((folder) => folder.name)).toEqual(['src']);
		expect(root.files.map((file) => file.path)).toEqual(['top.rs']);
		const src = root.folders[0]!;
		expect(src.files.map((file) => file.path)).toEqual(['src/a.rs']);
		expect(src.folders.map((folder) => folder.name)).toEqual(['deep']);
		const counts = subtreeCounts(root.folders, root.files);
		expect(counts).toEqual({ files: 3, symbols: 4 });
	});

	it('renders folders, files and symbols, collapses, filters and opens', async () => {
		backend.on('symbol_tree', () => outline);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const opened: { path: string; line: number }[] = [];
		const view = new SymbolDatabaseView(host);
		view.onOpen = (path, line) => opened.push({ path, line });
		await view.load();

		// The whole tree: folders first (each followed by its subtree), then the root's
		// files - and every open file followed by its declarations.
		expect(texts('.sd-row .label', host)).toEqual(['src', 'deep', 'b.rs', 'beta', 'a.rs', 'Alpha', 'gamma', 'top.rs', 'main']);
		expect(texts('.sd-row .tail', host)).toContain('1 · 3 refs');

		// A folder click collapses it (its files and nested folders go with it).
		const srcRow = Array.from(host.querySelectorAll<HTMLElement>('.sd-row')).find((row) => row.dataset['key'] === 'src')!;
		click(srcRow);
		expect(Array.from(host.querySelectorAll('.sd-row')).some((row) => row.dataset['key'] === 'src/deep')).toBe(false);
		click(srcRow);
		expect(Array.from(host.querySelectorAll('.sd-row')).some((row) => row.dataset['key'] === 'src/deep')).toBe(true);

		// A symbol click opens its declaration; the row shows the line and the refs.
		const gamma = Array.from(host.querySelectorAll<HTMLElement>('.sd-row')).find((row) => row.dataset['key'] === 'src/a.rs:9')!;
		click(gamma);
		expect(opened).toEqual([{ path: 'src/a.rs', line: 10 }]);

		// The filter keeps only the matching symbols (and the folders leading to them).
		const filter = host.querySelector<HTMLInputElement>('.sd-filter')!;
		filter.value = 'GAM';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(texts('.sd-row .label', host)).toEqual(['src', 'a.rs', 'gamma']);
	});

	it('reconciles rows instead of rebuilding them: a filter keeps unaffected rows\' elements', async () => {
		backend.on('symbol_tree', () => outline);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new SymbolDatabaseView(host);
		await view.load();

		// Grab the element of a row a filter does not touch: typing in the filter may drop
		// the non-matching subtrees, but the unaffected visible rows keep their DOM identity
		// (a whole-tree rebuild per keystroke re-created thousands of rows on a big index).
		const gammaRow = Array.from(host.querySelectorAll<HTMLElement>('.sd-row')).find((row) => row.dataset['key'] === 'src/a.rs:9')!;

		const filter = host.querySelector<HTMLInputElement>('.sd-filter')!;
		filter.value = 'GAM';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(texts('.sd-row .label', host)).toEqual(['src', 'a.rs', 'gamma']);
		expect(host.querySelector<HTMLElement>('.sd-row[data-key="src/a.rs:9"]')).toBe(gammaRow);
		expect(host.querySelector('.sd-row[data-key="top.rs"]')).toBeNull();

		// Clearing the filter brings every row back; the survivor is still itself.
		filter.value = '';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(host.querySelectorAll('.sd-row')).toHaveLength(9);
		expect(host.querySelector<HTMLElement>('.sd-row[data-key="src/a.rs:9"]')).toBe(gammaRow);
	});

	it('rebuilds through the command and reloads', async () => {
		backend.on('symbol_tree', () => outline);
		backend.on('symbols_rebuild', () => ({ state: 'ready', done: 3, total: 3, files: 3, symbols: 4 }));
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new SymbolDatabaseView(host);
		await view.load();
		const refresh = Array.from(host.querySelectorAll<HTMLButtonElement>('.sd-header .action-btn')).pop()!;
		click(refresh);
		await flush(8);
		expect(backend.callsTo('symbols_rebuild')).toHaveLength(1);
		expect(backend.callsTo('symbol_tree').length).toBeGreaterThanOrEqual(2);
	});

	it('shows the empty state when the index has nothing', async () => {
		backend.on('symbol_tree', () => []);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new SymbolDatabaseView(host);
		await view.load();
		expect(host.querySelector('.sd-empty')!.textContent).toContain('index is empty');
	});
});

describe('the M7 polish that landed beside it', () => {
	it("density re-packs the workbench's strips through CSS variables", () => {
		updateSetting('density', 'compact');
		expect(document.documentElement.style.getPropertyValue('--row-height')).toBe('20px');
		expect(document.documentElement.style.getPropertyValue('--tab-height')).toBe('30px');
		updateSetting('density', 'comfortable');
		expect(document.documentElement.style.getPropertyValue('--row-height')).toBe('22px');
		expect(document.documentElement.style.getPropertyValue('--tab-height')).toBe('35px');
	});

	it('the auto theme resolves against the system', () => {
		// jsdom's matchMedia answers false, so the auto theme names the system's light
		// pick exactly the way an explicit "Light Modern" would.
		applyTheme('auto');
		const kind = document.body.dataset['vscodeThemeKind'];
		expect(kind).toBe('vscode-light');
		expect(['Dark Modern', 'Light Modern']).toContain(document.body.dataset['vscodeThemeName']);
		expect(kind === 'vscode-dark' ? 'Dark Modern' : 'Light Modern').toBe(document.body.dataset['vscodeThemeName']);
	});
});

describe('the macro hover', () => {
	beforeEach(() => resetMacroHoverCache());

	const CONF_H = 'C:/repo/inc/conf.h';
	const MAIN_C = 'C:/repo/src/main.c';
	const files: Record<string, string> = {
		[CONF_H]: '#pragma once\n\n#define MAX_LEN 256\n#define GROW(n) ((n) * 2)\n#define WIDE(a) \\\n    step(a); \\\n    step(a + 1)\n',
		[MAIN_C]: 'int other(void) { return 1; }\n'
	};

	/** A source over the files above; `defs` are what its index answers for a name. */
	function source(defs: WsSymbol[]): MacroHoverSource & { lookups: string[] } {
		const lookups: string[] = [];
		return {
			lookups,
			root: () => 'C:\\repo',
			lookup: async (name: string) => {
				lookups.push(name);
				return defs;
			},
			read: async (path: string) => {
				const posix = path.split('\\').join('/');
				const text = files[posix];
				return text === undefined ? null : text;
			}
		};
	}

	it('slices the directive a definition names, continuations included', () => {
		const text = files[CONF_H]!;
		expect(macroValueAt(text, 2, 2)).toBe('#define MAX_LEN 256');
		expect(macroValueAt(text, 4, 6)).toBe('#define WIDE(a) \\\n    step(a); \\\n    step(a + 1)');
		expect(macroValueAt('short\n', 0, 400)).toBe('short', 'an end line past the file clamps to the last line');
	});

	it('lists every definition of the name with its own directive text', async () => {
		const macros = source([
			{ kind: 'macro', name: 'MAX_LEN', path: 'inc/conf.h', line: 2 },
			{ kind: 'macro', name: 'MAX_LEN', path: 'src/other.h', line: 0 },
			{ kind: 'function', name: 'MAX_LEN', path: 'src/main.c', line: 9 }
		]);
		const entries = await macroHoverEntries(macros, 'MAX_LEN');
		expect(entries.map((entry) => [entry.path, entry.line, entry.text])).toEqual([
			['inc/conf.h', 2, '#define MAX_LEN 256'],
			['src/other.h', 0, '']
		]);
	});

	it('answers nothing without a folder, an index, or a macro', async () => {
		const noRoot = source([]);
		noRoot.root = () => null;
		expect(await macroHoverEntries(noRoot, 'MAX_LEN')).toEqual([]);

		const failing = source([]);
		failing.lookup = async () => {
			throw new Error('index gone');
		};
		expect(await macroHoverEntries(failing, 'MAX_LEN')).toEqual([]);

		expect(await macroHoverEntries(source([{ kind: 'function', name: 'other', path: 'src/main.c', line: 0 }]), 'other')).toEqual([]);
	});

	it('re-uses a lookup answer for a while instead of asking per hover', async () => {
		const macros = source([{ kind: 'macro', name: 'MAX_LEN', path: 'inc/conf.h', line: 2 }]);
		await macroHoverEntries(macros, 'MAX_LEN');
		await macroHoverEntries(macros, 'MAX_LEN');
		await macroHoverEntries(macros, 'OTHER');
		expect(macros.lookups).toEqual(['MAX_LEN', 'OTHER']);
	});

	it('resolves the word under the pointer and renders one entry per definition', async () => {
		const view = {
			state: {
				wordAt: () => ({ from: 10, to: 17 }),
				sliceDoc: (from: number, to: number) => (from === 10 ? 'MAX_LEN' : '')
			}
		} as unknown as EditorView;
		const macros = source([{ kind: 'macro', name: 'MAX_LEN', path: 'inc/conf.h', line: 2 }]);
		expect(await macroHoverFor(macros, view, 12)).toEqual([{ path: 'inc/conf.h', line: 2, text: '#define MAX_LEN 256' }]);
		const noWord = { state: { wordAt: () => null, sliceDoc: () => '' } } as unknown as EditorView;
		expect(await macroHoverFor(macros, noWord, 12)).toBeNull();

		const dom = macroHoverDom('MAX_LEN', (await macroHoverFor(macros, view, 12))!);
		expect(dom.querySelector('.ggs-symbol-hover-head')!.textContent).toBe('MAX_LEN');
		expect(dom.querySelector('.ggs-symbol-hover-loc')!.textContent).toBe('inc/conf.h:3');
		expect(dom.querySelector('.ggs-symbol-hover-code')!.textContent).toBe('#define MAX_LEN 256');

		const several = macroHoverDom('MAX_LEN', [
			{ path: 'inc/conf.h', line: 2, text: '#define MAX_LEN 256' },
			{ path: 'src/other.h', line: 0, text: '' }
		]);
		expect(several.querySelector('.ggs-symbol-hover-head')!.textContent).toContain('2');
		expect(several.querySelectorAll('.ggs-symbol-hover-loc')).toHaveLength(2);
		expect(several.querySelectorAll('.ggs-symbol-hover-code')).toHaveLength(1, 'an unread file shows its location only');
	});
});

describe('the quick-info hover (any indexed symbol)', () => {
	beforeEach(() => {
		resetMacroHoverCache();
		resetQuickInfoCache();
	});

	const MAIN_C = 'C:/repo/src/main.c';
	const files: Record<string, string> = {
		[MAIN_C]: '/** Adds its arguments. */\nint add(int a, int b)\n{\n\treturn a + b;\n}\n',
		['C:/repo/src/other.c']: 'int add(int a, int b);\n'
	};

	function source(defs: WsSymbol[]): MacroHoverSource & { lookups: string[] } {
		const lookups: string[] = [];
		return {
			lookups,
			root: () => 'C:\\repo',
			lookup: async (name: string) => {
				lookups.push(name);
				return defs;
			},
			read: async (path: string) => {
				const posix = path.split('\\').join('/');
				const text = files[posix];
				return text === undefined ? null : text;
			}
		};
	}

	it('lifts the comment block that ends on the line above a declaration', () => {
		const text = files[MAIN_C]!;
		expect(precedingComment(text, 1)).toBe('/** Adds its arguments. */');
		expect(precedingComment(text, 4)).toBe('');
		const chained = '// one\n// two\nint f(void);\n';
		expect(precedingComment(chained, 2)).toBe('// one\n// two');
		const gapped = '// one\n\n// two\nint f(void);\n';
		expect(precedingComment(gapped, 3)).toBe('// two', 'a blank line ends the block');
		const many = Array.from({ length: 8 }, (_, i) => `// row ${i}`).join('\n') + '\nint f(void);\n';
		const picked = precedingComment(many, 8).split('\n');
		expect(picked).toHaveLength(6);
		expect(picked[0]).toBe('// row 2', 'the lines closest to the declaration win');
	});

	it('answers the signature line and the comment above it', async () => {
		const info = await quickInfoFor(source([{ kind: 'function', name: 'add', path: 'src/main.c', line: 1 }]), 'add');
		expect(info!.name).toBe('add');
		expect(info!.entries).toHaveLength(1);
		expect(info!.entries[0]!.text).toBe('int add(int a, int b)');
		expect(info!.entries[0]!.comment).toBe('/** Adds its arguments. */');
	});

	it('slices a block kind’s whole body through its end line, a scalar kind none', async () => {
		const files: Record<string, string> = {
			'C:/repo/src/point.h':
				'typedef struct {\n    int x;\n    int y;\n} Point;\n\nint area(const Point *p)\n{\n\treturn p->x * p->y;\n}\nint z;\n'
		};
		const src = source([{ kind: 'struct', name: 'Point', path: 'src/point.h', line: 0, endLine: 3 }]);
		src.read = async (path: string) => files[path.split('\\').join('/')] ?? null;
		const info = await quickInfoFor(src, 'Point');
		expect(info!.entries[0]!.body).toBe('typedef struct {\n    int x;\n    int y;\n} Point;');
		expect(info!.entries[0]!.text).toBe('typedef struct {', 'the declaration line still rides along');

		const fn = source([{ kind: 'function', name: 'area', path: 'src/point.h', line: 5, endLine: 8 }]);
		fn.read = async (path: string) => files[path.split('\\').join('/')] ?? null;
		const info2 = await quickInfoFor(fn, 'area');
		expect(info2!.entries[0]!.body).toBe('int area(const Point *p)\n{\n\treturn p->x * p->y;\n}');

		const scalar = source([{ kind: 'variable', name: 'z', path: 'src/point.h', line: 9 }]);
		scalar.read = async (path: string) => files[path.split('\\').join('/')] ?? null;
		const info3 = await quickInfoFor(scalar, 'z');
		expect(info3!.entries[0]!.body).toBe('');
		expect(info3!.entries[0]!.text).toBe('int z;');

		const outline = source([{ kind: 'function', name: 'outline_only', path: 'src/point.h', line: 5 }]);
		outline.read = async (path: string) => files[path.split('\\').join('/')] ?? null;
		expect((await quickInfoFor(outline, 'outline_only'))!.entries[0]!.body).toBe('', 'no end line, no body');
	});

	it('shows the body whole in the tooltip and a variable its declaration line', async () => {
		const bodyInfo = {
			name: 'add',
			entries: [
				{
					kind: 'function',
					path: 'src/main.c',
					line: 1,
					text: 'int add(int a, int b)',
					comment: '/** Adds its arguments. */',
					body: 'int add(int a, int b)\n{\n\treturn a + b;\n}'
				}
			]
		};
		const dom = quickInfoDom(bodyInfo);
		const body = dom.querySelector('.ggs-symbol-hover-body')!;
		expect(body.textContent).toBe('int add(int a, int b)\n{\n\treturn a + b;\n}');
		expect(dom.querySelectorAll('.ggs-symbol-hover-code')).toHaveLength(1, 'the signature rides inside the body, not beside it');

		const lineInfo: typeof bodyInfo = {
			name: 'z',
			entries: [{ kind: 'variable', path: 'src/point.h', line: 9, text: 'int z;', comment: '', body: '' }]
		};
		const line = quickInfoDom(lineInfo);
		expect(line.querySelector('.ggs-symbol-hover-body')).toBeNull();
		expect(line.querySelector('.ggs-symbol-hover-code')!.textContent).toBe('int z;');
	});

	it('reads the hover site: a call is the function, a value position the variable', () => {
		expect(hoverKindHint('total(a, b);', 0, 5)).toBe('function');
		expect(hoverKindHint('int total(int a, int b)', 4, 9)).toBe('function', 'the definition line reads as the function too');
		expect(hoverKindHint('int total = 0;', 4, 9)).toBe('variable');
		expect(hoverKindHint('total = total + 1;', 8, 13)).toBe('variable');
		expect(hoverKindHint('if (total == 3) {', 5, 10)).toBe('variable', 'a comparison is still the value');
		expect(hoverKindHint('struct Point {', 7, 12)).toBe('struct');
		expect(hoverKindHint('typedef struct tagRect Rect;', 23, 26)).toBe('struct', 'the tag keyword reaches past the tag name');
		expect(hoverKindHint('enum State s;', 5, 10)).toBe('enum');
		expect(hoverKindHint('Size canvas;', 0, 4)).toBeNull('a bare type name is undecided');
	});

	it('a hovered variable leads over a same-named function, a call site leads with the function', async () => {
		resetQuickInfoCache();
		const files: Record<string, string> = {
			'C:/repo/src/math.c': 'int total(int a, int b)\n{\n\treturn a + b;\n}\n',
			'C:/repo/src/main.c': 'void step(void) {\n    int total = 0;\n    total = total + 1;\n    step2(total);\n}\n'
		};
		// The lookup answers the function FIRST — the kind the hover site asks for must
		// still lead.
		const defs: WsSymbol[] = [
			{ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 3 },
			{ kind: 'variable', name: 'total', path: 'src/main.c', line: 1 }
		];
		const src = source(defs);
		src.read = async (path: string) => files[path.split('\\').join('/')] ?? null;
		const atValue = await quickInfoFor(src, 'total', 'C:/repo/src/main.c', 2, 'variable');
		expect(atValue!.entries[0]!.kind).toBe('variable');
		expect(atValue!.entries[0]!.text).toBe('    int total = 0;');
		const atCall = await quickInfoFor(src, 'total', 'C:/repo/src/main.c', 0, 'function');
		expect(atCall!.entries[0]!.kind).toBe('function');
		expect(atCall!.entries[0]!.body).toBe('int total(int a, int b)\n{\n\treturn a + b;\n}');
	});

	it('hovering inside a definition ranks that definition first', async () => {
		resetQuickInfoCache();
		const files: Record<string, string> = {
			'C:/repo/src/point.h': 'struct Point {\n    int x;\n    int y;\n};\n'
		};
		const defs: WsSymbol[] = [
			{ kind: 'struct', name: 'Point', path: 'src/point.h', line: 0, endLine: 3 },
			{ kind: 'function', name: 'Point', path: 'src/other.c', line: 0, endLine: 1 }
		];
		const src = source(defs);
		src.read = async (path: string) => files[path.split('\\').join('/')] ?? null;
		const info = await quickInfoFor(src, 'Point', 'C:/repo/src/point.h', 2, null);
		expect(info!.entries[0]!.kind).toBe('struct');
		expect(info!.entries[0]!.body).toBe('struct Point {\n    int x;\n    int y;\n};');
	});

	it('carries the definition body whole up to the caps', () => {
		const text = 'int f(void)\n{\n\treturn 1;\n}\nint g;\n';
		expect(symbolBodyAt(text, 0, 3)).toBe('int f(void)\n{\n\treturn 1;\n}');
		expect(symbolBodyAt(text, 0, 0)).toBe('', 'an end line at the line names no body');
		expect(symbolBodyAt(text, 0, undefined)).toBe('');
		expect(symbolBodyAt(text, 0, 400)).toBe('int f(void)\n{\n\treturn 1;\n}\nint g;', 'an end line past the file clamps to the last line');
		const long = Array.from({ length: 800 }, (_, i) => `row ${i}`).join('\n');
		expect(symbolBodyAt(long, 0, 799).split('\n')).toHaveLength(600);
	});

	it('spans the tooltip over the hovered word', () => {
		const view = {
			state: { wordAt: (pos: number) => (pos === 12 ? { from: 10, to: 17 } : null) }
		} as unknown as EditorView;
		expect(wordRangeAt(view, 12)).toEqual({ from: 10, to: 17 });
		expect(wordRangeAt(view, 0)).toBeNull();
	});

	it('keeps the tooltip alive while the pointer travels to it and onto it', () => {
		const view = new EditorView({
			state: EditorState.create({ doc: 'x\n', extensions: [hoverKeepAliveExtension()] }),
			parent: document.body
		});
		const tip = document.createElement('div');
		tip.className = 'cm-tooltip';
		const inner = document.createElement('div');
		inner.className = 'ggs-symbol-hover';
		tip.appendChild(inner);
		view.dom.appendChild(tip);
		tip.getBoundingClientRect = () =>
			({ left: 100, right: 300, top: 50, bottom: 150, width: 200, height: 100, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
		let reached = 0;
		view.dom.addEventListener('mousemove', () => {
			reached++;
		});
		const move = (x: number, y: number, buttons = 0): MouseEvent => {
			reached = 0;
			const event = new MouseEvent('mousemove', { clientX: x, clientY: y, buttons, bubbles: true });
			inner.dispatchEvent(event);
			return event;
		};

		move(200, 160);
		expect(reached).toBe(0, 'the gap between the hovered word and the tooltip');
		move(200, 100);
		expect(reached).toBe(0, 'inside the tooltip itself');
		move(200, 210);
		expect(reached).toBe(1, 'past the zone below');
		move(200, 20);
		expect(reached).toBe(1, 'past the zone above');
		move(330, 100);
		expect(reached).toBe(1, 'sideways off the tooltip');
		move(200, 160, 1);
		expect(reached).toBe(1, 'a drag must keep selecting');

		tip.remove();
		// The tooltip is gone; a move inside the editor passes through untouched. Dispatched
		// on the view itself — the detached tooltip's pane is no longer in any propagation
		// path.
		reached = 0;
		view.dom.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 100, buttons: 0, bubbles: true }));
		expect(reached).toBe(1, 'no tooltip stands, nothing is swallowed');
		view.destroy();
	});

	it('skips macro definitions, answers nothing without any, and re-uses the lookup', async () => {
		const macrosOnly = source([{ kind: 'macro', name: 'add', path: 'src/main.c', line: 0 }]);
		expect(await quickInfoFor(macrosOnly, 'add')).toBeNull();
		expect(await quickInfoFor(macrosOnly, 'add')).toBeNull();
		expect(macrosOnly.lookups).toEqual(['add'], 'the TTL cache holds');

		const none = source([{ kind: 'macro', name: 'other', path: 'src/main.c', line: 0 }]);
		expect(await quickInfoFor(none, 'other')).toBeNull();
	});

	it('leads with the hovered file own definition', async () => {
		const info = await quickInfoFor(
			source([
				{ kind: 'function', name: 'add', path: 'src/other.c', line: 0 },
				{ kind: 'function', name: 'add', path: 'src/main.c', line: 1 }
			]),
			'add',
			'C:/repo/src/main.c'
		);
		expect(info!.entries[0]!.path).toBe('src/main.c');
		expect(info!.entries[0]!.text).toBe('int add(int a, int b)');
		expect(info!.entries).toHaveLength(2);
	});

	it('renders the kind, comment, signature and a location that opens on click', async () => {
		const info = await quickInfoFor(source([{ kind: 'function', name: 'add', path: 'src/main.c', line: 1 }]), 'add');
		const opened: string[] = [];
		const dom = quickInfoDom(info!, (path, line) => opened.push(`${path}@${line}`));
		expect(dom.classList.contains('ggs-quick-info')).toBe(true);
		expect(dom.querySelector('.ggs-symbol-hover-head')!.textContent).toBe('add');
		expect(dom.querySelector('.ggs-symbol-hover-comment')!.textContent).toBe('/** Adds its arguments. */');
		expect(dom.querySelector('.ggs-symbol-hover-code')!.textContent).toBe('int add(int a, int b)');
		click(dom.querySelector('button.ggs-symbol-hover-loc'));
		expect(opened).toEqual(['src/main.c@1']);

		const plain = quickInfoDom(info!);
		expect(plain.querySelector('.ggs-symbol-hover-loc')!.tagName).toBe('DIV', 'no open, no button');
	});
});

describe('the peek definition popup', () => {
	it('shows the context above and the body through the column-0 close', () => {
		const text = 'a\nb\nint f(void)\n{\n\tstep();\n}\nint g;\n';
		expect(definitionWindow(text, 2)).toBe('a\nb\nint f(void)\n{\n\tstep();\n}');
	});

	it('uses the end line the index names and caps the window', () => {
		const text = 'x\n#define W(a) \\\n\tstep(a) \\\n\tstep(a+1)\nint y;\n';
		expect(definitionWindow(text, 1, 3)).toBe('x\n#define W(a) \\\n\tstep(a) \\\n\tstep(a+1)');
		const long = Array.from({ length: 120 }, (_, i) => `row ${i}`).join('\n');
		expect(definitionWindow(long, 0).split('\n').length).toBeLessThanOrEqual(60);
	});

	it('lists several definitions, switches the body with the pick, marks the active row', async () => {
		const files: Record<string, string> = {
			'C:/repo/a.c': 'int one(void);\n',
			'C:/repo/b.c': 'int two(void);\n'
		};
		const handlers = {
			root: () => 'C:\\repo',
			read: async (path: string) => {
				const posix = `C:/repo/${path.split('\\').join('/')}`;
				return files[posix] ?? null;
			},
			open: () => undefined,
			close: () => undefined
		};
		const dom = buildPeekDom(
			'fn',
			[
				{ kind: 'function', name: 'fn', path: 'a.c', line: 0 },
				{ kind: 'function', name: 'fn', path: 'b.c', line: 0 }
			],
			handlers
		);
		expect(dom.querySelectorAll('.ggs-peek-def')).toHaveLength(2);
		expect(dom.querySelector('.ggs-peek-name')!.textContent).toBe('fn');
		expect(dom.querySelector('.ggs-peek-kind')!.textContent).toBe('function');
		await flush(2);
		expect(dom.querySelector('.ggs-peek-body')!.textContent).toBe('int one(void);');
		expect(dom.querySelectorAll('.ggs-peek-def')[0]!.classList.contains('active')).toBe(true);
		click(dom.querySelectorAll('.ggs-peek-def')[1]);
		await flush(2);
		expect(dom.querySelector('.ggs-peek-body')!.textContent).toBe('int two(void);');
		expect(dom.querySelectorAll('.ggs-peek-def')[1]!.classList.contains('active')).toBe(true);
	});

	it('opens the shown definition through its own actions and closes', () => {
		const opened: string[] = [];
		let closed = 0;
		const dom = buildPeekDom(
			'fn',
			[{ kind: 'function', name: 'fn', path: 'a.c', line: 2 }],
			{
				root: () => 'C:\\repo',
				read: async () => '',
				open: (path, line) => opened.push(`${path}@${line}`),
				close: () => {
					closed++;
				}
			}
		);
		click(dom.querySelector('.ggs-peek-open'));
		expect(opened).toEqual(['a.c@2']);
		expect(closed).toBe(1);
		click(dom.querySelector('.ggs-peek-close'));
		expect(closed).toBe(2);
	});
});

describe('Peek Definition through the index', () => {
	it('shows the definition in place, opens it into a tab, and Escape closes', async () => {
		scriptFiles({ [`${REPO}\\main.ts`]: 'const x = alpha();\n', [`${REPO}\\src\\a.ts`]: 'function alpha() {}\n' });
		backend.on('symbol_lookup', () => [{ kind: 'function', name: 'alpha', path: 'src/a.ts', line: 0 }]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.ts`);
		group.activeView!.dispatch({ selection: { anchor: 10 } });
		await group.peekDefinition();
		await flush(4);
		const peek = document.querySelector('.ggs-peek');
		expect(peek).not.toBeNull();
		expect(peek!.querySelector('.ggs-peek-name')!.textContent).toBe('alpha');
		expect(peek!.querySelector('.ggs-peek-body')!.textContent).toBe('function alpha() {}');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('main.ts', 'the file never moves');

		// The popup's Open button rides the same jump: a tab opens at the definition.
		click(peek!.querySelector('.ggs-peek-open'));
		await flush(4);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.ts');
		expect(document.querySelector('.ggs-peek')).toBeNull('opening dismisses the popup');

		// A second peek stands alone; Escape dismisses it without opening anything.
		await group.openFile(`${REPO}\\main.ts`);
		group.activeView!.dispatch({ selection: { anchor: 10 } });
		await group.peekDefinition();
		await flush(4);
		expect(document.querySelector('.ggs-peek')).not.toBeNull();
		key(document, 'Escape');
		expect(document.querySelector('.ggs-peek')).toBeNull();
	});

	it('answers nothing when the index holds no definition', async () => {
		scriptFiles({ [`${REPO}\\main.ts`]: 'const x = alpha();\n' });
		backend.on('symbol_lookup', () => []);
		backend.on('workspace_symbols', () => []);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.ts`);
		group.activeView!.dispatch({ selection: { anchor: 10 } });
		await group.peekDefinition();
		await flush(4);
		expect(document.querySelector('.ggs-peek')).toBeNull();
		expect(document.querySelector('.notification')?.textContent).toContain('alpha');
	});
});

describe('Scope-aware definitions (2026-11-18)', () => {
	// The C file the scope tests live in: a global function `total` with a file-scope
	// call site, a local `total` and a parameter `first` inside `step`.
	const C_TEXT = 'int total(int a, int b) { return a + b; }\nint use = total(1, 2);\n\nvoid step(int first) {\n    int total = 0;\n    total = total + first;\n}\n';

	it('Go to Definition jumps to the enclosing function local, never the global', async () => {
		scriptFiles({ [`${REPO}\\main.c`]: C_TEXT });
		// The scope command answers the local; the global index would answer the
		// same-named function — it must not be asked at all.
		backend.on('symbol_scope_lookup', ({ name, ext }) => {
			expect(name).toBe('total');
			expect(ext).toBe('c');
			return [{ kind: 'variable', name: 'total', line: 4, column: 8, scopeEnd: 6 }];
		});
		backend.on('symbol_lookup', () => {
			throw new Error('the global index must not be asked for a scoped name');
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.c`);
		const view = group.activeView!;
		// The cursor sits on the use of the local `total` inside step (line 6, 1-based;
		// column 4 is its first letter).
		view.dispatch({ selection: { anchor: view.state.doc.line(6).from + 4 } });
		await group.goToDefinition();
		await flush(4);
		// The tab never moves; the cursor lands on the local's declaration line.
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('main.c');
		const line = view.state.doc.lineAt(view.state.selection.main.head);
		expect(line.text).toBe('    int total = 0;');
		expect(backend.callsTo('symbol_scope_lookup')).toHaveLength(1);
	});

	it('falls back to the index when the site is outside every local scope', async () => {
		scriptFiles({ [`${REPO}\\main.c`]: C_TEXT, [`${REPO}\\src\\total.c`]: 'int total(int a, int b) { return 0; }\n' });
		backend.on('symbol_scope_lookup', ({ name }) => {
			expect(name).toBe('total');
			return [];
		});
		backend.on('symbol_lookup', () => [{ kind: 'function', name: 'total', path: 'src/total.c', line: 0 }]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.c`);
		const view = group.activeView!;
		// Line 2 is file scope: the call site of the global function.
		view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 10 } });
		await group.goToDefinition();
		await flush(4);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('total.c');
	});

	it('the hover shows the scoped declaration alone and slices it from the buffer', async () => {
		resetQuickInfoCache();
		const reads: string[] = [];
		const source: MacroHoverSource = {
			root: () => 'C:\\repo',
			lookup: async () => {
				throw new Error('the index must not be asked when a local answers');
			},
			read: async (path) => {
				reads.push(path);
				return null;
			},
			scopeLookup: async (name, line, text) => {
				expect(line).toBe(5);
				expect(text.split('\n')[5]).toContain('total = total + first');
				return [{ kind: 'variable', name, line: 4, column: 8, scopeEnd: 6 }];
			}
		};
		const info = await scopeQuickInfoFor(source, 'total', 5, C_TEXT, `${REPO}\\main.c`);
		expect(info).not.toBeNull();
		expect(info!.entries).toHaveLength(1);
		expect(info!.entries[0]!.text).toBe('int total = 0;');
		expect(info!.entries[0]!.path).toBe('main.c');
		expect(info!.entries[0]!.line).toBe(4);
		expect(reads).toHaveLength(0);
		// And a source without the scope lookup (a diff tab, the tests' older fakes)
		// answers nothing locally — the caller falls back to the index path.
		const bare: MacroHoverSource = { root: () => 'C:\\repo', lookup: async () => [], read: async () => null };
		expect(await scopeQuickInfoFor(bare, 'total', 5, C_TEXT, `${REPO}\\main.c`)).toBeNull();
	});

	it('Peek Definition shows the local with this file as its own path', async () => {
		scriptFiles({ [`${REPO}\\main.c`]: C_TEXT });
		backend.on('symbol_scope_lookup', ({ name }) => {
			expect(name).toBe('first');
			return [{ kind: 'parameter', name: 'first', line: 3, column: 18, scopeEnd: 6 }];
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\main.c`);
		const view = group.activeView!;
		view.dispatch({ selection: { anchor: view.state.doc.line(6).from + 20 } });
		await group.peekDefinition();
		await flush(4);
		const peek = document.querySelector('.ggs-peek');
		expect(peek).not.toBeNull();
		expect(peek!.querySelector('.ggs-peek-name')!.textContent).toBe('first');
		expect(peek!.querySelector('.ggs-peek-kind')!.textContent).toBe('parameter');
		// Opening the local stays in this file — the declaration is its own.
		click(peek!.querySelector('.ggs-peek-open'));
		await flush(4);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('main.c');
	});
});

