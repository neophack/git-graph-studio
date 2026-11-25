// The Analysis result pages (module 17), one editor tab per tool: three streaming
// reports (Complexity & Hotspots, Dead Code, Security Scan) over the shared
// batch-then-done channel rhythm, the Import Graph list, and the Module Analysis page —
// the workspace's cross-file calls as the layered architecture overview the backend
// builds from the symbol store's dependency facts (`analysis_module_overview`: module
// and file cards with coupling metrics, every kept dependency a call-count-labelled
// arrow, the mermaid source along for the export), rendered on the native SVG board of
// moduleDiagram.ts (wheel zoom, drag pan, a zoom toolbar, the selection states and
// the right-click navigation) beside a collapsible tree of module dependencies → file
// pairs → call sites. Both views cap what they draw and the tree renders lazily, so no
// workspace size can stall the page. Loaded lazily behind the Analysis sidebar; nothing
// here belongs to the first-paint bundle.

import { Channel } from '../../platform/ipc/core';
import {
	analysisDeadCode,
	analysisImportGraph,
	analysisMetrics,
	analysisModuleEdgeDetail,
	analysisModuleOverview,
	analysisSecurity,
	type AnalysisStatus,
	type DeadCodeEvent,
	type DeadRow,
	type Finding,
	type ImportGraphData,
	type MetricRow,
	type MetricsEvent,
	type ModuleEdge,
	type ModuleEdgeDetail,
	type ModuleNode,
	type ModuleOverview,
	type SecurityEvent
} from '../../platform/ipc/analysis';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { t, tf } from '../../platform/i18n';
import { KIND_ICONS } from '../search';
import { analysisTool, type AnalysisToolId } from './analysisTools';
import type { AnalysisPageView } from './types';
import { McpPage } from '../mcp';
import { DiagramView, moduleLabel } from './moduleDiagram';
import { actionButton, basename, el, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

/* ---------- The backend shapes ---------- */

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
/** How many streamed rows a report page retains: the page sorts and filters the
 *  retained window, and counts every row the backend sent — on a workspace whose
 *  report has more rows than this, the window keeps the renderer's memory flat and
 *  the footer says so (the totals stay exact). */
const RETAIN_ROWS = 20_000;

abstract class ReportPage<T> implements AnalysisPageView {
	protected rows: T[] = [];
	/** Every row the stream carried, retained or not — the honest total. */
	protected streamed = 0;
	protected filter = '';
	protected error: string | null = null;
	protected running = false;
	protected summary = '';
	protected runId = 0;
	/** The analysis index's latest status push: while a cold build parses under a
	 *  report, the building line says where it is instead of a bare spinner. */
	private buildStatus: AnalysisStatus | null = null;
	private readonly title: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly progress: HTMLElement;
	private readonly buildingLine: HTMLElement;
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
		this.buildingLine = el('div', 'an-building');
		this.list = el('div', 'an-list');
		container.append(header, this.progress, this.buildingLine, this.list);
		this.render();
		// The report runs on open: the index is already built by then, so the first
		// batch is a query away, not a parse away — and on a cold index the build
		// streams the per-file reports itself, rows landing as files parse.
		void this.start();
	}

	/** The index status pushes (the editor area routes them): the building line's
	 *  live counts. Painted directly — a progress push must not re-render the list. */
	noteBuildStatus(status: AnalysisStatus | null): void {
		this.buildStatus = status;
		this.paintBuilding();
	}

	/** The building line under the progress bar: visible only while this page waits
	 *  on a build that is actually running. */
	private paintBuilding(): void {
		const status = this.buildStatus;
		this.buildingLine.textContent = this.running && status?.state === 'building'
			? tf('analysis.page.building', status.done, status.total)
			: '';
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
		this.streamed = 0;
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

	/** Count a batch and keep its rows while the window has room. */
	protected retain(incoming: T[]): void {
		this.streamed += incoming.length;
		const room = RETAIN_ROWS - this.rows.length;
		if (room > 0) this.rows.push(...incoming.slice(0, room));
	}

	render(): void {
		this.progress.classList.toggle('running', this.running);
		this.paintBuilding();
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
		if (this.streamed > this.rows.length) {
			this.list.appendChild(el('div', 'an-more', [tf('analysis.page.retained', this.rows.length, this.streamed)]));
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
				this.retain(event.rows);
				this.render();
			} else if (!event.cancelled) {
				// A cancelled run (a folder switch, a newer rebuild) retires quietly:
				// its zero totals must not stand as the page's answer.
				this.summary = tf('analysis.metrics.summary', event.functions);
			}
		};
		await analysisMetrics(onEvent);
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
	}

	protected async fetch(run: number): Promise<void> {
		const onEvent = new Channel<DeadCodeEvent>();
		onEvent.onmessage = (event) => {
			if (!this.isCurrent(run)) return;
			if (event.kind === 'batch') {
				this.retain(event.rows);
				this.render();
			} else if (!event.cancelled) {
				this.summary = tf('analysis.deadcode.summary', event.found);
			}
		};
		await analysisDeadCode(this.includeExported, onEvent);
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
				this.retain(event.findings);
				this.render();
			} else if (!event.cancelled) {
				this.summary = tf('analysis.security.summary', event.findings);
			}
		};
		await analysisSecurity(onEvent);
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

/* ---------- Module Analysis (9-volume interactive explorer) ---------- */

const DEPTH_OPTIONS = [
	{ value: 0, key: 'analysis.modules.depth.auto' },
	{ value: 1, key: 'analysis.modules.depth.l1' },
	{ value: 2, key: 'analysis.modules.depth.l2' },
	{ value: 3, key: 'analysis.modules.depth.files' }
] as const;

/** The Module Analysis page: nine-volume-backed layered architecture explorer with
 *  Netron-inspired interactive SVG canvas, progressive breadcrumb drill-down, depth
 *  selector, cycles-only & neighborhood isolation filters, resizable right-hand
 *  Properties Inspector drawer, and synchronized list view. */
class ModulePage implements AnalysisPageView {
	private overview: ModuleOverview | null = null;
	private loading = true;
	private error: string | null = null;
	private buildStatus: AnalysisStatus | null = null;
	private filter = '';
	private view: 'graph' | 'list' = 'graph';
	/** Active drill-down directory prefix (`null` = workspace root). */
	private scope: string | null = null;
	/** Grouping depth: 0=Auto, 1=L1, 2=L2, 3=Files. */
	private depth = 0;
	private cyclesOnly = false;
	/** Optional neighborhood isolation target node id. */
	private focusedNodeId: string | null = null;
	private selected: { kind: 'node' | 'edge'; id: string } | null = null;
	private edgeDetailCache = new Map<string, ModuleEdgeDetail>();
	private edgeDetailLoading = false;
	private edgeDetailToken = 0;
	private loadToken = 0;
	private inspectorWidth = 340;
	private readonly folders: string[];

	private readonly drawing: DiagramView;
	private readonly title: HTMLElement;
	private readonly breadcrumbsBar: HTMLElement;
	private readonly statusHost: HTMLElement;
	private readonly workspace: HTMLElement;
	private readonly body: HTMLElement;
	private readonly inspectorSash: HTMLElement;
	private readonly inspector: HTMLElement;
	private readonly graphbar: HTMLElement;
	private readonly filterInput: HTMLInputElement;
	private readonly depthSelect: HTMLSelectElement;
	private readonly cyclesBtn: HTMLButtonElement;
	private readonly toggles: { graph: HTMLElement; list: HTMLElement };

	onOpen: ((path: string, line: number) => void) | null = null;

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
			this.render();
		});
		this.filterInput.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			const { nodes } = this.visibleGraph();
			if (nodes.length === 0) return;
			const q = this.filter;
			const exact = q
				? nodes.find((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) ?? nodes[0]
				: nodes[0];
			this.jumpTo(exact.id);
		});

		this.depthSelect = el('select', 'an-sort an-depth') as HTMLSelectElement;
		this.depthSelect.setAttribute('aria-label', t('analysis.modules.depth'));
		for (const opt of DEPTH_OPTIONS) {
			const o = el('option', undefined, [t(opt.key)]) as HTMLOptionElement;
			o.value = String(opt.value);
			this.depthSelect.appendChild(o);
		}
		this.depthSelect.value = '0';
		this.depthSelect.addEventListener('change', () => {
			this.depth = Number(this.depthSelect.value) || 0;
			void this.load();
		});

		this.cyclesBtn = el('button', 'an-cycles-btn') as HTMLButtonElement;
		this.cyclesBtn.hidden = true;
		this.cyclesBtn.addEventListener('click', () => {
			this.cyclesOnly = !this.cyclesOnly;
			this.cyclesBtn.classList.toggle('on', this.cyclesOnly);
			this.render();
		});

		const graphToggle = el('button', 'an-toggle on', [t('analysis.modules.view.graph')]);
		const listToggle = el('button', 'an-toggle', [t('analysis.modules.view.tree')]);
		graphToggle.addEventListener('click', () => this.setView('graph'));
		listToggle.addEventListener('click', () => this.setView('list'));
		this.toggles = { graph: graphToggle, list: listToggle };

		this.drawing = new DiagramView({
			onActivateNode: (node) => {
				if (node.kind === 'file') this.onOpen?.(node.id, 1);
				else if (node.expandable) this.drillInto(node.id);
			},
			onSelect: (hit) => {
				if (!hit || (this.selected && this.selected.kind === hit.kind && this.selected.id === hit.id)) {
					this.clearSelection();
				} else {
					this.selectElement(hit);
				}
			},
			onNodeContext: (x, y, id) => this.nodeMenu(x, y, id),
			onEdgeContext: (x, y, id) => this.edgeMenu(x, y, id),
			onEscape: () => {
				if (this.selected) this.clearSelection();
				else if (this.focusedNodeId) this.setFocusNode(null);
			}
		});

		this.graphbar = el('div', 'an-graphbar');
		this.drawing.host.append(this.graphbar);
		this.breadcrumbsBar = el('div', 'an-breadcrumbs');
		this.statusHost = el('div');
		this.body = el('div', 'an-list');
		this.inspectorSash = el('div', 'an-insp-sash');
		this.inspectorSash.hidden = true;
		this.wireInspectorSash();
		this.inspector = el('aside', 'an-inspector');
		this.inspector.hidden = true;
		this.inspector.style.width = `${this.inspectorWidth}px`;
		this.workspace = el('div', 'an-mod-workspace', [this.drawing.host, this.body, this.inspectorSash, this.inspector]);

		container.append(
			el('div', 'an-header', [
				icon('symbol-module'),
				this.title,
				this.filterInput,
				this.depthSelect,
				this.cyclesBtn,
				el('div', 'an-toggles', [graphToggle, listToggle]),
				el('div', 'actions', [
					actionButton('copy', t('analysis.modules.copyMermaid'), () => this.copyMermaid()),
					actionButton('refresh', t('analysis.page.rerun'), () => void this.load())
				])
			]),
			this.breadcrumbsBar,
			this.statusHost,
			this.workspace
		);
		this.render();
		void this.load();
	}

	private wireInspectorSash(): void {
		let startX = 0;
		let startW = this.inspectorWidth;
		const onMove = (event: PointerEvent) => {
			const next = Math.max(260, Math.min(640, startW + (startX - event.clientX)));
			this.inspectorWidth = next;
			this.inspector.style.width = `${next}px`;
		};
		const onUp = () => {
			this.inspectorSash.classList.remove('active');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
		};
		this.inspectorSash.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			startX = event.clientX;
			startW = this.inspector.offsetWidth || this.inspectorWidth;
			this.inspectorSash.classList.add('active');
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', onUp);
		});
	}

	private setView(view: 'graph' | 'list'): void {
		if (this.view === view) return;
		this.view = view;
		this.toggles.graph.classList.toggle('on', view === 'graph');
		this.toggles.list.classList.toggle('on', view === 'list');
		this.render();
	}

	private drillInto(scope: string | null): void {
		const next = scope || null;
		if (next === this.scope) return;
		this.scope = next;
		this.selected = null;
		this.focusedNodeId = null;
		this.cyclesOnly = false;
		this.cyclesBtn.classList.remove('on');
		void this.load();
	}

	private setFocusNode(nodeId: string | null): void {
		const next = nodeId === this.focusedNodeId ? null : nodeId;
		this.focusedNodeId = next;
		if (next) this.selected = { kind: 'node', id: next };
		this.render();
		if (next) this.drawing.focusElement(next);
	}

	private async load(): Promise<void> {
		const token = ++this.loadToken;
		this.loading = true;
		this.error = null;
		this.selected = null;
		this.focusedNodeId = null;
		this.edgeDetailToken++;
		this.edgeDetailLoading = false;
		this.edgeDetailCache.clear();
		this.render();
		try {
			const overview = await analysisModuleOverview(this.scope, this.depth, this.folders);
			if (token !== this.loadToken) return;
			this.overview = overview;
		} catch (error) {
			if (token !== this.loadToken) return;
			this.overview = null;
			this.error = String(error);
		}
		this.loading = false;
		this.render();
	}

	noteBuildStatus(status: AnalysisStatus | null): void {
		this.buildStatus = status;
		if (this.loading) this.render();
	}

	private visibleGraph(): { nodes: ModuleNode[]; edges: ModuleEdge[] } {
		const ov = this.overview;
		if (!ov) return { nodes: [], edges: [] };
		let nodes = ov.nodes;
		let edges = ov.edges;
		if (this.cyclesOnly) {
			const cycleIds = new Set(nodes.filter((n) => n.inCycle).map((n) => n.id));
			nodes = nodes.filter((n) => cycleIds.has(n.id));
			edges = edges.filter((e) => e.isCycle && cycleIds.has(e.from) && cycleIds.has(e.to));
		}
		if (this.focusedNodeId) {
			const fid = this.focusedNodeId;
			const relatedEdges = edges.filter((e) => e.from === fid || e.to === fid);
			const keepIds = new Set<string>([fid]);
			for (const e of relatedEdges) {
				keepIds.add(e.from);
				keepIds.add(e.to);
			}
			nodes = nodes.filter((n) => keepIds.has(n.id));
			edges = relatedEdges;
		}
		if (this.filter) {
			const q = this.filter;
			const direct = new Set(nodes.filter((n) =>
				n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)
			).map((n) => n.id));
			const keptEdges = edges.filter((e) =>
				direct.has(e.from) || direct.has(e.to) || e.topSymbols.some((s) => s.toLowerCase().includes(q))
			);
			const keepNodes = new Set(direct);
			for (const e of keptEdges) {
				keepNodes.add(e.from);
				keepNodes.add(e.to);
			}
			nodes = nodes.filter((n) => keepNodes.has(n.id));
			edges = keptEdges;
		}
		return { nodes, edges };
	}

	render(): void {
		const ov = this.overview;
		this.title.textContent = this.loading
			? `${t('analysis.page.loading')}…`
			: this.error
				? t('analysis.page.error')
				: (ov ? tf('analysis.modules.summary', ov.nodes.length, ov.edges.length, ov.cycles.length) : '');

		const cycleCount = ov?.cycles.length ?? 0;
		this.cyclesBtn.hidden = cycleCount === 0;
		this.cyclesBtn.textContent = tf('analysis.modules.cyclesOnly', cycleCount);
		this.cyclesBtn.classList.toggle('on', this.cyclesOnly);

		this.renderBreadcrumbs();
		this.statusHost.textContent = '';
		const status = (text: string, cls = 'an-empty') => this.statusHost.appendChild(el('div', cls, [text]));

		if (this.loading) {
			status(this.buildStatus?.state === 'building'
				? tf('analysis.page.building', this.buildStatus.done, this.buildStatus.total)
				: `${t('analysis.page.loading')}…`);
			this.drawing.setGraph([], []);
			this.syncView();
			return;
		}
		if (this.error) {
			status(this.error);
			this.drawing.setGraph([], []);
			this.syncView();
			return;
		}
		if (!ov || ov.nodes.length === 0) {
			status(t('analysis.modules.empty'));
			this.drawing.setGraph([], []);
			this.syncView();
			return;
		}

		const { nodes, edges } = this.visibleGraph();
		if (nodes.length === 0) {
			status(t('analysis.page.empty'));
		}

		if (this.view === 'graph') {
			this.drawing.setGraph(nodes, edges);
			this.applySelectionStates(nodes, edges);
		} else {
			this.renderList(nodes, edges, status);
		}
		this.updateGraphbar();
		this.renderInspector();
		this.syncView();
	}

	private renderBreadcrumbs(): void {
		this.breadcrumbsBar.textContent = '';
		const crumbs = this.overview?.breadcrumbs ?? [];
		if (crumbs.length === 0 && this.folders.length === 0) {
			this.breadcrumbsBar.hidden = true;
			return;
		}
		this.breadcrumbsBar.hidden = false;
		const rootBtn = el('button', 'an-crumb', [t('analysis.modules.workspaceRoot')]);
		rootBtn.addEventListener('click', () => this.drillInto(null));
		this.breadcrumbsBar.append(rootBtn);
		let acc = '';
		crumbs.forEach((seg, idx) => {
			acc = acc ? `${acc}/${seg}` : seg;
			const target = acc;
			this.breadcrumbsBar.append(icon('chevron-right'));
			const btn = el('button', idx === crumbs.length - 1 ? 'an-crumb active' : 'an-crumb', [seg]);
			btn.addEventListener('click', () => this.drillInto(target));
			this.breadcrumbsBar.append(btn);
		});
		if (this.folders.length > 0) {
			this.breadcrumbsBar.append(el('span', 'an-crumb-scope', [tf('analysis.modules.scopeChip', this.folders.join(', '))]));
		}
	}

	private syncView(): void {
		const list = this.view === 'list';
		this.body.hidden = !list;
		this.drawing.host.hidden = list;
		this.drawing.host.parentElement?.parentElement?.classList.toggle('an-tree', list);
		if (!list) this.drawing.onShown();
	}

	private selectElement(hit: { kind: 'node' | 'edge'; id: string }): void {
		this.selected = hit;
		const { nodes, edges } = this.visibleGraph();
		this.applySelectionStates(nodes, edges);
		this.updateGraphbar();
		this.renderInspector();
		if (hit.kind === 'edge') {
			const edge = this.overview?.edges.find((e) => e.id === hit.id);
			if (edge) void this.loadEdgeDetail(edge);
		}
	}

	private clearSelection(): void {
		if (!this.selected) return;
		this.selected = null;
		this.edgeDetailToken++;
		this.edgeDetailLoading = false;
		this.drawing.setStates({}, {});
		this.updateGraphbar();
		this.renderInspector();
	}

	private applySelectionStates(nodes: ModuleNode[], edges: ModuleEdge[]): void {
		if (!this.selected) {
			this.drawing.setStates({}, {});
			return;
		}
		const nodeStates: Record<string, string[]> = {};
		const edgeStates: Record<string, string[]> = {};
		if (this.selected.kind === 'edge') {
			const edge = edges.find((e) => e.id === this.selected!.id);
			if (!edge) {
				this.drawing.setStates({}, {});
				return;
			}
			edgeStates[edge.id] = ['selected'];
			nodeStates[edge.from] = ['related', 'upstream'];
			nodeStates[edge.to] = ['related', 'downstream'];
		} else {
			const nid = this.selected.id;
			if (!nodes.some((n) => n.id === nid)) {
				this.drawing.setStates({}, {});
				return;
			}
			nodeStates[nid] = ['selected'];
			for (const e of edges) {
				if (e.from === nid) {
					edgeStates[e.id] = ['selected', 'downstream'];
					if (e.to !== nid) {
						nodeStates[e.to] = [...(nodeStates[e.to] ?? []), 'related', 'downstream'];
					}
				} else if (e.to === nid) {
					edgeStates[e.id] = ['selected', 'upstream'];
					if (e.from !== nid) {
						nodeStates[e.from] = [...(nodeStates[e.from] ?? []), 'related', 'upstream'];
					}
				}
			}
		}
		for (const n of nodes) if (!nodeStates[n.id]) nodeStates[n.id] = ['dim'];
		for (const e of edges) if (!edgeStates[e.id]) edgeStates[e.id] = ['dim'];
		this.drawing.setStates(nodeStates, edgeStates);
	}

	private async loadEdgeDetail(edge: ModuleEdge): Promise<void> {
		if (this.edgeDetailCache.has(edge.id)) {
			this.edgeDetailLoading = false;
			this.renderInspector();
			return;
		}
		const token = ++this.edgeDetailToken;
		this.edgeDetailLoading = true;
		this.renderInspector();
		try {
			const detail = await analysisModuleEdgeDetail(edge.from, edge.to, this.scope, this.depth, this.folders);
			if (token !== this.edgeDetailToken) return;
			this.edgeDetailCache.set(edge.id, detail);
		} catch {
			if (token !== this.edgeDetailToken) return;
		}
		this.edgeDetailLoading = false;
		this.renderInspector();
	}

	private renderInspectorSection(title: string, children: HTMLElement[], defaultOpen = true): HTMLElement {
		const sec = el('div', `an-insp-group${defaultOpen ? '' : ' collapsed'}`);
		const chevron = icon(defaultOpen ? 'chevron-down' : 'chevron-right');
		const head = el('button', 'an-insp-sec', [chevron, el('span', undefined, [title])]);
		const content = el('div', 'an-insp-group-body', children);
		head.addEventListener('click', () => {
			const isCollapsed = sec.classList.toggle('collapsed');
			chevron.className = `codicon codicon-${isCollapsed ? 'chevron-right' : 'chevron-down'}`;
		});
		sec.append(head, content);
		return sec;
	}

	private renderPropRow(label: string, value: string | HTMLElement): HTMLElement {
		return el('div', 'an-prop-row', [
			el('span', 'an-prop-key', [label]),
			typeof value === 'string' ? el('span', 'an-prop-val', [value]) : value
		]);
	}

	private renderInspector(): void {
		this.inspector.textContent = '';
		if (!this.selected || !this.overview) {
			this.inspector.hidden = true;
			this.inspectorSash.hidden = true;
			return;
		}
		this.inspector.hidden = false;
		this.inspectorSash.hidden = false;
		const ov = this.overview;

		if (this.selected.kind === 'node') {
			const node = ov.nodes.find((n) => n.id === this.selected!.id);
			if (!node) {
				this.inspector.hidden = true;
				this.inspectorSash.hidden = true;
				return;
			}
			const kindKey = node.kind === 'file'
				? 'analysis.modules.inspector.kind.file'
				: node.kind === 'external'
					? 'analysis.modules.inspector.kind.external'
					: 'analysis.modules.inspector.kind.module';

			const head = el('div', `an-insp-head kind-${node.kind}${node.inCycle ? ' cycle' : ''}`, [
				el('span', `an-insp-dot kind-${node.kind}${node.inCycle ? ' cycle' : ''}`),
				el('span', 'an-insp-title', [moduleLabel(node.id)]),
				actionButton('copy', t('analysis.modules.copyPath'), () => { void writeText(node.id).then(() => {}, () => {}); }),
				actionButton('close', t('analysis.modules.inspector.close'), () => this.clearSelection())
			]);

			const actions = el('div', 'an-insp-actions');
			if (node.expandable) {
				const drillBtn = el('button', 'button', [icon('folder-opened'), t('analysis.modules.drillIn')]);
				drillBtn.addEventListener('click', () => this.drillInto(node.id));
				actions.append(drillBtn);
			} else if (node.kind === 'file') {
				const openBtn = el('button', 'button', [icon('go-to-file'), t('analysis.modules.openFile')]);
				openBtn.addEventListener('click', () => this.onOpen?.(node.id, 1));
				actions.append(openBtn);
			}
			const isFocused = this.focusedNodeId === node.id;
			const focusBtn = el('button', `button secondary${isFocused ? ' active' : ''}`, [
				icon('filter'),
				isFocused ? t('analysis.modules.clearFocus') : t('analysis.modules.isolate')
			]);
			focusBtn.addEventListener('click', () => this.setFocusNode(node.id));
			actions.append(focusBtn);
			if (this.view === 'graph') {
				const centerBtn = actionButton('target', t('analysis.modules.centerNode'), () => this.drawing.focusElement(node.id));
				actions.append(centerBtn);
			}

			// Netron-style structured Properties table with visual instability gauge.
			const instClamped = Math.max(0, Math.min(1, node.instability));
			const instTier = node.inCycle ? 'cycle' : instClamped >= 0.75 ? 'high' : instClamped >= 0.35 ? 'mid' : 'low';
			const instDesc = instClamped >= 0.75
				? t('analysis.modules.inspector.unstable')
				: instClamped >= 0.35
					? t('analysis.modules.inspector.balanced')
					: t('analysis.modules.inspector.stable');
			const instVal = el('span', 'an-prop-val an-prop-inst', [
				el('span', 'an-inst-bar', [
					el('i', `an-inst-bar-fill ${instTier}`)
				]),
				el('span', undefined, [`${node.instability.toFixed(2)} (${instDesc})`])
			]);
			(instVal.querySelector('.an-inst-bar-fill') as HTMLElement).style.width = `${Math.max(4, Math.round(instClamped * 100))}%`;

			const propRows: HTMLElement[] = [
				this.renderPropRow(t('analysis.modules.inspector.kind'), t(kindKey)),
				this.renderPropRow(t('analysis.modules.inspector.layer'), `L${node.layer}`),
				this.renderPropRow(t('analysis.modules.inspector.files'), String(node.files)),
				this.renderPropRow(t('analysis.modules.inspector.symbols'), String(node.symbols)),
				this.renderPropRow(t('analysis.modules.inspector.coupling'), `↓ ${node.fanIn}  /  ↑ ${node.fanOut}`),
				this.renderPropRow(t('analysis.modules.inspector.instability'), instVal)
			];
			if (node.inCycle) {
				propRows.push(this.renderPropRow(
					t('analysis.modules.inspector.cycleTag'),
					el('span', 'an-chip an-chip-cycle', [t('analysis.modules.inspector.cycleTag')])
				));
			}

			const outEdges = ov.edges.filter((e) => e.from === node.id).sort((a, b) => b.weight - a.weight);
			const inEdges = ov.edges.filter((e) => e.to === node.id).sort((a, b) => b.weight - a.weight);
			const body = el('div', 'an-insp-body', [
				actions,
				this.renderInspectorSection(t('analysis.modules.inspector.properties'), [
					el('div', 'an-prop-grid', propRows)
				])
			]);

			if (outEdges.length > 0) {
				body.append(this.renderInspectorSection(
					tf('analysis.modules.inspector.dependsOn', outEdges.length),
					outEdges.map((e) => this.renderInspectorEdgeRow(e, e.to, 'out'))
				));
			}
			if (inEdges.length > 0) {
				body.append(this.renderInspectorSection(
					tf('analysis.modules.inspector.usedBy', inEdges.length),
					inEdges.map((e) => this.renderInspectorEdgeRow(e, e.from, 'in'))
				));
			}
			if (node.topFiles.length > 0) {
				const maxSym = Math.max(1, ...node.topFiles.map((f) => f.symbols));
				const fileRows = node.topFiles.map((f) => {
					const bar = el('span', 'an-file-bar', [el('i')]);
					(bar.firstElementChild as HTMLElement).style.width = `${Math.max(8, Math.round((f.symbols / maxSym) * 100))}%`;
					const row = el('div', 'an-row an-insp-row', [
						icon('file-code'),
						el('span', 'label', [f.path]),
						bar,
						el('span', 'tail', [`${f.symbols}`])
					]);
					row.title = `${f.path} (${f.symbols} symbols)`;
					row.addEventListener('click', () => this.onOpen?.(f.path, 1));
					return row;
				});
				body.append(this.renderInspectorSection(
					tf('analysis.modules.inspector.keyFiles', node.topFiles.length),
					fileRows
				));
			}
			this.inspector.append(head, body);
			return;
		}

		// Edge Inspector (Netron tensor/connection style + L2 on-demand evidence).
		const edge = ov.edges.find((e) => e.id === this.selected!.id);
		if (!edge) {
			this.inspector.hidden = true;
			this.inspectorSash.hidden = true;
			return;
		}
		const head = el('div', `an-insp-head${edge.isCycle ? ' cycle' : ''}`, [
			icon(edge.isCycle ? 'sync' : 'arrow-right'),
			el('span', 'an-insp-title', [`${moduleLabel(edge.from)} → ${moduleLabel(edge.to)}`]),
			actionButton('copy', t('analysis.modules.copyPair'), () => { void writeText(`${edge.from} → ${edge.to}`).then(() => {}, () => {}); }),
			actionButton('close', t('analysis.modules.inspector.close'), () => this.clearSelection())
		]);

		const fromJump = el('button', 'an-endpoint-pill', [icon('symbol-module'), el('span', undefined, [moduleLabel(edge.from)])]);
		fromJump.addEventListener('click', () => this.jumpTo(edge.from));
		const toJump = el('button', 'an-endpoint-pill', [icon('symbol-module'), el('span', undefined, [moduleLabel(edge.to)])]);
		toJump.addEventListener('click', () => this.jumpTo(edge.to));
		const endpointsBar = el('div', 'an-endpoints-bar', [
			fromJump,
			el('span', 'an-arrow', ['→']),
			toJump
		]);

		const edgeProps: HTMLElement[] = [
			this.renderPropRow(t('analysis.modules.inspector.symbolRefs'), String(edge.symbolRefs)),
			this.renderPropRow(t('analysis.modules.inspector.baseRefs'), String(edge.baseRefs)),
			this.renderPropRow(t('analysis.modules.filePairs').replace('{0}', '').trim() || 'File Pairs', String(edge.filePairs))
		];
		if (edge.isCycle) {
			edgeProps.push(this.renderPropRow(
				t('analysis.modules.inspector.cycleTag'),
				el('span', 'an-chip an-chip-cycle', [t('analysis.modules.inspector.cycleTag')])
			));
		}

		const body = el('div', 'an-insp-body', [
			endpointsBar,
			this.renderInspectorSection(t('analysis.modules.inspector.properties'), [
				el('div', 'an-prop-grid', edgeProps)
			])
		]);

		if (edge.topSymbols.length > 0) {
			body.append(this.renderInspectorSection(
				t('analysis.modules.inspector.topSymbols'),
				[el('div', 'an-insp-chips', edge.topSymbols.map((s) => el('span', 'an-chip', [s])))]
			));
		}

		const detail = this.edgeDetailCache.get(edge.id);
		if (this.edgeDetailLoading && !detail) {
			body.append(el('div', 'an-insp-note', [t('analysis.modules.inspector.loadingDetail')]));
		} else if (detail) {
			if (detail.imports.length > 0) {
				const impRows = detail.imports.slice(0, 50).map((imp) => {
					const row = el('div', 'an-row an-insp-row', [
						icon('references'),
						el('span', 'label', [`${basename(imp.fromFile)} → ${basename(imp.toFile)}`]),
						el('span', 'description', [imp.specifier])
					]);
					row.title = `${imp.fromFile} → ${imp.toFile}`;
					row.addEventListener('click', () => this.onOpen?.(imp.fromFile, 1));
					return row;
				});
				body.append(this.renderInspectorSection(
					tf('analysis.modules.inspector.imports', detail.imports.length),
					impRows
				));
			}
			const totalSites = detail.filePairs.reduce((sum, p) => sum + p.sites.length, 0);
			if (totalSites > 0) {
				const siteRows: HTMLElement[] = [];
				for (const pair of detail.filePairs.slice(0, 30)) {
					for (const site of pair.sites.slice(0, 15)) {
						const label = site.receiver ? `${site.receiver}.${site.symbol}` : site.symbol;
						const row = el('div', 'an-row an-insp-row', [
							icon('symbol-method'),
							el('span', 'label', [label]),
							el('span', 'description', [`${pair.fromFile}:${site.line + 1}`])
						]);
						row.title = `${pair.fromFile}:${site.line + 1} → ${pair.toFile}`;
						row.addEventListener('click', () => this.onOpen?.(pair.fromFile, site.line + 1));
						siteRows.push(row);
					}
				}
				body.append(this.renderInspectorSection(
					tf('analysis.modules.inspector.callSites', totalSites),
					siteRows
				));
			}
			if (detail.imports.length === 0 && totalSites === 0) {
				body.append(el('div', 'an-insp-note', [t('analysis.modules.inspector.noDetail')]));
			}
		}
		this.inspector.append(head, body);
	}

	private renderInspectorEdgeRow(edge: ModuleEdge, targetId: string, dir: 'in' | 'out'): HTMLElement {
		const jumpBtn = actionButton('target', t('analysis.modules.centerNode'), () => this.jumpTo(targetId));
		jumpBtn.addEventListener('click', (ev) => ev.stopPropagation());
		const row = el('div', `an-row an-insp-row an-dir-${dir}${edge.isCycle ? ' an-cycle-row' : ''}`, [
			icon(edge.isCycle ? 'sync' : dir === 'out' ? 'arrow-right' : 'arrow-left'),
			el('span', 'label', [moduleLabel(targetId)]),
			el('span', 'an-weight-pill', [`${edge.weight}`]),
			jumpBtn
		]);
		row.addEventListener('click', () => this.selectElement({ kind: 'edge', id: edge.id }));
		return row;
	}

	private renderList(_nodes: ModuleNode[], edges: ModuleEdge[], status: (text: string, cls?: string) => void): void {
		this.body.textContent = '';
		if (edges.length === 0) {
			status(t('analysis.page.empty'));
			return;
		}
		this.body.appendChild(el('div', 'an-section', [tf('analysis.modules.dependencies', edges.length)]));
		for (const edge of edges.slice(0, 1000)) {
			const locateBtn = actionButton('target', t('analysis.modules.locateInGraph'), () => {
				this.setView('graph');
				this.selectElement({ kind: 'edge', id: edge.id });
				this.drawing.focusElement(edge.id);
			});
			locateBtn.addEventListener('click', (ev) => ev.stopPropagation());
			const row = el('div', `an-row an-branch${edge.isCycle ? ' an-cycle-row' : ''}`, [
				icon(edge.isCycle ? 'sync' : 'arrow-right'),
				el('span', 'label', [moduleLabel(edge.from), el('span', 'an-arrow', ['→']), moduleLabel(edge.to)]),
				el('span', 'description', [edge.topSymbols.slice(0, 3).join(', ')]),
				el('span', 'tail', [`${tf('analysis.modules.calls', edge.weight)} · ${tf('analysis.modules.filePairs', edge.filePairs)}`]),
				locateBtn
			]);
			row.addEventListener('click', () => this.selectElement({ kind: 'edge', id: edge.id }));
			this.body.appendChild(row);
		}
	}

	private jumpTo(nodeId: string): void {
		if (this.view !== 'graph') this.setView('graph');
		this.selectElement({ kind: 'node', id: nodeId });
		this.drawing.focusElement(nodeId);
	}

	private copyMermaid(): void {
		const mermaid = this.overview?.mermaid;
		if (!mermaid) return;
		void writeText(mermaid).then(() => {}, () => {});
	}

	private updateGraphbar(): void {
		this.graphbar.textContent = '';
		const legend = el('div', 'an-legend', [
			el('span', 'an-legend-item', [el('i', 'an-legend-dot kind-module'), t('analysis.modules.legend.module')]),
			el('span', 'an-legend-item', [el('i', 'an-legend-dot kind-file'), t('analysis.modules.legend.file')]),
			el('span', 'an-legend-item', [el('i', 'an-legend-dot kind-external'), t('analysis.modules.legend.external')]),
			el('span', 'an-legend-item', [el('i', 'an-legend-dot cycle'), t('analysis.modules.legend.cycle')])
		]);
		this.graphbar.appendChild(legend);

		if (this.folders.length > 0) {
			const chip = el('span', 'chip scope', [icon('folder'), el('span', undefined, [tf('analysis.modules.scopeChip', this.folders.join(', '))])]);
			chip.title = this.folders.join('\n');
			this.graphbar.appendChild(chip);
		}
		if (this.focusedNodeId) {
			this.graphbar.appendChild(this.graphbarChip(
				tf('analysis.modules.focusChip', moduleLabel(this.focusedNodeId)),
				'filter',
				t('analysis.modules.clearFocus'),
				() => this.setFocusNode(null)
			));
		}
		if (this.selected && this.overview) {
			if (this.selected.kind === 'node') {
				const node = this.overview.nodes.find((n) => n.id === this.selected!.id);
				if (node) {
					this.graphbar.appendChild(this.graphbarChip(
						tf('analysis.modules.selected', moduleLabel(node.id), node.fanOut, node.fanIn),
						'circle-filled',
						t('analysis.modules.clearSelection'),
						() => this.clearSelection()
					));
				}
			} else {
				const edge = this.overview.edges.find((e) => e.id === this.selected!.id);
				if (edge) {
					this.graphbar.appendChild(this.graphbarChip(
						tf('analysis.modules.selectedEdge', moduleLabel(edge.from), moduleLabel(edge.to), edge.weight),
						'arrow-right',
						t('analysis.modules.clearSelection'),
						() => this.clearSelection()
					));
				}
			}
		}
	}

	private graphbarChip(text: string, iconName: string, clearTitle: string, onClear: () => void): HTMLElement {
		const chip = el('span', 'chip', [icon(iconName), el('span', undefined, [text]), actionButton('close', clearTitle, onClear)]);
		chip.title = text;
		return chip;
	}

	private nodeMenu(x: number, y: number, id: string): void {
		const ov = this.overview;
		const node = ov?.nodes.find((n) => n.id === id);
		if (!ov || !node) return;
		const out = ov.edges.filter((e) => e.from === id);
		const inn = ov.edges.filter((e) => e.to === id);
		const neighbourItems = (list: ModuleEdge[], pick: (e: ModuleEdge) => string): MenuEntry[] =>
			list.slice(0, 30).map((e) => ({
				label: `${moduleLabel(pick(e))} (${tf('analysis.modules.calls', e.weight)})`,
				run: () => this.jumpTo(pick(e))
			}));
		const entries: MenuEntry[] = [
			...(node.expandable ? [{ label: t('analysis.modules.drillIn'), run: () => this.drillInto(node.id) }] : []),
			...(node.kind === 'file' ? [{ label: t('analysis.modules.openFile'), run: () => this.onOpen?.(node.id, 1) }] : []),
			{
				label: this.focusedNodeId === node.id ? t('analysis.modules.clearFocus') : t('analysis.modules.focus'),
				run: () => this.setFocusNode(node.id)
			},
			'separator',
			out.length > 0
				? { label: tf('analysis.modules.callsOut', out.length), submenu: neighbourItems(out, (e) => e.to) }
				: { label: tf('analysis.modules.callsOut', 0), disabled: true },
			inn.length > 0
				? { label: tf('analysis.modules.callsIn', inn.length), submenu: neighbourItems(inn, (e) => e.from) }
				: { label: tf('analysis.modules.callsIn', 0), disabled: true },
			'separator',
			{ label: t('analysis.modules.copyPath'), run: () => { void writeText(node.id).then(() => {}, () => {}); } }
		];
		showContextMenu(x, y, entries);
	}

	private edgeMenu(x: number, y: number, edgeId: string): void {
		const edge = this.overview?.edges.find((e) => e.id === edgeId);
		if (!edge) return;
		const entries: MenuEntry[] = [
			{ label: `${moduleLabel(edge.from)} → ${moduleLabel(edge.to)}`, disabled: true },
			'separator',
			{ label: t('analysis.modules.copyPair'), run: () => { void writeText(`${edge.from} → ${edge.to}`).then(() => {}, () => {}); } }
		];
		showContextMenu(x, y, entries);
	}
}

/* ---------- Import Graph ---------- */

class ImportsPage implements AnalysisPageView {
	private graph: ImportGraphData | null = null;
	private loading = true;
	private error: string | null = null;
	/** The index status push: while the page's load waits on a cold build, the
	 *  loading line names the build's live position. */
	private buildStatus: AnalysisStatus | null = null;
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

	private loadToken = 0;

	private async load(): Promise<void> {
		const token = ++this.loadToken;
		this.loading = true;
		this.error = null;
		this.render();
		try {
			const graph = await analysisImportGraph();
			if (token !== this.loadToken) return;
			this.graph = graph;
		} catch (error) {
			if (token !== this.loadToken) return;
			this.graph = null;
			this.error = String(error);
		}
		this.loading = false;
		this.render();
	}

	/** The index status pushes (the editor area routes them): the loading state names
	 *  the build's live position; after the load they change nothing. */
	noteBuildStatus(status: AnalysisStatus | null): void {
		this.buildStatus = status;
		if (this.loading) this.render();
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
			this.body.appendChild(el('div', 'an-empty', [this.buildStatus?.state === 'building'
				? tf('analysis.page.building', this.buildStatus.done, this.buildStatus.total)
				: `${t('analysis.page.loading')}…`]));
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
