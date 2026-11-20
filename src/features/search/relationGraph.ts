// The Relation Graph (module 5) — the Symbol Window's lower half: the symbol under the
// cursor's ring on an interactive graph, drawn on **@antv/G6** (AntV's graph engine —
// the established drawing library behind this class of diagram tool, per the owner's
// direction: 不要自己写，要使用库，比如Drawnix). The engine is driven incrementally:
// a ring's expansion `addNodeData`s its cards below the expanded one and a collapse
// `removeNodeData`s them — every other card keeps its exact slot and the camera never
// moves (点击加号减号要添加减少节点，不要重新刷图). The layout is Source Insight's
// relation window's stable tree: slots grow rightward/downward from the root and a
// placed card never relocates. The cards speak the SI vocabulary: a card whose label
// carries the +/− — the ring's expander — drills on one click (deferred, so a double
// click's first press never expands), a card without a ring — and the double click on
// any card — opens the definition, a right-click menu drills, re-roots or opens, and
// resting floats the declaration card. The engine's own viewport handles the wheel
// zoom, the drag pan and Fit (`fitView`). The direction buttons swap refs to / refs
// from / contains; an aggregating edge carries its ×N in its label; a ring cut short
// (or a card at the 3-depth cap) carries the ⋯. G6 loads lazily on the first drawing
// (a chunk the sidebar's first paint never pays for).

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup, symbolRelationChildren, type RelationDirection, type RelationNode } from '../../platform/ipc/symbols';

import { t, tf } from '../../platform/i18n';
import { el, escapeHtml, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

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

/** The card's fixed geometry — the layout's slots, the edges' anchors and the world
 *  bounds are all counted in these. */
const NODE_W = 160;
const NODE_H = 28;

/** One depth level's vertical span. */
const LEVEL_H = 76;

/** The horizontal gap between neighbouring slots of one depth. */
const GAP_X = 18;


/** How deep the graph may drill before a card's ring answers the cap instead — the
 *  runaway guard for a hot name whose rings never end (the panel tree's is 8). */
const MAX_DEPTH = 3;

/** The pointer's rest before the declaration card floats in — the panel tree's timing. */
const DECL_DELAY = 300;

/** A drillable card's click waits this long before it drills, so the double click's
 *  first press never expands the ring on its way to the jump (SI's expander reads
 *  instantly; here the whole card is the expander, and the delay is the merge's cost). */
const CLICK_DRILL_DELAY = 220;

/** One graph node: a symbol card and its ring's bookkeeping. The drawn structure is a
 *  strict tree — a ring answer naming a symbol already drawn adds a cross edge instead of
 *  a second card. A collapsed card's descendants stay in the map (their rings come back
 *  without a re-fetch) and simply lose their slots. */
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

/** A settled slot in world coordinates — the card's top-left corner. Slots are permanent:
 *  a placed card never moves (the stable tree). */
interface LayoutPoint {
	x: number;
	y: number;
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

/** One card's label: the drill marker the ring's state carries (+ / −), the container
 *  prefix, the name, and the ⋯ a cut-short ring appends. */
function relationLabel(node: GraphNode): string {
	const marker = node.hasChildren ? (node.expanded ? '− ' : '+ ') : '';
	return `${marker}${node.container ? `${node.container}·` : ''}${node.name}${node.truncated ? ' ⋯' : ''}`;
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
	/** The canvas: the G6 container (the engine's own viewport — wheel zoom, drag pan,
	 *  Fit and its scrollbars live inside it). */
	readonly element: HTMLElement;

	/** The direction buttons, the pin and the Fit — the Symbol Window's section head hosts
	 *  them beside its own label, so the graph costs one row of the sidebar. */
	readonly controls: HTMLElement;

	/** A definition jump — the line arrives 1-based. */
	onOpen?: (path: string, line: number) => void;

	/** The pin's toggle — the host re-feeds the cursor's symbol when the pin lifts. */
	onPinChange?: (pinned: boolean) => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  the declaration card's file read opens the absolute spelling the backend needs.
	 *  Unwired, the path passes through as-is. */
	resolvePath?: (path: string) => string;

	private readonly stage: HTMLElement;

	/** The resting/loading/failed note, floating over the engine's canvas. */
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

	/** The stable slots: placed cards never move — an expansion only appends slots. */
	private readonly positions = new Map<string, LayoutPoint>();

	/** The next free slot's x per depth — the layout's allocation frontier. */
	private readonly depthCursor = new Map<number, number>();

	private readonly dirTo: HTMLButtonElement;

	private readonly dirFrom: HTMLButtonElement;

	private readonly dirContains: HTMLButtonElement;

	private readonly pinButton: HTMLButtonElement;

	private disposed = false;

	/** The engine instance and its lazy construction — the G6 chunk loads on the first
	 *  drawing, and every draw that lost a supersede race stays unpainted (each engine
	 *  data operation repaints incrementally; a stale one would fight the newer state). */
	private graph: import('@antv/g6').Graph | null = null;

	private graphReady: Promise<import('@antv/g6').Graph> | null = null;

	/** The engine draw in flight — the initial fit waits for it. */
	private drawn: Promise<void> = Promise.resolve();

	/** The labels painted on the engine's current cards — the update pass only rewrites
	 *  the ones whose ring state moved (+ / − / ⋯). */
	private readonly paintedLabels = new Map<string, string>();

	constructor() {
		this.stage = el('div', 'rg-stage');
		this.hint = el('div', 'rg-hint rg-hint-overlay');
		this.element = el('div', 'rg-root', [this.stage, this.hint]);

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
		this.disposed = true;
		this.hideDecl();
		this.cancelClickDrill();
		document.removeEventListener('mousedown', this.onDocMouseDown);
		document.removeEventListener('keydown', this.onDocKeyDown);
		this.graph?.destroy();
		this.graph = null;
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
		this.cancelClickDrill();
		this.nodes.clear();
		this.positions.clear();
		this.depthCursor.clear();
		this.crossEdges.length = 0;
		this.crossSeen.clear();
		this.paintedLabels.clear();
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
			this.place(node, 0);
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
					this.revealChildren(node);
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

	/* ---------- The stable tree layout ---------- */

	/** Give a card its permanent slot: the next free x at its depth — or, when the band
	 *  below its parent is still free, right under the parent (the ring grows where the
	 *  eye already is). Placed cards never move again. */
	private place(node: GraphNode, depth: number): void {
		const parent = node.parentKey !== null ? this.positions.get(node.parentKey) : undefined;
		const x = node.parentKey === null ? 0 : Math.max(this.depthCursor.get(depth) ?? 0, parent?.x ?? 0);
		this.positions.set(node.key, { x, y: depth * LEVEL_H });
		this.depthCursor.set(depth, x + NODE_W + GAP_X);
	}

	/** The visible walk: the root, then every expanded card's children in turn — a
	 *  collapsed card's descendants stay in the map but leave the drawing. */
	private visibleNodes(): GraphNode[] {
		const list: GraphNode[] = [];
		const collect = (key: string): void => {
			const node = this.nodes.get(key);
			if (!node) return;
			list.push(node);
			if (node.expanded) for (const child of node.children) collect(child);
		};
		collect(this.rootKey);
		return list;
	}

	/* ---------- Expansion ---------- */

	private async toggleExpand(key: string): Promise<void> {
		const node = this.nodes.get(key);
		if (!node || node.loading) return;
		if (node.expanded) {
			// The collapse removes the card's whole visible subtree — slots and cards —
			// and nothing else moves.
			for (const descendant of this.visibleSubtree(key)) {
				if (descendant !== node) this.positions.delete(descendant.key);
			}
			node.expanded = false;
			this.render();
			return;
		}
		node.expanded = true;
		if (node.loaded) {
			this.revealChildren(node);
			this.render();
			return;
		}
		if (this.depthOf(key) >= MAX_DEPTH) {
			// At the cap the marker stays and the ⋯ answers — the rings exist, the graph
			// just stops drawing them (re-rooting on the card goes deeper instead).
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
		this.revealChildren(node);
		this.render();
	}

	/** The re-expansion of a cached ring: its cards re-enter at fresh slots (their old
	 *  ones may have been taken), still without moving anything already placed. */
	private revealChildren(node: GraphNode): void {
		const depth = this.depthOf(node.key) + 1;
		for (const key of node.children) {
			const child = this.nodes.get(key);
			if (child && !this.positions.has(key)) this.place(child, depth);
		}
	}

	/** A card's visible subtree: itself plus every drawn descendant. */
	private visibleSubtree(key: string): GraphNode[] {
		const list: GraphNode[] = [];
		const collect = (at: string): void => {
			const node = this.nodes.get(at);
			if (!node) return;
			list.push(node);
			if (node.expanded) for (const child of node.children) collect(child);
		};
		collect(key);
		return list;
	}

	/** The card's depth over the tree's parent chain. */
	private depthOf(key: string): number {
		let depth = 0;
		let at = this.nodes.get(key);
		while (at && at.parentKey !== null) {
			depth++;
			at = this.nodes.get(at.parentKey);
		}
		return depth;
	}

	/* ---------- Rendering (the engine's incremental data operations) ---------- */

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

	/** Repaint the drawing through the engine's data operations: the target card/edge
	 *  lists diff against what the engine holds, so an expansion only **adds** its ring's
	 *  cards and a collapse only **removes** its subtree — every other card keeps its
	 *  slot and the camera stays (the stable tree). The empty states (hint branches)
	 *  clear the engine outright. */
	private render(): void {
		this.hint.textContent = '';
		this.hint.hidden = true;
		if (!this.root) {
			this.hint.appendChild(el('span', undefined, [this.rootNote ?? t('symbols.graph.hint')]));
			this.hint.hidden = false;
			this.clearEngine();
			return;
		}
		if (this.rootLoading) {
			this.hint.append(icon('sync', 'codicon-modifier-spin'), el('span', undefined, [t('relations.loading')]));
			this.hint.hidden = false;
			this.clearEngine();
			return;
		}
		if (this.rootFailed) {
			this.hint.appendChild(el('span', undefined, [t('relations.failed')]));
			this.hint.hidden = false;
			this.clearEngine();
			return;
		}
		this.draw(this.buildScene());
	}

	private buildScene(): { nodes: { id: string; label: string; x: number; y: number; root: boolean }[]; edges: { id: string; from: string; to: string; kind: string; count: number }[] } {
		const visible = this.visibleNodes();
		return {
			nodes: visible.map((node) => {
				const point = this.positions.get(node.key)!;
				return { id: node.key, label: relationLabel(node), x: point.x + NODE_W / 2, y: point.y + NODE_H / 2, root: node.parentKey === null };
			}),
			edges: this.visibleEdgeList().map((edge) => ({ id: `${edge.from}\u0000${edge.to}`, from: edge.from, to: edge.to, kind: edge.kind, count: edge.count }))
		};
	}

	private clearEngine(): void {
		this.paintedLabels.clear();
		if (!this.graph) return;
		this.graph.removeNodeData(this.graph.getNodeData().map((node) => String(node.id)));
		this.graph.removeEdgeData(this.graph.getEdgeData().map((edge) => String(edge.id)));
	}

	/** Hand the scene to the engine — building it first when this is the first draw (the
	 *  dynamic import); a state that landed while the engine built draws what stands, not
	 *  what asked. A draw that loses a supersede race or the dispose stays unpainted. */
	private drawSeq = 0;

	private draw(scene: { nodes: { id: string; label: string; x: number; y: number; root: boolean }[]; edges: { id: string; from: string; to: string; kind: string; count: number }[] }): void {
		const seq = ++this.drawSeq;
		if (this.graph) {
			this.applyScene(scene);
			return;
		}
		void this.ensureGraph()
			.then((graph) => {
				if (this.disposed || seq !== this.drawSeq) return;
				const settled = !this.root || this.rootLoading || this.rootFailed ? null : this.buildScene();
				if (settled) this.applyScene(settled);
			})
			.catch(() => undefined);
	}

	private async ensureGraph(): Promise<import('@antv/g6').Graph> {
		this.graphReady ??= (async () => {
			const { Graph } = await import('@antv/g6');
			if (this.disposed) throw new Error('the relation graph was disposed');
			const palette = themePalette();
			const graph = new Graph({
				container: this.stage,
				animation: false,
				data: { nodes: [], edges: [] },
				// The viewport affordances are the engine's own: wheel zoom, drag pan.
				behaviors: ['zoom-canvas', 'drag-canvas'],
				node: {
					type: 'rect',
					style: {
						size: [NODE_W, NODE_H],
						radius: 6,
						fill: palette.card,
						stroke: palette.cardStroke,
						lineWidth: 1,
						labelPlacement: 'center',
						labelFontSize: 11,
						labelFontFamily: uiFontFamily(),
						labelFill: palette.text,
						cursor: 'pointer'
					}
				},
				edge: {
					type: 'line',
					style: {
						stroke: palette.edge,
						lineWidth: 1.5,
						endArrow: true,
						endArrowSize: 8,
						labelFontSize: 10,
						labelFontFamily: uiFontFamily(),
						labelFill: palette.text,
						labelBackground: true,
						labelBackgroundFill: palette.card,
						labelBackgroundRadius: 3,
						labelPadding: [1, 3]
					}
				}
			});
			// The pointer's vocabulary (the state machine below owns the meanings).
			graph.on('node:click', (event: unknown) => this.onCardClick(this.cardKey(event)));
			graph.on('node:dblclick', (event: unknown) => {
				this.cancelClickDrill();
				const node = this.nodes.get(this.cardKey(event));
				if (node) this.onOpen?.(node.path, node.line + 1);
			});
			graph.on('node:contextmenu', (event: unknown) => {
				const client = (event as { client?: { x: number; y: number }; originalEvent?: MouseEvent }).client ??
					{ x: (event as { originalEvent?: MouseEvent }).originalEvent?.clientX ?? 0, y: (event as { originalEvent?: MouseEvent }).originalEvent?.clientY ?? 0 };
				(event as { originalEvent?: MouseEvent }).originalEvent?.preventDefault();
				this.showCardMenu(client.x, client.y, this.cardKey(event));
			});
			graph.on('node:pointerenter', (event: unknown) => {
				const node = this.nodes.get(this.cardKey(event));
				if (!node) return;
				const client = (event as { client?: { x: number; y: number } }).client ?? { x: 0, y: 0 };
				this.scheduleDecl(node, client.x, client.y);
			});
			graph.on('node:pointerleave', () => {
				if (this.declTimer !== null) {
					clearTimeout(this.declTimer);
					this.declTimer = null;
				}
			});
			this.graph = graph;
			await graph.render();
			return graph;
		})();
		return this.graphReady;
	}

	/** The clicked card's key off an engine event: the event's target is the card's data
	 *  (or its id, by engine version) — both carry the key. */
	private cardKey(event: unknown): string {
		const target = (event as { target?: unknown }).target;
		if (typeof target === 'string') return target;
		return (target as { id?: string })?.id ?? '';
	}

	/** The scene's diff onto the engine: new cards add, gone cards remove, a card whose
	 *  ring state moved (+ / − / ⋯) rewrites its label — and nothing else is touched, so
	 *  the camera and the kept cards stand exactly where they were. */
	private applyScene(scene: { nodes: { id: string; label: string; x: number; y: number; root: boolean }[]; edges: { id: string; from: string; to: string; kind: string; count: number }[] }): void {
		const graph = this.graph;
		if (!graph) return;
		const palette = themePalette();
		const kept = new Set(scene.nodes.map((node) => node.id));
		const goneNodes = graph.getNodeData().map((node) => String(node.id)).filter((id) => !kept.has(id));
		if (goneNodes.length > 0) graph.removeNodeData(goneNodes);
		const fresh = scene.nodes.filter((node) => !graph.getNodeData().some((data) => String(data.id) === node.id));
		if (fresh.length > 0) {
			graph.addNodeData(
				fresh.map((node) => ({
					id: node.id,
					style: {
						x: node.x,
						y: node.y,
						labelText: node.label,
						stroke: node.root ? palette.rootStroke : palette.cardStroke,
						lineWidth: node.root ? 1.5 : 1,
						fill: node.root ? palette.rootCard : palette.card,
						labelFill: node.root ? palette.rootText : palette.text,
						labelFontWeight: node.root ? 600 : 400
					}
				}))
			);
		}
		// The kept cards' labels move only when their ring state moved (+ / − / ⋯).
		for (const node of scene.nodes) {
			if (this.paintedLabels.get(node.id) !== node.label) {
				graph.updateNodeData([{ id: node.id, style: { labelText: node.label } }]);
				this.paintedLabels.set(node.id, node.label);
			}
		}
		const keptEdges = new Set(scene.edges.map((edge) => edge.id));
		const goneEdges = graph.getEdgeData().map((edge) => String(edge.id)).filter((id) => !keptEdges.has(id));
		if (goneEdges.length > 0) graph.removeEdgeData(goneEdges);
		const presentEdges = new Set(graph.getEdgeData().map((edge) => String(edge.id)));
		const freshEdges = scene.edges.filter((edge) => !presentEdges.has(edge.id));
		if (freshEdges.length > 0) {
			graph.addEdgeData(
				freshEdges.map((edge) => ({
					id: edge.id,
					source: edge.from,
					target: edge.to,
					style: {
						stroke: palette[edge.kind as 'call' | 'use' | 'member'] ?? palette.edge,
					lineDash: edge.kind === 'use' ? [4, 3] : undefined,
					lineWidth: edge.count > 1 ? 2.5 : 1.5,
					labelText: edge.count > 1 ? `×${edge.count}` : ''
				}
			}))
		);
		// The data operations only update the records — draw paints the diff onto the
		// canvas (a blank canvas otherwise).
		this.drawn = graph.draw();
	}
	}

	/* ---------- The view ---------- */

	/** Fit the whole drawing into the viewport — a new root's opening frame and the Fit
	 *  button's answer (the engine's own fit, padding kept). */
	fit(): void {
		// The initial fit lands after the first draw paints (a fitView against an undrawn
		// engine would frame nothing).
		void this.drawn.then(() => this.graph?.fitView({ when: 'always' }));
	}

	/** The page re-gained a real viewport (the section re-showed, the sash moved): keep
	 *  the camera unless the drawing no longer fits it — a zoom-to-fit when it outgrew,
	 *  a re-centre when it slid off. */
	frame(): void {
		const graph = this.graph;
		if (!graph) return;
		const [width, height] = graph.getSize();
		if (width === 0 || height === 0) return;
		const topLeft = graph.getCanvasByClient([0, 0]);
		const bottomRight = graph.getCanvasByClient([width, height]);
		const spanW = bottomRight[0] - topLeft[0];
		const spanH = bottomRight[1] - topLeft[1];
		const minX = Math.min(...[...this.positions.values()].map((p) => p.x));
		const maxX = Math.max(...[...this.positions.values()].map((p) => p.x + NODE_W));
		const minY = Math.min(...[...this.positions.values()].map((p) => p.y));
		const maxY = Math.max(...[...this.positions.values()].map((p) => p.y + NODE_H));
		const fullyVisible = minX >= topLeft[0] && minY >= topLeft[1] && maxX <= bottomRight[0] && maxY <= bottomRight[1];
		if (fullyVisible) return;
		if (maxX - minX <= spanW && maxY - minY <= spanH) {
			// It fits the viewport's span: bring its centre into view.
			void graph.translateTo([(minX + maxX) / 2, (minY + maxY) / 2]);
		} else {
			void graph.fitView({ when: "always" });
		}
	}

	private cancelClickDrill(): void {
		if (this.clickTimer !== null) {
			clearTimeout(this.clickTimer);
			this.clickTimer = null;
		}
	}

	private clickTimer: number | null = null;

	/* ---------- The card handlers (Source Insight's vocabulary) ---------- */

	private onCardClick(key: string): void {
		const node = this.nodes.get(key);
		if (!node) return;
		// A card with a ring drills on one click (the deferred drill, so a double click's
		// first press never expands); a card without a ring has nothing to drill and
		// opens at once.
		if (!node.hasChildren) {
			this.onOpen?.(node.path, node.line + 1);
			return;
		}
		if (this.clickTimer !== null) clearTimeout(this.clickTimer);
		this.clickTimer = window.setTimeout(() => {
			this.clickTimer = null;
			void this.toggleExpand(key);
		}, CLICK_DRILL_DELAY);
	}

	private showCardMenu(x: number, y: number, key: string): void {
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
	}

	/* ---------- The declaration card ---------- */

	private readonly onDocMouseDown = (event: MouseEvent): void => {
		if (this.declCard && !this.declCard.contains(event.target as Node)) this.hideDecl();
	};

	private readonly onDocKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape' && this.declCard) this.hideDecl();
	};

	private declTimer: number | null = null;

	private readonly declCache = new Map<string, Promise<DeclFragment | null>>();

	private declCard: HTMLElement | null = null;

	private scheduleDecl(node: GraphNode, x: number, y: number): void {
		if (this.declTimer !== null) clearTimeout(this.declTimer);
		this.declTimer = window.setTimeout(() => {
			this.declTimer = null;
			void this.showDecl(node, this.generation, x, y);
		}, DECL_DELAY);
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
		if (this.declTimer !== null) {
			clearTimeout(this.declTimer);
			this.declTimer = null;
		}
		this.declCard?.remove();
		this.declCard = null;
	}
}

/** The canvas palette: the engine's canvas cannot read CSS variables, so the colours
 *  cross as literals picked by the workbench theme's kind. */
function themePalette(): {
	card: string;
	cardStroke: string;
	rootCard: string;
	rootStroke: string;
	rootText: string;
	text: string;
	edge: string;
	call: string;
	use: string;
	member: string;
} {
	const dark = document.documentElement.classList.contains('vscode-dark');
	return dark
		? { card: '#2c3544', cardStroke: '#454f5e', rootCard: '#2c3544', rootStroke: '#6dd4e9', rootText: '#e8edf5', text: '#e8edf5', edge: '#9da5b4', call: '#4fc1ff', use: '#9da5b4', member: '#89d185' }
		: { card: '#f7f7f7', cardStroke: '#c8c8c8', rootCard: '#f7f7f7', rootStroke: '#006abc', rootText: '#171717', text: '#171717', edge: '#5a5a5a', call: '#006abc', use: '#5a5a5a', member: '#2da44e' };
}

/** The workbench's UI font, resolved once — the canvas text needs the literal family. */
function uiFontFamily(): string {
	try {
		const family = getComputedStyle(document.body).fontFamily;
		return family || 'sans-serif';
	} catch {
		return 'sans-serif';
	}
}

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}
