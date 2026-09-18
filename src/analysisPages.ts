// The Analysis result pages (module 17), one editor tab per tool: three streaming
// reports (Complexity & Hotspots, Dead Code, Security Scan) over the shared
// batch-then-done channel rhythm, the Import Graph list, and the Module Analysis page —
// the workspace's cross-file calls drawn as file blocks on an @antv/G6 canvas (built-in
// layouts assign the positions, blocks drag, a click highlights a block's dependencies,
// the right-click menu jumps between the related files, double-click opens) beside a
// collapsible tree of module dependencies → file pairs → call sites. Both views cap what
// they draw and the tree renders lazily, so no workspace size can stall the page. Loaded
// lazily behind the Analysis sidebar; nothing here belongs to the first-paint bundle.

import { invoke, Channel } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Graph as G6Graph, IEvent, LayoutOptions } from '@antv/g6';

import { t, tf } from './i18n';
import { KIND_ICONS } from './contextView';
import { analysisTool, type AnalysisToolId } from './analysisTools';
import { McpPage } from './mcpPage';
import { actionButton, basename, el, icon, showContextMenu, type MenuEntry } from './ui';

/* ---------- The backend shapes ---------- */

interface MetricRow {
	path: string; name: string; kind: string; container: string | null; line: number;
	lines: number; params: number; complexity: number; nesting: number; refs: number; hotspot: number;
	/** The big-code-analysis columns — present when that engine measured the function. */
	cognitive?: number; halstead?: number; lloc?: number; mi?: number;
}

interface DeadRow {
	path: string; name: string; kind: string; container: string | null; line: number; exported: boolean; lines: number;
}

interface Finding {
	ruleId: string; severity: 'error' | 'warning' | 'info'; message: string;
	path: string; line: number; column: number; cwe: string;
}

interface ImportGraphData { edges: [string, string][]; cycles: string[][] }

/** `analysis_module_graph`: the workspace's cross-file calls lifted to modules (the
 *  directories that group the files) — module edges, the file pairs under them and the
 *  call sites under those. */
interface ModuleInfo { name: string; files: number; symbols: number }
interface ModuleEdge { from: string; to: string; calls: number; files: number }
interface CallSiteRow { from: string; to: string; line: number; column: number }
interface FileDep { from: string; to: string; calls: number; sites: CallSiteRow[] }
interface ModuleGraphData {
	modules: ModuleInfo[];
	edges: ModuleEdge[];
	fileEdges: FileDep[];
	totalCalls: number;
	totalFileEdges: number;
}

type MetricsEvent = { kind: 'batch'; rows: MetricRow[] } | { kind: 'done'; files: number; functions: number; cancelled: boolean };
type DeadCodeEvent = { kind: 'batch'; rows: DeadRow[] } | { kind: 'done'; found: number; cancelled: boolean };
type SecurityEvent = { kind: 'batch'; findings: Finding[] } | { kind: 'done'; files: number; findings: number; cancelled: boolean };

/** What a hosted page hands the editor: rows open files in the editor area. */
export interface AnalysisPageView {
	onOpen: ((path: string, line: number) => void) | null;
}

/** The editor's `openAnalysisPage` entry: build the page a tool's tab hosts. */
export function createAnalysisPage(tool: AnalysisToolId, container: HTMLElement): AnalysisPageView {
	switch (tool) {
		case 'modules': return new ModulePage(container);
		case 'metrics': return new MetricsPage(container);
		case 'deadcode': return new DeadCodePage(container);
		case 'security': return new SecurityPage(container);
		case 'imports': return new ImportsPage(container);
		case 'mcp': return new McpPage(container);
	}
}

/* ---------- The shared page kit ---------- */

/** A page that streams `batch` / `done` rows over a channel, with a filter, a rerun
 *  action and the loading / empty / error states every report shares. Rows render into
 *  one flat list; subclasses decide what a row and a match are. */
abstract class ReportPage<T> implements AnalysisPageView {
	protected rows: T[] = [];
	protected filter = '';
	protected error: string | null = null;
	protected running = false;
	protected summary = '';
	protected runId = 0;
	private readonly title: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly progress: HTMLElement;
	protected readonly list: HTMLElement;

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement, toolId: AnalysisToolId, extraControls: (HTMLElement | null)[] = []) {
		const tool = analysisTool(toolId);
		container.classList.add('an-page');
		this.title = el('span', 'an-title');
		this.filterInput = el('input', 'an-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('analysis.page.filter');
		this.filterInput.setAttribute('aria-label', t('analysis.page.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filter = this.filterInput.value.trim().toLowerCase();
			this.render();
		});
		const header = el('div', 'an-header', [
			icon(tool.icon),
			this.title,
			this.filterInput,
			...extraControls,
			el('div', 'actions', [
				actionButton('refresh', t('analysis.page.rerun'), () => void this.start())
			])
		]);
		this.progress = el('div', 'an-progress');
		this.list = el('div', 'an-list');
		container.append(header, this.progress, this.list);
		this.render();
		// The report runs on open: the index is already built by then, so the first
		// batch is a query away, not a parse away.
		void this.start();
	}

	/** The typed channel + invoke of the report command. */
	protected abstract fetch(run: number): Promise<void>;

	/** One result row; clicks call `this.open(path, line)`. */
	protected abstract renderRow(row: T): HTMLElement;

	/** Whether a row survives the filter box. */
	protected abstract matches(row: T): boolean;

	/** What the title says once the stream ends (the subclass has the counters). */
	protected abstract doneTitle(): string;

	protected open(path: string, line: number): void {
		this.onOpen?.(path, line);
	}

	protected async start(): Promise<void> {
		const run = ++this.runId;
		this.rows = [];
		this.error = null;
		this.summary = '';
		this.running = true;
		this.render();
		try {
			await this.fetch(run);
		} catch (error) {
			if (run === this.runId) this.error = String(error);
		}
		if (run !== this.runId) return; // a newer run took over
		this.running = false;
		this.render();
	}

	/** Guard against a stale channel message after a rerun. */
	protected isCurrent(run: number): boolean {
		return run === this.runId;
	}

	render(): void {
		this.progress.classList.toggle('running', this.running);
		this.title.textContent = this.running
			? `${t('analysis.page.loading')}…`
			: this.error
				? t('analysis.page.error')
				: this.doneTitle();
		this.list.textContent = '';
		if (!this.running && !this.error && this.rows.length === 0) {
			this.list.appendChild(el('div', 'an-empty', [t('analysis.page.empty')]));
			return;
		}
		const visible = this.rows.filter((row) => this.matches(row));
		const cap = 5000;
		for (const row of visible.slice(0, cap)) this.list.appendChild(this.renderRow(row));
		if (visible.length > cap) {
			this.list.appendChild(el('div', 'an-more', [tf('analysis.page.more', visible.length - cap)]));
		}
	}
}

/* ---------- Complexity & Hotspots ---------- */

/** The dimensions the rows can be sorted by — one per column the rows carry,
 *  biggest first (name goes alphabetically), hotspot the default because it is
 *  the page's own ranking. The big-code-analysis columns push unmeasured rows
 *  to the end; maintainability is the one column where smaller is worse, so it
 *  runs ascending — the least maintainable function leads. */
const METRIC_SORTS = [
	{ id: 'hotspot', key: 'analysis.metrics.sort.hotspot', compare: (a: MetricRow, b: MetricRow) => b.hotspot - a.hotspot || b.complexity - a.complexity },
	{ id: 'complexity', key: 'analysis.metrics.sort.complexity', compare: (a: MetricRow, b: MetricRow) => b.complexity - a.complexity || b.hotspot - a.hotspot },
	{ id: 'cognitive', key: 'analysis.metrics.sort.cognitive', compare: (a: MetricRow, b: MetricRow) => (b.cognitive ?? -1) - (a.cognitive ?? -1) || b.complexity - a.complexity },
	{ id: 'mi', key: 'analysis.metrics.sort.mi', compare: (a: MetricRow, b: MetricRow) => (a.mi ?? 101) - (b.mi ?? 101) || b.complexity - a.complexity },
	{ id: 'lines', key: 'analysis.metrics.sort.lines', compare: (a: MetricRow, b: MetricRow) => b.lines - a.lines || b.hotspot - a.hotspot },
	{ id: 'params', key: 'analysis.metrics.sort.params', compare: (a: MetricRow, b: MetricRow) => b.params - a.params || b.hotspot - a.hotspot },
	{ id: 'nesting', key: 'analysis.metrics.sort.nesting', compare: (a: MetricRow, b: MetricRow) => b.nesting - a.nesting || b.hotspot - a.hotspot },
	{ id: 'refs', key: 'analysis.metrics.sort.refs', compare: (a: MetricRow, b: MetricRow) => b.refs - a.refs || b.hotspot - a.hotspot },
	{ id: 'name', key: 'analysis.metrics.sort.name', compare: (a: MetricRow, b: MetricRow) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.path.localeCompare(b.path) }
] as const;
type MetricSortId = typeof METRIC_SORTS[number]['id'];

class MetricsPage extends ReportPage<MetricRow> {
	private sort: MetricSortId = 'hotspot';

	constructor(container: HTMLElement) {
		// The sort picker rides the header like the module page's layout picker; the
		// order applies only through `resort`, never on the render path itself.
		const sortSelect = el('select', 'an-sort') as HTMLSelectElement;
		for (const entry of METRIC_SORTS) {
			const option = el('option', undefined, [t(entry.key)]) as HTMLOptionElement;
			option.value = entry.id;
			sortSelect.appendChild(option);
		}
		sortSelect.value = 'hotspot';
		sortSelect.setAttribute('aria-label', t('analysis.metrics.sort'));
		sortSelect.addEventListener('change', () => {
			const picked = sortSelect.value as MetricSortId;
			if (METRIC_SORTS.some((entry) => entry.id === picked)) this.sort = picked;
			void this.resort();
		});
		super(container, 'metrics', [sortSelect]);
	}

	protected async fetch(run: number): Promise<void> {
		const onEvent = new Channel<MetricsEvent>();
		onEvent.onmessage = (event) => {
			if (!this.isCurrent(run)) return;
			if (event.kind === 'batch') {
				// Batches render in arrival order — sorting every batch would hold the
				// UI thread for the whole stream; `resort` orders the rows once at the end.
				this.rows.push(...event.rows);
				this.render();
			} else {
				this.summary = tf('analysis.metrics.summary', event.functions);
			}
		};
		await invoke('analysis_metrics', { onEvent });
		// Sort before the stream's final render (`render: false` — `start` renders).
		await this.resort(false);
	}

	/** Sort the streamed rows by the picked dimension, off the synchronous render
	 *  path: the yield lets the loading paint and the picker's change event land
	 *  first, and a pass made stale — a rerun started, the dimension switched
	 *  again — steps aside for the newest one. */
	private async resort(render = true): Promise<void> {
		const run = this.runId;
		const picked = this.sort;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (!this.isCurrent(run) || picked !== this.sort) return;
		const entry = METRIC_SORTS.find((sort) => sort.id === picked) ?? METRIC_SORTS[0];
		this.rows.sort(entry.compare);
		if (render) this.render();
	}

	protected doneTitle(): string {
		return this.summary || t('analysis.tool.metrics');
	}

	protected matches(row: MetricRow): boolean {
		if (!this.filter) return true;
		return row.name.toLowerCase().includes(this.filter)
			|| row.path.toLowerCase().includes(this.filter)
			|| (row.container ?? '').toLowerCase().includes(this.filter);
	}

	protected renderRow(row: MetricRow): HTMLElement {
		const element = el('div', 'an-row');
		element.title = row.cognitive === undefined
			? row.path
			: `${row.path}\n${tf('analysis.metrics.rich', row.cognitive, row.lloc ?? 0, row.halstead ?? 0, row.mi ?? 0)}`;
		element.append(
			icon(KIND_ICONS[row.kind] ?? 'symbol-method'),
			el('span', 'label', [row.container ? `${row.container}.${row.name}` : row.name]),
			el('span', 'description', [row.path]),
			el('span', 'an-metrics', [
				el('span', 'an-hot', [`C ${row.complexity}`]),
				...(row.cognitive !== undefined ? [el('span', undefined, [`Co ${row.cognitive}`])] : []),
				...(row.mi !== undefined ? [el('span', undefined, [`MI ${row.mi}`])] : []),
				el('span', undefined, [`L ${row.lines}`]),
				el('span', undefined, [`P ${row.params}`]),
				el('span', undefined, [`N ${row.nesting}`]),
				el('span', undefined, [`R ${row.refs}`])
			]),
			el('span', 'tail', [`H ${row.hotspot}`])
		);
		element.addEventListener('click', () => this.open(row.path, row.line + 1));
		return element;
	}
}

/* ---------- Dead Code ---------- */

class DeadCodePage extends ReportPage<DeadRow> {
	private includeExported = false;
	private readonly checkbox: HTMLInputElement;

	constructor(container: HTMLElement) {
		const checkbox = el('input') as HTMLInputElement;
		checkbox.type = 'checkbox';
		checkbox.id = 'an-dead-exported';
		checkbox.addEventListener('change', () => {
			this.includeExported = checkbox.checked;
			void this.start();
		});
		const label = el('label', 'an-option', [checkbox, t('analysis.deadcode.includeExported')]);
		super(container, 'deadcode', [label]);
		this.checkbox = checkbox;
	}

	protected async fetch(run: number): Promise<void> {
		const onEvent = new Channel<DeadCodeEvent>();
		onEvent.onmessage = (event) => {
			if (!this.isCurrent(run)) return;
			if (event.kind === 'batch') {
				this.rows.push(...event.rows);
				this.render();
			} else {
				this.summary = tf('analysis.deadcode.summary', event.found);
			}
		};
		await invoke('analysis_dead_code', { includeExported: this.includeExported, onEvent });
	}

	protected doneTitle(): string {
		return this.summary || t('analysis.tool.deadcode');
	}

	protected matches(row: DeadRow): boolean {
		if (!this.filter) return true;
		return row.name.toLowerCase().includes(this.filter)
			|| row.path.toLowerCase().includes(this.filter)
			|| (row.container ?? '').toLowerCase().includes(this.filter);
	}

	protected renderRow(row: DeadRow): HTMLElement {
		const element = el('div', 'an-row');
		element.title = row.exported ? t('analysis.deadcode.exported') : t('analysis.deadcode.private');
		element.append(
			icon(KIND_ICONS[row.kind] ?? 'symbol-method'),
			el('span', 'label', [row.container ? `${row.container}.${row.name}` : row.name]),
			el('span', 'description', [row.path]),
			...(row.exported ? [el('span', 'an-chip', ['exported'])] : []),
			el('span', 'tail', [`${row.lines} ln`])
		);
		element.addEventListener('click', () => this.open(row.path, row.line + 1));
		return element;
	}
}

/* ---------- Security Scan ---------- */

const SEVERITY_ICONS: Record<string, string> = { error: 'error', warning: 'warning', info: 'info' };
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

class SecurityPage extends ReportPage<Finding> {
	constructor(container: HTMLElement) {
		super(container, 'security');
	}

	protected async fetch(run: number): Promise<void> {
		const onEvent = new Channel<SecurityEvent>();
		onEvent.onmessage = (event) => {
			if (!this.isCurrent(run)) return;
			if (event.kind === 'batch') {
				this.rows.push(...event.findings);
				this.render();
			} else {
				this.summary = tf('analysis.security.summary', event.findings);
			}
		};
		await invoke('analysis_security', { onEvent });
		this.rows.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.path.localeCompare(b.path));
	}

	protected doneTitle(): string {
		return this.summary || t('analysis.tool.security');
	}

	protected matches(row: Finding): boolean {
		if (!this.filter) return true;
		return row.message.toLowerCase().includes(this.filter)
			|| row.ruleId.toLowerCase().includes(this.filter)
			|| row.path.toLowerCase().includes(this.filter)
			|| row.cwe.toLowerCase().includes(this.filter);
	}

	protected renderRow(row: Finding): HTMLElement {
		const element = el('div', `an-row an-sev-${row.severity}`);
		element.title = row.cwe;
		element.append(
			icon(SEVERITY_ICONS[row.severity] ?? 'info'),
			el('span', 'label', [row.message]),
			el('span', 'an-chip', [row.ruleId]),
			el('span', 'description', [`${row.path}:${row.line + 1}`])
		);
		element.addEventListener('click', () => this.open(row.path, row.line + 1));
		return element;
	}
}

/* ---------- Module Analysis ---------- */

/** A file's module: its directory; "" is the workspace root. */
function moduleOf(path: string): string {
	const at = path.lastIndexOf('/');
	return at === -1 ? '' : path.slice(0, at);
}

/** How a module names itself on the page — the workspace root gets a label. */
function moduleLabel(name: string): string {
	return name || t('analysis.modules.root');
}

/** The G6 data the page feeds the drawing, spelled out so the mapping stays ours (the
 *  index signature is the library's own datum contract). `data.size` is the block's
 *  real rectangle — the layouts' collision detection reads it there. */
interface GraphNodeDatum {
	id: string;
	type: 'rect';
	data: { module: string; callsIn: number; callsOut: number; size: [number, number] };
	style: Record<string, unknown>;
	[key: string]: unknown;
}

interface GraphEdgeDatum {
	id: string;
	source: string;
	target: string;
	style: Record<string, unknown>;
	[key: string]: unknown;
}

/** What `mapGraph` hands `mountGraph`: the drawing's data plus everything the page's own
 *  interactions need — the theme accents states are styled with, the dependency rows the
 *  edges came from (the right-click menus read them), and the module legend. */
interface MappedGraph {
	nodes: GraphNodeDatum[];
	edges: GraphEdgeDatum[];
	edgeStroke: string;
	/** The colour the selected element and its dependencies take over. */
	accent: string;
	/** The dependency rows behind the edges, capped the same way — the menus' data. */
	deps: FileDep[];
	/** The modules on the canvas and the stroke colour each one paints its files. */
	legend: { module: string; color: string }[];
	dropped: number;
	ringRadius: number;
}

/** The element id a G6 element event carries, if any. */
function elementId(event: IEvent): unknown {
	return (event as { target?: { id?: unknown } }).target?.id;
}

/** Where a context menu opens: the pointer's viewport position, whichever shape the
 *  library's event mirror exposes (native `clientX/Y` or G6's `client` point). */
function menuAt(event: IEvent): { x: number; y: number } {
	const pointer = event as { clientX?: number; clientY?: number; client?: { x?: number; y?: number } };
	return { x: pointer.clientX ?? pointer.client?.x ?? 0, y: pointer.clientY ?? pointer.client?.y ?? 0 };
}

/** The layouts the picker offers — the @antv/G6 built-ins that read a dependency graph
 *  well. The layout runs in the page (never over IPC), so switching is instant. */
const GRAPH_LAYOUTS = [
	{ id: 'force', key: 'analysis.modules.layout.force' },
	{ id: 'dagre', key: 'analysis.modules.layout.dagre' },
	{ id: 'circular', key: 'analysis.modules.layout.circular' },
	{ id: 'radial', key: 'analysis.modules.layout.radial' },
	{ id: 'grid', key: 'analysis.modules.layout.grid' },
	{ id: 'concentric', key: 'analysis.modules.layout.concentric' }
] as const;
type GraphLayoutId = typeof GRAPH_LAYOUTS[number]['id'];

/** Files / dependencies the drawing carries at most — past these the canvas blurs into
 *  noise; the page says how many files were left out and the tree lists everything. */
const MAX_GRAPH_NODES = 400;
const MAX_GRAPH_EDGES = 1500;
/** The idle window before the filter re-lays-out the drawing — typing must stay smooth. */
const FILTER_DEBOUNCE_MS = 250;

/** A theme colour, resolved where G6 can reach it: the drawing is a canvas, where CSS
 *  variables do not go, so the current theme's values are read at build time (the
 *  rerun action picks up a theme switch). */
function themeColor(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

/** The G6 module, loaded on the first drawing — the reports share this chunk and must
 *  not pay for the canvas engine they never mount. */
type G6Module = typeof import('@antv/g6');
let g6Module: Promise<G6Module> | null = null;

function loadG6(): Promise<G6Module> {
	return (g6Module ??= import('@antv/g6'));
}

/** The Module Analysis page: the workspace's cross-file calls as a drawing — every
 *  busy file a block whose position a G6 layout assigns automatically (switchable:
 *  force, layered, circular, …), every dependency an arrow, blocks draggable, a
 *  double-click opening the file — beside a collapsible tree (module dependencies →
 *  file pairs → call sites). A click highlights the clicked element and the
 *  dependencies it touches and dims the rest; the right-click menu opens the file,
 *  jumps to a related block (Calls / Called By), isolates the neighbourhood or lists
 *  an edge's call sites; a legend maps the module stroke colours. Both views cap what
 *  they draw and children render only while expanded, so the page stays responsive on
 *  any workspace. */
class ModulePage implements AnalysisPageView {
	private data: ModuleGraphData | null = null;
	private loading = true;
	private error: string | null = null;
	/** The filter as typed (the tree follows it live); the drawing follows `graphFilter`. */
	private filter = '';
	private graphFilter = '';
	private filterTimer: ReturnType<typeof setTimeout> | null = null;
	private view: 'graph' | 'tree' = 'graph';
	private layout: GraphLayoutId = 'circular';
	/** The block whose neighbourhood the drawing isolates, or null for everything. */
	private focusNode: string | null = null;
	/** The clicked block or edge on the current mount — states do not survive a remount. */
	private selectedId: string | null = null;
	/** The current drawing's mapping (null while loading / empty), kept for the
	 *  interactions: adjacency for the highlight, dependency rows for the menus. */
	private mapped: MappedGraph | null = null;
	private readonly openModules = new Set<string>();
	private readonly openFiles = new Set<string>();
	/** Bumps on every load; part of the graph rebuild key. */
	private loadId = 0;
	private graphKey = '';
	private graphDropped = 0;
	private graphEmpty = false;
	private graph: G6Graph | null = null;
	private readonly title: HTMLElement;
	private readonly statusHost: HTMLElement;
	private readonly body: HTMLElement;
	private readonly canvasHost: HTMLElement;
	/** The colour legend and the selection / focus chips, overlays on the canvas. */
	private readonly legend: HTMLElement;
	private readonly graphbar: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly layoutSelect: HTMLSelectElement;
	private readonly toggles: { graph: HTMLElement; tree: HTMLElement };

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement) {
		container.classList.add('an-page', 'an-graph');
		this.title = el('span', 'an-title');
		this.filterInput = el('input', 'an-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('analysis.page.filter');
		this.filterInput.setAttribute('aria-label', t('analysis.page.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filter = this.filterInput.value.trim().toLowerCase();
			// The tree re-renders at once; the drawing re-lays-out only once typing
			// settles — a relayout per keystroke is the jank this debounce avoids.
			if (this.filterTimer) clearTimeout(this.filterTimer);
			this.filterTimer = setTimeout(() => {
				this.filterTimer = null;
				this.graphFilter = this.filter;
				this.render();
			}, FILTER_DEBOUNCE_MS);
			this.render();
		});
		const graphToggle = el('button', 'an-toggle on', [t('analysis.modules.view.graph')]);
		const treeToggle = el('button', 'an-toggle', [t('analysis.modules.view.tree')]);
		graphToggle.addEventListener('click', () => this.setView('graph'));
		treeToggle.addEventListener('click', () => this.setView('tree'));
		this.toggles = { graph: graphToggle, tree: treeToggle };
		this.layoutSelect = el('select', 'an-layout') as HTMLSelectElement;
		for (const entry of GRAPH_LAYOUTS) {
			const option = el('option', undefined, [t(entry.key)]) as HTMLOptionElement;
			option.value = entry.id;
			this.layoutSelect.appendChild(option);
		}
		this.layoutSelect.value = this.layout;
		this.layoutSelect.setAttribute('aria-label', t('analysis.modules.layout'));
		this.layoutSelect.addEventListener('change', () => {
			const picked = this.layoutSelect.value as GraphLayoutId;
			if (GRAPH_LAYOUTS.some((entry) => entry.id === picked)) this.layout = picked;
			this.render();
		});
		this.statusHost = el('div');
		this.body = el('div', 'an-list');
		this.canvasHost = el('div', 'an-g6');
		this.canvasHost.title = t('analysis.modules.hint');
		this.legend = el('div', 'an-legend');
		this.legend.setAttribute('aria-label', t('analysis.modules.legend'));
		this.graphbar = el('div', 'an-graphbar');
		this.canvasHost.append(this.legend, this.graphbar);
		// The canvas's own menu is never what the user wants — the blocks' and arrows'
		// right-click menus replace it (G6's contextmenu events still fire).
		this.canvasHost.addEventListener('contextmenu', (event) => event.preventDefault());
		container.append(
			el('div', 'an-header', [
				icon('symbol-module'),
				this.title,
				this.filterInput,
				el('div', 'an-toggles', [graphToggle, treeToggle]),
				this.layoutSelect,
				el('div', 'actions', [
					actionButton('screen-full', t('analysis.modules.fit'), () => void this.graph?.fitView()),
					actionButton('refresh', t('analysis.page.rerun'), () => void this.load())
				])
			]),
			this.statusHost,
			this.body,
			this.canvasHost
		);
		this.render();
		void this.load();
	}

	private setView(view: 'graph' | 'tree'): void {
		if (this.view === view) return;
		this.view = view;
		this.toggles.graph.classList.toggle('on', view === 'graph');
		this.toggles.tree.classList.toggle('on', view === 'tree');
		this.render();
	}

	private async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		this.loadId++;
		this.render();
		try {
			this.data = await invoke<ModuleGraphData>('analysis_module_graph');
		} catch (error) {
			this.data = null;
			this.error = String(error);
		}
		this.loading = false;
		this.render();
	}

	/** Whether a file pair survives the filter: its file names, or a symbol at one of
	 *  its call sites, spelling part of the query. */
	private fileMatches(dep: FileDep): boolean {
		const filter = this.view === 'graph' ? this.graphFilter : this.filter;
		if (!filter) return true;
		return dep.from.toLowerCase().includes(filter)
			|| dep.to.toLowerCase().includes(filter)
			|| dep.sites.some((site) => site.from.toLowerCase().includes(filter)
				|| site.to.toLowerCase().includes(filter));
	}

	/** Whether a module edge survives the filter: its own module names, or any file
	 *  pair under it matching (files or call-site symbols). */
	private moduleMatches(edge: ModuleEdge, children: FileDep[]): boolean {
		if (!this.filter) return true;
		return edge.from.toLowerCase().includes(this.filter)
			|| edge.to.toLowerCase().includes(this.filter)
			|| children.some((dep) => this.fileMatches(dep));
	}

	render(): void {
		this.title.textContent = this.loading
			? `${t('analysis.page.loading')}…`
			: this.error
				? t('analysis.page.error')
				: (this.data
					? tf('analysis.modules.summary', this.data.modules.length, this.data.totalFileEdges, this.data.totalCalls)
					: '');
		this.statusHost.textContent = '';
		const status = (text: string, cls = 'an-empty') => this.statusHost.appendChild(el('div', cls, [text]));
		if (this.loading) {
			status(`${t('analysis.page.loading')}…`);
			this.syncView();
			return;
		}
		if (this.error) {
			status(this.error);
			this.syncView();
			return;
		}
		const data = this.data;
		if (!data) return;
		if (data.edges.length === 0) {
			status(t('analysis.modules.empty'));
			this.syncView();
			return;
		}
		if (this.view === 'graph') this.renderGraph(data, status);
		else this.renderTree(data, status);
		this.syncView();
	}

	/** Show / hide the two view hosts and mark the page (the layout picker only speaks
	 *  to the drawing; the CSS steps it aside in the tree view). */
	private syncView(): void {
		const tree = this.view === 'tree';
		this.body.hidden = !tree;
		this.canvasHost.hidden = tree;
		this.canvasHost.parentElement?.classList.toggle('an-tree', tree);
		if (!tree && this.graph) {
			// The host was display:none while the tree was up — re-measure the canvas.
			this.graph.resize();
		}
	}

	private renderGraph(data: ModuleGraphData, status: (text: string, cls?: string) => void): void {
		const key = `${this.loadId}|${this.layout}|${this.graphFilter}|${this.focusNode ?? ''}`;
		if (key !== this.graphKey) {
			this.graphKey = key;
			const mapped = this.mapGraph(data);
			this.graphDropped = mapped?.dropped ?? 0;
			this.graphEmpty = mapped === null;
			void this.mountGraph(key, mapped);
		}
		if (this.graphDropped > 0) {
			status(tf('analysis.modules.graphMore', this.graphDropped), 'an-more');
		}
		if (this.graphEmpty) status(t('analysis.page.empty'));
	}

	/** What the drawing carries: the busiest files as blocks (the cap keeps the canvas
	 *  readable), blocks sized by cross-file traffic, stroke colour by module, arrows
	 *  weighted by call count. Pure mapping — no library involved. `ringRadius` is the
	 *  circle the blocks' combined widths fit on, for the layout that needs it. */
	private mapGraph(data: ModuleGraphData): MappedGraph | null {
		// While a block is focused the drawing carries only its dependencies — the
		// neighbourhood a jump-to-related wants to see, not the whole workspace.
		const deps = data.fileEdges.filter((dep) => this.fileMatches(dep)
			&& (!this.focusNode || dep.from === this.focusNode || dep.to === this.focusNode));
		if (deps.length === 0) return null;
		const traffic = new Map<string, { callsIn: number; callsOut: number }>();
		for (const dep of deps) {
			const from = traffic.get(dep.from) ?? { callsIn: 0, callsOut: 0 };
			from.callsOut += dep.calls;
			traffic.set(dep.from, from);
			const to = traffic.get(dep.to) ?? { callsIn: 0, callsOut: 0 };
			to.callsIn += dep.calls;
			traffic.set(dep.to, to);
		}
		const ranked = [...traffic.entries()].sort((a, b) =>
			(b[1].callsIn + b[1].callsOut) - (a[1].callsIn + a[1].callsOut) || a[0].localeCompare(b[0]));
		const kept = ranked.slice(0, MAX_GRAPH_NODES);
		if (kept.length === 0) return null;
		const keptSet = new Set(kept.map(([path]) => path));
		const palette = [
			themeColor('--vscode-charts-blue', '#3794ff'),
			themeColor('--vscode-charts-green', '#89d185'),
			themeColor('--vscode-charts-yellow', '#cca700'),
			themeColor('--vscode-charts-orange', '#d18616'),
			themeColor('--vscode-charts-red', '#f14c4c'),
			themeColor('--vscode-charts-purple', '#b180d7')
		];
		const moduleIndex = new Map(data.modules.map((module, index) => [module.name, index]));
		const moduleColor = (name: string): string => palette[(moduleIndex.get(name) ?? 0) % palette.length];
		const fill = themeColor('--vscode-editorWidget-background', '#2d2d2d');
		const labelFill = themeColor('--vscode-editor-foreground', '#cccccc');
		let span = 0;
		const nodes: GraphNodeDatum[] = kept.map(([path, counts]) => {
			const label = path.slice(path.lastIndexOf('/') + 1);
			const size: [number, number] = [Math.min(210, Math.max(72, label.length * 7 + 18)), 30];
			// The circle these blocks fit on, with a gap and corner margin — the circular
			// layout has no collision pass of its own.
			span += size[0] + 36;
			return {
				id: path,
				type: 'rect',
				data: { module: moduleOf(path), callsIn: counts.callsIn, callsOut: counts.callsOut, size },
				style: {
					size,
					radius: 6,
					fill,
					stroke: moduleColor(moduleOf(path)),
					lineWidth: 1.5,
					labelText: label,
					labelFill,
					labelFontSize: 11,
					labelPlacement: 'center'
				}
			};
		});
		const drawnDeps = deps
			.filter((dep) => keptSet.has(dep.from) && keptSet.has(dep.to))
			.slice(0, MAX_GRAPH_EDGES);
		const edges: GraphEdgeDatum[] = drawnDeps.map((dep) => ({
			// The pair is unique among the drawn rows, so the id addresses the arrow in
			// state updates and context menus alike.
			id: `${dep.from}→${dep.to}`,
			source: dep.from,
			target: dep.to,
			style: { lineWidth: Math.min(4, 1 + Math.log2(dep.calls + 1)) }
		}));
		// The legend maps what the canvas actually paints: the modules with blocks on it,
		// busiest first. Past the palette the colours repeat, so the legend stops there.
		const onCanvas = new Map<string, number>();
		for (const [path] of kept) onCanvas.set(moduleOf(path), (onCanvas.get(moduleOf(path)) ?? 0) + 1);
		const legend = [...onCanvas.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, palette.length)
			.map(([module]) => ({ module, color: moduleColor(module) }));
		return {
			nodes,
			edges,
			edgeStroke: themeColor('--vscode-descriptionForeground', '#999999'),
			accent: themeColor('--vscode-focusBorder', '#007fd4'),
			deps: drawnDeps,
			legend,
			dropped: ranked.length - kept.length,
			ringRadius: Math.max(260, Math.round(span * 1.25 / (2 * Math.PI)))
		};
	}

	/** Create (or replace) the G6 drawing. The library loads first, and a newer key —
	 *  a layout switch, a rerun, the filter settling, a focus change — retires this
	 *  mount before it ever builds. */
	private async mountGraph(key: string, mapped: MappedGraph | null): Promise<void> {
		if (!mapped) return;
		const { Graph } = await loadG6();
		if (key !== this.graphKey) return;
		this.graph?.destroy();
		// A fresh mount starts unselected — element states live inside the instance.
		this.selectedId = null;
		this.mapped = mapped;
		this.graph = new Graph({
			container: this.canvasHost,
			width: this.canvasHost.clientWidth || undefined,
			height: this.canvasHost.clientHeight || undefined,
			data: { nodes: mapped.nodes, edges: mapped.edges },
			layout: this.layoutOptions(mapped.ringRadius),
			node: {
				state: {
					// The page owns selection itself (click-select is not loaded): the
					// clicked block takes the accent, its neighbours keep their module
					// stroke but thicken, everything else fades back.
					selected: { stroke: mapped.accent, lineWidth: 3, halo: false },
					related: { lineWidth: 2.5, halo: false },
					dim: { opacity: 0.25 }
				}
			},
			edge: {
				style: { stroke: mapped.edgeStroke, endArrow: true },
				state: {
					selected: { stroke: mapped.accent },
					dim: { opacity: 0.12 }
				}
			},
			behaviors: [
				'zoom-canvas',
				'drag-canvas',
				// The force layouts follow a dragged block; the others move it alone.
				this.layout === 'force' ? 'drag-element-force' : 'drag-element'
			],
			animation: false
		});
		this.graph.on('node:dblclick', (event: IEvent) => {
			const path = elementId(event);
			if (typeof path === 'string') this.onOpen?.(path, 1);
		});
		this.graph.on('node:click', (event: IEvent) => {
			const id = elementId(event);
			if (typeof id !== 'string') return;
			if (id === this.selectedId) this.clearSelection();
			else this.selectElement(id);
		});
		this.graph.on('edge:click', (event: IEvent) => {
			const id = elementId(event);
			if (typeof id === 'string') this.selectElement(id);
		});
		this.graph.on('canvas:click', () => this.clearSelection());
		this.graph.on('node:contextmenu', (event: IEvent) => {
			const id = elementId(event);
			if (typeof id !== 'string') return;
			const at = menuAt(event);
			this.nodeMenu(at.x, at.y, id);
		});
		this.graph.on('edge:contextmenu', (event: IEvent) => {
			const id = elementId(event);
			if (typeof id !== 'string') return;
			const at = menuAt(event);
			this.edgeMenu(at.x, at.y, id);
		});
		this.updateLegend(mapped);
		this.updateGraphbar();
		this.graph.render()
			.then(() => this.graph?.fitView())
			.catch(() => {
				// The tab closed mid-render, or the canvas host is gone — nothing to do.
			});
	}

	/** The layouts, sized for rectangles: every one gets the blocks' real extents (also
	 *  stashed in each node's `data.size`, the collision source the library documents),
	 *  the ones with a preventOverlap switch get it on, and the layered / ring layouts
	 *  get spacing wide enough that no block ever sits on another. */
	private layoutOptions(ringRadius: number): LayoutOptions {
		const nodeSize = (node: { data?: Record<string, unknown> }): [number, number] => {
			const size = node.data?.size;
			return Array.isArray(size) && size.length === 2 ? [Number(size[0]), Number(size[1])] : [72, 30];
		};
		switch (this.layout) {
			case 'force':
				return { type: 'force', linkDistance: 170, preventOverlap: true, nodeSize, nodeSpacing: 16 };
			case 'dagre':
				return { type: 'dagre', rankdir: 'LR', nodesep: 28, ranksep: 64, nodeSize };
			case 'circular':
				return { type: 'circular', radius: ringRadius };
			case 'radial':
				return { type: 'radial', unitRadius: 200, preventOverlap: true, nodeSize };
			case 'grid':
				return { type: 'grid', preventOverlap: true, nodeSize };
			case 'concentric':
				return { type: 'concentric', preventOverlap: true, nodeSize };
		}
	}

	/** Highlight one element and everything it touches: a clicked block with its
	 *  dependencies and neighbours, or a clicked arrow with its two endpoints. The rest
	 *  of the drawing fades back, so the highlight reads at any workspace size. */
	private selectElement(id: string): void {
		const mapped = this.mapped;
		if (!mapped) return;
		const states: Record<string, string[]> = {};
		const edge = mapped.edges.find((candidate) => candidate.id === id);
		if (edge) {
			states[id] = ['selected'];
			states[edge.source] = ['related'];
			states[edge.target] = ['related'];
		} else {
			states[id] = ['selected'];
			for (const candidate of mapped.edges) {
				if (candidate.source === id) {
					states[candidate.id] = ['selected'];
					states[candidate.target] = ['related'];
				} else if (candidate.target === id) {
					states[candidate.id] = ['selected'];
					states[candidate.source] = ['related'];
				}
			}
		}
		for (const node of mapped.nodes) if (!states[node.id]) states[node.id] = ['dim'];
		for (const candidate of mapped.edges) if (!states[candidate.id]) states[candidate.id] = ['dim'];
		this.selectedId = id;
		this.applyStates(states);
		this.updateGraphbar();
	}

	/** Back to the drawing's neutral state — a click on empty canvas, the chip's close,
	 *  or a second click on the selected element. */
	private clearSelection(): void {
		if (!this.selectedId) return;
		this.selectedId = null;
		const mapped = this.mapped;
		if (mapped) {
			const states: Record<string, string[]> = {};
			for (const node of mapped.nodes) states[node.id] = [];
			for (const edge of mapped.edges) states[edge.id] = [];
			this.applyStates(states);
		}
		this.updateGraphbar();
	}

	/** One batched state update; a retired mount rejects it, and the next mount starts
	 *  clean anyway. */
	private applyStates(states: Record<string, string[]>): void {
		this.graph?.setElementState(states).catch(() => {
			// nothing to do — the mount this update targeted is gone
		});
	}

	/** A menu jump to a related block: select it as if clicked and bring it into view. */
	private jumpTo(nodeId: string): void {
		this.selectElement(nodeId);
		this.graph?.focusElement(nodeId).catch(() => {
			// nothing to do — the mount is gone
		});
	}

	/** Isolate the drawing to one block's neighbourhood, or back to everything. */
	private focusOn(path: string): void {
		if (this.focusNode === path) return;
		this.focusNode = path;
		this.render();
	}

	private clearFocus(): void {
		if (!this.focusNode) return;
		this.focusNode = null;
		this.render();
	}

	/** The chips over the canvas's bottom corner: what is selected, what the drawing is
	 *  focused on — each with its way out. */
	private updateGraphbar(): void {
		this.graphbar.textContent = '';
		if (this.focusNode) {
			this.graphbar.appendChild(this.graphbarChip(
				tf('analysis.modules.focusChip', this.focusNode), 'filter',
				t('analysis.modules.clearFocus'), () => this.clearFocus()));
		}
		if (this.selectedId && this.mapped) {
			const node = this.mapped.nodes.find((candidate) => candidate.id === this.selectedId);
			if (node) {
				this.graphbar.appendChild(this.graphbarChip(
					tf('analysis.modules.selected', node.id, node.data.callsOut, node.data.callsIn), 'circle-filled',
					t('analysis.modules.clearSelection'), () => this.clearSelection()));
			} else {
				const dep = this.mapped.deps.find((candidate) => `${candidate.from}→${candidate.to}` === this.selectedId);
				if (dep) {
					this.graphbar.appendChild(this.graphbarChip(
						tf('analysis.modules.selectedEdge', dep.from, dep.to, dep.calls), 'arrow-right',
						t('analysis.modules.clearSelection'), () => this.clearSelection()));
				}
			}
		}
	}

	private graphbarChip(text: string, iconName: string, clearTitle: string, onClear: () => void): HTMLElement {
		const chip = el('span', 'chip', [icon(iconName), el('span', undefined, [text]), actionButton('close', clearTitle, onClear)]);
		chip.title = text;
		return chip;
	}

	/** The colour legend over the canvas's top corner — the modules the drawing paints,
	 *  with the stroke colour each one gave its blocks. */
	private updateLegend(mapped: MappedGraph | null): void {
		this.legend.textContent = '';
		if (!mapped) return;
		for (const entry of mapped.legend) {
			const dot = el('span', 'dot');
			// A canvas palette colour — data the theme minted, which CSS variables cannot
			// carry inline.
			dot.style.background = entry.color;
			this.legend.appendChild(el('span', 'an-legend-item', [dot, moduleLabel(entry.module)]));
		}
	}

	/** The block's right-click menu: open the file, jump to a related block through the
	 *  Calls / Called By submenus, isolate the neighbourhood, copy the path. */
	private nodeMenu(x: number, y: number, path: string): void {
		const out = new Map<string, number>();
		const inn = new Map<string, number>();
		for (const dep of this.mapped?.deps ?? []) {
			if (dep.from === path) out.set(dep.to, (out.get(dep.to) ?? 0) + dep.calls);
			if (dep.to === path) inn.set(dep.from, (inn.get(dep.from) ?? 0) + dep.calls);
		}
		const neighbourItems = (list: Map<string, number>): MenuEntry[] => {
			const ranked = [...list.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
			const items: MenuEntry[] = ranked.slice(0, 30).map(([file, calls]) => ({
				label: `${file} (${tf('analysis.modules.calls', calls)})`,
				run: () => this.jumpTo(file)
			}));
			if (ranked.length > 30) items.push({ label: tf('analysis.page.more', ranked.length - 30), disabled: true });
			return items;
		};
		const entries: MenuEntry[] = [
			{ label: t('analysis.modules.openFile'), run: () => this.onOpen?.(path, 1) },
			'separator',
			out.size > 0
				? { label: tf('analysis.modules.callsOut', out.size), submenu: neighbourItems(out) }
				: { label: tf('analysis.modules.callsOut', 0), disabled: true },
			inn.size > 0
				? { label: tf('analysis.modules.callsIn', inn.size), submenu: neighbourItems(inn) }
				: { label: tf('analysis.modules.callsIn', 0), disabled: true },
			this.focusNode === path
				? { label: t('analysis.modules.clearFocus'), run: () => this.clearFocus() }
				: { label: t('analysis.modules.focus'), run: () => this.focusOn(path) },
			'separator',
			{ label: t('analysis.modules.copyPath'), run: () => {
				void writeText(path).then(
					() => { /* the clipboard has it */ },
					() => { /* the clipboard is unavailable — the menu still closed */ }
				);
			} }
		];
		showContextMenu(x, y, entries);
	}

	/** The arrow's right-click menu: its call sites (each opening the caller's line),
	 *  both files, the pair to copy. */
	private edgeMenu(x: number, y: number, edgeId: string): void {
		const dep = this.mapped?.deps.find((candidate) => `${candidate.from}→${candidate.to}` === edgeId);
		if (!dep) return;
		const sites: MenuEntry[] = dep.sites.slice(0, 25).map((site) => ({
			label: `${site.from}→${site.to}  ${dep.from}:${site.line + 1}`,
			run: () => this.onOpen?.(dep.from, site.line + 1)
		}));
		if (dep.calls > dep.sites.length) {
			sites.push({ label: tf('analysis.modules.more', dep.calls - dep.sites.length), disabled: true });
		}
		const entries: MenuEntry[] = [
			{ label: `${dep.from} → ${dep.to}`, disabled: true },
			'separator',
			sites.length > 0
				? { label: tf('analysis.modules.edgeSites', dep.sites.length), submenu: sites }
				: { label: tf('analysis.modules.edgeSites', 0), disabled: true },
			'separator',
			{ label: tf('analysis.modules.openNamed', basename(dep.from)), run: () => this.onOpen?.(dep.from, 1) },
			{ label: tf('analysis.modules.openNamed', basename(dep.to)), run: () => this.onOpen?.(dep.to, 1) },
			'separator',
			{ label: t('analysis.modules.copyPair'), run: () => {
				void writeText(`${dep.from} → ${dep.to}`).then(
					() => { /* the clipboard has it */ },
					() => { /* the clipboard is unavailable — the menu still closed */ }
				);
			} }
		];
		showContextMenu(x, y, entries);
	}

	private renderTree(data: ModuleGraphData, status: (text: string, cls?: string) => void): void {
		this.body.textContent = '';
		// The file pairs grouped under their module edge, keeping the payload's
		// calls-first order inside each group.
		const groups = new Map<string, FileDep[]>();
		for (const dep of data.fileEdges) {
			const key = `${moduleOf(dep.from)}→${moduleOf(dep.to)}`;
			const list = groups.get(key);
			if (list) list.push(dep);
			else groups.set(key, [dep]);
		}
		const visible = data.edges.filter((edge) => this.moduleMatches(edge, groups.get(`${edge.from}→${edge.to}`) ?? []));
		if (visible.length === 0) {
			status(t('analysis.page.empty'));
			return;
		}
		this.body.appendChild(el('div', 'an-section', [tf('analysis.modules.dependencies', visible.length)]));
		if (data.fileEdges.length < data.totalFileEdges) {
			this.body.appendChild(el('div', 'an-more', [tf('analysis.modules.truncated', data.fileEdges.length, data.totalFileEdges)]));
		}
		const cap = 1000;
		for (const edge of visible.slice(0, cap)) {
			this.body.appendChild(this.renderModuleEdge(edge, groups.get(`${edge.from}→${edge.to}`) ?? []));
		}
		if (visible.length > cap) {
			this.body.appendChild(el('div', 'an-more', [tf('analysis.page.more', visible.length - cap)]));
		}
	}

	/** One module dependency row, and — while expanded — the file pairs under it. */
	private renderModuleEdge(edge: ModuleEdge, children: FileDep[]): HTMLElement {
		const key = `${edge.from}→${edge.to}`;
		const open = this.openModules.has(key);
		const row = el('div', 'an-row an-branch');
		row.setAttribute('role', 'button');
		row.setAttribute('aria-expanded', String(open));
		row.title = open ? t('analysis.modules.collapse') : t('analysis.modules.expand');
		row.append(
			icon(open ? 'chevron-down' : 'chevron-right'),
			el('span', 'label', [moduleLabel(edge.from), el('span', 'an-arrow', ['→']), moduleLabel(edge.to)]),
			el('span', 'tail', [`${tf('analysis.modules.calls', edge.calls)} · ${tf('analysis.modules.filePairs', edge.files)}`])
		);
		row.addEventListener('click', () => {
			if (!this.openModules.delete(key)) this.openModules.add(key);
			this.render();
		});
		const wrap = el('div', 'an-group');
		wrap.append(row);
		if (!open) return wrap;
		// A module edge that matched the filter itself shows all of its files; one that
		// matched only through a child shows just the matching children.
		const direct = !this.filter
			|| edge.from.toLowerCase().includes(this.filter)
			|| edge.to.toLowerCase().includes(this.filter);
		const pairs = direct ? children : children.filter((dep) => this.fileMatches(dep));
		for (const dep of pairs.slice(0, 500)) wrap.appendChild(this.renderFileDep(dep));
		if (pairs.length > 500) {
			wrap.appendChild(el('div', 'an-more an-l1', [tf('analysis.page.more', pairs.length - 500)]));
		}
		return wrap;
	}

	/** One file-pair row, and — while expanded — the call sites under it. */
	private renderFileDep(dep: FileDep): HTMLElement {
		const key = `${dep.from}→${dep.to}`;
		const open = this.openFiles.has(key);
		const row = el('div', 'an-row an-l1');
		row.setAttribute('role', 'button');
		row.setAttribute('aria-expanded', String(open));
		row.title = open ? t('analysis.modules.collapse') : t('analysis.modules.expand');
		row.append(
			icon(open ? 'chevron-down' : 'chevron-right'),
			el('span', 'label', [dep.from, el('span', 'an-arrow', ['→']), dep.to]),
			el('span', 'tail', [tf('analysis.modules.calls', dep.calls)])
		);
		row.addEventListener('click', () => {
			if (!this.openFiles.delete(key)) this.openFiles.add(key);
			this.render();
		});
		const wrap = el('div', 'an-group');
		wrap.append(row);
		if (!open) return wrap;
		for (const site of dep.sites) {
			const siteRow = el('div', 'an-row an-l2');
			siteRow.title = `${site.from} → ${site.to}`;
			siteRow.append(
				icon('arrow-right'),
				el('span', 'label', [site.from, el('span', 'an-arrow', ['→']), site.to]),
				el('span', 'description', [`${dep.from}:${site.line + 1}`])
			);
			siteRow.addEventListener('click', () => this.onOpen?.(dep.from, site.line + 1));
			wrap.appendChild(siteRow);
		}
		if (dep.calls > dep.sites.length) {
			wrap.appendChild(el('div', 'an-more an-l2', [tf('analysis.modules.more', dep.calls - dep.sites.length)]));
		}
		return wrap;
	}
}

/* ---------- Import Graph ---------- */

class ImportsPage implements AnalysisPageView {
	private graph: ImportGraphData | null = null;
	private loading = true;
	private error: string | null = null;
	private filter = '';
	private readonly title: HTMLElement;
	private readonly body: HTMLElement;
	private readonly filterInput: HTMLInputElement;

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement) {
		container.classList.add('an-page');
		this.title = el('span', 'an-title');
		this.filterInput = el('input', 'an-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('analysis.page.filter');
		this.filterInput.setAttribute('aria-label', t('analysis.page.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filter = this.filterInput.value.trim().toLowerCase();
			this.render();
		});
		this.body = el('div', 'an-list');
		container.append(
			el('div', 'an-header', [
				icon('type-hierarchy-sub'),
				this.title,
				this.filterInput,
				el('div', 'actions', [
					actionButton('refresh', t('analysis.page.rerun'), () => void this.load())
				])
			]),
			this.body
		);
		this.render();
		void this.load();
	}

	private async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		this.render();
		try {
			this.graph = await invoke<ImportGraphData>('analysis_import_graph');
		} catch (error) {
			this.graph = null;
			this.error = String(error);
		}
		this.loading = false;
		this.render();
	}

	render(): void {
		this.body.textContent = '';
		this.title.textContent = this.loading
			? `${t('analysis.page.loading')}…`
			: this.error
				? t('analysis.page.error')
				: (this.graph
					? tf('analysis.imports.summary', this.graph.edges.length, this.graph.cycles.length)
					: '');
		if (this.loading) {
			this.body.appendChild(el('div', 'an-empty', [`${t('analysis.page.loading')}…`]));
			return;
		}
		if (this.error) {
			this.body.appendChild(el('div', 'an-empty', [this.error]));
			return;
		}
		const graph = this.graph;
		if (!graph) return;
		const matches = (path: string) => !this.filter || path.toLowerCase().includes(this.filter);

		this.body.appendChild(el('div', 'an-section', [tf('analysis.imports.cycles', graph.cycles.length)]));
		const cycles = graph.cycles.filter((cycle) => cycle.some(matches));
		if (cycles.length === 0) {
			this.body.appendChild(el('div', 'an-empty', [t('analysis.imports.noCycles')]));
		} else {
			for (const cycle of cycles.slice(0, 200)) {
				const row = el('div', 'an-row an-cycle');
				const parts: Node[] = [icon('sync')];
				cycle.forEach((file, index) => {
					parts.push(el('span', index === 0 ? 'label' : 'an-cycle-step', [file]));
					if (index < cycle.length - 1) parts.push(el('span', 'an-arrow', ['→']));
				});
				row.append(...parts);
				row.addEventListener('click', () => this.onOpen?.(cycle[0], 1));
				this.body.appendChild(row);
			}
		}

		this.body.appendChild(el('div', 'an-section', [tf('analysis.imports.edges', graph.edges.length)]));
		const edges = graph.edges.filter(([from, to]) => matches(from) || matches(to));
		for (const [from, to] of edges.slice(0, 2000)) {
			const row = el('div', 'an-row');
			row.append(
				icon('arrow-right'),
				el('span', 'label', [from]),
				el('span', 'description', [to])
			);
			row.addEventListener('click', () => this.onOpen?.(from, 1));
			this.body.appendChild(row);
		}
		if (edges.length > 2000) {
			this.body.appendChild(el('div', 'an-more', [tf('analysis.page.more', edges.length - 2000)]));
		}
	}
}
