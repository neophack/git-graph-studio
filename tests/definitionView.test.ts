// The Definition panel page (module 5): the clicked symbol's definition content — the
// body sliced through the index's end_line, a macro extended over its continuations, the
// cap's cut note, the header's location jump, the pin, and the workbench wiring (the
// palette command, the panel page, the cursor follow's gate, the zh-cn pairs).

import { beforeEach, describe, expect, it } from 'vitest';

import { DefinitionView } from '../src/features/search';
import { commands } from '../src/platform/commands';
import { updateSetting } from '../src/platform/settings';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, menuItem, rightClick, texts } from './helpers';
import type { WsSymbol } from '../src/platform/ipc/search';

const FILE_BODY = [
	'int total(int a, int b)',
	'{',
	'    int sum = a + b;',
	'    return sum;',
	'}',
	'int after(void)',
	'{',
	'    return 1;',
	'}'
].join('\n');

const DEFS: WsSymbol[] = [{ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 }];

function mountView(): DefinitionView {
	const view = new DefinitionView();
	document.body.appendChild(view.element);
	return view;
}

/** The caret point `charAt` characters into the row's text — the mocked
 *  caretRangeFromPoint's answer, walked off the row's own text nodes. */
function caretAt(row: HTMLElement, charAt: number): { startContainer: Node; startOffset: number } {
	const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
	let at = 0;
	let node = walker.nextNode();
	while (node) {
		const length = node.textContent?.length ?? 0;
		if (at + length > charAt) return { startContainer: node, startOffset: charAt - at };
		at += length;
		node = walker.nextNode();
	}
	throw new Error('the caret walked past the row');
}

beforeEach(() => {
	backend.reset();
	updateSetting('locale', 'en');
	backend.on('symbol_lookup', ({ name }) => (name === 'total' ? DEFS : []));
	backend.on('read_file', ({ path }) => (path === 'src/math.c' ? { contents: FILE_BODY, binary: false, size: FILE_BODY.length } : undefined));
});

	describe('rendering the definition', () => {
		it('shows the body through the end line, with the header naming kind and location', async () => {
			const view = mountView();
			view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
			await flush();
			expect(texts('.def-name', view.element)).toEqual(['total']);
			expect(view.element.querySelector('.def-kind')?.textContent).toBe('function');
			// The whole file is the live view now, the symbol's own
			// span marked as the selection.
			expect(view.element.querySelector('.def-code')?.textContent).toBe(FILE_BODY);
			const selected = [...view.element.querySelectorAll<HTMLElement>('.def-line.def-sel')];
			expect(selected.map((row) => row.dataset['line'])).toEqual(['0', '1', '2', '3', '4']);
			view.element.remove();
		});

		it("the body's code is colored — the tokenizer's runs over the lines", async () => {
			const view = mountView();
			view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
			await flush();
			const code = view.element.querySelector('.def-code')!;
			// The keywords (`int`, `return`) ride their own class, the line spans carry the
			// rows, and the pane's text content stays the code verbatim.
			const keywords = [...code.querySelectorAll('.hl-keyword')].map((span) => span.textContent);
			expect(keywords).toContain('int');
			expect(keywords).toContain('return');
			expect(code.querySelectorAll('.def-line').length).toBe(9); // the whole file
			view.element.remove();
		});

	it('a macro without an indexed end extends over its backslash continuations', async () => {
		const macro = [
			'#define WIDE(a) \\',
			'    ((a) < 0 ? \\',
			'     -(a) : (a))',
			'int after;'
		].join('\n');
		backend.on('read_file', () => ({ contents: macro, binary: false, size: macro.length }));
		const view = mountView();
		view.setDefinition({ kind: 'macro', name: 'WIDE', path: 'src/wide.h', line: 0 });
		await flush();
		// The whole file shows, and the macro's span extends over its continuations.
		expect(view.element.querySelector('.def-code')?.textContent).toBe(macro);
		const selected = [...view.element.querySelectorAll<HTMLElement>('.def-line.def-sel')];
		expect(selected.map((row) => row.dataset['line'])).toEqual(['0', '1', '2']);
		view.element.remove();
	});

	it('a file past the whole-file ceiling refuses with its own note', async () => {
		const big = ['int x;'].join(';');
		const padded = big + ' '.repeat(1024 * 1024 + 8 - big.length); // past 1 MiB + 1
		backend.on('read_file', () => ({ contents: padded, binary: false, size: padded.length }));
		const view = mountView();
		view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
		await flush();
		expect(view.element.querySelector('.def-hint')?.textContent).toContain('file too big');
		view.element.remove();
	});

	it('a click on a word relocates the page onto its definition', async () => {
		const AFTER = [{ kind: 'function', name: 'after', path: 'src/math.c', line: 5, endLine: 7 }];
		backend.on('symbol_lookup', ({ name }) => (name === 'total' ? DEFS : AFTER));
		const view = mountView();
		view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
		await flush();
		// The caret mock answers the word 'after' on the whole-file view's line 6.
		const row = view.element.querySelector<HTMLElement>('.def-line[data-line="5"]')!; // 'int after(void)'
		const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range };
		doc.caretRangeFromPoint = () => caretAt(row, 4) as Range;
		click(row);
		await flush();
		expect(view.element.querySelector('.def-name')?.textContent).toBe('after');
		const chosen = [...view.element.querySelectorAll<HTMLElement>('.def-line.def-sel')];
		expect(chosen.map((sel) => sel.dataset['line'])).toEqual(['5', '6', '7']);
		doc.caretRangeFromPoint = undefined;
		view.element.remove();
	});

	it('the location button jumps at the 1-based line', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpenDefinition = (path, line) => opens.push(`${path}:${line}`);
		view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
		await flush();
		click(view.element.querySelector('.def-location'));
		expect(opens).toEqual(['src/math.c:1']);
		view.element.remove();
	});

	it("the right-click menu syncs the page's current position to the code page", async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpenDefinition = (path, line) => opens.push(`${path}:${line}`);
		view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
		await flush();
		// The menu stands anywhere on the page; its entry makes the same jump the
		// location button makes (the wiring joins the repo root on its side).
		rightClick(view.element.querySelector('.def-name')!);
		click(menuItem('Sync the current position to the code page')!);
		expect(opens).toEqual(['src/math.c:1']);
		// A chain-browsed page syncs its new position: re-root on 'after' and sync again.
		const AFTER = [{ kind: 'function', name: 'after', path: 'src/math.c', line: 5, endLine: 7 }];
		backend.on('symbol_lookup', ({ name }) => (name === 'after' ? AFTER : DEFS));
		const row = view.element.querySelector<HTMLElement>('.def-line[data-line="5"]')!;
		const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range };
		doc.caretRangeFromPoint = () => caretAt(row, 4) as Range;
		click(row);
		await flush();
		rightClick(view.element.querySelector('.def-name')!);
		click(menuItem('Sync the current position to the code page')!);
		expect(opens).toEqual(['src/math.c:1', 'src/math.c:6']);
		doc.caretRangeFromPoint = undefined;
		view.element.remove();
	});

	it('no subject, no sync menu', async () => {
		const view = mountView();
		view.setDefinition(null);
		rightClick(view.element.querySelector('.def-hint')!);
		expect(document.querySelector('.context-menu')).toBeNull();
		view.element.remove();
	});

	it('no subject shows the resting hint', () => {
		const view = mountView();
		view.setDefinition(null);
		expect(view.element.querySelector('.def-hint')?.textContent).toContain('Click a symbol');
		view.element.remove();
	});

	it("the body's read resolves through the host's absolute spelling", async () => {
		const view = mountView();
		const reads: string[] = [];
		backend.on('read_file', ({ path }) => {
			reads.push(String(path));
			return String(path) === 'C:\\repo\\src\\math.c' ? { contents: FILE_BODY, binary: false, size: FILE_BODY.length } : undefined;
		});
		view.resolvePath = (path) => `C:\\repo\\${path.replaceAll('/', '\\')}`;
		view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
		await flush();
		// The repo-relative index path crossed joined; the body rendered from the answer.
		expect(reads).toEqual(['C:\\repo\\src\\math.c']);
		expect(view.element.querySelector('.def-code')?.textContent).toContain('int total(int a, int b)');
		view.element.remove();
	});
});

/* ---------- The workbench wiring ---------- */

import { trText } from '../src/platform/i18n';

describe('the workbench wiring', () => {
	/** The proven boot table (tests/symbolWindow.test.ts): the workbench constructor and
	 *  boot against these handlers reach a settled shell without any unhandled invoke. */
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
		backend.on('symbol_file_outline', () => ({ symbols: [], imports: [] }));
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		workbench?.dispose();
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
	});

	it('registers the palette command with its zh-cn pair and renders the panel tab in Chinese', () => {
		const command = commands.get('workbench.showDefinition');
		expect(command).toBeDefined();
		expect(commands.paletteItems().some((item) => item.value === 'workbench.showDefinition')).toBe(true);

		updateSetting('locale', 'zh-cn');
		expect(trText('Definition')).toBe('定义');
		expect(texts('.panel-title')).toContain('定义');
		updateSetting('locale', 'en');
		expect(texts('.panel-title')).toContain('Definition');
		workbench.dispose();
	});

	it('the follow only asks while the definition page is the active one and unpinned', async () => {
		workbench.panel.show('definition');
		const asked: Record<string, unknown>[] = [];
		backend.on('symbol_lookup', (args) => {
			asked.push(args);
			return [];
		});
		// No active editor view: the resolver clears the page without an ask.
		await workbench.resolveDefinitionSymbol({ kind: 'file', path: 'C:\\repo\\src\\main.c', line: 3, column: 5 });
		expect(asked).toHaveLength(0);
		workbench.dispose();
	});

	it('the panel pages read through the joined root, an absolute path passing through', () => {
		expect(workbench.panel.definition.resolvePath?.('src/a.c')).toBe('C:\\repo\\src\\a.c');
		expect(workbench.panel.references.resolvePath?.('src/a.c')).toBe('C:\\repo\\src\\a.c');
		expect(workbench.panel.definition.resolvePath?.('D:\\elsewhere\\a.c')).toBe('D:\\elsewhere\\a.c');
		workbench.dispose();
	});

	it("the relation click's feed pins the page, shows it and lands the subject", async () => {
		const page = workbench.panel.definition;
		expect(page.isPinned()).toBe(false);
		// The graph's plain click rides this hook: pin FIRST — the page's activation
		// below re-resolves the cursor's symbol through the debounced follow, whose gate
		// the pin is, so the symbol the click named stands.
		workbench.symbolWindow.onShowDefinition!({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 });
		await flush(5);
		expect(page.isPinned()).toBe(true);
		expect(workbench.panel.isVisible()).toBe(true);
		expect(workbench.panel.activeView()).toBe('definition');
		expect(page.element.querySelector('.def-name')?.textContent).toBe('total');
		// No active editor view: had the activation's follow fired past the gate, its
		// resolver would have cleared the page after its debounce — the subject stays.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(page.element.querySelector('.def-name')?.textContent).toBe('total');
		workbench.dispose();
	});
});
