// The Code Analysis module's vitest (module 17): the sidebar (tool rows, index state,
// rebuild) and the five result pages — the streaming reports over their batch/done
// channels, the module analysis drawing (the @antv/G6 stub verifying the mapping, the
// layout switch and the block double-click) beside its tree, and the import graph's
// cycles. Everything runs against the scripted `tauriMock` backend like every other
// view suite.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from './helpers';

import { backend, Channel } from './tauriMock';
import { created as g6Graphs } from './g6Stub';

vi.mock('@antv/g6', () => import('./g6Stub'));

let AnalysisView: typeof import('../src/analysisView').AnalysisView;
let createAnalysisPage: typeof import('../src/analysisPages').createAnalysisPage;
let ANALYSIS_TOOLS: typeof import('../src/analysisTools').ANALYSIS_TOOLS;

async function modules(): Promise<void> {
	({ AnalysisView } = await import('../src/analysisView'));
	({ createAnalysisPage } = await import('../src/analysisPages'));
	({ ANALYSIS_TOOLS } = await import('../src/analysisTools'));
}

function host(): HTMLElement {
	const element = document.createElement('div');
	document.body.appendChild(element);
	return element;
}

function texts(selector: string, root: ParentNode = document): string[] {
	return [...root.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? '');
}

/** The module graph fixture the drawing and the tree share. */
function moduleGraphAnswer(): Record<string, unknown> {
	return {
		modules: [
			{ name: '', files: 1, symbols: 2 },
			{ name: 'src', files: 3, symbols: 9 }
		],
		edges: [
			{ from: 'src', to: 'src', calls: 6, files: 2 },
			{ from: '', to: 'src', calls: 2, files: 1 }
		],
		fileEdges: [
			{ from: 'src/a.ts', to: 'src/ui.ts', calls: 5, sites: [
				{ from: 'main', to: 'render', line: 3, column: 2 },
				{ from: 'boot', to: 'render', line: 9, column: 7 }
			] },
			{ from: 'src/b.ts', to: 'src/ui.ts', calls: 1, sites: [{ from: 'walk', to: 'render', line: 0, column: 4 }] },
			{ from: 'top.rs', to: 'src/a.ts', calls: 2, sites: [
				{ from: 'start', to: 'main', line: 1, column: 0 },
				{ from: 'stop', to: 'main', line: 5, column: 1 }
			] }
		],
		totalCalls: 8,
		totalFileEdges: 3
	};
}

beforeEach(() => {
	g6Graphs.length = 0;
});

describe('the Analysis sidebar', () => {
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
		// The filter narrows to what it matches.
		const filter = document.querySelector<HTMLInputElement>('.an-filter')!;
		filter.value = 'calm';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
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

	it('a failing report shows the building hint instead of throwing', async () => {
		await modules();
		backend.on('analysis_metrics', () => {
			throw new Error('The code analysis index is still building');
		});
		createAnalysisPage('metrics', host());
		await flush(8);
		expect(texts('.an-title')[0]).toContain('building');
	});
});

describe('the graph pages', () => {
	it('module analysis opens on the drawing and opens a file on block double-click', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		// The page opens on the drawing: one G6 graph over the files, rendered once.
		expect(g6Graphs.length).toBe(1);
		const graph = g6Graphs[0]!;
		const options = graph.options as {
			data: { nodes: { id: string; data: { module: string } }[]; edges: { source: string; target: string }[] };
			layout: { type: string };
			behaviors: string[];
		};
		expect(graph.rendered).toBe(1);
		// The busiest files lead the blocks: a.ts (5 out + 2 in) before ui.ts (6 in).
		expect(options.data.nodes.map((node) => node.id)).toEqual(['src/a.ts', 'src/ui.ts', 'top.rs', 'src/b.ts']);
		expect(options.data.nodes[0].data.module).toBe('src');
		// Every block carries its real rectangle in data.size — the collision source the
		// layouts read, so no block ever sits on another.
		const firstNode = options.data.nodes[0] as { data: { size: [number, number] } };
		expect(firstNode.data.size[1]).toBe(30);
		expect(firstNode.data.size[0]).toBeGreaterThanOrEqual(72);
		expect(options.data.edges.map((edge) => `${edge.source}→${edge.target}`)).toEqual([
			'src/a.ts→src/ui.ts',
			'src/b.ts→src/ui.ts',
			'top.rs→src/a.ts'
		]);
		// The default layout is circular — the blocks on a ring whose radius fits their
		// combined widths; without a force simulation, blocks drag alone.
		expect(options.layout.type).toBe('circular');
		expect((options.layout as { radius?: number }).radius).toBeGreaterThanOrEqual(260);
		expect(options.behaviors).toContain('drag-element');
		expect(options.behaviors).not.toContain('drag-element-force');
		expect(options.behaviors).toContain('zoom-canvas');
		// A double-clicked block opens the file.
		graph.emit('node:dblclick', { target: { id: 'src/a.ts' } });
		expect(opened).toEqual(['src/a.ts:1']);
	});

	it('module analysis switches layouts, capping the drawing at 400 blocks', async () => {
		await modules();
		const fileEdges = Array.from({ length: 401 }, (_, i) => ({
			from: `f${String(i).padStart(3, '0')}.rs`,
			to: 'hub.rs',
			calls: 1,
			sites: []
		}));
		backend.on('analysis_module_graph', () => ({
			modules: [{ name: '', files: 402, symbols: 500 }],
			edges: [{ from: '', to: '', calls: 401, files: 401 }],
			fileEdges,
			totalCalls: 401,
			totalFileEdges: 401
		}));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		const first = g6Graphs.at(-1)!;
		const firstData = (first.options as { data: { nodes: unknown[] } }).data;
		expect(firstData.nodes.length).toBe(400, 'the drawing caps at 400 blocks');
		expect(texts('.an-more', root)[0]).toContain('2 more files');
		// The layout picker rebuilds the drawing with the chosen algorithm — the layered
		// layout runs left-to-right with spacing wide enough for the blocks.
		const select = root.querySelector<HTMLSelectElement>('.an-layout')!;
		select.value = 'dagre';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await flush(4);
		const second = g6Graphs.at(-1)!;
		expect(second).not.toBe(first);
		const layout = (second.options as { layout: { type: string; rankdir?: string; nodesep?: number; ranksep?: number } }).layout;
		expect(layout.type).toBe('dagre');
		expect(layout.rankdir).toBe('LR');
		expect(layout.nodesep).toBeGreaterThanOrEqual(20);
		expect(layout.ranksep).toBeGreaterThanOrEqual(50);
		expect((second.options as { behaviors: string[] }).behaviors).toContain('drag-element');
	});

	it('module analysis toggles to the tree and expands to files and call sites', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		expect(texts('.an-title', root)[0]).toBe('2 modules · 3 file dependencies · 8 cross-file calls');
		// The Tree toggle flips the view; the layout picker steps aside.
		const toggles = [...root.querySelectorAll<HTMLElement>('.an-toggle')];
		expect(toggles[0].classList.contains('on')).toBe(true);
		toggles[1].click();
		expect(root.classList.contains('an-tree')).toBe(true);
		expect(root.querySelector<HTMLElement>('.an-branch')).toBeTruthy();
		// The tree starts collapsed at the module edges.
		const branches = [...root.querySelectorAll<HTMLElement>('.an-branch')];
		expect(branches.length).toBe(2);
		expect(branches[0].textContent).toContain('src→src');
		expect(branches[0].textContent).toContain('6 calls');
		expect(branches[0].textContent).toContain('2 file pairs');
		expect(branches[1].textContent).toContain('(root)→src');
		expect(root.querySelectorAll('.an-row.an-l1').length).toBe(0, 'the tree starts collapsed');

		// Expanding a module edge lists its file pairs in the payload's calls-first order.
		branches[0].click();
		await flush(2);
		const files = [...root.querySelectorAll<HTMLElement>('.an-row.an-l1')];
		expect(files.length).toBe(2);
		expect(files[0].textContent).toContain('src/a.ts→src/ui.ts');
		expect(files[1].textContent).toContain('src/b.ts→src/ui.ts');
		expect(root.querySelectorAll('.an-row.an-l2').length).toBe(0);

		// Expanding a file pair lists its call sites; a site click opens the caller's line.
		files[0].click();
		await flush(2);
		const sites = [...root.querySelectorAll<HTMLElement>('.an-row.an-l2')];
		expect(sites.length).toBe(2);
		expect(sites[0].textContent).toContain('main→render');
		expect(sites[0].textContent).toContain('src/a.ts:4');
		// 5 calls but only 2 sites listed — the trailing count stays honest.
		expect(texts('.an-more', root).some((text) => text.includes('3'))).toBe(true);
		sites[0].click();
		expect(opened).toEqual(['src/a.ts:4']);

		// The filter narrows the whole tree — a symbol name reaches the pair that calls
		// it, and an edge that matched only through a child shows just that child.
		const filter = root.querySelector<HTMLInputElement>('.an-filter')!;
		filter.value = 'boot';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		expect(root.querySelectorAll('.an-branch').length).toBe(1);
		expect(root.querySelectorAll('.an-row.an-l1').length).toBe(1);
		expect(texts('.an-row.an-l1', root)[0]).toContain('src/a.ts→src/ui.ts');
	});

	it('module analysis says how many file dependencies the cap hid', async () => {
		await modules();
		backend.on('analysis_module_graph', () => ({
			modules: [{ name: 'src', files: 2, symbols: 4 }],
			edges: [{ from: 'src', to: 'src', calls: 3, files: 2 }],
			fileEdges: [{ from: 'src/a.ts', to: 'src/b.ts', calls: 3, sites: [] }],
			totalCalls: 3,
			totalFileEdges: 2
		}));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		(root.querySelectorAll<HTMLElement>('.an-toggle')[1]).click();
		expect(texts('.an-more', root)[0]).toBe('showing 1 of 2 file dependencies');
	});

	it('module analysis shows its empty state when no file calls another', async () => {
		await modules();
		backend.on('analysis_module_graph', () => ({
			modules: [{ name: 'src', files: 2, symbols: 4 }],
			edges: [],
			fileEdges: [],
			totalCalls: 0,
			totalFileEdges: 0
		}));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		expect(texts('.an-empty', root)[0]).toContain('No cross-file calls');
		expect(g6Graphs.length).toBe(0, 'nothing to draw');
	});

	it('module analysis highlights the clicked block\'s dependencies and dims the rest', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		const graph = g6Graphs[0]!;
		graph.emit('node:click', { target: { id: 'src/a.ts' } });
		await flush(2);
		// The clicked block takes the selection, its neighbours thicken, every arrow it
		// touches is selected too, and everything else fades back.
		const states = graph.stateCalls[0] as Record<string, string[]>;
		expect(states['src/a.ts']).toEqual(['selected']);
		expect(states['src/ui.ts']).toEqual(['related']);
		expect(states['top.rs']).toEqual(['related']);
		expect(states['src/b.ts']).toEqual(['dim']);
		expect(states['src/a.ts→src/ui.ts']).toEqual(['selected']);
		expect(states['top.rs→src/a.ts']).toEqual(['selected']);
		expect(states['src/b.ts→src/ui.ts']).toEqual(['dim']);
		// The chip over the canvas states what is selected.
		expect(texts('.an-graphbar .chip', root)[0]).toContain('src/a.ts');
		// A click on empty canvas returns the drawing to neutral.
		graph.emit('canvas:click', {});
		await flush(2);
		const cleared = graph.stateCalls[1] as Record<string, string[]>;
		expect(cleared['src/a.ts']).toEqual([]);
		expect(cleared['src/b.ts→src/ui.ts']).toEqual([]);
		expect(root.querySelectorAll('.an-graphbar .chip').length).toBe(0);
	});

	it('module analysis right-clicks a block into a navigation menu', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		const graph = g6Graphs[0]!;
		graph.emit('node:contextmenu', { target: { id: 'src/a.ts' }, clientX: 40, clientY: 40 });
		await flush(2);
		const items = () => [...document.querySelectorAll<HTMLElement>('.context-menu .item')];
		expect(items().map((item) => item.textContent)).toContain('Open File');
		// Open File is the double-click jump, from the menu.
		items().find((item) => item.textContent === 'Open File')!.click();
		expect(opened).toEqual(['src/a.ts:1']);
		// The Calls submenu lists the related blocks; picking one selects and centres it.
		graph.emit('node:contextmenu', { target: { id: 'src/a.ts' }, clientX: 40, clientY: 40 });
		await flush(2);
		items().find((item) => item.textContent === 'Calls (1)')!.dispatchEvent(new MouseEvent('mouseenter'));
		await flush(2);
		const neighbour = items().find((item) => item.textContent?.includes('src/ui.ts'))!;
		neighbour.click();
		expect(graph.focused).toEqual(['src/ui.ts']);
		const states = graph.stateCalls.at(-1) as Record<string, string[]>;
		expect(states['src/ui.ts']).toEqual(['selected']);
	});

	it('module analysis right-clicks an arrow into its call sites', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		const graph = g6Graphs[0]!;
		graph.emit('edge:contextmenu', { target: { id: 'src/a.ts→src/ui.ts' }, clientX: 40, clientY: 40 });
		await flush(2);
		const items = () => [...document.querySelectorAll<HTMLElement>('.context-menu .item')];
		expect(items().some((item) => item.textContent === 'src/a.ts → src/ui.ts')).toBe(true);
		items().find((item) => item.textContent === 'Call Sites (2)')!.dispatchEvent(new MouseEvent('mouseenter'));
		await flush(2);
		items().find((item) => item.textContent?.includes('main→render'))!.click();
		expect(opened).toEqual(['src/a.ts:4']);
	});

	it('module analysis focuses a block\'s neighbourhood from the menu', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		const graph = g6Graphs[0]!;
		graph.emit('node:contextmenu', { target: { id: 'src/ui.ts' }, clientX: 40, clientY: 40 });
		await flush(2);
		[...document.querySelectorAll<HTMLElement>('.context-menu .item')]
			.find((item) => item.textContent === 'Show Only Related Files')!.click();
		await flush(6);
		// The drawing rebuilds around the block: itself and the two files that call it.
		const focused = g6Graphs.at(-1)!;
		expect(focused).not.toBe(graph);
		const ids = (focused.options as { data: { nodes: { id: string }[] } }).data.nodes.map((node) => node.id);
		expect(ids).toEqual(['src/ui.ts', 'src/a.ts', 'src/b.ts']);
		// The chip names the focus and clears it — back to every file.
		expect(texts('.an-graphbar .chip', root)[0]).toContain('src/ui.ts');
		(root.querySelector('.an-graphbar .chip .action-btn') as HTMLElement).click();
		await flush(6);
		const restored = g6Graphs.at(-1)!;
		expect((restored.options as { data: { nodes: unknown[] } }).data.nodes.length).toBe(4);
	});

	it('module analysis draws a legend of the modules on the canvas', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		// Busiest module first, the workspace root included under its label.
		expect(texts('.an-legend-item', root)).toEqual(['src', '(root)']);
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
		const root = host();
		createAnalysisPage('mcp', root);
		await flush(8);
		const sections = texts('.an-section', root);
		expect(sections.length).toBe(3);
		expect(sections[0]).toContain('Connecting');
		expect(sections[1]).toContain('Tool catalogue (2)');
		expect(sections[2]).toContain('Recent calls (2)');
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
});
