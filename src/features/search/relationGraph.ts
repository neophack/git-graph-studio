// The Relation Graph (module 5) — the Symbol Window's lower half: the symbol under the
// cursor as an interactive box-and-arrow graph over the same `symbol_relation_children`
// engine the Relations panel's tree drives. Every ring the
// tree can drill the graph draws: nodes are the symbols, edges the reference sites with
// their arrowheads pointing at the referenced side (the ×N badge and the call/use/member
// kinds ride along), the direction buttons swap refs to / refs from / contains, and a node
// whose ring the index promises grows the same lazy + the tree rows carry. The pointer
// works the canvas: dragging a box moves it (its edges follow), dragging the background
// pans, the wheel zooms about the cursor, one click opens the definition, a double click
// re-roots the graph on that symbol, and resting floats the declaration card the panel
// floats. The layout is a tidy top-down tree recomputed over the visible (expanded)
// shapes; a dragged box's offset survives every re-layout, so an expansion never throws
// the arrangement away, and only a new root or the Fit button recenters.

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup, symbolRelationChildren, type RelationDirection, type RelationNode } from '../../platform/ipc/symbols';

import { t, tf } from '../../platform/i18n';
import { KIND_ICONS } from './contextView';
import { el, escapeHtml, icon } from '../../platform/ui/index';

import './relationGraph.css';

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

/** The box's fixed geometry — the layout's slots, the edges' anchors and the svg's bounds
 *  are all counted in these, and `.rg-node`'s own width/height copy them. */
const NODE_W = 148;
const NODE_H = 24;

/** One depth level's vertical span. */
const LEVEL_H = 62;

/** The horizontal gap between neighbouring leaf slots. */
const GAP_X = 14;

/** The world's empty border: the svg's bounds and the Fit's math both carry it. */
const PAD = 28;

/** The pointer's travel before a press becomes a drag — and its click dies. */
const DRAG_T = 4;

/** The zoom clamp, about the cursor. */
const SCALE_MIN = 0.3;
const SCALE_MAX = 2.5;
const ZOOM_STEP = 1.15;

/** How deep the graph may drill before a node's + answers the cap instead — the runaway
 *  guard for a hot name whose rings never end (the panel tree's is 8; the canvas fills
 *  faster than a list). */
const MAX_DEPTH = 3;

/** The pointer's rest before the declaration card floats in — the panel tree's timing. */
const DECL_DELAY = 300;

/** One graph node: a symbol box and its ring's bookkeeping. The visible structure is a
 *  strict tree — a ring answer naming a symbol already drawn adds a cross edge instead of
 *  a second box, so the layout recursion never meets a cycle. */
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
	 *  arrow's kind and the ×N badge (the root carries the neutral defaults). */
	edgeKind: string;
	edgeCount: number;
	hasChildren: boolean;
	expanded: boolean;
	loaded: boolean;
	loading: boolean;
	/** The node's own ring came back cut short — the faint note under the box keeps saying so. */
	truncated: boolean;
	/** The user's drag offset in world coordinates, kept across every re-layout. */
	dx: number;
	dy: number;
	elt: HTMLElement | null;
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

/** A settled layout position in world coordinates — the box's top-left corner. */
interface LayoutPoint {
	x: number;
	y: number;
}

/** The graph's world bounds, the svg's viewBox and the Fit's input. */
interface Bounds {
	minX: number;
	minY: number;
	width: number;
	height: number;
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
		truncated: false,
		dx: 0,
		dy: 0,
		elt: null
	};
}

/** The visible (expanded) tree's tidy top-down layout: leaves take sequential slots,
 *  parents centre over their children's span, and a final per-depth sweep pushes any
 *  overlap right (a wide child subtree can shove its parent's centre into the neighbour's
 *  — the edges follow, nothing else moves). Strictly over the expanded shapes: a collapsed
 *  node occupies its own slot and its subtree none. */
export function computeLayout(nodes: Map<string, GraphNode>, rootKey: string): Map<string, LayoutPoint> {
	const positions = new Map<string, LayoutPoint>();
	let cursor = 0;
	const place = (key: string, depth: number): { min: number; max: number } => {
		const node = nodes.get(key);
		if (!node) return { min: cursor, max: cursor };
		const kids = node.expanded ? node.children : [];
		if (kids.length === 0) {
			const x = cursor;
			cursor += NODE_W + GAP_X;
			positions.set(key, { x, y: depth * LEVEL_H });
			return { min: x, max: x };
		}
		let min = Infinity;
		let max = -Infinity;
		for (const kid of kids) {
			const span = place(kid, depth + 1);
			min = Math.min(min, span.min);
			max = Math.max(max, span.max);
		}
		const x = (min + max) / 2;
		positions.set(key, { x, y: depth * LEVEL_H });
		return { min: Math.min(min, x), max: Math.max(max, x) };
	};
	place(rootKey, 0);
	// Pre-order DFS meets every depth left-to-right, so one "last right edge per depth"
	// table is the whole sweep.
	const lastRight = new Map<number, number>();
	const fix = (key: string, depth: number): void => {
		const point = positions.get(key);
		if (!point) return;
		const prev = lastRight.get(depth) ?? -Infinity;
		if (point.x < prev) point.x = prev;
		lastRight.set(depth, point.x + NODE_W + GAP_X);
		const node = nodes.get(key);
		if (node?.expanded) for (const kid of node.children) fix(kid, depth + 1);
	};
	fix(rootKey, 0);
	return positions;
}

function boundsOf(positions: Map<string, LayoutPoint>): Bounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const point of positions.values()) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x + NODE_W);
		maxY = Math.max(maxY, point.y + NODE_H);
	}
	if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 0, height: 0 };
	return { minX: minX - PAD, minY: minY - PAD, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
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
	/** The canvas: the pan/zoom viewport holding the edge svg and the node boxes. */
	readonly element: HTMLElement;

	/** The direction buttons, the pin and the Fit — the Symbol Window's section head hosts
	 *  them beside its own label, so the graph costs one row of the sidebar. */
	readonly controls: HTMLElement;

	/** A definition click (one click on a box) — the line arrives 1-based. */
	onOpen?: (path: string, line: number) => void;

	/** The pin's toggle — the host re-feeds the cursor's symbol when the pin lifts. */
	onPinChange?: (pinned: boolean) => void;

	private root: RelationRoot | null = null;

	private direction: RelationDirection = 'refsTo';

	private readonly nodes = new Map<string, GraphNode>();

	private rootKey = '';

	/** Rings that named an already-drawn symbol: the arrow without the second box. */
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

	/** The settled layout (before the drag offsets), the world bounds, and the view. */
	private positions = new Map<string, LayoutPoint>();

	private bounds: Bounds = { minX: 0, minY: 0, width: 0, height: 0 };

	private scale = 1;

	private panX = 0;

	private panY = 0;

	/** The viewport element (the canvas) — drag/pan/wheel land here. */
	private readonly viewport: HTMLElement;

	private readonly world: HTMLElement;

	private readonly svg: SVGSVGElement;

	private readonly dirTo: HTMLButtonElement;

	private readonly dirFrom: HTMLButtonElement;

	private readonly dirContains: HTMLButtonElement;

	private readonly pinButton: HTMLButtonElement;

	/* ---------- The drag/pan bookkeeping ---------- */

	/** The box drag in flight — its window listeners end it; `moved` kills the click. */
	private drag: { node: GraphNode; startX: number; startY: number; baseDx: number; baseDy: number; moved: boolean } | null = null;

	/** The background pan in flight. */
	private panning: { startX: number; startY: number; baseX: number; baseY: number } | null = null;

	/** Set when a pointer settled as a drag — the click that follows pointerup must die. */
	private clickSuppressed = false;

	/* ---------- The declaration card ---------- */

	private readonly declCache = new Map<string, Promise<DeclFragment | null>>();

	private declTimer: number | null = null;

	private declCard: HTMLElement | null = null;

	private readonly onDocMouseDown = (event: MouseEvent): void => {
		if (this.declCard && !this.declCard.contains(event.target as Node)) this.hideDecl();
	};

	private readonly onDocKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape' && this.declCard) this.hideDecl();
	};

	constructor() {
		this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.svg.classList.add('rg-edges');
		this.world = el('div', 'rg-world');
		this.world.appendChild(this.svg);
		this.viewport = el('div', 'rg-view', [this.world]);
		this.element = el('div', 'rg-root', [this.viewport]);
		this.viewport.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.viewport.addEventListener('pointerdown', (event) => this.onViewportPointerDown(event));

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

	/** The host's dispose: the document-level dismissers must not outlive the view. */
	dispose(): void {
		this.hideDecl();
		this.endPointer();
		document.removeEventListener('mousedown', this.onDocMouseDown);
		document.removeEventListener('keydown', this.onDocKeyDown);
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
	 *  direction survives, every expansion and drag offset below the root does not. */
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
	 *  symbol already drawn becomes a cross edge (the arrow without the second box). */
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
			// At the cap the + stays and the faint cut note answers — the rings exist, the
			// canvas just stops drawing them (re-rooting on the node goes deeper instead).
			node.loaded = true;
			node.truncated = true;
			node.expanded = false;
			this.render();
			return;
		}
		node.loading = true;
		this.paintNode(node);
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

	private render(): void {
		this.world.textContent = '';
		this.world.appendChild(this.svg);
		if (!this.root) {
			this.svg.setAttribute('width', '0');
			this.svg.setAttribute('height', '0');
			this.world.appendChild(el('div', 'rg-hint', [this.rootNote ?? t('symbols.graph.hint')]));
			return;
		}
		if (this.rootLoading) {
			this.world.appendChild(el('div', 'rg-hint', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.rootFailed) {
			this.world.appendChild(el('div', 'rg-hint', [t('relations.failed')]));
			return;
		}
		this.positions = computeLayout(this.nodes, this.rootKey);
		this.bounds = boundsOf(this.positions);
		this.svg.setAttribute('width', String(this.bounds.width));
		this.svg.setAttribute('height', String(this.bounds.height));
		this.svg.setAttribute('viewBox', `${this.bounds.minX} ${this.bounds.minY} ${this.bounds.width} ${this.bounds.height}`);
		this.svg.style.left = `${this.bounds.minX}px`;
		this.svg.style.top = `${this.bounds.minY}px`;
		this.paintEdges();
		for (const node of this.nodes.values()) this.world.appendChild(this.buildNode(node));
		this.paintPositions();
		this.applyTransform();
	}

	/** The light repaint a drag asks for: every box and edge moves, nothing rebuilds. */
	private paintPositions(): void {
		for (const node of this.nodes.values()) {
			const point = this.positions.get(node.key);
			if (!point || !node.elt) continue;
			node.elt.style.left = `${point.x + node.dx - this.bounds.minX}px`;
			node.elt.style.top = `${point.y + node.dy - this.bounds.minY}px`;
		}
		this.paintEdges();
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

	private paintEdges(): void {
		this.svg.textContent = '';
		if (this.positions.size === 0) return;
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		for (const kind of ['call', 'use', 'member'] as const) {
			const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
			marker.setAttribute('id', `rg-arrow-${kind}`);
			marker.setAttribute('viewBox', '0 0 10 10');
			marker.setAttribute('refX', '9');
			marker.setAttribute('refY', '5');
			marker.setAttribute('markerWidth', '7');
			marker.setAttribute('markerHeight', '7');
			marker.setAttribute('markerUnits', 'userSpaceOnUse');
			marker.setAttribute('orient', 'auto-start-reverse');
			const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
			head.setAttribute('class', `rg-arrow rg-arrow-${kind}`);
			marker.appendChild(head);
			defs.appendChild(marker);
		}
		this.svg.appendChild(defs);
		for (const edge of this.visibleEdgeList()) {
			const from = this.nodeAnchor(edge.from, true);
			const to = this.nodeAnchor(edge.to, false);
			if (!from || !to) continue;
			// The straight hop between the facing sides: the head lands on the referenced box.
			const downward = to.y > from.y;
			const x1 = from.x + NODE_W / 2;
			const y1 = downward ? from.y + NODE_H : from.y;
			const x2 = to.x + NODE_W / 2;
			const y2 = downward ? to.y : to.y + NODE_H;
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
			path.setAttribute('class', `rg-edge rg-${edge.kind === 'member' ? 'member' : edge.kind === 'call' ? 'call' : 'use'}`);
			if (edge.kind !== 'member' && edge.count > 1) path.setAttribute('data-count', String(edge.count));
			path.setAttribute('marker-end', `url(#rg-arrow-${edge.kind === 'member' ? 'member' : edge.kind === 'call' ? 'call' : 'use'})`);
			const label = edge.count > 1 ? `×${edge.count}` : '';
			if (label) {
				path.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title')).textContent = label;
			}
			this.svg.appendChild(path);
		}
	}

	/** A node's anchor side: `bottom` true hands the bottom-centre, false the top-centre —
	 *  in world coordinates, the drag offset included. */
	private nodeAnchor(key: string, bottom: boolean): { x: number; y: number } | null {
		const node = this.nodes.get(key);
		const point = this.positions.get(key);
		if (!node || !point) return null;
		const x = point.x + node.dx;
		const y = point.y + node.dy;
		return { x, y: bottom ? y + NODE_H : y };
	}

	private buildNode(node: GraphNode): HTMLElement {
		const badge = node.hasChildren ? el('button', 'rg-badge') : el('span', 'rg-badge rg-leaf');
		if (node.hasChildren) badge.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.toggleExpand(node.key);
		});
		const box = el('div', node.parentKey === null ? 'rg-node rg-root-node' : 'rg-node', [
			badge,
			icon(KIND_ICONS[node.kind] ?? 'symbol-variable'),
			node.container ? el('span', 'rg-container', [`${node.container}·`]) : null,
			el('span', 'rg-label', [node.name])
		]);
		box.style.left = '0px';
		box.style.top = '0px';
		box.dataset['key'] = node.key;
		box.title = `${node.path}:${node.line + 1}`;
		box.addEventListener('click', () => {
			if (this.clickSuppressed) {
				this.clickSuppressed = false;
				return;
			}
			this.onOpen?.(node.path, node.line + 1);
		});
		box.addEventListener('dblclick', (event) => {
			event.stopPropagation();
			this.setRoot({ kind: node.kind, name: node.name, path: node.path, line: node.line });
		});
		box.addEventListener('pointerdown', (event) => this.beginNodeDrag(event, node));
		this.wireDeclHover(box, node);
		node.elt = box;
		this.paintNode(node);
		if (node.truncated) {
			const cut = el('div', 'rg-cut', [t('symbols.graph.cut')]);
			const point = this.positions.get(node.key);
			if (point) {
				cut.style.left = `${point.x + node.dx - this.bounds.minX}px`;
				cut.style.top = `${point.y + node.dy + NODE_H + 2 - this.bounds.minY}px`;
			}
			this.world.appendChild(cut);
		}
		return box;
	}

	private paintNode(node: GraphNode): void {
		if (!node.elt) return;
		const badge = node.elt.querySelector<HTMLButtonElement>('.rg-badge');
		if (!badge || badge.classList.contains('rg-leaf')) return;
		badge.classList.toggle('loading', node.loading);
		badge.textContent = '';
		if (node.loading) badge.appendChild(icon('sync', 'codicon-modifier-spin'));
		else badge.textContent = node.expanded ? '−' : '+';
	}

	/* ---------- Pan, zoom, drag ---------- */

	private applyTransform(): void {
		this.world.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
	}

	/** Fit the world's bounds into the viewport, centred — a new root's opening frame,
	 *  the Fit button's answer, and the host's re-frame when the section re-shows. A
	 *  viewport with no layout yet (a hidden page) keeps the identity transform. */
	fit(): void {
		const width = this.viewport.clientWidth;
		const height = this.viewport.clientHeight;
		if (width === 0 || height === 0 || this.bounds.width === 0) return;
		const scale = Math.min(Math.min(width / this.bounds.width, height / this.bounds.height), 1);
		this.scale = Math.max(scale, SCALE_MIN);
		this.panX = (width - this.bounds.width * this.scale) / 2;
		this.panY = (height - this.bounds.height * this.scale) / 2;
		this.applyTransform();
	}

	private onWheel(event: WheelEvent): void {
		event.preventDefault();
		this.zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
	}

	private zoomAt(clientX: number, clientY: number, factor: number): void {
		const rect = this.viewport.getBoundingClientRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, this.scale * factor));
		if (next === this.scale) return;
		// The world point under the cursor stays under it: pan' = p − (p − pan)·s′/s.
		this.panX = px - ((px - this.panX) * next) / this.scale;
		this.panY = py - ((py - this.panY) * next) / this.scale;
		this.scale = next;
		this.applyTransform();
	}

	private onViewportPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement | null)?.closest('.rg-node')) return;
		this.hideDecl();
		this.endPointer();
		this.panning = { startX: event.clientX, startY: event.clientY, baseX: this.panX, baseY: this.panY };
		const move = (e: PointerEvent): void => {
			if (!this.panning) return;
			this.panX = this.panning.baseX + (e.clientX - this.panning.startX);
			this.panY = this.panning.baseY + (e.clientY - this.panning.startY);
			this.applyTransform();
		};
		const up = (): void => {
			this.panning = null;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	private beginNodeDrag(event: PointerEvent, node: GraphNode): void {
		if (event.button !== 0) return;
		event.stopPropagation();
		this.hideDecl();
		this.clickSuppressed = false;
		this.endPointer();
		this.drag = { node, startX: event.clientX, startY: event.clientY, baseDx: node.dx, baseDy: node.dy, moved: false };
		const move = (e: PointerEvent): void => {
			const drag = this.drag;
			if (!drag) return;
			const dx = e.clientX - drag.startX;
			const dy = e.clientY - drag.startY;
			if (!drag.moved && Math.hypot(dx, dy) < DRAG_T) return;
			drag.moved = true;
			drag.node.dx = drag.baseDx + dx / this.scale;
			drag.node.dy = drag.baseDy + dy / this.scale;
			this.paintPositions();
		};
		const up = (): void => {
			if (this.drag?.moved) this.clickSuppressed = true;
			this.drag = null;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	/** Retire any pointer's window listeners (a drag or a pan whose up never came — the
	 *  view's dispose path included). */
	private endPointer(): void {
		this.drag = null;
		this.panning = null;
	}

	/* ---------- The declaration card ---------- */

	private wireDeclHover(surface: HTMLElement, node: GraphNode): void {
		surface.addEventListener('mouseenter', (event) => {
			const generation = this.generation;
			if (this.declTimer !== null) clearTimeout(this.declTimer);
			this.declTimer = window.setTimeout(() => {
				this.declTimer = null;
				void this.showDecl(node, generation, event.clientX, event.clientY);
			}, DECL_DELAY);
		});
		surface.addEventListener('mouseleave', (event) => {
			if (this.declTimer !== null) {
				clearTimeout(this.declTimer);
				this.declTimer = null;
			}
			if (this.declCard && event.relatedTarget instanceof Node && this.declCard.contains(event.relatedTarget)) return;
			this.hideDecl();
		});
	}

	/** Fetch (or reuse) the declaration fragment of one symbol: the index's definitions for
	 *  the name pick the node's own file first, then one with a body, then the first; the
	 *  file's lines from the declaration on fill the fragment, capped. A fetch that finds
	 *  nothing answers null and is not kept. */
	private declFragment(name: string, path: string): Promise<DeclFragment | null> {
		const key = `${name}|${path}`;
		const cached = this.declCache.get(key);
		if (cached) return cached;
		const fetch = (async (): Promise<DeclFragment | null> => {
			try {
				const defs = (await symbolLookup(name)) ?? [];
				const def = defs.find((d) => d.path === path) ?? defs.find((d) => (d.endLine ?? d.line) > d.line) ?? defs[0];
				if (!def) return null;
				const file = await readFile(def.path);
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
		if (this.declTimer !== null) {
			clearTimeout(this.declTimer);
			this.declTimer = null;
		}
		this.declCard?.remove();
		this.declCard = null;
	}
}

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}
