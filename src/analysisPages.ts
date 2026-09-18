// The Analysis result pages (module 17), one editor tab per tool: three streaming
// reports (Complexity & Hotspots, Dead Code, Security Scan) over the shared
// batch-then-done channel rhythm, and two graph pages (Call Graph, Import Graph) drawn
// as SVG the CAN chart way — one viewBox, theme colours. The Call Graph opens on the
// workspace's every call relationship; the search then narrows it to a per-symbol walk.
// Loaded lazily behind the Analysis sidebar; nothing here belongs to the first-paint
// bundle.

import { invoke, Channel } from '@tauri-apps/api/core';

import { t, tf } from './i18n';
import { KIND_ICONS } from './contextView';
import { analysisTool, type AnalysisToolId } from './analysisTools';
import { actionButton, el, icon, quickPick } from './ui';

/* ---------- The backend shapes ---------- */

interface WsSymbol {
	kind: string;
	name: string;
	path: string;
	line: number;
	column?: number;
	endLine?: number;
	container?: string | null;
}

interface GraphNode {
	kind: string;
	name: string;
	container: string | null;
	path: string;
	line: number;
	complexity: number;
	signature: string;
	depth: number;
}

interface GraphEndpoint { name: string; path: string; line: number }

interface GraphEdge { from: GraphEndpoint; to: GraphEndpoint; callPath: string; callLine: number; callColumn: number }

interface CallGraph { nodes: GraphNode[]; edges: GraphEdge[]; ambiguous: number }

/** `analysis_workspace_call_graph`: every relationship at once, capped and counted. */
interface WorkspaceCallGraph extends CallGraph {
	totalNodes: number;
	totalEdges: number;
}

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
		case 'callgraph': return new CallGraphPage(container);
		case 'metrics': return new MetricsPage(container);
		case 'deadcode': return new DeadCodePage(container);
		case 'security': return new SecurityPage(container);
		case 'imports': return new ImportsPage(container);
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
	private runId = 0;
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

class MetricsPage extends ReportPage<MetricRow> {
	constructor(container: HTMLElement) {
		super(container, 'metrics');
	}

	protected async fetch(run: number): Promise<void> {
		const onEvent = new Channel<MetricsEvent>();
		onEvent.onmessage = (event) => {
			if (!this.isCurrent(run)) return;
			if (event.kind === 'batch') {
				this.rows.push(...event.rows);
				this.render();
			} else {
				this.summary = tf('analysis.metrics.summary', event.functions);
			}
		};
		await invoke('analysis_metrics', { onEvent });
		this.rows.sort((a, b) => b.hotspot - a.hotspot || b.complexity - a.complexity);
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

/* ---------- Call Graph ---------- */

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
	return node;
}

class CallGraphPage implements AnalysisPageView {
	private readonly page: HTMLElement;
	private readonly body: HTMLElement;
	private readonly note: HTMLElement;
	private readonly search: HTMLInputElement;
	private root: WsSymbol | null = null;
	private direction: 'callers' | 'callees' = 'callees';
	private depth = 2;
	private runId = 0;
	private graph: CallGraph | null = null;
	private full: WorkspaceCallGraph | null = null;
	private filter = '';
	private loading = false;
	private error: string | null = null;

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement) {
		this.page = container;
		container.classList.add('an-page', 'an-graph');
		this.search = el('input', 'an-filter an-symbol') as HTMLInputElement;
		this.search.type = 'search';
		this.search.placeholder = t('analysis.callgraph.symbol');
		this.search.setAttribute('aria-label', t('analysis.callgraph.symbol'));
		this.search.addEventListener('input', () => {
			// On the whole-workspace view the box filters the drawing live; Enter still
			// commits to a focused walk.
			if (this.root) return;
			this.filter = this.search.value.trim().toLowerCase();
			this.render();
		});
		this.search.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void this.pick();
		});
		const callers = el('button', 'an-toggle', [t('analysis.callgraph.callers')]);
		const callees = el('button', 'an-toggle on', [t('analysis.callgraph.callees')]);
		callers.addEventListener('click', () => this.setDirection('callers', callers, callees));
		callees.addEventListener('click', () => this.setDirection('callees', callers, callees));
		const depth = el('select', 'an-depth') as HTMLSelectElement;
		for (const value of [1, 2, 3, 4]) {
			const option = el('option', undefined, [String(value)]) as HTMLOptionElement;
			option.value = String(value);
			depth.appendChild(option);
		}
		depth.value = String(this.depth);
		depth.setAttribute('aria-label', t('analysis.callgraph.depth'));
		depth.addEventListener('change', () => {
			this.depth = Number(depth.value) || 2;
			void this.load();
		});
		this.note = el('div', 'an-note');
		this.body = el('div', 'an-graph-body');
		container.append(
			el('div', 'an-header', [
				icon('callout'),
				el('span', 'an-title', [t('analysis.tool.callgraph')]),
				this.search,
				el('div', 'an-toggles', [callers, callees]),
				depth,
				el('div', 'actions', [
					actionButton('globe', t('analysis.callgraph.showAll'), () => this.showAll())
				])
			]),
			this.note,
			this.body
		);
		this.render();
		// The page opens on the workspace's every call relationship — no symbol has to
		// be found first; the search then narrows to a focused walk.
		void this.loadFull();
	}

	private setDirection(direction: 'callers' | 'callees', callers: HTMLElement, callees: HTMLElement): void {
		this.direction = direction;
		callers.classList.toggle('on', direction === 'callers');
		callees.classList.toggle('on', direction === 'callees');
		void this.load();
	}

	/** Back to the whole-workspace drawing (also the page's opening state). */
	private showAll(): void {
		this.root = null;
		this.graph = null;
		this.search.value = '';
		this.filter = '';
		void this.loadFull();
	}

	private async loadFull(): Promise<void> {
		const run = ++this.runId;
		this.loading = true;
		this.error = null;
		this.render();
		try {
			this.full = await invoke<WorkspaceCallGraph>('analysis_workspace_call_graph');
		} catch (error) {
			if (run === this.runId) {
				this.full = null;
				this.error = String(error);
			}
		}
		if (run !== this.runId) return;
		this.loading = false;
		this.render();
	}

	/** Search the symbol, disambiguate with the picker, then draw the graph. */
	private async pick(): Promise<void> {
		const query = this.search.value.trim();
		if (!query) return;
		let hits: WsSymbol[] = [];
		try {
			hits = await invoke<WsSymbol[]>('workspace_symbols', { query, limit: 50 });
		} catch {
			hits = [];
		}
		if (hits.length === 0) {
			this.error = t('analysis.callgraph.notFound');
			this.render();
			return;
		}
		if (hits.length === 1) {
			this.root = hits[0];
			void this.load();
			return;
		}
		const picked = await quickPick(
			hits.map((hit) => ({
				label: hit.container ? `${hit.container}.${hit.name}` : hit.name,
				description: `${hit.path}:${hit.line + 1}`,
				value: `${hit.path}:${hit.line}`
			})),
			t('analysis.callgraph.pick')
		);
		if (picked) {
			this.root = hits.find((hit) => `${hit.path}:${hit.line}` === picked) ?? null;
			void this.load();
		}
	}

	private async load(): Promise<void> {
		if (!this.root) return;
		const run = ++this.runId;
		this.loading = true;
		this.error = null;
		this.render();
		try {
			this.graph = await invoke<CallGraph>('analysis_call_graph', {
				name: this.root.name,
				path: this.root.path,
				line: this.root.line,
				direction: this.direction,
				maxDepth: this.depth
			});
		} catch (error) {
			if (run === this.runId) {
				this.graph = null;
				this.error = String(error);
			}
		}
		if (run !== this.runId) return;
		this.loading = false;
		this.render();
	}

	render(): void {
		this.body.textContent = '';
		this.note.textContent = '';
		// The direction and depth controls only speak to a focused walk; the
		// whole-workspace view carries every relationship already.
		this.page.classList.toggle('an-full', !this.root);
		if (this.loading) {
			this.body.appendChild(el('div', 'an-empty', [`${t('analysis.page.loading')}…`]));
			return;
		}
		if (this.error) {
			this.note.textContent = this.error.startsWith('The code analysis index')
				? t('analysis.page.error')
				: this.error;
			this.body.appendChild(el('div', 'an-empty', [this.error]));
			return;
		}
		if (this.root) {
			const graph = this.graph;
			if (!graph) return;
			if (graph.nodes.length === 0) {
				this.body.appendChild(el('div', 'an-empty', [t('analysis.page.empty')]));
				return;
			}
			if (graph.ambiguous > 0) this.note.textContent = tf('analysis.callgraph.ambiguous', graph.ambiguous);
			this.body.appendChild(this.drawGraph(graph.nodes, graph.edges));
			this.body.appendChild(this.drawCallSites(graph.edges));
			return;
		}
		const full = this.full;
		if (!full) return;
		if (full.nodes.length === 0) {
			this.body.appendChild(el('div', 'an-empty', [t('analysis.page.empty')]));
			return;
		}
		const nodes = full.nodes.filter((node) => this.nodeMatches(node));
		const visible = new Set(nodes.map((node) => `${node.path}:${node.line}`));
		const edges = full.edges.filter((edge) =>
			visible.has(`${edge.from.path}:${edge.from.line}`)
			&& visible.has(`${edge.to.path}:${edge.to.line}`));
		const notes = [tf('analysis.callgraph.full', full.totalNodes, full.totalEdges)];
		if (full.nodes.length < full.totalNodes || full.edges.length < full.totalEdges) {
			notes.push(tf('analysis.callgraph.truncated', full.nodes.length, full.totalNodes, full.edges.length, full.totalEdges));
		}
		if (full.ambiguous > 0) notes.push(tf('analysis.callgraph.ambiguous', full.ambiguous));
		this.note.textContent = notes.join(' · ');
		if (nodes.length === 0) {
			this.body.appendChild(el('div', 'an-empty', [t('analysis.page.empty')]));
			return;
		}
		this.body.appendChild(this.drawGraph(nodes, edges));
	}

	private nodeMatches(node: GraphNode): boolean {
		if (!this.filter) return true;
		return node.name.toLowerCase().includes(this.filter)
			|| (node.container ?? '').toLowerCase().includes(this.filter)
			|| node.path.toLowerCase().includes(this.filter);
	}

	/** The layered SVG: one row per BFS depth, nodes spread horizontally, curved edges. */
	private drawGraph(nodes: GraphNode[], edges: GraphEdge[]): HTMLElement {
		const nodeWidth = 190;
		const nodeHeight = 38;
		const rowGap = 84;
		const columnGap = 18;
		const layers = new Map<number, GraphNode[]>();
		for (const node of nodes) {
			const layer = layers.get(node.depth) ?? [];
			layer.push(node);
			layers.set(node.depth, layer);
		}
		const width = Math.max(...[...layers.values()].map((layer) => layer.length)) * (nodeWidth + columnGap) + columnGap;
		const height = layers.size * (nodeHeight + rowGap - nodeHeight / 2) + 30;
		const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, class: 'an-svg', role: 'img' });
		// A wide workspace drawing keeps a readable minimum width and scrolls instead of
		// shrinking to a hairline; past the second cap it scales down (the filter narrows).
		if (width > 1600) svg.style.minWidth = `${Math.min(width, 3200)}px`;
		const at = new Map<string, { x: number; y: number }>();
		for (const [depth, layer] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
			layer.forEach((node, index) => {
				const x = columnGap + index * (nodeWidth + columnGap) + (width - columnGap - layer.length * (nodeWidth + columnGap)) / 2;
				const y = 16 + depth * (nodeHeight + rowGap - nodeHeight / 2);
				at.set(`${node.path}:${node.line}`, { x, y });
			});
		}
		for (const edge of edges) {
			const from = at.get(`${edge.from.path}:${edge.from.line}`);
			const to = at.get(`${edge.to.path}:${edge.to.line}`);
			if (!from || !to) continue;
			const x1 = from.x + nodeWidth / 2;
			const y1 = from.y + nodeHeight;
			const x2 = to.x + nodeWidth / 2;
			const y2 = to.y;
			const bend = (y1 + y2) / 2;
			svg.appendChild(svgNode('path', {
				d: `M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`,
				class: 'an-edge'
			}));
		}
		for (const [depth, layer] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
			layer.forEach((node) => {
				const position = at.get(`${node.path}:${node.line}`)!;
				const group = svgNode('g', { class: 'an-node' + (depth === 0 ? ' root' : '') });
				group.appendChild(svgNode('rect', { x: position.x, y: position.y, rx: 6, width: nodeWidth, height: nodeHeight }));
				const label = svgNode('text', { x: position.x + nodeWidth / 2, y: position.y + 16 });
				label.textContent = node.container ? `${node.container}.${node.name}` : node.name;
				const tail = svgNode('text', { x: position.x + nodeWidth / 2, y: position.y + 29, class: 'an-node-sub' });
				tail.textContent = node.kind;
				group.append(label, tail);
				group.addEventListener('click', () => {
					// A node click makes it the new root — the graph walks from there.
					this.root = { kind: node.kind, name: node.name, path: node.path, line: node.line };
					this.search.value = node.name;
					void this.load();
				});
				group.addEventListener('dblclick', () => this.onOpen?.(node.path, node.line + 1));
				svg.appendChild(group);
			});
		}
		const host = el('div', 'an-svg-host');
		host.appendChild(svg);
		return host;
	}

	/** The call sites under the drawing: every edge as a clickable row. */
	private drawCallSites(edges: GraphEdge[]): HTMLElement {
		if (edges.length === 0) return el('div');
		const list = el('div', 'an-list an-callsites');
		list.appendChild(el('div', 'an-section', [t('analysis.callgraph.callsites')]));
		for (const edge of edges.slice(0, 500)) {
			const row = el('div', 'an-row');
			row.append(
				icon('arrow-right'),
				el('span', 'label', [`${edge.from.name} → ${edge.to.name}`]),
				el('span', 'description', [`${edge.callPath}:${edge.callLine + 1}`])
			);
			row.addEventListener('click', () => this.onOpen?.(edge.callPath, edge.callLine + 1));
			list.appendChild(row);
		}
		return list;
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
