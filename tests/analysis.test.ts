// The Code Analysis module's vitest (module 17): the sidebar (tool rows, index state,
// rebuild) and the five result pages — the streaming reports over their batch/done
// channels, the module analysis drawing (the backend-laid-out diagram the SVG viewport
// renders: group boxes, blocks, arrows, the selection highlight, the right-click
// navigation, the mermaid copy, pan and zoom) beside its tree, and the import graph's
// cycles. Everything runs against the scripted `tauriMock` backend like every other
// view suite.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../src/platform/i18n';
import { flush } from './helpers';

import { backend, Channel } from './tauriMock';

let AnalysisView: typeof import('../src/features/analysis').AnalysisView;
let createAnalysisPage: typeof import('../src/features/analysis').createAnalysisPage;
let ANALYSIS_TOOLS: typeof import('../src/features/analysis').ANALYSIS_TOOLS;

async function modules(): Promise<void> {
	({ AnalysisView } = await import('../src/features/analysis'));
	({ createAnalysisPage } = await import('../src/features/analysis'));
	({ ANALYSIS_TOOLS } = await import('../src/features/analysis'));
}

function host(): HTMLElement {
	const element = document.createElement('div');
	document.body.appendChild(element);
	return element;
}

function texts(selector: string, root: ParentNode = document): string[] {
	return [...root.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? '');
}

describe('the Analysis sidebar', () => {
	it('relabels everything when the display language switches', async () => {
		await modules();
		backend.on('analysis_status', () => ({ state: 'ready', done: 3, total: 3, files: 3, symbols: 9, calls: 5 }));
		const view = new AnalysisView(host());
		await view.refresh();
		setLocale('en');
		expect(texts('.sidebar-title .label')[0]).toBe('Analysis');
		expect(texts('.pane-header .label')[0]).toBe('Tools');
		// The switch relabels the titles, the pane headers, the tool rows and the state
		// line in place — no remount, the same view instance.
		setLocale('zh-cn');
		expect(texts('.sidebar-title .label')[0]).toBe('代码分析');
		expect(texts('.pane-header .label')[0]).toBe('工具');
		expect(texts('.an-tool .label').some((text) => text.includes('模块'))).toBe(true);
		expect(texts('.an-status')[0]).not.toBe('Analysis');
		setLocale('en');
		expect(texts('.sidebar-title .label')[0]).toBe('Analysis');
	});
	it('lists the five tools and opens their pages on click', async () => {
		await modules();
		backend.on('analysis_status', () => ({ state: 'ready', done: 3, total: 3, files: 3, symbols: 9, calls: 5 }));
		const view = new AnalysisView(host());
		await view.refresh();
		const opened: string[] = [];
		view.onOpenTool = (tool) => opened.push(tool);
		const rows = document.querySelectorAll('.an-tool');
		expect(rows.length).toBe(ANALYSIS_TOOLS.length);
		// The VS Code two-line row: the label and its description stack inside the text
		// column instead of competing for one line, and the full pair rides as the tooltip.
		for (const row of [...rows]) {
			expect(texts('.text .label', row)[0].length).toBeGreaterThan(0);
			expect(texts('.text .description', row)[0].length).toBeGreaterThan(0);
			expect((row as HTMLElement).title).toContain('—');
		}
		(rows[0] as HTMLElement).click();
		expect(opened).toEqual(['modules']);
		expect(texts('.an-status')[0]).toContain('3');
		expect(texts('.an-status')[0]).toContain('9');
	});

	it('shows the building state and runs the rebuild through its channel', async () => {
		await modules();
		backend.on('analysis_status', () => ({ state: 'building', done: 1, total: 4, files: 0, symbols: 0, calls: 0 }));
		const view = new AnalysisView(host());
		await view.refresh();
		expect(texts('.an-status')[0]).toContain('1/4');
		backend.on('analysis_rebuild', ({ onEvent }) => {
			(onEvent as Channel).send({ kind: 'progress', done: 4, total: 4 });
			return { state: 'ready', done: 4, total: 4, files: 4, symbols: 8, calls: 6 };
		});
		(document.querySelector('.pane-header .action-btn') as HTMLElement).click();
		await flush(6);
		expect(backend.callsTo('analysis_rebuild').length).toBe(1);
	});
});

describe('the report pages', () => {
	it('metrics streams batches, sorts by hotspot and opens rows', async () => {
		await modules();
		backend.on('analysis_metrics', ({ onEvent }) => {
			const channel = onEvent as Channel;
			channel.send({
				kind: 'batch',
				rows: [
					{ path: 'src/a.rs', name: 'calm', kind: 'function', container: null, line: 0, lines: 3, params: 1, complexity: 1, nesting: 0, refs: 1, hotspot: 1 },
					{ path: 'src/a.rs', name: 'storm', kind: 'function', container: 'Srv', line: 9, lines: 30, params: 4, complexity: 9, nesting: 3, refs: 4, hotspot: 36 }
				]
			});
			channel.send({ kind: 'done', files: 1, functions: 2, cancelled: false });
			return null;
		});
		const page = createAnalysisPage('metrics', host());
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		const labels = texts('.an-row .label');
		expect(labels[0]).toContain('storm', 'the hotspot leads');
		expect(labels[0]).toContain('Srv', 'the container prefixes the method');
		expect(labels[1]).toContain('calm');
		(document.querySelectorAll('.an-row')[0] as HTMLElement).click();
		expect(opened).toEqual(['src/a.rs:10']);
		// The filter narrows to what it matches (debounced 100 ms).
		const filter = document.querySelector<HTMLInputElement>('.an-filter')!;
		filter.value = 'calm';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(texts('.an-row .label').length).toBe(1);
	});

	it('metrics rows carry the big-code-analysis columns when measured', async () => {
		await modules();
		backend.on('analysis_metrics', ({ onEvent }) => {
			const channel = onEvent as Channel;
			channel.send({
				kind: 'batch',
				rows: [
					// Measured: cognitive, Halstead, LLOC and MI all present.
					{ path: 'src/deep.rs', name: 'deep', kind: 'function', container: null, line: 0, lines: 5, params: 1, complexity: 3, nesting: 2, refs: 1, hotspot: 3, cognitive: 5, halstead: 210, lloc: 4, mi: 62 },
					// Not measured (a language without a grammar): the columns are absent.
					{ path: 'src/plain.sh', name: 'plain', kind: 'function', container: null, line: 0, lines: 2, params: 0, complexity: 1, nesting: 0, refs: 1, hotspot: 1 }
				]
			});
			channel.send({ kind: 'done', files: 2, functions: 2, cancelled: false });
			return null;
		});
		createAnalysisPage('metrics', host());
		await flush(8);
		const chips = texts('.an-row .an-metrics span');
		expect(chips.filter((text) => text.startsWith('Co '))).toEqual(['Co 5']);
		expect(chips.filter((text) => text.startsWith('MI '))).toEqual(['MI 62']);
		const rows = [...document.querySelectorAll<HTMLElement>('.an-row')];
		expect(rows[0].title).toContain('Halstead volume 210', 'the tooltip carries the full detail');
		expect(rows[1].title).toBe('src/plain.sh', 'an unmeasured row keeps the plain path tooltip');
	});

	it('metrics re-sorts the rows by the picked dimension', async () => {
		await modules();
		backend.on('analysis_metrics', ({ onEvent }) => {
			const channel = onEvent as Channel;
			channel.send({
				kind: 'batch',
				rows: [
					{ path: 'src/big/two.rs', name: 'two', kind: 'function', container: null, line: 0, lines: 40, params: 1, complexity: 3, nesting: 0, refs: 1, hotspot: 3, cognitive: 2, halstead: 20, lloc: 30, mi: 55 },
					{ path: 'src/big/one.rs', name: 'one', kind: 'function', container: null, line: 0, lines: 5, params: 1, complexity: 2, nesting: 0, refs: 1, hotspot: 2, cognitive: 1, halstead: 10, lloc: 4, mi: 80 },
					{ path: 'lib/x.rs', name: 'x', kind: 'function', container: null, line: 0, lines: 7, params: 1, complexity: 1, nesting: 0, refs: 1, hotspot: 1 }
				]
			});
			channel.send({ kind: 'done', files: 3, functions: 3, cancelled: false });
			return null;
		});
		createAnalysisPage('metrics', host());
		await flush(8);
		const select = document.querySelector<HTMLSelectElement>('.an-sort')!;
		expect(select.value).toBe('hotspot');
		const labels = () => texts('.an-row .label');
		expect(labels()).toEqual(['two', 'one', 'x'], 'hotspot leads by default');
		// Each switch sorts asynchronously — a yield, then the sorted render.
		const pick = async (id: string) => {
			select.value = id;
			select.dispatchEvent(new Event('change', { bubbles: true }));
			await flush(2);
		};
		// Lines: the longest function first.
		await pick('lines');
		expect(labels()).toEqual(['two', 'x', 'one']);
		// Name: alphabetical.
		await pick('name');
		expect(labels()).toEqual(['one', 'two', 'x']);
		// Maintainability: the worst index leads and unmeasured rows trail last.
		await pick('mi');
		expect(labels()).toEqual(['two', 'one', 'x']);
		// The filter and the sort compose: the narrowed rows keep the picked order.
		await pick('lines');
		const filter = document.querySelector<HTMLInputElement>('.an-filter')!;
		filter.value = 'big';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(labels()).toEqual(['two', 'one']);
	});

	it('dead code honours the exported checkbox by rerunning', async () => {
		await modules();
		const calls: boolean[] = [];
		backend.on('analysis_dead_code', ({ onEvent, includeExported }) => {
			calls.push(Boolean(includeExported));
			(onEvent as Channel).send({ kind: 'done', found: 0, cancelled: false });
			return null;
		});
		createAnalysisPage('deadcode', host());
		await flush(8);
		expect(calls).toEqual([false]);
		const checkbox = document.querySelector<HTMLInputElement>('.an-option input')!;
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change', { bubbles: true }));
		await flush(8);
		expect(calls).toEqual([false, true]);
	});

	it('security renders severity rows with their rule chips', async () => {
		await modules();
		backend.on('analysis_security', ({ onEvent }) => {
			(onEvent as Channel).send({
				kind: 'batch',
				findings: [{ ruleId: 'SEC-003', severity: 'error', message: 'secret-looking literal assigned to a credential variable', path: 'cfg.py', line: 2, column: 0, cwe: 'CWE-798' }]
			});
			(onEvent as Channel).send({ kind: 'done', files: 3, findings: 1, cancelled: false });
			return null;
		});
		createAnalysisPage('security', host());
		await flush(8);
		const row = document.querySelector('.an-row.an-sev-error')!;
		expect(row.textContent).toContain('SEC-003');
		expect(row.textContent).toContain('cfg.py:3');
	});

	it('a failing report shows the retry hint instead of throwing', async () => {
		await modules();
		// The index builds inside the command now; what can still fail is a build cancelled
		// under it (a folder switch).
		backend.on('analysis_metrics', () => {
			throw new Error('The code analysis was cancelled');
		});
		createAnalysisPage('metrics', host());
		await flush(8);
		expect(texts('.an-title')[0]).toContain('try again');
	});

	it('a cold build names its live position while the page waits, and the line clears with the report', async () => {
		await modules();
		let release: (() => void) | null = null;
		backend.on('analysis_dead_code', () => new Promise<void>((resolve) => { release = resolve; }));
		const page = createAnalysisPage('deadcode', host());
		await flush(4);
		// The build's status push (boot routes it) reaches the page: the counter moves
		// instead of a bare spinner.
		page.noteBuildStatus?.({ state: 'building', done: 512, total: 3000, files: 0, symbols: 0, calls: 0 });
		expect(texts('.an-building')[0]).toContain('512');
		expect(texts('.an-building')[0]).toContain('3000');
		// A push from a finished index is not a build: the line stays empty.
		page.noteBuildStatus?.({ state: 'ready', done: 3, total: 3, files: 3, symbols: 9, calls: 5 });
		expect(texts('.an-building')[0]).toBe('');
		page.noteBuildStatus?.({ state: 'building', done: 512, total: 3000, files: 0, symbols: 0, calls: 0 });
		// The report finishing clears the line for good.
		release?.();
		await flush(8);
		expect(texts('.an-building')[0]).toBe('');
	});

	it('a cancelled run retires quietly — its zero totals never stand as the answer', async () => {
		await modules();
		backend.on('analysis_metrics', ({ onEvent }) => {
			(onEvent as Channel).send({ kind: 'batch', rows: [
				{ path: 'a.rs', name: 'fn', kind: 'function', container: null, line: 0, lines: 1, params: 0, complexity: 1, nesting: 0, refs: 0, hotspot: 1 }
			] });
			(onEvent as Channel).send({ kind: 'done', files: 0, functions: 0, cancelled: true });
			return null;
		});
		createAnalysisPage('metrics', host());
		await flush(8);
		// The rows keep streaming (they are honest — they landed), but the cancelled
		// Done's `0 functions measured` must not become the title.
		expect(texts('.an-title')[0]).not.toContain('0 functions');
		expect(texts('.an-title')[0]).toContain('Complexity');
	});
});

describe('the graph pages', () => {
	function overviewAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			scope: '',
			depth: 1,
			breadcrumbs: [],
			nodes: [
				{ id: 'app', label: 'app', kind: 'module', expandable: true, files: 2, symbols: 6, fanIn: 0, fanOut: 1, instability: 1.0, inCycle: false, layer: 0, topFiles: [{ path: 'app/main.ts', symbols: 4 }] },
				{ id: 'core', label: 'core', kind: 'module', expandable: true, files: 3, symbols: 10, fanIn: 2, fanOut: 1, instability: 0.33, inCycle: true, layer: 1, topFiles: [{ path: 'core/engine.ts', symbols: 7 }] },
				{ id: 'db', label: 'db', kind: 'module', expandable: true, files: 1, symbols: 4, fanIn: 1, fanOut: 1, instability: 0.5, inCycle: true, layer: 1, topFiles: [{ path: 'db/store.ts', symbols: 4 }] }
			],
			edges: [
				{ id: 'app→core', from: 'app', to: 'core', weight: 5, symbolRefs: 5, baseRefs: 0, filePairs: 2, topSymbols: ['runCore', 'Engine'], isCycle: false },
				{ id: 'core→db', from: 'core', to: 'db', weight: 4, symbolRefs: 4, baseRefs: 0, filePairs: 1, topSymbols: ['queryDb'], isCycle: true },
				{ id: 'db→core', from: 'db', to: 'core', weight: 2, symbolRefs: 2, baseRefs: 0, filePairs: 1, topSymbols: ['Engine'], isCycle: true }
			],
			cycles: [['core', 'db']],
			totalFiles: 6,
			totalSymbols: 20,
			totalEdges: 3,
			mermaid: 'flowchart TD\n  M0["app"]\n  M0 -->|"5 refs"| M1\n',
			...overrides
		};
	}

	function edgeDetailAnswer(): Record<string, unknown> {
		return {
			from: 'app',
			to: 'core',
			imports: [{ fromFile: 'app/main.ts', toFile: 'core/engine.ts', specifier: '../core/engine' }],
			filePairs: [{
				fromFile: 'app/main.ts',
				toFile: 'core/engine.ts',
				symbols: ['runCore'],
				sites: [{ symbol: 'runCore', receiver: null, line: 3, column: 2 }]
			}],
			scannedFiles: 1
		};
	}

	function nodeEl(root: HTMLElement, id: string): SVGElement {
		return root.querySelector(`g.an-mod-node[data-node-id="${id}"]`)!;
	}

	function edgeEl(root: HTMLElement, id: string): SVGElement {
		return root.querySelector(`g.an-mod-edge[data-edge-id="${id}"]`)!;
	}

	it('renders native SVG layered module cards, cycle markers, and opens node inspector on click', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer());
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(6);

		expect(texts('.an-title', root)[0]).toBe('3 modules · 3 edges · 1 cycles');
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(3);
		expect(root.querySelectorAll('g.an-mod-edge').length).toBe(3);
		expect(edgeEl(root, 'core→db').classList.contains('cycle')).toBe(true);
		expect(nodeEl(root, 'core').classList.contains('cycle')).toBe(true);

		// Clicking a module card highlights neighbours, dims unrelated nodes, and opens the Inspector.
		nodeEl(root, 'app').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(nodeEl(root, 'app').classList.contains('selected')).toBe(true);
		expect(nodeEl(root, 'core').classList.contains('related')).toBe(true);
		expect(nodeEl(root, 'db').classList.contains('dim')).toBe(true);
		expect(root.querySelector<HTMLElement>('.an-inspector')!.hidden).toBe(false);
		expect(texts('.an-insp-title', root)[0]).toBe('app');

		// Clicking a key file inside the Inspector opens it in the editor.
		const keyFileRow = [...root.querySelectorAll<HTMLElement>('.an-insp-row')]
			.find((row) => row.textContent?.includes('app/main.ts'))!;
		keyFileRow.click();
		expect(opened).toEqual(['app/main.ts:1']);
	});

	it('clicks an edge to fetch on-demand L2 imports and routes call sites to the definition panel', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer());
		backend.on('analysis_module_edge_detail', () => edgeDetailAnswer());
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		const shownDefs: Array<{ kind: string; name: string; path: string; line: number }> = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		page.onShowDefinition = (subject) => shownDefs.push(subject);
		await flush(6);

		edgeEl(root, 'app→core').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush(6);
		expect(backend.callsTo('analysis_module_edge_detail')).toHaveLength(1);
		expect(backend.callsTo('analysis_module_edge_detail')[0]).toMatchObject({ from: 'app', to: 'core' });
		expect(texts('.an-insp-title', root)[0]).toBe('app → core');
		const siteRow = [...root.querySelectorAll<HTMLElement>('.an-insp-row')]
			.find((row) => row.textContent?.includes('runCore'))!;
		siteRow.click();
		expect(shownDefs).toEqual([{ kind: 'function', name: 'runCore', path: 'app/main.ts', line: 3 }]);
		expect(opened).toEqual([]);
	});

	it('drills into a module on double-click and navigates back via breadcrumbs', async () => {
		await modules();
		backend.on('analysis_module_overview', ({ scope }: { scope: string | null }) => (
			scope === 'core'
				? overviewAnswer({
					scope: 'core',
					breadcrumbs: ['core'],
					nodes: [{ id: 'core/engine.ts', label: 'engine.ts', kind: 'file', expandable: false, files: 1, symbols: 7, fanIn: 0, fanOut: 0, instability: 0, inCycle: false, layer: 0, topFiles: [] }],
					edges: [],
					cycles: []
				})
				: overviewAnswer()
		));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(6);

		nodeEl(root, 'core').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await flush(6);
		expect(backend.callsTo('analysis_module_overview').at(-1)).toMatchObject({ scope: 'core' });
		expect(texts('.an-crumb', root)).toEqual(['Workspace', 'core']);
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(1);

		// Click root breadcrumb to return to workspace overview.
		root.querySelector<HTMLElement>('.an-crumb')!.click();
		await flush(6);
		expect(backend.callsTo('analysis_module_overview').at(-1)).toMatchObject({ scope: null });
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(3);
	});

	it('filters cycles-only, switches depth, toggles list view, and copies Mermaid', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(6);

		// Cycles-only button narrows to cyclic nodes and edges.
		const cyclesBtn = root.querySelector<HTMLButtonElement>('.an-cycles-btn')!;
		expect(cyclesBtn.hidden).toBe(false);
		cyclesBtn.click();
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(2);
		expect(root.querySelectorAll('g.an-mod-edge').length).toBe(2);
		cyclesBtn.click();
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(3);

		// Depth selector refetches with the selected depth.
		const depthSelect = root.querySelector<HTMLSelectElement>('.an-depth')!;
		depthSelect.value = '3';
		depthSelect.dispatchEvent(new Event('change', { bubbles: true }));
		await flush(6);
		expect(backend.callsTo('analysis_module_overview').at(-1)).toMatchObject({ depth: 3 });

		// List toggle shows flat module dependency rows.
		const toggles = [...root.querySelectorAll<HTMLElement>('.an-toggle')];
		toggles[1].click();
		expect(root.querySelectorAll('.an-list .an-branch').length).toBe(3);
		toggles[0].click();

		// Copy Mermaid copies overview.mermaid to clipboard.
		const copy = [...root.querySelectorAll<HTMLElement>('.an-header .actions .action-btn')]
			.find((button) => button.title === 'Copy Mermaid Source')!;
		copy.click();
		expect(backend.clipboard.at(-1)).toContain('flowchart TD');
	});

	it('scopes to folders and shows empty state when no modules exist', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer({ nodes: [], edges: [], cycles: [] }));
		const root = host();
		createAnalysisPage('modules', root, ['src/editor']);
		await flush(6);
		expect(backend.callsTo('analysis_module_overview')[0]).toMatchObject({ folders: ['src/editor'] });
		expect(texts('.an-empty', root)[0]).toContain('No modules');
	});

	it('zooms from the toolbar, wheel and keyboard', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(6);
		const hostEl = root.querySelector<HTMLElement>('.an-diagram')!;
		const level = () => texts('.an-zoom-level', root)[0];
		const settle = () => new Promise((resolve) => setTimeout(resolve, 220));
		expect(level()).toBe('100%');
		const zoomButton = (title: string) =>
			[...root.querySelectorAll<HTMLElement>('.an-zoombar .action-btn')].find((button) => button.title === title)!;
		zoomButton('Zoom in').click();
		await settle();
		expect(level()).toBe('118%');
		zoomButton('Zoom out').click();
		await settle();
		expect(level()).toBe('100%');
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
		await settle();
		expect(level()).toBe('100%');

		// Pure-vector Netron zoom: transform lives on SVG <g class="an-viewport"> with no CSS scale on stage.
		const stage = root.querySelector<HTMLElement>('.an-svg-stage')!;
		const vp = root.querySelector<SVGGElement>('g.an-viewport')!;
		expect(stage.style.transform).toBe('');
		expect(vp.getAttribute('transform')).toContain('scale(');
		expect(root.querySelector('feDropShadow')).toBeNull();
	});

	it('supports TB/LR layout toggle, minimap toggle, neighborhood isolation, Escape clear, and SVG export', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(6);

		const toolBtn = (title: string) =>
			[...root.querySelectorAll<HTMLElement>('.an-zoombar .action-btn')].find((button) => button.title === title)!;

		// Minimap is rendered for multi-node graphs and can be toggled off/on.
		const minimap = root.querySelector<HTMLElement>('.an-minimap')!;
		expect(minimap.hidden).toBe(false);
		toolBtn('Toggle minimap').click();
		expect(minimap.hidden).toBe(true);
		toolBtn('Toggle minimap').click();
		expect(minimap.hidden).toBe(false);

		// Layout direction switches between Vertical (TB) and Horizontal (LR).
		toolBtn('Horizontal layout (Left to Right)').click();
		expect(toolBtn('Vertical layout (Top to Bottom)')).toBeTruthy();
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(3);

		// Copy SVG Diagram copies standalone SVG markup.
		toolBtn('Copy SVG Diagram').click();
		expect(backend.clipboard.at(-1)).toContain('<svg');

		// Select 'app', then isolate its neighborhood (app + core only, db excluded).
		nodeEl(root, 'app').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const isolateBtn = [...root.querySelectorAll<HTMLButtonElement>('.an-insp-actions .button')]
			.find((b) => b.textContent?.includes('Isolate Neighborhood'))!;
		isolateBtn.click();
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(2);

		// Pressing Escape clears selection, then pressing Escape again clears focus isolation.
		const hostEl = root.querySelector<HTMLElement>('.an-diagram')!;
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(root.querySelector<HTMLElement>('.an-inspector')!.hidden).toBe(true);
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(root.querySelectorAll('g.an-mod-node').length).toBe(3);
	});

	it('allows free infinite-canvas panning at any zoom and after dragging a node below the initial layout', async () => {
		await modules();
		backend.on('analysis_module_overview', () => overviewAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(6);

		const hostEl = root.querySelector<HTMLElement>('.an-diagram')!;
		Object.defineProperty(hostEl, 'clientWidth', { configurable: true, value: 1200 });
		Object.defineProperty(hostEl, 'clientHeight', { configurable: true, value: 800 });
		const vp = root.querySelector<SVGGElement>('g.an-viewport')!;
		const parseTranslate = () => {
			const m = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(vp.getAttribute('transform') ?? '');
			return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
		};
		const raf = () => new Promise((resolve) => setTimeout(resolve, 30));

		// Fit first with explicit viewport size.
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
		await new Promise((resolve) => setTimeout(resolve, 220));
		const start = parseTranslate();

		// Drag canvas freely at 100% zoom even though the graph fits inside the viewport.
		hostEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 200 }));
		hostEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', clientX: 350, clientY: 50 }));
		hostEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', clientX: 350, clientY: 50 }));
		await raf();
		const afterFreePan = parseTranslate();
		expect(afterFreePan.x).toBeGreaterThan(start.x + 100);
		expect(afterFreePan.y).toBeLessThan(start.y - 100);

		// Drag a node far downward, zoom in, then pan freely downward to inspect it.
		const coreNode = nodeEl(root, 'core');
		coreNode.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 2, pointerType: 'mouse', clientX: 100, clientY: 100 }));
		hostEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 2, pointerType: 'mouse', clientX: 100, clientY: 700 }));
		hostEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 2, pointerType: 'mouse', clientX: 100, clientY: 700 }));

		// Zoom in twice via keyboard.
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
		await new Promise((resolve) => setTimeout(resolve, 220));
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
		await new Promise((resolve) => setTimeout(resolve, 220));
		const beforeZoomedPan = parseTranslate();

		// Drag canvas upward by 600px (scrolling view downward past original graph height).
		hostEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 3, pointerType: 'mouse', clientX: 300, clientY: 700 }));
		hostEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, pointerId: 3, pointerType: 'mouse', clientX: 300, clientY: 100 }));
		hostEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 3, pointerType: 'mouse', clientX: 300, clientY: 100 }));
		await raf();
		const afterZoomedPan = parseTranslate();
		expect(afterZoomedPan.y).toBeLessThan(beforeZoomedPan.y - 500);

		// Cycle edge renders cleanly with a ⟳ badge and no stroke-dasharray attribute.
		const cycleEdge = edgeEl(root, 'core→db');
		expect(cycleEdge.querySelector('.an-edge-path')?.getAttribute('stroke-dasharray')).toBeNull();
		expect(cycleEdge.querySelector('.an-edge-badge text')?.textContent).toContain('⟳');
	});

	it('coalesces hover highlights via root has-hover class, translates tooltip on GPU, and enables large-graph mode', async () => {
		await modules();
		const bigNodes = Array.from({ length: 42 }, (_, i) => ({
			id: `mod_${i}`,
			label: `mod_${i}`,
			kind: 'module',
			expandable: true,
			files: 2,
			symbols: 10,
			fanIn: i > 0 ? 1 : 0,
			fanOut: i < 41 ? 1 : 0,
			instability: 0.5,
			inCycle: false,
			layer: i % 4,
			topFiles: []
		}));
		const bigEdges = Array.from({ length: 41 }, (_, i) => ({
			id: `mod_${i}→mod_${i + 1}`,
			from: `mod_${i}`,
			to: `mod_${i + 1}`,
			weight: 2,
			symbolRefs: 2,
			baseRefs: 0,
			filePairs: 1,
			topSymbols: ['fn'],
			isCycle: false
		}));
		backend.on('analysis_module_overview', () => overviewAnswer({
			nodes: bigNodes,
			edges: bigEdges,
			cycles: [],
			totalEdges: bigEdges.length
		}));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(6);

		const diagram = root.querySelector<HTMLElement>('.an-diagram')!;
		const svg = root.querySelector<SVGSVGElement>('svg.an-svg-canvas')!;
		const tip = root.querySelector<HTMLElement>('.an-hover-tip')!;
		expect(diagram.classList.contains('large-graph')).toBe(true);

		const raf = () => new Promise((resolve) => setTimeout(resolve, 25));
		const n0 = nodeEl(root, 'mod_0');
		const n1 = nodeEl(root, 'mod_1');
		const n2 = nodeEl(root, 'mod_2');

		// Hover mod_0: root gets has-hover, only incident elements get hover classes (no O(N) .hover-dim).
		n0.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 80, clientY: 90 }));
		await raf();
		expect(svg.classList.contains('has-hover')).toBe(true);
		expect(n0.classList.contains('hover-self')).toBe(true);
		expect(n1.classList.contains('hover-out')).toBe(true);
		expect(root.querySelectorAll('.hover-dim').length).toBe(0);
		expect(tip.hidden).toBe(false);
		expect(tip.style.transform).toContain('translate3d(');
		expect(tip.style.left).toBe('');

		// Moving directly from mod_0 to mod_1 keeps has-hover steady and updates only the neighborhood.
		n0.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: n1 }));
		expect(svg.classList.contains('has-hover')).toBe(true);
		n1.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 120, clientY: 130 }));
		await raf();
		expect(svg.classList.contains('has-hover')).toBe(true);
		expect(n0.classList.contains('hover-self')).toBe(false);
		expect(n0.classList.contains('hover-in')).toBe(true);
		expect(n1.classList.contains('hover-self')).toBe(true);
		expect(n2.classList.contains('hover-out')).toBe(true);

		// Leaving the graph clears hover cleanly after the brief grace window.
		n1.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(svg.classList.contains('has-hover')).toBe(false);
		expect(tip.hidden).toBe(true);
	});

	it('the MCP page lists setup, the catalogue and the call log', async () => {
		await modules();
		backend.on('mcp_tools', () => [
			{ name: 'symbol_lookup', description: 'Every declaration of exactly this symbol name' },
			{ name: 'analysis_module_graph', description: 'The cross-file calls as module dependencies' }
		]);
		backend.on('mcp_log', () => [
			{ time: 1760000095000, tool: 'symbol_lookup', ok: false, ms: 12, args: '{"name":"missing"}' },
			{ time: 1760000000000, tool: '(start)', ok: true, ms: 0, args: '{"root":"D:\\repo"}' }
		]);
		backend.on('claude_mcp_status', () => ({ registered: true, folder: 'D:\\repo', command: 'C:\\apps\\ggs.exe' }));
		const root = host();
		createAnalysisPage('mcp', root);
		await flush(8);
		const sections = texts('.an-section', root);
		expect(sections.length).toBe(4);
		expect(sections[1]).toContain('Claude Integration');
		expect(sections[0]).toContain('Connecting');
		expect(sections[2]).toContain('Tool catalogue (2)');
		expect(sections[3]).toContain('Recent calls (2)');
		// The command line and the stdio snippet, each with its copy action.
		const snippets = texts('.an-code', root);
		expect(snippets[0]).toContain('ggs --mcp');
		expect(snippets[1]).toContain('"mcpServers"');
		expect(root.querySelectorAll('.an-codebar .action-btn').length).toBe(2);
		// The catalogue rows, and the log rows with the failure marked.
		expect(texts('.an-row .label', root)).toContain('analysis_module_graph');
		const failed = root.querySelector('.an-row.an-sev-error')!;
		expect(failed.textContent).toContain('symbol_lookup');
		expect(failed.textContent).toContain('12 ms');
		expect((failed as HTMLElement).title).toContain('"name":"missing"');
	});

	it('the MCP page shows the Claude integration unregistered when no folder is wired', async () => {
		await modules();
		backend.on('mcp_tools', () => []);
		backend.on('mcp_log', () => []);
		backend.on('claude_mcp_status', () => ({ registered: false, folder: null, command: null }));
		const root = host();
		createAnalysisPage('mcp', root);
		await flush(8);
		expect(texts('.an-section', root)[1]).toContain('Claude Integration');
		expect(texts('.an-empty', root).join(' ')).toContain('Not registered');
	});

	it('import graph lists cycles before dependencies', async () => {
		await modules();
		backend.on('analysis_import_graph', () => ({
			edges: [['src/a.js', 'src/b.js'], ['src/b.js', 'src/a.js'], ['src/c.ts', 'src/b.js']],
			cycles: [['src/a.js', 'src/b.js']]
		}));
		const page = createAnalysisPage('imports', host());
		const opened: string[] = [];
		page.onOpen = (path) => opened.push(path);
		await flush(8);
		const sections = texts('.an-section');
		expect(sections[0]).toContain('Cycles');
		expect(sections[1]).toContain('Dependencies');
		const cycle = document.querySelector('.an-row.an-cycle')!;
		expect(cycle.textContent).toContain('src/a.js→src/b.js');
		cycle.click();
		expect(opened).toEqual(['src/a.js']);
	});

	it('routes item clicks in metrics, dead code, security and import graph to the definition panel', async () => {
		await modules();

		// 1. Complexity & Hotspots (metrics)
		backend.on('analysis_metrics', ({ onEvent }) => {
			const channel = onEvent as Channel;
			channel.send({
				kind: 'batch',
				rows: [
					{ path: 'src/a.rs', name: 'storm', kind: 'method', container: 'Srv', line: 9, lines: 30, params: 4, complexity: 9, nesting: 3, refs: 4, hotspot: 36 }
				]
			});
			channel.send({ kind: 'done', files: 1, functions: 1, cancelled: false });
			return null;
		});
		const metricsRoot = host();
		const metricsPage = createAnalysisPage('metrics', metricsRoot);
		const metricsOpened: string[] = [];
		const metricsDefs: Array<{ kind: string; name: string; path: string; line: number; endLine?: number }> = [];
		metricsPage.onOpen = (path, line) => metricsOpened.push(`${path}:${line}`);
		metricsPage.onShowDefinition = (subject) => metricsDefs.push(subject);
		await flush(8);
		metricsRoot.querySelector<HTMLElement>('.an-row')!.click();
		expect(metricsDefs).toEqual([{ kind: 'method', name: 'Srv.storm', path: 'src/a.rs', line: 9, endLine: 38 }]);
		expect(metricsOpened).toEqual([]);

		// 2. Dead Code (deadcode)
		backend.on('analysis_dead_code', ({ onEvent }) => {
			const channel = onEvent as Channel;
			channel.send({
				kind: 'batch',
				rows: [
					{ path: 'src/unused.ts', name: 'orphan', kind: 'function', container: null, line: 4, exported: false, lines: 6 }
				]
			});
			channel.send({ kind: 'done', found: 1, cancelled: false });
			return null;
		});
		const deadRoot = host();
		const deadPage = createAnalysisPage('deadcode', deadRoot);
		const deadOpened: string[] = [];
		const deadDefs: Array<{ kind: string; name: string; path: string; line: number; endLine?: number }> = [];
		deadPage.onOpen = (path, line) => deadOpened.push(`${path}:${line}`);
		deadPage.onShowDefinition = (subject) => deadDefs.push(subject);
		await flush(8);
		deadRoot.querySelector<HTMLElement>('.an-row')!.click();
		expect(deadDefs).toEqual([{ kind: 'function', name: 'orphan', path: 'src/unused.ts', line: 4, endLine: 9 }]);
		expect(deadOpened).toEqual([]);

		// 3. Security Scan (security)
		backend.on('analysis_security', ({ onEvent }) => {
			const channel = onEvent as Channel;
			channel.send({
				kind: 'batch',
				findings: [{ ruleId: 'SEC-003', severity: 'error', message: 'hardcoded secret', path: 'cfg.py', line: 2, column: 0, cwe: 'CWE-798' }]
			});
			channel.send({ kind: 'done', files: 1, findings: 1, cancelled: false });
			return null;
		});
		const secRoot = host();
		const secPage = createAnalysisPage('security', secRoot);
		const secOpened: string[] = [];
		const secDefs: Array<{ kind: string; name: string; path: string; line: number }> = [];
		secPage.onOpen = (path, line) => secOpened.push(`${path}:${line}`);
		secPage.onShowDefinition = (subject) => secDefs.push(subject);
		await flush(8);
		secRoot.querySelector<HTMLElement>('.an-row')!.click();
		expect(secDefs).toEqual([{ kind: 'file', name: 'SEC-003: hardcoded secret', path: 'cfg.py', line: 2 }]);
		expect(secOpened).toEqual([]);

		// 4. Import Dependency Graph (imports) — cycles, cycle steps, and dependency edges
		backend.on('analysis_import_graph', () => ({
			edges: [['src/c.ts', 'src/b.js']],
			cycles: [['src/a.js', 'src/b.js']]
		}));
		const impRoot = host();
		const impPage = createAnalysisPage('imports', impRoot);
		const impOpened: string[] = [];
		const impDefs: Array<{ kind: string; name: string; path: string; line: number }> = [];
		impPage.onOpen = (path, line) => impOpened.push(`${path}:${line}`);
		impPage.onShowDefinition = (subject) => impDefs.push(subject);
		await flush(8);
		impRoot.querySelector<HTMLElement>('.an-row.an-cycle')!.click();
		impRoot.querySelector<HTMLElement>('.an-cycle-step')!.click();
		impRoot.querySelectorAll<HTMLElement>('.an-row:not(.an-cycle)')[0]!.click();
		expect(impDefs).toEqual([
			{ kind: 'file', name: 'a.js', path: 'src/a.js', line: 0 },
			{ kind: 'file', name: 'b.js', path: 'src/b.js', line: 0 },
			{ kind: 'file', name: 'c.ts', path: 'src/c.ts', line: 0 }
		]);
		expect(impOpened).toEqual([]);
	});
});
