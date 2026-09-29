// The Code Analysis module's vitest (module 17): the sidebar (tool rows, index state,
// rebuild) and the five result pages — the streaming reports over their batch/done
// channels, the module analysis drawing (the backend-laid-out diagram the SVG viewport
// renders: group boxes, blocks, arrows, the selection highlight, the right-click
// navigation, the mermaid copy, pan and zoom) beside its tree, and the import graph's
// cycles. Everything runs against the scripted `tauriMock` backend like every other
// view suite.

vi.mock('mermaid', () => import('./mermaidStub'));
vi.mock('@mermaid-js/layout-elk', () => ({ default: {} }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from './helpers';

import { backend, Channel } from './tauriMock';
import { initializations, rendered } from './mermaidStub';


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
	/** The module diagram fixture the drawing tests share — the model answer
	 *  `analysis_module_diagram` returns for the module graph fixture above; the
	 *  drawing itself is the mermaid source, which the stubbed renderer parses into
	 *  the element shapes the assertions drive. */
	const FIXTURE_MERMAID = 'flowchart TD\n  subgraph G0["src"]\n    N0["a.ts<br/>[src]"]\n    N1["ui.ts<br/>[src]"]\n    N3["b.ts<br/>[src]"]\n  end\n  N2["top.rs"]\n  N2 -->|"2 calls"| N0\n  N0 -->|"5 calls"| N1\n  N3 -->|"1 calls"| N1\n';

	function diagramAnswer(): Record<string, unknown> {
		return {
			nodes: [
				{ path: 'src/a.ts', label: 'a.ts', module: 'src', tone: 1, callsIn: 2, callsOut: 5 },
				{ path: 'src/ui.ts', label: 'ui.ts', module: 'src', tone: 1, callsIn: 6, callsOut: 0 },
				{ path: 'top.rs', label: 'top.rs', module: '', tone: 0, callsIn: 0, callsOut: 2 },
				{ path: 'src/b.ts', label: 'b.ts', module: 'src', tone: 1, callsIn: 0, callsOut: 1 }
			],
			edges: [
				{ id: 'src/a.ts→src/ui.ts', from: 'src/a.ts', to: 'src/ui.ts', calls: 5, dashed: false },
				{ id: 'src/b.ts→src/ui.ts', from: 'src/b.ts', to: 'src/ui.ts', calls: 1, dashed: false },
				{ id: 'top.rs→src/a.ts', from: 'top.rs', to: 'src/a.ts', calls: 2, dashed: false }
			],
			droppedFiles: 0, droppedEdges: 0,
			mermaid: FIXTURE_MERMAID
		};
	}

	function nodeEl(root: HTMLElement, path: string): HTMLElement {
		return root.querySelector(`g.node[data-path="${path}"]`)!;
	}

	/** The drawing lands asynchronously (mermaid's render, even stubbed): wait for
	 *  the blocks to appear instead of betting on the flush count. */
	async function untilDrawn(root: HTMLElement, count = 1): Promise<void> {
		await vi.waitFor(() => {
			if (root.querySelectorAll('[data-path]').length < count) throw new Error('the diagram has not rendered yet');
		}, { timeout: 3000 });
	}

	/** Wait for the drawing to hold exactly `count` marked blocks — a refetch's
	 *  stale tree (its own marker count) must not satisfy the wait. */
	async function untilCount(root: HTMLElement, count: number): Promise<void> {
		await vi.waitFor(() => {
			const marked = root.querySelectorAll('[data-path]').length;
			if (marked !== count) throw new Error(`the drawing holds ${marked} blocks, not ${count} yet`);
		}, { timeout: 3000 });
	}

	it('renders through gitdiagram mermaid configuration, verbatim', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		createAnalysisPage('modules', host());
		await flush(8);
		// The one initialize() the page made is gitdiagram's own baseConfig — the
		// display is its pipeline by construction, not by approximation.
		expect(initializations.length).toBeGreaterThanOrEqual(1);
		const config = initializations.at(-1)!;
		expect(config).toMatchObject({
			startOnLoad: false,
			securityLevel: 'strict',
			theme: 'base',
			htmlLabels: false,
			layout: 'elk',
			look: 'classic'
		});
		expect(config.flowchart).toEqual({
			wrappingWidth: 200,
			curve: 'linear',
			nodeSpacing: 50,
			rankSpacing: 50,
			padding: 15
		});
		// The one ELK tweak past gitdiagram's config, on the owner's ask: simplex
		// node placement, so cross-group arrows pull short instead of winding
		// around distant boxes.
		expect(config.elk).toEqual({ nodePlacementStrategy: 'NETWORK_SIMPLEX' });
	});

	it('renders gitdiagram’s dark palette under a dark theme, and re-renders when the theme flips', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await untilDrawn(root);
		// jsdom's document carries no theme kind — the drawing opens in
		// gitdiagram's light variable set.
		const light = initializations.at(-1)!.themeVariables as Record<string, string>;
		expect(light.lineColor).toBe('#334155');
		expect(light.primaryTextColor).toBe('#171717');
		// A dark theme flips the pick — settings marks the kind on <html> and
		// dispatches THEME_EVENT once the stylesheet has loaded; the drawing
		// re-renders through gitdiagram's dark variables.
		document.documentElement.classList.add('vscode-dark');
		const rendersBefore = rendered.length;
		try {
			document.dispatchEvent(new CustomEvent('app:theme-applied', { bubbles: true }));
			await flush(8);
			const dark = initializations.at(-1)!.themeVariables as Record<string, string>;
			expect(dark.lineColor).toBe('#ffd486');
			expect(dark.primaryTextColor).toBe('#e8edf5');
			expect(dark.secondaryColor).toBe('#26303f');
			expect(rendered.length).toBeGreaterThan(rendersBefore);
			expect(initializations.at(-1)!.flowchart).toEqual({
				wrappingWidth: 200,
				curve: 'linear',
				nodeSpacing: 50,
				rankSpacing: 50,
				padding: 15
			});
		} finally {
			document.documentElement.classList.remove('vscode-dark');
		}
	});

	it('module analysis renders the backend diagram and opens a file on block double-click', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		await untilDrawn(root);
		// The drawing is one backend fetch: the laid-out diagram, filter and focus empty.
		const diagramCalls = backend.callsTo('analysis_module_diagram');
		expect(diagramCalls.length).toBe(1);
		expect(diagramCalls[0]).toMatchObject({ focus: null, filter: '' });
		// mermaid renders the source: the cards in the answer's order, the subgraph
		// cluster, the arrows with their call counts (the stub parses the source into
		// mermaid's own element shapes).
		console.log('IDS', [...root.querySelectorAll('g.node')].map((n) => `${n.getAttribute('id')}=>${(n as SVGElement).dataset?.path ?? n.getAttribute('data-path')}`));
		expect([...root.querySelectorAll<HTMLElement>('g.node')].map((node) => node.dataset.path))
			.toEqual(['src/a.ts', 'src/ui.ts', 'src/b.ts', 'top.rs'], 'the subgraph cards precede the ungrouped');
		expect(root.querySelectorAll('[data-id]').length).toBeGreaterThanOrEqual(3, 'every arrow is marked');
		// gitdiagram's two-line card: the name over the bracketed directory.
		expect(nodeEl(root, 'src/a.ts').textContent).toContain('a.ts');
		expect(nodeEl(root, 'src/a.ts').textContent).toContain('[src]');
		expect(nodeEl(root, 'top.rs').textContent).toBe('top.rs', 'a root file keeps one line');
		// A double-clicked block opens the file.
		nodeEl(root, 'src/a.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(opened).toEqual(['src/a.ts:1']);
	});

	it('module analysis says how many files the diagram cap dropped', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => ({ ...diagramAnswer(), droppedFiles: 354 }));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		expect(texts('.an-more', root)[0]).toContain('354 more files');
	});

	it('module analysis toggles to the tree and expands to files and call sites', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		expect(texts('.an-title', root)[0]).toBe('2 modules · 3 file dependencies · 8 cross-file calls');
		// The Tree toggle flips the view; the drawing's host steps aside.
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
		backend.on('analysis_module_diagram', () => diagramAnswer());
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
		backend.on('analysis_module_diagram', () => ({ ...diagramAnswer(), nodes: [], edges: [], groups: [] }));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		expect(texts('.an-empty', root)[0]).toContain('No cross-file calls');
		expect(root.querySelectorAll('[data-path]').length).toBe(0, 'nothing to draw');
	});

	it('module analysis highlights the clicked block\'s dependencies and dims the rest', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		await untilDrawn(root);
		nodeEl(root, 'src/a.ts').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// The clicked block takes the selection, its neighbours thicken, every arrow it
		// touches is selected too, and everything else fades back.
		expect(nodeEl(root, 'src/a.ts').classList.contains('selected')).toBe(true);
		expect(nodeEl(root, 'src/ui.ts').classList.contains('related')).toBe(true);
		expect(nodeEl(root, 'top.rs').classList.contains('related')).toBe(true);
		expect(nodeEl(root, 'src/b.ts').classList.contains('dim')).toBe(true);
		expect(root.querySelector('[data-id="src/a.ts→src/ui.ts"]')!.classList.contains('selected')).toBe(true);
		expect(root.querySelector('[data-id="top.rs→src/a.ts"]')!.classList.contains('selected')).toBe(true);
		expect(root.querySelector('[data-id="src/b.ts→src/ui.ts"]')!.classList.contains('dim')).toBe(true);
		// The chip over the drawing states what is selected.
		expect(texts('.an-graphbar .chip', root)[0]).toContain('src/a.ts');
		// A click on empty drawing returns it to neutral.
		root.querySelector('.an-mermaid svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(nodeEl(root, 'src/a.ts').classList.contains('selected')).toBe(false);
		expect(root.querySelector('[data-id="src/b.ts→src/ui.ts"]')!.classList.contains('dim')).toBe(false);
		expect(root.querySelectorAll('.an-graphbar .chip').length).toBe(0);
	});

	it('module analysis right-clicks a block into a navigation menu', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		await untilDrawn(root);
		nodeEl(root, 'src/a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
		await flush(2);
		const items = () => [...document.querySelectorAll<HTMLElement>('.context-menu .item')];
		expect(items().map((item) => item.textContent)).toContain('Open File');
		// Open File is the double-click jump, from the menu.
		items().find((item) => item.textContent === 'Open File')!.click();
		expect(opened).toEqual(['src/a.ts:1']);
		// The Calls submenu lists the related blocks; picking one selects and centres it.
		nodeEl(root, 'src/a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
		await flush(2);
		items().find((item) => item.textContent === 'Calls (1)')!.dispatchEvent(new MouseEvent('mouseenter'));
		await flush(2);
		items().find((item) => item.textContent?.includes('src/ui.ts'))!.click();
		expect(nodeEl(root, 'src/ui.ts').classList.contains('selected')).toBe(true);
	});

	it('module analysis right-clicks an arrow into its call sites', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		const page = createAnalysisPage('modules', root);
		const opened: string[] = [];
		page.onOpen = (path, line) => opened.push(`${path}:${line}`);
		await flush(8);
		await untilDrawn(root);
		root.querySelector('[data-id="src/a.ts→src/ui.ts"]')!
			.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
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
		const focusedAnswer = () => ({
			...diagramAnswer(),
			nodes: diagramAnswer().nodes.filter((node) => (node as { path: string }).path !== 'top.rs'),
			edges: diagramAnswer().edges.filter((edge) => (edge as { from: string }).from !== 'top.rs'),
			mermaid: 'flowchart TD\n  subgraph G0["src"]\n    N0["a.ts<br/>[src]"]\n    N1["ui.ts<br/>[src]"]\n    N2["b.ts<br/>[src]"]\n  end\n  N0 -->|"5 calls"| N1\n  N2 -->|"1 calls"| N1\n'
		});
		backend.on('analysis_module_diagram', ({ focus }: { focus: string | null }) => (focus ? focusedAnswer() : diagramAnswer()));
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		await untilDrawn(root);
		nodeEl(root, 'src/ui.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
		await flush(2);
		[...document.querySelectorAll<HTMLElement>('.context-menu .item')]
			.find((item) => item.textContent === 'Show Only Related Files')!.click();
		await flush(8);
		await untilCount(root, 3);
		// The drawing refetches around the block: itself and the files that call it.
		const calls = () => backend.callsTo('analysis_module_diagram');
		expect(calls()).toHaveLength(2);
		expect(calls()[1]).toMatchObject({ focus: 'src/ui.ts' });
		expect(root.querySelectorAll('[data-path]').length).toBe(3);
		// The chip names the focus and clears it — back to every file.
		expect(texts('.an-graphbar .chip', root)[0]).toContain('src/ui.ts');
		(root.querySelector('.an-graphbar .chip .action-btn') as HTMLElement).click();
		await flush(8);
		await untilCount(root, 4);
		expect(calls()).toHaveLength(3);
		expect(calls()[2]).toMatchObject({ focus: null });
		expect(root.querySelectorAll('[data-path]').length).toBe(4);
	});

	it('module analysis scopes to folders, and the scope rides both reads and the chip', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		createAnalysisPage('modules', root, ['src/editor', 'src/scroll']);
		await flush(8);
		await untilDrawn(root);
		// Both backend reads carry the folder pick — the tree and the drawing
		// report the same folders.
		expect(backend.callsTo('analysis_module_graph')[0]).toEqual({ folders: ['src/editor', 'src/scroll'] });
		expect(backend.callsTo('analysis_module_diagram')[0]).toMatchObject({ focus: null, filter: '', folders: ['src/editor', 'src/scroll'] });
		// The graphbar names the scope with a chip that has no way out — the
		// scope is the page's identity, not a view state.
		const chip = root.querySelector('.an-graphbar .chip.scope')!;
		expect(chip.textContent).toContain('src/editor, src/scroll');
		expect(chip.querySelector('.action-btn')).toBeNull();

		// The unscoped page keeps its whole-workspace reads (an empty scope).
		const whole = host();
		createAnalysisPage('modules', whole);
		await flush(8);
		await untilDrawn(whole);
		expect(backend.callsTo('analysis_module_graph')[1]).toEqual({ folders: [] });
		expect(whole.querySelector('.an-graphbar .chip.scope')).toBeNull();
	});

	it('module analysis copies the diagram as mermaid source', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		const copy = [...root.querySelectorAll<HTMLElement>('.an-header .actions .action-btn')]
			.find((button) => button.title === 'Copy Mermaid Source')!;
		copy.click();
		expect(backend.clipboard.at(-1)).toContain('flowchart TD');
		expect(backend.clipboard.at(-1)).toContain('subgraph G0["src"]');
	});

	it('module analysis zooms from the toolbar, the wheel and the keyboard', async () => {
		await modules();
		backend.on('analysis_module_graph', moduleGraphAnswer);
		backend.on('analysis_module_diagram', () => diagramAnswer());
		const root = host();
		createAnalysisPage('modules', root);
		await flush(8);
		const hostEl = root.querySelector<HTMLElement>('.an-diagram')!;
		const level = () => texts('.an-zoom-level', root)[0];
		// The toolbar's zoom and fit glide over 160 ms — the assertions wait it out.
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
		// A mouse wheel (whole-line notches) zooms at the cursor; a trackpad's
		// fractional pixel scroll pans instead; ctrl+wheel is always pinch-zoom.
		// The zoom percentage reads against the fit level, so `0` fits to 100%.
		const wheelAt = async (init: Record<number, unknown>) => {
			const wheel = new Event('wheel', { bubbles: true, cancelable: true });
			Object.assign(wheel, { clientX: 8, clientY: 8, ...init });
			hostEl.dispatchEvent(wheel);
			// The view state lands on the next animation frame.
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		};
		await wheelAt({ deltaY: -120 });
		expect(Number(level().replace('%', ''))).toBeGreaterThan(118, 'the mouse wheel zoomed');
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
		await settle();
		expect(level()).toBe('100%');
		// ctrl+wheel zooms regardless of the delta's shape (no animation — direct).
		await wheelAt({ deltaY: -4, ctrlKey: true });
		expect(Number(level().replace('%', ''))).toBeGreaterThan(100);
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
		await settle();
		// A fractional-Y pixel delta latches the trackpad mode: pan, not zoom.
		wheelAt({ deltaY: 12.5, deltaX: 2 });
		expect(level()).toBe('100%', 'the trackpad scroll panned, the zoom held');
		// The arrow keys pan by 40 px; Home fits like `0`.
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
		hostEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
		await settle();
		expect(level()).toBe('100%');
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
