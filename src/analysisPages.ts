// The Analysis result pages (module 17), one editor tab per tool: three streaming
// reports (Complexity & Hotspots, Dead Code, Security Scan) over the shared
// batch-then-done channel rhythm, the Import Graph list, and the Module Analysis page —
// the workspace's cross-file calls as the gitdiagram-style architecture diagram the
// backend lays out (`analysis_module_diagram`: the busiest files as blocks inside their
// module's group box, every kept dependency a call-count-labelled arrow, the mermaid
// source along for the export), rendered on the hand-written SVG viewport of
// moduleDiagram.ts (wheel zoom, drag pan, a zoom toolbar, the selection highlight and
// the right-click navigation) beside a collapsible tree of module dependencies → file
// pairs → call sites. Both views cap what they draw and the tree renders lazily, so no
// workspace size can stall the page. Loaded lazily behind the Analysis sidebar; nothing
// here belongs to the first-paint bundle.

import { invoke, Channel } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { t, tf } from './i18n';
import { KIND_ICONS } from './contextView';
import { analysisTool, type AnalysisToolId } from './analysisTools';
import { McpPage } from './mcpPage';
import { DiagramView, moduleLabel, moduleOf, type ModuleDiagram } from './moduleDiagram';
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

/** The editor's `openAnalysisPage` entry: build the page a tool's tab hosts. The
 *  Module Analysis tool takes a folder scope — the folders the Explorer's pick
 *  named; empty is the whole workspace. */
export function createAnalysisPage(tool: AnalysisToolId, container: HTMLElement, folders?: string[]): AnalysisPageView {
	switch (tool) {
		case 'modules': return new ModulePage(container, folders ?? []);
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

/** The idle window before the filter refetches the drawing — typing must stay smooth. */
const FILTER_DEBOUNCE_MS = 250;

/** The Module Analysis page: the workspace's cross-file calls as a gitdiagram-style
 *  architecture diagram — the busiest files as blocks inside their module's group box,
 *  every kept dependency an arrow labelled with its call count, the geometry, the caps
 *  and the mermaid source all the backend's (`analysis_module_diagram`) — drawn on the
 *  SVG viewport of moduleDiagram.ts (wheel zoom at the cursor, drag pan, a zoom toolbar
 *  with fit, a click highlighting a block's dependencies, the right-click menu jumping
 *  between the related files, double-click opening) beside a collapsible tree (module
 *  dependencies → file pairs → call sites). The drawing's filter narrows to the files
 *  whose path spells the query (it shrinks with every keystroke — a pair survives only
 *  between matching files), the focus isolates one file's neighbourhood, and the tree
 *  matches symbols too; the tree renders lazily, so the page stays responsive on
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
	/** The block whose neighbourhood the drawing isolates, or null for everything. */
	private focusNode: string | null = null;
	/** The clicked block or arrow on the current diagram — states do not survive a refetch. */
	private selectedId: string | null = null;
	/** The current drawing — `analysis_module_diagram`'s answer — kept for the
	 *  interactions: adjacency for the highlight, the mermaid source for the copy. */
	private diagram: ModuleDiagram | null = null;
	private readonly openModules = new Set<string>();
	private readonly openFiles = new Set<string>();
	/** Bumps on every load; part of the diagram refetch key. */
	private loadId = 0;
	private graphKey = '';
	private readonly drawing: DiagramView;
	private readonly title: HTMLElement;
	private readonly statusHost: HTMLElement;
	private readonly body: HTMLElement;
	/** The selection / focus chips, overlays on the drawing. */
	private readonly graphbar: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly toggles: { graph: HTMLElement; tree: HTMLElement };

	onOpen: ((path: string, line: number) => void) | null = null;

	/** The folders the page reports on, repo-relative — the Explorer pick's scope.
	 *  Empty is the whole workspace. Both backend reads carry it; it rides the
	 *  graphbar as a chip with no way out (the scope is the tab's identity — the
	 *  whole-workspace page is its own tab). */
	private readonly folders: string[];

	constructor(container: HTMLElement, folders: string[]) {
		this.folders = folders;
		container.classList.add('an-page', 'an-graph');
		this.title = el('span', 'an-title');
		this.filterInput = el('input', 'an-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('analysis.page.filter');
		this.filterInput.setAttribute('aria-label', t('analysis.page.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filter = this.filterInput.value.trim().toLowerCase();
			// The tree re-renders at once; the drawing refetches only once typing settles
			// — a refetch per keystroke is the jank this debounce avoids.
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
		this.drawing = new DiagramView({
			onOpenNode: (path) => this.onOpen?.(path, 1),
			onSelect: (id) => {
				if (id === null || id === this.selectedId) this.clearSelection();
				else this.selectElement(id);
			},
			onNodeContext: (x, y, id) => this.nodeMenu(x, y, id),
			onEdgeContext: (x, y, id) => this.edgeMenu(x, y, id)
		});
		this.graphbar = el('div', 'an-graphbar');
		this.drawing.host.append(this.graphbar);
		this.statusHost = el('div');
		this.body = el('div', 'an-list');
		container.append(
			el('div', 'an-header', [
				icon('symbol-module'),
				this.title,
				this.filterInput,
				el('div', 'an-toggles', [graphToggle, treeToggle]),
				el('div', 'actions', [
					actionButton('copy', t('analysis.modules.copyMermaid'), () => this.copyMermaid()),
					actionButton('refresh', t('analysis.page.rerun'), () => void this.load())
				])
			]),
			this.statusHost,
			this.body,
			this.drawing.host
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
			this.data = await invoke<ModuleGraphData>('analysis_module_graph', { folders: this.folders });
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

	/** Show / hide the two view hosts and mark the page (the zoom toolbar only
	 *  speaks to the drawing; the CSS steps it aside in the tree view). */
	private syncView(): void {
		const tree = this.view === 'tree';
		this.body.hidden = !tree;
		this.drawing.host.hidden = tree;
		this.drawing.host.parentElement?.classList.toggle('an-tree', tree);
		if (!tree) this.drawing.onShown();
	}

	private renderGraph(data: ModuleGraphData, status: (text: string, cls?: string) => void): void {
		const key = `${this.loadId}|${this.graphFilter}|${this.focusNode ?? ''}`;
		if (key !== this.graphKey) {
			this.graphKey = key;
			void this.mountDiagram(key);
		}
		const dropped = this.diagram?.droppedFiles ?? 0;
		if (dropped > 0) status(tf('analysis.modules.graphMore', dropped), 'an-more');
		if (this.diagram && this.diagram.nodes.length === 0) status(t('analysis.page.empty'));
	}

	/** Fetch the drawing the backend lays out — the filter and the focus narrow the
	 *  pairs at the source. A newer key (a rerun, the filter settling, a focus change)
	 *  retires this fetch before it ever renders. */
	private async mountDiagram(key: string): Promise<void> {
		this.diagram = null;
		this.selectedId = null;
		this.drawing.setDiagram(null);
		try {
			const diagram = await invoke<ModuleDiagram>('analysis_module_diagram', {
				focus: this.focusNode,
				filter: this.graphFilter,
				folders: this.folders
			});
			if (key !== this.graphKey) return;
			this.diagram = diagram;
		} catch {
			if (key !== this.graphKey) return;
			this.diagram = null;
		}
		this.drawing.setDiagram(this.diagram);
		this.updateGraphbar();
		this.render(); // the dropped / empty statuses follow the answer
	}

	/** Highlight one element and everything it touches: a clicked block with its
	 *  dependencies and neighbours, or a clicked arrow with its two endpoints. The rest
	 *  of the drawing fades back, so the highlight reads at any workspace size. */
	private selectElement(id: string): void {
		const diagram = this.diagram;
		if (!diagram) return;
		const states: Record<string, string[]> = {};
		const edge = diagram.edges.find((candidate) => candidate.id === id);
		if (edge) {
			states[id] = ['selected'];
			states[edge.from] = ['related'];
			states[edge.to] = ['related'];
		} else {
			states[id] = ['selected'];
			for (const candidate of diagram.edges) {
				if (candidate.from === id) {
					states[candidate.id] = ['selected'];
					states[candidate.to] = ['related'];
				} else if (candidate.to === id) {
					states[candidate.id] = ['selected'];
					states[candidate.from] = ['related'];
				}
			}
		}
		for (const node of diagram.nodes) if (!states[node.path]) states[node.path] = ['dim'];
		for (const candidate of diagram.edges) if (!states[candidate.id]) states[candidate.id] = ['dim'];
		this.selectedId = id;
		this.drawing.setStates(states);
		this.updateGraphbar();
	}

	/** Back to the drawing's neutral state — a click on empty canvas, the chip's close,
	 *  or a second click on the selected element. */
	private clearSelection(): void {
		if (!this.selectedId) return;
		this.selectedId = null;
		const diagram = this.diagram;
		if (diagram) {
			const states: Record<string, string[]> = {};
			for (const node of diagram.nodes) states[node.path] = [];
			for (const edge of diagram.edges) states[edge.id] = [];
			this.drawing.setStates(states);
		}
		this.updateGraphbar();
	}

	/** A menu jump to a related block: select it as if clicked and centre it in the
	 *  viewport. */
	private jumpTo(nodeId: string): void {
		this.selectElement(nodeId);
		this.drawing.focusElement(nodeId);
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

	/** The diagram as mermaid source — gitdiagram's copy-the-diagram export; a paste
	 *  into any mermaid renderer redraws the same architecture. */
	private copyMermaid(): void {
		const diagram = this.diagram;
		if (!diagram || diagram.nodes.length === 0) return;
		void writeText(diagram.mermaid).then(
			() => { /* the clipboard has it */ },
			() => { /* the clipboard is unavailable — the button still closed */ }
		);
	}

	/** The chips over the drawing's bottom corner: the scope the tab reports on,
	 *  what is selected, what the drawing is focused on — the scope has no way
	 *  out (it is the tab's identity), the rest each with theirs. */
	private updateGraphbar(): void {
		this.graphbar.textContent = '';
		if (this.folders.length > 0) {
			const chip = el('span', 'chip scope', [icon('folder'), el('span', undefined, [tf('analysis.modules.scopeChip', this.folders.join(', '))])]);
			chip.title = this.folders.join('\n');
			this.graphbar.appendChild(chip);
		}
		if (this.focusNode) {
			this.graphbar.appendChild(this.graphbarChip(
				tf('analysis.modules.focusChip', this.focusNode), 'filter',
				t('analysis.modules.clearFocus'), () => this.clearFocus()));
		}
		if (this.selectedId && this.diagram) {
			const node = this.diagram.nodes.find((candidate) => candidate.path === this.selectedId);
			if (node) {
				this.graphbar.appendChild(this.graphbarChip(
					tf('analysis.modules.selected', node.path, node.callsOut, node.callsIn), 'circle-filled',
					t('analysis.modules.clearSelection'), () => this.clearSelection()));
			} else {
				const edge = this.diagram.edges.find((candidate) => candidate.id === this.selectedId);
				if (edge) {
					this.graphbar.appendChild(this.graphbarChip(
						tf('analysis.modules.selectedEdge', edge.from, edge.to, edge.calls), 'arrow-right',
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

	/** The block's right-click menu: open the file, jump to a related block through the
	 *  Calls / Called By submenus, isolate the neighbourhood, copy the path. */
	private nodeMenu(x: number, y: number, path: string): void {
		const out = new Map<string, number>();
		const inn = new Map<string, number>();
		for (const edge of this.diagram?.edges ?? []) {
			if (edge.from === path) out.set(edge.to, (out.get(edge.to) ?? 0) + edge.calls);
			if (edge.to === path) inn.set(edge.from, (inn.get(edge.from) ?? 0) + edge.calls);
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
		const edge = this.diagram?.edges.find((candidate) => candidate.id === edgeId);
		if (!edge) return;
		const dep = this.data?.fileEdges.find((candidate) => candidate.from === edge.from && candidate.to === edge.to);
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
