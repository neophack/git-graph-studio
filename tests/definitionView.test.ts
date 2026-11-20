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
import { click, flush, texts } from './helpers';
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
		expect(view.element.querySelector('.def-location')?.textContent).toBe('math.c:1');
		expect(view.element.querySelector('.def-code')?.textContent).toBe('int total(int a, int b)\n{\n    int sum = a + b;\n    return sum;\n}');
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
		expect(view.element.querySelector('.def-code')?.textContent).toBe(macro.split('\n').slice(0, 3).join('\n'));
		view.element.remove();
	});

	it('the cap cuts a long body with the faint note', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) lines.push(`int line_${i};`);
		const big = lines.join('\n');
		backend.on('read_file', () => ({ contents: big, binary: false, size: big.length }));
		const view = mountView();
		view.setDefinition({ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 499 });
		await flush();
		expect(view.element.querySelectorAll('.def-cut')).toHaveLength(1);
		expect(view.element.querySelector('.def-code')?.textContent).toContain('line_398');
		expect(view.element.querySelector('.def-code')?.textContent).not.toContain('line_400');
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

	it('no subject shows the resting hint', () => {
		const view = mountView();
		view.setDefinition(null);
		expect(view.element.querySelector('.def-hint')?.textContent).toContain('Click a symbol');
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
});
