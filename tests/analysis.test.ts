// The Code Analysis module's vitest (module 17): the sidebar (tool rows, index state,
// rebuild) and the five result pages — the streaming reports over their batch/done
// channels, the call graph's search → draw → walk flow, and the import graph's cycles.
// Everything runs against the scripted `tauriMock` backend like every other view suite.

import { describe, expect, it, vi } from 'vitest';
import { flush } from './helpers';

import { backend, Channel } from './tauriMock';

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
		expect(opened).toEqual(['callgraph']);
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
	it('call graph opens on the whole workspace, filters and returns from a walk', async () => {
		await modules();
		backend.on('analysis_workspace_call_graph', () => ({
			nodes: [
				{ kind: 'function', name: 'main', container: null, path: 'src/main.rs', line: 1, complexity: 1, signature: 'fn main()', depth: 0 },
				{ kind: 'method', name: 'render', container: 'View', path: 'src/view.rs', line: 4, complexity: 2, signature: 'fn render()', depth: 1 },
				{ kind: 'method', name: 'paint', container: 'View', path: 'src/view.rs', line: 9, complexity: 1, signature: 'fn paint()', depth: 2 }
			],
			edges: [
				{ from: { name: 'main', path: 'src/main.rs', line: 1 }, to: { name: 'render', path: 'src/view.rs', line: 4 }, callPath: 'src/main.rs', callLine: 2, callColumn: 8 },
				{ from: { name: 'render', path: 'src/view.rs', line: 4 }, to: { name: 'paint', path: 'src/view.rs', line: 9 }, callPath: 'src/view.rs', callLine: 5, callColumn: 4 }
			],
			ambiguous: 0, totalNodes: 3, totalEdges: 2
		}));
		backend.on('workspace_symbols', () => [{ kind: 'method', name: 'render', path: 'src/view.rs', line: 4, container: 'View' }]);
		backend.on('analysis_call_graph', ({ name }) => ({
			nodes: [
				{ kind: 'method', name, container: 'View', path: 'src/view.rs', line: 4, complexity: 2, signature: 'fn render()', depth: 0 },
				{ kind: 'method', name: 'paint', container: 'View', path: 'src/view.rs', line: 9, complexity: 1, signature: 'fn paint()', depth: 1 }
			],
			edges: [{ from: { name, path: 'src/view.rs', line: 4 }, to: { name: 'paint', path: 'src/view.rs', line: 9 }, callPath: 'src/view.rs', callLine: 5, callColumn: 4 }],
			ambiguous: 0
		}));
		createAnalysisPage('callgraph', host());
		await flush(8);
		// The opening view draws every relationship: nodes and their connecting lines.
		expect(document.querySelectorAll('svg.an-svg .an-node').length).toBe(3);
		expect(document.querySelectorAll('svg.an-svg .an-edge').length).toBe(2);
		expect(texts('.an-note')[0]).toContain('3');
		expect(document.querySelector('.an-page.an-full')).toBeTruthy();
		// Typing filters the drawing live (a lone node keeps no edge).
		const search = document.querySelector<HTMLInputElement>('.an-symbol')!;
		search.value = 'paint';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		expect(document.querySelectorAll('svg.an-svg .an-node').length).toBe(1);
		expect(document.querySelectorAll('svg.an-svg .an-edge').length).toBe(0);
		// A node click becomes a focused walk; "All calls" returns to the whole graph.
		search.value = '';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		(document.querySelectorAll('.an-node')[0] as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush(6);
		expect(document.querySelector('.an-page.an-full')).toBeFalsy();
		expect(document.querySelectorAll('svg.an-svg .an-node').length).toBe(2);
		(document.querySelector('.an-header .action-btn') as HTMLElement).click();
		await flush(6);
		expect(document.querySelector('.an-page.an-full')).toBeTruthy();
		expect(document.querySelectorAll('svg.an-svg .an-node').length).toBe(3);
		expect(document.querySelectorAll('svg.an-svg .an-edge').length).toBe(2);
	});

	it('call graph canvas zooms with the wheel and pans by dragging', async () => {
		await modules();
		backend.on('analysis_workspace_call_graph', () => ({
			nodes: [
				{ kind: 'function', name: 'main', container: null, path: 'src/main.rs', line: 1, complexity: 1, signature: 'fn main()', depth: 0 },
				{ kind: 'function', name: 'leaf', container: null, path: 'src/main.rs', line: 5, complexity: 1, signature: 'fn leaf()', depth: 1 }
			],
			edges: [{ from: { name: 'main', path: 'src/main.rs', line: 1 }, to: { name: 'leaf', path: 'src/main.rs', line: 5 }, callPath: 'src/main.rs', callLine: 2, callColumn: 8 }],
			ambiguous: 0, totalNodes: 2, totalEdges: 1
		}));
		const walks: string[] = [];
		backend.on('analysis_call_graph', ({ name }) => {
			walks.push(name);
			return { nodes: [], edges: [], ambiguous: 0 };
		});
		createAnalysisPage('callgraph', host());
		await flush(8);
		const canvas = document.querySelector('.an-canvas') as HTMLElement;
		const view = document.querySelector('.an-viewport') as SVGGElement;
		const transform = () => view.getAttribute('transform') ?? '';
		// No layout in jsdom: the opening fit stands at identity.
		expect(transform()).toBe('translate(0 0) scale(1)');
		// The wheel zooms at the cursor.
		canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 50, clientY: 40, bubbles: true, cancelable: true }));
		expect(transform()).not.toBe('translate(0 0) scale(1)');
		// The overlay's zoom and fit buttons drive the same transform.
		const buttons = [...document.querySelectorAll('.an-zoom .action-btn')] as HTMLElement[];
		buttons[2].click();
		expect(transform()).toBe('translate(0 0) scale(1)');
		buttons[0].click();
		expect(transform()).toContain('scale(1.25)');
		buttons[2].click();
		// A drag pans the canvas and its trailing click never walks into the node it lands on.
		const node = document.querySelector('.an-node') as SVGElement;
		node.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
		canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 25, clientY: 10, bubbles: true }));
		canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 12, bubbles: true }));
		canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 40, clientY: 12, bubbles: true }));
		expect(transform()).toBe('translate(30 2) scale(1)');
		node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(walks).toEqual([]);
		// A click without a pan still walks from the node.
		node.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }));
		node.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 10, bubbles: true }));
		node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(walks).toEqual(['main']);
	});

	it('call graph searches, draws and walks to a clicked node', async () => {
		await modules();
		backend.on('analysis_workspace_call_graph', () => ({ nodes: [], edges: [], ambiguous: 0, totalNodes: 0, totalEdges: 0 }));
		backend.on('workspace_symbols', () => [{ kind: 'function', name: 'alpha', path: 'src/a.rs', line: 3 }]);
		const graphs: { name: string; direction: string }[] = [];
		backend.on('analysis_call_graph', ({ name, direction }) => {
			graphs.push({ name, direction });
			return {
				nodes: [
					{ kind: 'function', name, container: null, path: 'src/a.rs', line: 3, complexity: 2, signature: `fn ${name}()`, depth: 0 },
					{ kind: 'function', name: 'beta', container: 'S', path: 'src/b.rs', line: 0, complexity: 1, signature: 'fn beta()', depth: 1 }
				],
				edges: [{ from: { name, path: 'src/a.rs', line: 3 }, to: { name: 'beta', path: 'src/b.rs', line: 0 }, callPath: 'src/a.rs', callLine: 4, callColumn: 10 }],
				ambiguous: 0
			};
		});
		createAnalysisPage('callgraph', host());
		await flush(4);
		const search = document.querySelector<HTMLInputElement>('.an-symbol')!;
		search.value = 'alpha';
		search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await flush(8);
		expect(graphs[0]).toMatchObject({ name: 'alpha', direction: 'callees' });
		expect(document.querySelectorAll('svg.an-svg .an-node').length).toBe(2);
		expect(texts('.an-callsites .an-row .label')[0]).toContain('alpha → beta');
		// The direction toggle re-queries the other way.
		(document.querySelectorAll('.an-toggle')[0] as HTMLElement).click();
		await flush(6);
		expect(graphs[1].direction).toBe('callers');
		// A node click makes that node the next root.
		(document.querySelectorAll('.an-node')[1] as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush(6);
		expect(graphs[2]).toMatchObject({ name: 'beta' });
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
