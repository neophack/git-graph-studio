// The Relation Graph (module 5) — the Symbol Window's lower half: the symbol under the
// cursor's ring as a mermaid flowchart, drawn on the Code Analysis module's own drawing
// (`moduleDiagram.ts`'s DiagramView — the same mermaid + ELK renderer, the same
// gitdiagram-class viewer: pan, zoom, fit, keyboard, pinch). Every expansion rebuilds the
// flowchart source, so ELK re-lays the whole graph — the auto-arrange by construction, no
// overlaps ever. The pointer's vocabulary is Source Insight's relation window's: one
// click on a card whose label carries the +/− drills its ring (the deferred drill, so a
// double click's first press never expands), one click on a card without a ring — and
// the double click on any card — opens the definition, a right-click menu drills
// (expand/collapse), re-roots or opens, and resting floats the declaration card. The
// direction buttons swap refs to / refs from / contains; a node whose ring the index
// promises carries the +/− marker in its label (and ⋯ when the ring came back cut
// short), and an aggregating edge carries its ×N in the label. mermaid loads lazily,
// shared with module 17's chunk.

import type { ModuleDiagram } from '../../platform/ipc/analysis';
import { readFile } from '../../platform/ipc/fs';
import { symbolLookup, symbolRelationChildren, type RelationDirection, type RelationNode } from '../../platform/ipc/symbols';

import { t, tf } from '../../platform/i18n';
import { el, escapeHtml, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

import './relationGraph.css';

/** The drawing host's own type — the value itself crosses through the first draw's
 *  dynamic import (module 17's chunk; a static edge back to the analysis facade would
 *  close an import cycle the analysis page's own search import opens). */
type DiagramView = import('../analysis').DiagramView;

/** What the workbench resolved the symbol under the cursor to (0-based line) — the
 *  graph's root vocabulary, shared with every seeder of it. */
export interface RelationRoot {
	kind: string;
	name: string;
	/** Repo-relative path of the definition - the index's own vocabulary, which the
	 *  relation backend and every node below the root speak too. */
	path: string;
	line: number;
}

/** How deep the graph may drill before a node's ring answers the cap instead — the
 *  runaway guard for a hot name whose rings never end (the panel tree's is 8). */
const MAX_DEPTH = 3;

/** The pointer's rest before the declaration card floats in — the panel tree's timing. */
const DECL_DELAY = 300;

/** A drillable card's click waits this long before it drills, so the double click's
 *  first press never expands the ring on its way to the jump (SI's expander reads
 *  instantly; here the whole card is the expander, and the delay is the merge's cost). */
const CLICK_DRILL_DELAY = 220;

/** One graph node: a symbol's card and its ring's bookkeeping. The drawn structure is a
 *  strict tree — a ring answer naming a symbol already drawn adds a cross edge instead of
 *  a second card, so the source's node/edge lists never meet a cycle. */
interface GraphNode {
	key: string;
	kind: string;
	name: string;
	container: string | null;
	path: string;
	/** 0-based definition line — the click's jump and the re-root's coordinates. */
	line: number;
	parentKey: string | null;
	/** The fetched ring, in answer order — drawn only while `expanded`. */
	children: string[];
	/** The edge that produced this node: its site and how many sites it aggregates — the
	 *  arrow's kind and the ×N label (the root carries the neutral defaults). */
	edgeKind: string;
	edgeCount: number;
	hasChildren: boolean;
	expanded: boolean;
	loaded: boolean;
	loading: boolean;
	/** The node's own ring came back cut short — the label's ⋯ keeps saying so. */
	truncated: boolean;
}

/** One drawn arrow: `from` references (or contains) `to`, the head lands on `to`. */
interface GraphEdge {
	from: string;
	to: string;
	/** `call`, `use`, or `member` (a contains ring's edge). */
	kind: string;
	/** How many reference sites this edge aggregates — 1 for a single site. */
	count: number;
}

/** The identity key: two same-named definitions are different nodes. */
function nodeKey(name: string, path: string, line: number): string {
	return `${name}\u0000${path}\u0000${line}`;
}

function fromRelation(node: RelationNode, parentKey: string | null): GraphNode {
	return {
		key: nodeKey(node.name, node.path, node.line),
		kind: node.kind,
		name: node.name,
		container: node.container,
		path: node.path,
		line: node.line,
		parentKey,
		children: [],
		edgeKind: node.edgeKind,
		edgeCount: node.edgeCount,
		hasChildren: node.hasChildren,
		expanded: false,
		loaded: false,
		loading: false,
		truncated: false
	};
}

/* ---------- The mermaid source (pure, for the tests) ---------- */

/** One card's label: the drill marker the ring's state carries (+ / −), the container
 *  prefix, the name, and the ⋯ a cut-short ring appends. Quotes become apostrophes —
 *  mermaid's `["…"]` strings have no escape for them. */
export function relationLabel(node: GraphNode): string {
	const marker = node.hasChildren ? (node.expanded ? '− ' : '+ ') : '';
	const name = `${node.container ? `${node.container}·` : ''}${node.name}`.replace(/"/g, "'");
	return `${marker}${name}${node.truncated ? ' ⋯' : ''}`;
}

/** The flowchart `flowchart TD` source over the visible (expanded) shapes: nodes in
 *  `N0…` order, every edge from the referencing side to the referenced (refsTo's
 *  children point up, the other directions point down), the ×N a count past one carries,
 *  use arrows dashed, and the link styles + the root's class riding the theme palette
 *  (mermaid reads its style values literally — a `var(--…)` fails the render — so the
 *  colours cross as the literals, picked by the theme kind like mermaidConfig's own). */
export function relationMermaid(nodes: GraphNode[], edges: GraphEdge[], rootKey: string): string {
	const index = new Map(nodes.map((node, at) => [node.key, at]));
	const dark = document.documentElement.classList.contains('vscode-dark');
	const tone = dark ? { call: '#4fc1ff', use: '#9da5b4', member: '#89d185' } : { call: '#006abc', use: '#5a5a5a', member: '#2da44e' };
	const lines: string[] = ['flowchart TD'];
	for (const node of nodes) lines.push(`  N${index.get(node.key)}["${relationLabel(node)}"]`);
	const styled: string[] = [];
	for (const edge of edges) {
		const from = index.get(edge.from);
		const to = index.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const arrow = edge.kind === 'use' ? '-.->' : '-->';
		lines.push(`  N${from} ${arrow}${edge.count > 1 ? `|"×${edge.count}"|` : ''} N${to}`);
		const at = lines.length - 2 - nodes.length; // the edge's own linkStyle index
		styled.push(`${at} stroke:${tone[edge.kind as 'call' | 'use' | 'member'] ?? tone.use}`);
	}
	for (const style of styled) lines.push(`  linkStyle ${style}`);
	lines.push(
		`  classDef rgRoot ${dark ? 'fill:#2c3544,stroke:#6dd4e9,color:#e8edf5' : 'fill:#f7f7f7,stroke:#334155,color:#171717'},stroke-width:1.5px`,
		`  class N${index.get(rootKey) ?? 0} rgRoot`
	);
	return lines.join('\n');
}

/** The declaration card's cargo: the definition's opening lines and where they sit. */
interface DeclFragment {
	kind: string;
	path: string;
	/** 0-based line the fragment starts on. */
	line: number;
	text: string;
}

const DECL_MAX_LINES = 6;
const DECL_MAX_CHARS = 400;

export class RelationGraphView {
	/** The canvas: the mermaid drawing host (module 17's DiagramView — its zoombar,
	 *  pan/zoom, fit and keyboard ride along). */
	readonly element: HTMLElement;

	/** The direction buttons, the pin and the Fit — the Symbol Window's section head hosts
	 *  them beside its own label, so the graph costs one row of the sidebar. */
	readonly controls: HTMLElement;

	/** A definition click (one click on a card) — the line arrives 1-based. */
	onOpen?: (path: string, line: number) => void;

	/** The pin's toggle — the host re-feeds the cursor's symbol when the pin lifts. */
	onPinChange?: (pinned: boolean) => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  the declaration card's file read opens the absolute spelling the backend needs.
	 *  Unwired, the path passes through as-is. */
	resolvePath?: (path: string) => string;

	private diagram: DiagramView | null = null;

	/** The drawing host's lazy construction — the module 17 chunk (mermaid itself loads
	 *  inside it) only pays when a graph first draws. */
	private diagramReady: Promise<DiagramView> | null = null;

	/** Set by the dispose: a first draw still in flight must not mount into a dead view. */
	private disposed = false;

	/** The resting/loading/failed note, floating over the drawing host. */
	private readonly hint: HTMLElement;

	private root: RelationRoot | null = null;

	private direction: RelationDirection = 'refsTo';

	private readonly nodes = new Map<string, GraphNode>();

	private rootKey = '';

	/** Rings that named an already-drawn symbol: the arrow without the second card. */
	private readonly crossEdges: GraphEdge[] = [];

	private readonly crossSeen = new Set<string>();

	/** The root switch's staleness counter: a setRoot / direction switch drops every
	 *  answer before it, the in-flight expansions included. */
	private generation = 0;

	private rootLoading = false;

	private rootFailed = false;

	/** Why the root is empty (the host's note), shown instead of the resting hint. */
	private rootNote: string | undefined;

	private pinned = false;

	private readonly dirTo: HTMLButtonElement;

	private readonly dirFrom: HTMLButtonElement;

	private readonly dirContains: HTMLButtonElement;

	private readonly pinButton: HTMLButtonElement;

	/* ---------- The declaration card ---------- */

	private readonly declCache = new Map<string, Promise<DeclFragment | null>>();

	private declTimer: number | null = null;

	/** A drillable card's deferred drill in flight — the double click cancels it. */
	private clickTimer: number | null = null;

	private declCard: HTMLElement | null = null;

	private readonly onDocMouseDown = (event: MouseEvent): void => {
		if (this.declCard && !this.declCard.contains(event.target as Node)) this.hideDecl();
	};

	private readonly onDocKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape' && this.declCard) this.hideDecl();
	};

	/** The card the pointer rests on — the hover's deferred subject, dropped by the
	 *  next mouseover or a mouseout that leaves the host. */
	private declTarget: { node: GraphNode; generation: number; x: number; y: number } | null = null;

	constructor() {
		this.hint = el('div', 'rg-hint rg-hint-overlay');
		this.element = el('div', 'rg-root', [this.hint]);

		this.dirTo = el('button', 'rg-dir');
		this.dirTo.addEventListener('click', () => this.setDirection('refsTo'));
		this.dirFrom = el('button', 'rg-dir');
		this.dirFrom.addEventListener('click', () => this.setDirection('refsFrom'));
		this.dirContains = el('button', 'rg-dir');
		this.dirContains.addEventListener('click', () => this.setDirection('contains'));
		const fit = el('button', 'rg-dir', [icon('screen-full')]);
		fit.title = t('symbols.graph.fit');
		fit.addEventListener('click', () => this.fit());
		this.pinButton = el('button', 'rg-dir');
		this.pinButton.addEventListener('click', () => this.togglePin());
		this.controls = el('div', 'rg-controls', [this.dirTo, this.dirFrom, this.dirContains, this.pinButton, fit]);
		this.paintControls();

		document.addEventListener('mousedown', this.onDocMouseDown);
		document.addEventListener('keydown', this.onDocKeyDown);
		this.render();
	}

	/** The drawing host, built on the first render that has something to draw: the
	 *  dynamic import keeps the Symbol Window's first paint off module 17's chunk (and
	 *  the static one off the seam graph — the analysis page already imports this module
	 *  through its facade, and a static edge back would close a cycle). */
	private ensureDiagram(): Promise<DiagramView> {
		this.diagramReady ??= (async () => {
			const { DiagramView } = await import('../analysis');
			if (this.disposed) throw new Error('the relation graph was disposed');
			const diagram = new DiagramView({
				// Source Insight's relation-window vocabulary: a card whose label carries the
				// +/− (the ring's expander) drills on one click — the deferred drill, so a
				// double click's first press never expands before the jump; a card without
				// a ring has nothing to drill and its click opens the definition at once.
				// An edge click (its id carries the L_ prefix) and the background answer
				// nothing.
				onSelect: (id) => {
					if (id === null || id.startsWith('L_')) return;
					const node = this.nodes.get(id);
					if (!node) return;
					if (!node.hasChildren) {
						this.onOpen?.(node.path, node.line + 1);
						return;
					}
					if (this.clickTimer !== null) clearTimeout(this.clickTimer);
					this.clickTimer = window.setTimeout(() => {
						this.clickTimer = null;
						void this.toggleExpand(id);
					}, CLICK_DRILL_DELAY);
				},
				// The double click jumps to the definition — SI's own jump — cancelling a
				// drill the first press had scheduled.
				onOpenNode: (key) => {
					this.cancelClickDrill();
					const node = this.nodes.get(key);
					if (node) this.onOpen?.(node.path, node.line + 1);
				},
				// The right-click menu: the ring's drill, the re-root, the definition.
				onNodeContext: (x, y, key) => {
					const node = this.nodes.get(key);
					if (!node) return;
					const entries: MenuEntry[] = [];
					if (node.hasChildren) {
						entries.push({
							label: node.expanded ? t('relations.collapse') : t('relations.expand'),
							run: () => void this.toggleExpand(key)
						});
					}
					entries.push(
						{ label: t('relations.reRoot'), run: () => this.setRoot({ kind: node.kind, name: node.name, path: node.path, line: node.line }) },
						{ label: t('relations.openDef'), run: () => this.onOpen?.(node.path, node.line + 1) }
					);
					showContextMenu(x, y, entries);
				},
				onEdgeContext: () => undefined
			});
			// The host's own tooltip names the module page's hint — the graph speaks for itself.
			diagram.host.title = '';
			diagram.host.setAttribute('aria-label', t('symbols.graph.title'));
			// The hover's declaration card: one delegated pair over the drawing host —
			// mermaid rebuilds its SVG under us, the markers always resolve.
			diagram.host.addEventListener('mouseover', (event) => {
				const target = event.target instanceof Element ? event.target.closest('[data-path]') : null;
				const key = target?.getAttribute('data-path');
				const node = key ? this.nodes.get(key) : null;
				if (!node) return;
				this.scheduleDecl(node, event.clientX, event.clientY);
			});
			diagram.host.addEventListener('mouseout', (event) => {
				const target = event.target instanceof Element ? event.target.closest('[data-path]') : null;
				if (target) this.cancelDecl();
			});
			this.diagram = diagram;
			this.element.insertBefore(diagram.host, this.hint);
			return diagram;
		})();
		return this.diagramReady;
	}

	/** The host's dispose: the document-level dismissers must not outlive the view. */
	dispose(): void {
		this.disposed = true;
		this.hideDecl();
		this.cancelClickDrill();
		document.removeEventListener('mousedown', this.onDocMouseDown);
		document.removeEventListener('keydown', this.onDocKeyDown);
		this.diagram?.destroy();
	}

	private cancelClickDrill(): void {
		if (this.clickTimer !== null) {
			clearTimeout(this.clickTimer);
			this.clickTimer = null;
		}
	}

	/** Root the graph on an explicit symbol and pin it — the hover card's jump: the
	 *  cursor-follow must not immediately clobber the symbol the card named. */
	pinRoot(sym: RelationRoot): void {
		this.pinned = true;
		this.paintControls();
		this.setRoot(sym);
	}

	/* ---------- Root and direction ---------- */

	/** Swap the root (or clear it, `note` explaining why) and refetch its ring; the
	 *  direction survives, every expansion below the root does not. */
	setRoot(root: RelationRoot | null, note?: string): void {
		const same =
			this.root !== null && root !== null && this.root.name === root.name && this.root.path === root.path && this.root.line === root.line;
		if (same && !note) return;
		this.root = root ? { kind: root.kind, name: root.name, path: root.path, line: root.line } : null;
		this.rootNote = note;
		void this.loadRoot();
	}

	/** Flip the graph's direction and refetch: the other direction is a different graph. */
	private setDirection(direction: RelationDirection): void {
		if (this.direction === direction) return;
		this.direction = direction;
		void this.loadRoot();
	}

	private async loadRoot(): Promise<void> {
		const generation = ++this.generation;
		const root = this.root;
		this.hideDecl();
		this.nodes.clear();
		this.crossEdges.length = 0;
		this.crossSeen.clear();
		this.rootFailed = false;
		this.rootLoading = root !== null;
		this.paintControls();
		if (root) {
			const node = fromRelation(
				{ ...root, container: null, edgePath: root.path, edgeLine: root.line, edgeKind: '', edgeCount: 1, hasChildren: true },
				null
			);
			this.nodes.set(node.key, node);
			this.rootKey = node.key;
		}
		this.render();
		if (!root) return;
		try {
			const answer = await symbolRelationChildren(root.name, root.path, root.line, this.direction);
			if (generation !== this.generation) return;
			const node = this.nodes.get(this.rootKey);
			if (node) {
				node.hasChildren = (answer?.nodes.length ?? 0) > 0;
				node.truncated = answer?.truncated === true;
				if (node.hasChildren) {
					node.expanded = true;
					node.loaded = true;
					this.absorbRing(node, answer?.nodes ?? []);
				}
			}
		} catch {
			if (generation !== this.generation) return;
			this.rootFailed = true;
		}
		this.rootLoading = false;
		this.render();
		this.fit();
	}

	/** Absorb one ring answer into the graph: new symbols become the node's children, a
	 *  symbol already drawn becomes a cross edge (the arrow without the second card). */
	private absorbRing(node: GraphNode, ring: RelationNode[]): void {
		node.children = [];
		for (const entry of ring) {
			const key = nodeKey(entry.name, entry.path, entry.line);
			if (this.nodes.has(key)) {
				const from = this.direction === 'refsTo' ? key : node.key;
				const to = this.direction === 'refsTo' ? node.key : key;
				const seen = `${from}\u0000${to}`;
				if (!this.crossSeen.has(seen)) {
					this.crossSeen.add(seen);
					this.crossEdges.push({ from, to, kind: entry.edgeKind || 'member', count: entry.edgeCount });
				}
				continue;
			}
			const child = fromRelation(entry, node.key);
			this.nodes.set(child.key, child);
			node.children.push(child.key);
		}
		if (node.loaded && node.children.length === 0) node.hasChildren = false;
	}

	private togglePin(): void {
		this.pinned = !this.pinned;
		this.paintControls();
		this.onPinChange?.(this.pinned);
	}

	isPinned(): boolean {
		return this.pinned;
	}

	private paintControls(): void {
		this.dirTo.textContent = t('relations.refsTo');
		this.dirTo.classList.toggle('active', this.direction === 'refsTo');
		this.dirTo.setAttribute('aria-pressed', this.direction === 'refsTo' ? 'true' : 'false');
		this.dirFrom.textContent = t('relations.refsFrom');
		this.dirFrom.classList.toggle('active', this.direction === 'refsFrom');
		this.dirFrom.setAttribute('aria-pressed', this.direction === 'refsFrom' ? 'true' : 'false');
		this.dirContains.textContent = t('relations.contains');
		this.dirContains.classList.toggle('active', this.direction === 'contains');
		this.dirContains.setAttribute('aria-pressed', this.direction === 'contains' ? 'true' : 'false');
		this.pinButton.title = this.pinned ? t('relations.unpin') : t('relations.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.textContent = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.pinButton.classList.toggle('active', this.pinned);
	}

	/* ---------- Expansion ---------- */

	private async toggleExpand(key: string): Promise<void> {
		const node = this.nodes.get(key);
		if (!node || node.loading) return;
		if (node.expanded) {
			node.expanded = false;
			this.render();
			return;
		}
		node.expanded = true;
		if (node.loaded) {
			this.render();
			return;
		}
		if (this.depthOf(key) >= MAX_DEPTH) {
			// At the cap the marker stays and the ⋯ answers — the rings exist, the graph
			// just stops drawing them (re-rooting on the node goes deeper instead).
			node.loaded = true;
			node.truncated = true;
			node.expanded = false;
			this.render();
			return;
		}
		node.loading = true;
		const generation = this.generation;
		try {
			const answer = await symbolRelationChildren(node.name, node.path, node.line, this.direction);
			node.loading = false;
			if (generation !== this.generation) return;
			node.loaded = true;
			node.truncated = answer?.truncated === true;
			this.absorbRing(node, answer?.nodes ?? []);
		} catch {
			node.loading = false;
			if (generation !== this.generation) return;
			node.loaded = true;
			node.truncated = false;
		}
		this.render();
	}

	/** The node's depth over the tree's parent chain. */
	private depthOf(key: string): number {
		let depth = 0;
		let at = this.nodes.get(key);
		while (at && at.parentKey !== null) {
			depth++;
			at = this.nodes.get(at.parentKey);
		}
		return depth;
	}

	/* ---------- Rendering ---------- */

	/** Rebuild the flowchart over the current nodes: ELK lays the whole source again —
	 *  the auto-arrange by construction. The hint floats over the empty states. */
	private render(): void {
		this.hint.textContent = '';
		this.hint.hidden = true;
		if (!this.root) {
			this.hint.appendChild(el('span', undefined, [this.rootNote ?? t('symbols.graph.hint')]));
			this.hint.hidden = false;
			this.draw(null);
			return;
		}
		if (this.rootLoading) {
			this.hint.append(icon('sync', 'codicon-modifier-spin'), el('span', undefined, [t('relations.loading')]));
			this.hint.hidden = false;
			this.draw(null);
			return;
		}
		if (this.rootFailed) {
			this.hint.appendChild(el('span', undefined, [t('relations.failed')]));
			this.hint.hidden = false;
			this.draw(null);
			return;
		}
		this.draw(this.buildPayload());
	}

	/** The flowchart payload over the visible (expanded) shapes — the walk from the root
	 *  through expanded children only, so a collapsed subtree's cards leave the drawing
	 *  with it. The drawn order is the walk's: the root first, then every ring in turn —
	 *  mermaid's N-ids and the payload's paths line up by construction. */
	private buildPayload(): ModuleDiagram {
		const list: GraphNode[] = [];
		const collect = (key: string): void => {
			const node = this.nodes.get(key);
			if (!node) return;
			list.push(node);
			if (node.expanded) for (const child of node.children) collect(child);
		};
		collect(this.rootKey);
		const edges = this.visibleEdgeList();
		const index = new Map(list.map((node, at) => [node.key, at]));
		return {
			nodes: list.map((node) => ({ path: node.key, label: relationLabel(node), module: null, tone: 0, callsIn: 0, callsOut: 0 })),
			edges: edges
				.filter((edge) => index.has(edge.from) && index.has(edge.to))
				.map((edge) => ({ id: `L_N${index.get(edge.from)}_N${index.get(edge.to)}`, from: edge.from, to: edge.to, calls: edge.count, dashed: edge.kind === 'use' })),
			droppedFiles: 0,
			droppedEdges: 0,
			mermaid: relationMermaid(list, edges, this.rootKey)
		};
	}

	/** Hand the payload to the drawing host — building it first when this is the first
	 *  draw (the dynamic import above); a state that landed while the host built draws
	 *  what stands, not what asked, and a superseded draw never paints (every setDiagram
	 *  clears the tree before its async render — a stale one would flash it empty). A
	 *  build that loses a dispose race stays silent — the dead view keeps nothing to
	 *  draw into. */
	private drawSeq = 0;

	private draw(payload: ModuleDiagram | null): void {
		const seq = ++this.drawSeq;
		if (this.diagram) {
			this.diagram.setDiagram(payload);
			return;
		}
		void this.ensureDiagram()
			.then((diagram) => {
				if (this.disposed || seq !== this.drawSeq) return;
				const settled = !this.root || this.rootLoading || this.rootFailed ? null : this.buildPayload();
				diagram.setDiagram(settled);
			})
			.catch(() => undefined);
	}

	private visibleEdgeList(): GraphEdge[] {
		const edges: GraphEdge[] = [];
		for (const node of this.nodes.values()) {
			if (!node.expanded) continue;
			for (const key of node.children) {
				const child = this.nodes.get(key);
				if (!child) continue;
				// refsTo's children point up at their parent; the other directions point down.
				const from = this.direction === 'refsTo' ? key : node.key;
				const to = this.direction === 'refsTo' ? node.key : key;
				edges.push({ from, to, kind: child.edgeKind, count: child.edgeCount });
			}
		}
		edges.push(...this.crossEdges);
		return edges;
	}

	/* ---------- The view over the drawing ---------- */

	/** Fit the whole drawing into the viewport — the Fit button's answer and a new root's
	 *  opening frame. */
	fit(): void {
		this.diagram?.fit(true);
	}

	/** The page re-gained a real viewport (the section re-showed, the sash moved): frame
	 *  the drawing unless the user had zoomed or panned by hand. */
	frame(): void {
		this.diagram?.onShown();
	}

	/* ---------- The declaration card ---------- */

	private scheduleDecl(node: GraphNode, x: number, y: number): void {
		if (this.declTimer !== null) clearTimeout(this.declTimer);
		this.declTarget = { node, generation: this.generation, x, y };
		this.declTimer = window.setTimeout(() => {
			this.declTimer = null;
			const target = this.declTarget;
			if (target) void this.showDecl(target.node, target.generation, target.x, target.y);
		}, DECL_DELAY);
	}

	private cancelDecl(): void {
		if (this.declTimer !== null) {
			clearTimeout(this.declTimer);
			this.declTimer = null;
		}
		this.declTarget = null;
	}

	/** Fetch (or reuse) the declaration fragment of one symbol: the index's definitions for
	 *  the name pick the node's own file first, then one with a body, then the first; the
	 *  file's lines from the declaration on fill the fragment, capped. The read opens the
	 *  path through the host's `resolvePath` (the backend's read_file wants absolute
	 *  paths, the index speaks repo-relative ones). A fetch that finds nothing answers
	 *  null and is not kept. */
	private declFragment(name: string, path: string): Promise<DeclFragment | null> {
		const key = `${name}|${path}`;
		const cached = this.declCache.get(key);
		if (cached) return cached;
		const fetch = (async (): Promise<DeclFragment | null> => {
			try {
				const defs = (await symbolLookup(name)) ?? [];
				const def = defs.find((d) => d.path === path) ?? defs.find((d) => (d.endLine ?? d.line) > d.line) ?? defs[0];
				if (!def) return null;
				const file = await readFile(this.resolvePath?.(def.path) ?? def.path);
				const contents = file?.contents;
				if (contents == null) return null;
				const lines = contents.split('\n');
				const last = Math.min(def.line + DECL_MAX_LINES, Math.max(def.endLine ?? def.line, def.line) + 1);
				let text = lines.slice(def.line, last).join('\n').slice(0, DECL_MAX_CHARS);
				if (text.length === 0) return null;
				if (text.length === DECL_MAX_CHARS) text += '…';
				return { kind: def.kind, path: def.path, line: def.line, text };
			} catch {
				return null;
			}
		})();
		this.declCache.set(key, fetch);
		void fetch.then((fragment) => {
			if (fragment === null) this.declCache.delete(key);
		});
		return fetch;
	}

	private async showDecl(node: GraphNode, generation: number, x: number, y: number): Promise<void> {
		const fragment = await this.declFragment(node.name, node.path);
		if (!fragment || generation !== this.generation) return;
		this.hideDecl();
		const card = el('div', 'rg-decl');
		const code = el('pre', 'rg-decl-code');
		code.innerHTML = escapeHtml(fragment.text);
		card.append(
			code,
			el('div', 'rg-decl-meta', [tf('relations.declAt', fragment.kind, baseName(fragment.path), fragment.line + 1)])
		);
		card.addEventListener('mouseleave', () => this.hideDecl());
		this.declCard = card;
		(document.getElementById('overlays') ?? document.body).appendChild(card);
		const rect = card.getBoundingClientRect();
		let left = x + 12;
		if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
		let top = y + 14;
		if (top + rect.height > window.innerHeight - 4) top = Math.max(4, y - rect.height - 8);
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
	}

	private hideDecl(): void {
		this.cancelDecl();
		this.declCard?.remove();
		this.declCard = null;
	}
}

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}
