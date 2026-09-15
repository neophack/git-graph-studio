// The symbol index's frontend surfaces (M4): Quick Open's @ / # modes, Go-to-Definition's
// exact-name lookup with its multi-definition list, Find References' narrowed scan, the
// status bar's indexing item, the Context Window - and the M7 polish that landed with them
// (the density setting, the auto theme).

import { beforeEach, describe, expect, it } from 'vitest';

import { applyTheme, updateSetting } from '../src/settings';
import { ContextView } from '../src/contextView';
import { EditorGroup } from '../src/editor';
import { StatusBar } from '../src/statusbar';
import { buildTree, subtreeCounts, SymbolDatabaseView } from '../src/symbolDbView';
import { fileSymbolItems, workspaceSymbolItems } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, key, texts } from './helpers';

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
	await import('../src/textEditor');
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
