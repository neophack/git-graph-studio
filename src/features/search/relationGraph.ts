// The Relation Graph (module 5) — the Symbol Window's lower half: the symbol under the
// cursor's ring on an interactive graph, drawn on a hand-written SVG board in the
// worktile/plait mind-map manner (the owner's direction: 不要使用antv/g6，参考
// worktile/plait的代码重写当前绘图 — Plait itself mounts through React/Angular, so the
// board takes its *ideas*: the logic layout that stacks each branch's boxes and centers
// a parent on its children, the bezier branch links — an 8 px straight out of the parent
// card, then a cubic whose controls sit at a third and a half of the neighbouring gaps'
// sum — and the circle expander at the branch point). The layout is computed fresh on
// every draw over the visible tree, so a ring's expansion or collapse re-plans the whole
// drawing and the cards **glide** to their new spots (the owner's direction: 要像思维导
// 图一样的曲线连线，和自动移动节点) — a short rAF tween moves each displaced card and the
// links are redrawn from the moving cards every frame. The cards speak the classic
// vocabulary (2026-11-20, the owner's direction: the panels' operation logic aligned with
// the classic symbol IDEs): a card's one click opens its definition — the relation
// window's own click — and the ring's +/− expander is its own small circle at the branch
// point, whose click alone drills and collapses (instantly — no deferred merge); a
// right-click menu drills, re-roots or opens, and resting floats the declaration card,
// its code colored. The board's viewport is its own: wheel pans, ctrl/cmd+wheel zooms at
// the cursor, a background drag pans, and Fit frames the whole drawing. The relation TYPE
// is the classic window's own (2026-11-20): the picker lists the thirteen view names —
// Calls, Callers, Calls and Callers, Referenced by Functions/Files/Modules, Contains,
// Container, Base/Derived Classes, Member Types/Classes, Types Used — every ring drills
// by its own kind, the combined view's caller branches drilling as Callers and its callee
// branches as Calls (the node's edge coordinates name its side), the depth guard is the
// classic window's own — five levels of cards, the fifth a leaf — a ring cut short at the
// 64-children cap carries the ⋯, and an empty root ring answers the verdict the classic
// window prints ("no callers", "no contents", …).

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup, symbolRelationChildren, type RelationKind, type RelationNode } from '../../platform/ipc/symbols';

import { t, tf, type LocaleKey } from '../../platform/i18n';
import { extOf, highlightLine } from '../../platform/highlight';
import { el, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

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

/** One card's height. */
const NODE_H = 28;

/** The horizontal gap folded into every band — the sibling pitch on a row and the
 *  curve control offsets ride it, the way Plait's logic layout folds the gaps into the
 *  boxes. */
const HGAP = 34;

/** The vertical breathing room around one card, and one depth level's row pitch — the
 *  card, the branch expander beneath it and the link curve's breathing room between the
 *  rows. */
const VGAP = 16;
const ROW_H = NODE_H + 2 * VGAP;

/** How deep the graph may drill before a card's ring answers the cap instead — Source
 *  Insight's own guard: nodes are shown before the guard and the guard blocks
 *  expansion, so five levels of cards stand and the fifth is a leaf (the reference
 *  reconstruction's depth > 3). */
const MAX_DEPTH = 4;

/** the classic relation window's own type set, in its own order — the picker's
 *  entries and the wire spellings the backend accepts in every spelling. */
const PICKER_KINDS: { kind: RelationKind; label: LocaleKey }[] = [
	{ kind: 'calls', label: 'relations.kind.calls' },
	{ kind: 'callers', label: 'relations.kind.callers' },
	{ kind: 'callsAndCallers', label: 'relations.kind.callsAndCallers' },
	{ kind: 'referencedByFunctions', label: 'relations.kind.referencedByFunctions' },
	{ kind: 'referencedByFiles', label: 'relations.kind.referencedByFiles' },
	{ kind: 'referencedByModules', label: 'relations.kind.referencedByModules' },
	{ kind: 'contains', label: 'relations.kind.contains' },
	{ kind: 'container', label: 'relations.kind.container' },
	{ kind: 'baseClasses', label: 'relations.kind.baseClasses' },
	{ kind: 'derivedClasses', label: 'relations.kind.derivedClasses' },
	{ kind: 'memberTypes', label: 'relations.kind.memberTypes' },
	{ kind: 'memberClasses', label: 'relations.kind.memberClasses' },
	{ kind: 'typesUsed', label: 'relations.kind.typesUsed' }
];

/** The empty-ring verdict each kind answers with — the wording the relation window
 *  itself prints (the reference reconstruction's expansion verdicts). */
const EMPTY_VERDICTS: Partial<Record<RelationKind, LocaleKey>> = {
	calls: 'relations.empty.calls',
	callers: 'relations.empty.callers',
	callsAndCallers: 'relations.empty.callsAndCallers',
	referencedByFunctions: 'relations.empty.refsTo',
	referencedByFiles: 'relations.empty.files',
	referencedByModules: 'relations.empty.modules',
	contains: 'relations.empty.contains',
	container: 'relations.empty.container',
	baseClasses: 'relations.empty.baseClasses',
	derivedClasses: 'relations.empty.derivedClasses',
	memberTypes: 'relations.empty.memberTypes',
	memberClasses: 'relations.empty.memberClasses',
	typesUsed: 'relations.empty.typesUsed',
	refsTo: 'relations.empty.refsTo',
	refsFrom: 'relations.empty.refsFrom'
};

/** The pointer's rest before the declaration card floats in — the panel tree's timing. */
const DECL_DELAY = 300;

/** The branch expander: a small circle at the card's right edge, the branch point's own
 *  button — its click alone drills and collapses, the card's own click being the
 *  definition jump. */
const EXPANDER_R = 8;
const EXPANDER_OFF = 13;

/** The link's straight lead-out of the parent card before the curve begins, and the
 *  tween's run — Plait's `straightLineDistance`; the glide the owner asked for. */
const LINK_LEAD = 8;
const MOVE_MS = 220;

/** One graph node: a symbol card and its ring's bookkeeping. The drawn structure is a
 *  strict tree — a ring answer naming a symbol already drawn adds a cross edge instead of
 *  a second card. A collapsed card's descendants stay in the map (their rings come back
 *  without a re-fetch) and simply leave the drawing. */
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
	 *  arrow's kind and the ×N label (the root carries the neutral defaults). The site's
	 *  file also names the node's side in the combined view: a caller's edge lives in its
	 *  own file, a callee's in the subject's. */
	edgePath: string;
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

/** A settled spot in world coordinates — the card's top-left and its measured width
 *  (the labels size their cards; wider names make wider cards). */
interface LayoutPoint {
	x: number;
	y: number;
	w: number;
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
		edgePath: node.edgePath,
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
	return `${node.container ? `${node.container}·` : ''}${node.name}${node.truncated ? ' ⋯' : ''}`;
}

/** The ring expander's own label — the tree box's +/− (or ⋯ at the depth cap). */
function expanderLabel(node: GraphNode): string {
	return node.truncated && !node.expanded ? '⋯' : node.expanded ? '−' : '+';
}

/** One drawn scene: the cards and their branch expanders, and the arrows between them. */
interface Scene {
	nodes: { id: string; label: string; x: number; y: number; w: number; root: boolean }[];
	expanders: { id: string; for: string; label: string; x: number; y: number }[];
	edges: { id: string; from: string; to: string; kind: string; count: number }[];
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
	/** The board: the SVG viewport (wheel pan, ctrl/cmd+wheel zoom, background drag pan —
	 *  the drawing's own affordances, no engine behind them). */
	readonly element: HTMLElement;

	/** The relation-type picker, the pin and the Fit — the Symbol Window's section head
	 *  hosts them beside its own label, so the graph costs one row of the sidebar. */
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

	/** The drawing's own SVG: the world group carries the camera transform, over an edge
	 *  layer and a card layer (the links under the cards). */
	private readonly board: SVGSVGElement;

	private readonly world: SVGGElement;

	private readonly edgeLayer: SVGGElement;

	private readonly cardLayer: SVGGElement;

	/** The resting/loading/failed note, floating over the board. */
	private readonly hint: HTMLElement;

	private root: RelationRoot | null = null;

	private kind: RelationKind = 'refsTo';

	/** The root ring came back empty — the kind's own verdict shows beside the root. */
	private emptyVerdict = false;

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

	/** The freshly computed layout: every visible card's world spot, and the branch
	 *  expanders' centers — replanned on every draw, and the displaced cards glide. */
	private readonly layout = new Map<string, LayoutPoint>();

	private readonly layoutExp = new Map<string, { x: number; y: number }>();

	/** The drawing's world bounds over the current layout — the camera's fit reads. */
	private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

	/** The world bounds over every placed card and branch expander — recomputed after
	 *  each paint, the incremental fold moves spots in place. */
	private computeBounds(): void {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const span = (x: number, y: number, w: number, h: number): void => {
			minX = Math.min(minX, x); minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
		};
		for (const spot of this.layout.values()) span(spot.x, spot.y, spot.w, NODE_H);
		for (const exp of this.layoutExp.values()) span(exp.x - EXPANDER_R, exp.y - EXPANDER_R, EXPANDER_R * 2, EXPANDER_R * 2);
		this.bounds = { minX, minY, maxX, maxY };
	}

	/** The camera: the world group's translate + scale over the stage's pixels. */
	private camX = 0;

	private camY = 0;

	private camScale = 1;

	/** The glide: per card a from→to spot and its start time; one rAF loop walks them,
	 *  redrawing every link from the moving cards each frame. */
	private readonly moves = new Map<string, { fx: number; fy: number; start: number }>();

	private moveHandle: number | null = null;

	private settle: (() => void) | null = null;

	/** The painted cards' labels and spots — the next glide measures from them. */
	private readonly painted = new Map<string, { x: number; y: number }>();

	private readonly cardEls = new Map<string, SVGGElement>();

	private readonly edgeEls = new Map<string, SVGGElement>();

	private readonly edgeEnds = new Map<string, { from: string; to: string }>();

	private readonly kindButton: HTMLButtonElement;

	private readonly pinButton: HTMLButtonElement;

	private disposed = false;

	constructor() {
		this.stage = el('div', 'rg-stage');
		this.board = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.board.classList.add('rg-board');
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		this.world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.cardLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.world.append(defs, this.edgeLayer, this.cardLayer);
		this.board.appendChild(this.world);
		this.hint = el('div', 'rg-hint rg-hint-overlay');
		this.element = el('div', 'rg-root', [this.stage, this.hint]);
		this.stage.appendChild(this.board);

		this.board.addEventListener('wheel', this.onWheel, { passive: false });
		this.board.addEventListener('pointerdown', this.onPointerDown);

		this.kindButton = el('button', 'rg-dir rg-kind');
		this.kindButton.addEventListener('click', (event) => this.showKindPicker(event));
		const fit = el('button', 'rg-dir', [icon('screen-full')]);
		fit.title = t('symbols.graph.fit');
		fit.addEventListener('click', () => this.fit());
		this.pinButton = el('button', 'rg-dir');
		this.pinButton.addEventListener('click', () => this.togglePin());
		this.controls = el('div', 'rg-controls', [this.kindButton, this.pinButton, fit]);
		this.paintControls();

		document.addEventListener('mousedown', this.onDocMouseDown);
		document.addEventListener('keydown', this.onDocKeyDown);
		this.render();
	}

	/** The host's dispose: the document-level dismissers must not outlive the view. */
	dispose(): void {
		this.disposed = true;
		this.hideDecl();
		document.removeEventListener('mousedown', this.onDocMouseDown);
		document.removeEventListener('keydown', this.onDocKeyDown);
		this.stopMoves();
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
	 *  relation type survives, every expansion below the root does not. */
	setRoot(root: RelationRoot | null, note?: string): void {
		const same =
			this.root !== null && root !== null && this.root.name === root.name && this.root.path === root.path && this.root.line === root.line;
		if (same && !note) return;
		this.root = root ? { kind: root.kind, name: root.name, path: root.path, line: root.line } : null;
		this.rootNote = note;
		void this.loadRoot();
	}

	/** Swap the relation type and refetch: the other type is a different graph. */
	private setKind(kind: RelationKind): void {
		if (this.kind === kind) return;
		this.kind = kind;
		void this.loadRoot();
	}

	/** The picker: the classic window's own thirteen view names, the active one checked. */
	private showKindPicker(event: MouseEvent): void {
		const entries: MenuEntry[] = PICKER_KINDS.map((entry) => ({
			label: t(entry.label),
			checked: this.kind === entry.kind,
			run: () => this.setKind(entry.kind)
		}));
		showContextMenu(event.clientX, event.clientY, entries);
	}

	/** The ring's drill kind: every ring drills by the graph's own type, except the
	 *  combined view's branches — a caller keeps drilling as Callers (its edge site
	 *  lives outside the root's file) and a callee as Calls (the root's body names it). */
	private ringKind(node: GraphNode): RelationKind {
		if (this.kind !== 'callsAndCallers') return this.kind;
		return this.callsSide(node) ? 'calls' : 'callers';
	}

	/** The combined view's side of one node: a callee's edge site sits in the root's own
	 *  file (the body that names it); a caller's anywhere else. */
	private callsSide(node: GraphNode): boolean {
		return node.edgePath === (this.root?.path ?? '');
	}

	/** Whether this kind's arrow runs from the child to its parent (the referencing side
	 *  points at the referenced — refsTo's family, Container's chain upward, the derived
	 *  classes' `derives from`) or from the parent down (the body's references, the
	 *  contains rings, the base classes' `extends`). The combined view's branches read
	 *  the node's own side. */
	private pointsUp(node: GraphNode): boolean {
		switch (this.kind) {
			case 'refsTo':
			case 'referencedByFunctions':
			case 'referencedByFiles':
			case 'referencedByModules':
			case 'callers':
			case 'container':
			case 'derivedClasses':
				return true;
			case 'callsAndCallers':
				return !this.callsSide(node);
			default:
				return false;
		}
	}

	private async loadRoot(): Promise<void> {
		const generation = ++this.generation;
		const root = this.root;
		this.hideDecl();
		this.nodes.clear();
		this.layout.clear();
		this.layoutExp.clear();
		this.crossEdges.length = 0;
		this.crossSeen.clear();
		this.painted.clear();

		this.rootFailed = false;
		this.emptyVerdict = false;
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
			const answer = await symbolRelationChildren(root.name, root.path, root.line, this.kind);
			if (generation !== this.generation) return;
			const node = this.nodes.get(this.rootKey);
			if (node) {
				node.hasChildren = (answer?.nodes.length ?? 0) > 0;
				node.truncated = answer?.truncated === true;
				// An empty ring answers the kind's own verdict — the relation window's
				// "no callers", "no contents", … beside the root card.
				this.emptyVerdict = !node.hasChildren;
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
	 *  symbol already drawn becomes a cross edge (the arrow without the second card,
	 *  pointing the kind's own way). */
	private absorbRing(node: GraphNode, ring: RelationNode[]): void {
		node.children = [];
		for (const entry of ring) {
			const key = nodeKey(entry.name, entry.path, entry.line);
			if (this.nodes.has(key)) {
				const up = this.kind === 'callsAndCallers' ? entry.edgePath !== (this.root?.path ?? '') : this.pointsUp(node);
				const from = up ? key : node.key;
				const to = up ? node.key : key;
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
		const current = PICKER_KINDS.find((entry) => entry.kind === this.kind) ?? PICKER_KINDS[0];
		this.kindButton.textContent = '';
		this.kindButton.append(el('span', 'rg-kind-label', [t(current.label)]), icon('chevron-down'));
		this.kindButton.title = t('relations.kind.pick');
		this.kindButton.setAttribute('aria-label', this.kindButton.title);
		this.pinButton.title = this.pinned ? t('relations.unpin') : t('relations.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.textContent = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.pinButton.classList.toggle('active', this.pinned);
	}

	/* ---------- Expansion ---------- */

	/** The drill toggles the ring and repaints: the layout re-plans the visible tree
	 *  (the mind map's own 自动排列 — the drawing always lands on the tidy arrangement,
	 *  never a drifted one) and the displaced cards **glide** to their new spots, so the
	 *  fold reads as the branch opening and the tree closing up — the same drawing,
	 *  animated; no flash, no camera jump (the owner's directions: 点击打开折叠内容，
	 *  或者关闭折叠内容，不要重新刷新图形 + 要像思维导图一样自动排列). */
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
			const answer = await symbolRelationChildren(node.name, node.path, node.line, this.ringKind(node));
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

	/** A card's drawn children right now. */
	private drawnChildren(node: GraphNode): GraphNode[] {
		if (!node.expanded) return [];
		return node.children.map((key) => this.nodes.get(key)).filter((child): child is GraphNode => child !== undefined);
	}

	/* ---------- The Plait-manner mind layout ---------- */

	private visibleEdgeList(): GraphEdge[] {
		const edges: GraphEdge[] = [];
		const visible = new Set(this.visibleNodes().map((node) => node.key));
		for (const node of this.nodes.values()) {
			// Only a VISIBLE node's ring draws: a fold hides a whole subtree whose members
			// keep their cached `expanded` state — their arrows must leave with them, or
			// stray curves would linger over the emptied band.
			if (!node.expanded || !visible.has(node.key)) continue;
			for (const key of node.children) {
				const child = this.nodes.get(key);
				if (!child) continue;
				// The kind's own arrow direction: the referencing side points at the
				// referenced (refsTo's family, Container, Derived Classes) or the subject
				// points at what it names (refsFrom's family, Contains, Base Classes).
				const up = this.pointsUp(child);
				const from = up ? key : node.key;
				const to = up ? node.key : key;
				edges.push({ from, to, kind: child.edgeKind, count: child.edgeCount });
			}
		}
		// A cross edge stands only while both its ends are drawn — a fold that hides an
		// endpoint hides its arrow too, or a stray curve would linger over empty space.
		for (const edge of this.crossEdges) {
			if (visible.has(edge.from) && visible.has(edge.to)) edges.push(edge);
		}
		return edges;
	}

	/** Build the scene: the visible tree walks Plait's logic layout on every draw, TOP-DOWN
	 *  (the owner's direction: relation的图改成从上到下) — the root's card sits at the top,
	 *  every depth its own row below, the children of one card pack side by side by their
	 *  subtree widths and the card centers between its outermost children — so the
	 *  drawing always lands on the tidy arrangement (the mind map's 自动排列), and the
	 *  paint's glide carries the re-planned cards there smoothly. */
	private buildScene(): Scene {
		const nodes: Scene['nodes'] = [];
		const expanders: Scene['expanders'] = [];
		{
			this.layout.clear();
			this.layoutExp.clear();
			const walk = (node: GraphNode, left: number, y: number): number => {
				// The card's width is its label's own — wider names make wider cards, and the
				// band advance carries them.
				const w = Math.max(96, Math.min(340, estimateLabelWidth(relationLabel(node)) + 24));
				const kids = this.drawnChildren(node);
				if (kids.length > 0) {
					let at = left;
					let firstCx = 0;
					let lastCx = 0;
					kids.forEach((child, index) => {
						// The child's band starts at this frontier and the next child's band
						// follows; each band folds the breathing room on both faces.
						const width = walk(child, at, y + ROW_H);
						const spot = this.layout.get(child.key)!;
						const cx = spot.x + spot.w / 2;
						if (index === 0) firstCx = cx;
						lastCx = cx;
						at += width;
					});
					const cx = (firstCx + lastCx) / 2;
					this.layout.set(node.key, { x: cx - w / 2, y, w });
				} else {
					// The leaf's box is its width plus the folded breathing room on both faces;
					// the card centers in it — the sibling pitch rides the same number.
					const cx = left + HGAP + w / 2;
					this.layout.set(node.key, { x: cx - w / 2, y, w });
				}
				if (node.hasChildren) {
					const spot = this.layout.get(node.key)!;
					this.layoutExp.set(node.key, { x: spot.x + spot.w / 2, y: spot.y + NODE_H + EXPANDER_OFF });
				}
				if (kids.length > 0) {
					const last = this.layout.get(kids[kids.length - 1]!.key)!;
					return last.x + last.w + HGAP - left;
				}
				return w + 2 * HGAP;
			};
			const root = this.nodes.get(this.rootKey);
			if (root) walk(root, 0, 0);
		}
		this.computeBounds();
		for (const node of this.visibleNodes()) {
			const spot = this.layout.get(node.key);
			if (!spot) continue;
			nodes.push({ id: node.key, label: relationLabel(node), x: spot.x, y: spot.y, w: spot.w, root: node.parentKey === null });
			if (node.hasChildren) {
				const exp = this.layoutExp.get(node.key)!;
				expanders.push({ id: `${node.key}\u0000+`, for: node.key, label: expanderLabel(node), x: exp.x, y: exp.y });
			}
		}
		return {
			nodes,
			expanders,
			edges: this.visibleEdgeList().map((edge) => ({ id: `${edge.from}\u0000${edge.to}`, from: edge.from, to: edge.to, kind: edge.kind, count: edge.count }))
		};
	}

	/* ---------- Rendering (the SVG board) ---------- */

	/** Repaint the drawing: the layout replans the visible tree, the cards diff in
	 *  place (new cards fade in, moved cards glide, gone cards leave) and the links
	 *  redraw over the spots. The empty states (hint branches) clear the board. */
	private render(): void {
		this.hint.textContent = '';
		this.hint.hidden = true;
		if (!this.root) {
			this.hint.appendChild(el('span', undefined, [this.rootNote ?? t('symbols.graph.hint')]));
			this.hint.hidden = false;
			this.clearBoard();
			return;
		}
		if (this.rootLoading) {
			this.hint.append(icon('sync', 'codicon-modifier-spin'), el('span', undefined, [t('relations.loading')]));
			this.hint.hidden = false;
			this.clearBoard();
			return;
		}
		if (this.rootFailed) {
			this.hint.appendChild(el('span', undefined, [t('relations.failed')]));
			this.hint.hidden = false;
			this.clearBoard();
			return;
		}
		if (this.emptyVerdict) {
			// The root stands alone; the verdict is the kind's own — the wording the
			// relation window itself answers with.
			this.hint.appendChild(el('span', undefined, [t(EMPTY_VERDICTS[this.kind] ?? 'relations.empty.refsFrom')]));
			this.hint.hidden = false;
		}
		this.paintBoard(this.buildScene());
	}

	private clearBoard(): void {
		this.stopMoves();
		this.painted.clear();
		this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

		for (const g of this.cardEls.values()) g.remove();
		for (const g of this.edgeEls.values()) g.remove();
		this.cardEls.clear();
		this.edgeEls.clear();
		this.edgeEnds.clear();
		this.applyCamera();
	}

	private paintBoard(scene: Scene): void {
		const palette = themePalette();
		this.paintMarkers(palette);
		// The cards: new ones fade in at their spot, moved ones glide, gone ones leave.
		const seenCards = new Set<string>();
		for (const node of scene.nodes) {
			seenCards.add(node.id);
			let g = this.cardEls.get(node.id);
			if (!g) {
				g = this.makeCard(node, palette);
				this.cardEls.set(node.id, g);
				this.cardLayer.appendChild(g);
			}
			const rect = g.querySelector('rect')!;
			const label = g.querySelector('text')!;
			if (label.textContent !== node.label) label.textContent = node.label;
			if (rect.getAttribute('width') !== String(node.w)) {
				rect.setAttribute('width', String(node.w));
				label.setAttribute('x', String(node.w / 2));
			}
			const prior = this.painted.get(node.id);
			this.painted.set(node.id, { x: node.x, y: node.y });
			if (prior && (prior.x !== node.x || prior.y !== node.y)) {
				this.startMove(node.id, prior.x, prior.y);
				this.placeCard(g, node.x, node.y);
			} else if (!prior) {
				// A first appearance: fade in exactly where it belongs.
				this.placeCard(g, node.x, node.y);
				g.classList.add('rg-enter');
				window.setTimeout(() => g?.classList.remove('rg-enter'), 260);
			}
			g.classList.toggle('rg-root', node.root);
		}
		// The branch expanders ride the same diff.
		const seenExp = new Set<string>();
		for (const exp of scene.expanders) {
			seenExp.add(exp.id);
			let g = this.cardEls.get(exp.id);
			if (!g) {
				g = this.makeExpander(exp, palette);
				this.cardEls.set(exp.id, g);
				this.cardLayer.appendChild(g);
			}
			const label = g.querySelector('text')!;
			if (label.textContent !== exp.label) label.textContent = exp.label;
			const prior = this.painted.get(exp.id);
			this.painted.set(exp.id, { x: exp.x, y: exp.y });
			if (prior && (prior.x !== exp.x || prior.y !== exp.y)) {
				this.startMove(exp.id, prior.x, prior.y);
				this.placeCard(g, exp.x, exp.y);
			} else if (!prior) {
				this.placeCard(g, exp.x, exp.y);
				g.classList.add('rg-enter');
				window.setTimeout(() => g?.classList.remove('rg-enter'), 260);
			}
		}
		for (const [id, g] of this.cardEls) {
			if (!seenCards.has(id) && !seenExp.has(id)) {
				g.remove();
				this.cardEls.delete(id);
				this.painted.delete(id);
			}
		}
		// The links: rebuilt over the spots every draw — the tween's frames refresh them
		// from the moving cards.
		const seenEdges = new Set<string>();
		for (const edge of scene.edges) {
			seenEdges.add(edge.id);
			let g = this.edgeEls.get(edge.id);
			if (!g) {
				g = this.makeEdge(edge, palette);
				this.edgeEls.set(edge.id, g);
				this.edgeLayer.appendChild(g);
				this.edgeEnds.set(edge.id, { from: edge.from, to: edge.to });
			}
			this.paintEdge(g, edge, palette);
		}
		for (const [id, g] of this.edgeEls) {
			if (!seenEdges.has(id)) {
				g.remove();
				this.edgeEls.delete(id);
				this.edgeEnds.delete(id);
			}
		}
		this.applyCamera();
		if (this.moves.size > 0) this.beginMoves();
	}

	/** The arrowhead markers, one per link colour — rebuilt each draw, the palette may
	 *  have flipped with the theme. */
	private paintMarkers(palette: ReturnType<typeof themePalette>): void {
		const defs = this.world.querySelector('defs')!;
		while (defs.firstChild) defs.firstChild.remove();
		for (const [name, color] of Object.entries(palette).filter(([name]) => name.startsWith('edge') || ['call', 'use', 'member', 'base'].includes(name))) {
			const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
			marker.setAttribute('id', `rg-arr-${name}`);
			marker.setAttribute('viewBox', '0 0 10 10');
			marker.setAttribute('refX', '8');
			marker.setAttribute('refY', '5');
			marker.setAttribute('markerWidth', '7');
			marker.setAttribute('markerHeight', '7');
			marker.setAttribute('orient', 'auto-start-reverse');
			const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			head.setAttribute('d', 'M0,1 L9,5 L0,9 z');
			head.setAttribute('fill', color);
			marker.appendChild(head);
			defs.appendChild(marker);
		}
	}

	private makeCard(node: Scene['nodes'][number], palette: ReturnType<typeof themePalette>): SVGGElement {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.classList.add('rg-card');
		g.dataset.id = node.id;
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('height', String(NODE_H));
		rect.setAttribute('rx', '7');
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('dominant-baseline', 'central');
		label.setAttribute('font-size', '11');
		label.setAttribute('font-family', uiFontFamily());
		label.setAttribute('x', String(node.w / 2));
		label.setAttribute('y', String(NODE_H / 2));
		label.textContent = node.label;
		g.append(rect, label);
		if (node.root) {
			rect.setAttribute('stroke', palette.rootStroke);
			rect.setAttribute('stroke-width', '1.5');
			rect.setAttribute('fill', palette.rootCard);
			label.setAttribute('fill', palette.rootText);
			label.setAttribute('font-weight', '600');
		} else {
			rect.setAttribute('stroke', palette.cardStroke);
			rect.setAttribute('stroke-width', '1');
			rect.setAttribute('fill', palette.card);
			label.setAttribute('fill', palette.text);
		}
		g.addEventListener('click', (event) => {
			// The branch expander rides inside the card group; its click alone drills —
			// never the definition jump.
			if ((event.target as Element).closest('.rg-expander')) return;
			this.onCardClick(node.id);
		});
		g.addEventListener('dblclick', () => {
			const node = this.nodes.get(nodeIdOf(g));
			if (node) this.onOpen?.(node.path, node.line + 1);
		});
		g.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.showCardMenu(event.clientX, event.clientY, nodeIdOf(g));
		});
		g.addEventListener('pointerenter', (event) => {
			if ((event.target as Element).closest('.rg-expander')) return;
			const node = this.nodes.get(nodeIdOf(g));
			if (!node) return;
			this.scheduleDecl(node, event.clientX, event.clientY);
		});
		g.addEventListener('pointerleave', () => {
			if (this.declTimer !== null) {
				clearTimeout(this.declTimer);
				this.declTimer = null;
			}
		});
		return g;
	}

	private makeExpander(exp: Scene['expanders'][number], palette: ReturnType<typeof themePalette>): SVGGElement {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.classList.add('rg-expander');
		g.dataset.for = exp.for;
		const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('r', String(EXPANDER_R));
		circle.setAttribute('fill', palette.card);
		circle.setAttribute('stroke', palette.cardStroke);
		circle.setAttribute('stroke-width', '1');
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('dominant-baseline', 'central');
		label.setAttribute('font-size', '12');
		label.setAttribute('font-family', uiFontFamily());
		label.setAttribute('fill', palette.text);
		label.textContent = exp.label;
		g.append(circle, label);
		const key = exp.for;
		g.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.toggleExpand(key);
		});
		g.addEventListener('dblclick', (event) => event.stopPropagation());
		g.addEventListener('contextmenu', (event) => event.stopPropagation());
		return g;
	}

	private makeEdge(edge: Scene['edges'][number], palette: ReturnType<typeof themePalette>): SVGGElement {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.classList.add('rg-edge');
		g.dataset.from = edge.from;
		g.dataset.to = edge.to;
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('fill', 'none');
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('font-size', '10');
		label.setAttribute('font-family', uiFontFamily());
		label.setAttribute('fill', palette.text);
		label.setAttribute('stroke', palette.card);
		label.setAttribute('stroke-width', '3');
		label.setAttribute('paint-order', 'stroke');
		g.append(path, label);
		return g;
	}

	/** One link's paint: colour, dash, width, the ×N label, and the path itself — Plait's
	 *  logic link: a straight lead out of the `from` card's facing edge, then a cubic
	 *  whose controls sit a third and a half of the neighbouring gaps' sum into the run,
	 *  landing on the `to` card's facing edge, the arrowhead riding the end. */
	private paintEdge(g: SVGGElement, edge: Scene['edges'][number], palette: ReturnType<typeof themePalette>): void {
		const from = this.layout.get(edge.from);
		const to = this.layout.get(edge.to);
		const path = g.querySelector('path')!;
		const label = g.querySelector('text')!;
		if (!from || !to) return;
		const d = this.linkPath(from, to);
		path.setAttribute('d', d);
		const color = palette[edge.kind as 'call' | 'use' | 'member' | 'base'] ?? palette.edge;
		path.setAttribute('stroke', color);
		path.setAttribute('stroke-width', edge.count > 1 ? '2.2' : '1.4');
		if (edge.kind === 'use') path.setAttribute('stroke-dasharray', '4 3');
		else path.removeAttribute('stroke-dasharray');
		path.setAttribute('marker-end', `url(#rg-arr-${['call', 'use', 'member', 'base'].includes(edge.kind) ? edge.kind : 'edge'})`);
		const text = edge.count > 1 ? `×${edge.count}` : '';
		label.textContent = text;
		if (text) {
			// The mid-curve anchor: the cubic's t = ½ point (the straight lead joins it).
			const [, lead, c1, c2, e] = this.linkPoints(from, to);
			label.setAttribute('x', String((lead[0] + 3 * c1[0] + 3 * c2[0] + e[0]) / 8));
			label.setAttribute('y', String((lead[1] + 3 * c1[1] + 3 * c2[1] + e[1]) / 8 + 3));
		}
	}

	/** The link's five points, TOP-DOWN: out of the `from` card's facing face (the bottom
	 *  face when the `to` card sits below, else the top), the straight lead's end, the
	 *  cubic's two controls — Plait's offsets, a third and a half of the neighbouring
	 *  gaps' sum — and the `to` card's facing face, where the arrowhead lands. */
	private linkPoints(from: LayoutPoint, to: LayoutPoint): [number, number][] {
		const downward = to.y >= from.y;
		const bx = from.x + from.w / 2;
		const by = downward ? from.y + NODE_H : from.y;
		const ex = to.x + to.w / 2;
		const ey = downward ? to.y : to.y + NODE_H;
		const dir = downward ? 1 : -1;
		const lead = Math.abs(ey - by) > 4 ? LINK_LEAD * dir : 0;
		const gapSum = 4 * HGAP;
		const c1y = by + lead + (gapSum / 3) * dir;
		const c2y = ey - (gapSum / 2.4) * dir;
		return [
			[bx, by],
			[bx, by + lead],
			[bx, c1y],
			[ex, c2y],
			[ex, ey]
		];
	}

	/** The path string over `linkPoints`: `M b L lead C c1 c2 e` — the straight lead and
	 *  the curve in one subpath. */
	private linkPath(from: LayoutPoint, to: LayoutPoint): string {
		const [b, lead, c1, c2, e] = this.linkPoints(from, to);
		return `M ${b[0]} ${b[1]} L ${lead[0]} ${lead[1]} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${e[0]} ${e[1]}`;
	}

	private placeCard(g: SVGGElement, x: number, y: number): void {
		g.setAttribute('transform', `translate(${x} ${y})`);
	}

	/** The glide: the card starts from where it stood and the rAF loop walks it to the
	 *  spot the layout just gave it — the links redraw from the moving cards every
	 *  frame, so the arrows stay glued. */
	private startMove(id: string, fx: number, fy: number): void {
		this.moves.set(id, { fx, fy, start: performance.now() });
	}

	private beginMoves(): void {
		if (this.moveHandle !== null) return;
		if (typeof requestAnimationFrame !== 'function') {
			// No frame clock (a bare harness): the cards already sit at their spots.
			this.moves.clear();
			return;
		}
		const tick = (): void => {
			this.moveHandle = null;
			const now = performance.now();
			for (const [id, move] of this.moves) {
				const g = this.cardEls.get(id);
				const target = this.painted.get(id);
				if (!g || !target) {
					this.moves.delete(id);
					continue;
				}
				const p = Math.min(1, (now - move.start) / MOVE_MS);
				const e = 1 - Math.pow(1 - p, 3);
				const x = move.fx + (target.x - move.fx) * e;
				const y = move.fy + (target.y - move.fy) * e;
				this.placeCard(g, x, y);
				if (p >= 1) this.moves.delete(id);
			}
			// The links follow the cards: every drawn arrow repaints over the moving ends.
			for (const [id, g] of this.edgeEls) {
				const ends = this.edgeEnds.get(id);
				if (!ends) continue;
				const from = this.renderedSpot(ends.from);
				const to = this.renderedSpot(ends.to);
				if (from && to) {
					g.querySelector('path')!.setAttribute('d', this.linkPath(from, to));
					const label = g.querySelector('text')!;
					if (label.textContent) {
						const [, lead, c1, c2, e] = this.linkPoints(from, to);
						label.setAttribute('x', String((lead[0] + 3 * c1[0] + 3 * c2[0] + e[0]) / 8));
						label.setAttribute('y', String((lead[1] + 3 * c1[1] + 3 * c2[1] + e[1]) / 8 + 3));
					}
				}
			}
			if (this.moves.size > 0) this.moveHandle = requestAnimationFrame(tick);
			if (this.moves.size === 0) {
				this.settle?.();
				this.settle = null;
			}
		};
		this.moveHandle = requestAnimationFrame(tick);
	}

	private stopMoves(): void {
		if (this.moveHandle !== null) {
			cancelAnimationFrame(this.moveHandle);
			this.moveHandle = null;
		}
		this.moves.clear();
	}

	/** A card's spot as the drawing holds it right now — the glide's interpolated one,
	 *  or the layout's settled one. The links read this so they stay glued. */
	private renderedSpot(id: string): LayoutPoint | null {
		const move = this.moves.get(id);
		const spot = this.layout.get(id);
		if (!spot) return null;
		if (move) {
			const p = Math.min(1, (performance.now() - move.start) / MOVE_MS);
			const e = 1 - Math.pow(1 - p, 3);
			return { x: move.fx + (spot.x - move.fx) * e, y: move.fy + (spot.y - move.fy) * e, w: spot.w };
		}
		return spot;
	}

	/** Resolves once any in-flight glide has landed — the harness and the tests read
	 *  settled geometry through it. */
	whenSettled(): Promise<void> {
		if (this.moves.size === 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.settle = resolve;
		});
	}

	/* ---------- The camera (pan / zoom / fit) ---------- */

	private applyCamera(): void {
		this.world.setAttribute('transform', `translate(${this.camX} ${this.camY}) scale(${this.camScale})`);
	}

	private readonly onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			const rect = this.board.getBoundingClientRect();
			const px = event.clientX - rect.left;
			const py = event.clientY - rect.top;
			const factor = Math.exp(-event.deltaY * 0.002);
			const next = Math.max(0.15, Math.min(3, this.camScale * factor));
			this.camX = px - ((px - this.camX) / this.camScale) * next;
			this.camY = py - ((py - this.camY) / this.camScale) * next;
			this.camScale = next;
			this.applyCamera();
		} else {
			this.camX -= event.deltaX;
			this.camY -= event.deltaY;
			this.applyCamera();
		}
	};

	private panFrom: { x: number; y: number; camX: number; camY: number } | null = null;

	private readonly onPointerDown = (event: PointerEvent): void => {
		// The cards and their branch expanders own their clicks: a pan start here would
		// capture the pointer to the board and the composed click would land on the
		// board, never on the circle. Only the bare board pans, main button only.
		if (event.button !== 0) return;
		if ((event.target as Element).closest('.rg-card, .rg-expander')) return;
		this.panFrom = { x: event.clientX, y: event.clientY, camX: this.camX, camY: this.camY };
		try {
			this.board.setPointerCapture(event.pointerId);
		} catch {
			// A harness without pointer capture still pans by the move events.
		}
		this.board.classList.add('rg-panning');
		const move = (moveEvent: PointerEvent): void => {
			if (!this.panFrom) return;
			this.camX = this.panFrom.camX + (moveEvent.clientX - this.panFrom.x);
			this.camY = this.panFrom.camY + (moveEvent.clientY - this.panFrom.y);
			this.applyCamera();
		};
		const up = (): void => {
			this.panFrom = null;
			this.board.classList.remove('rg-panning');
			this.board.removeEventListener('pointermove', move);
			this.board.removeEventListener('pointerup', up);
			this.board.removeEventListener('pointercancel', up);
		};
		this.board.addEventListener('pointermove', move);
		this.board.addEventListener('pointerup', up);
		this.board.addEventListener('pointercancel', up);
	};

	/** Fit the whole drawing into the viewport — a new root's opening frame and the Fit
	 *  button's answer. */
	fit(): void {
		const [width, height] = [this.stage.clientWidth, this.stage.clientHeight];
		const box = this.bounds;
		const spanW = box.maxX - box.minX;
		const spanH = box.maxY - box.minY;
		if (width === 0 || height === 0 || spanW <= 0 || spanH <= 0) return;
		const pad = 24;
		const scale = Math.max(0.15, Math.min(1.4, Math.min((width - pad * 2) / spanW, (height - pad * 2) / spanH)));
		this.camScale = scale;
		this.camX = (width - spanW * scale) / 2 - box.minX * scale;
		this.camY = (height - spanH * scale) / 2 - box.minY * scale;
		this.applyCamera();
	}

	/** The page re-gained a real viewport (the section re-showed, the sash moved): keep
	 *  the camera unless the drawing no longer fits it — a zoom-to-fit when it outgrew,
	 *  a re-centre when it slid off. */
	frame(): void {
		const width = this.stage.clientWidth;
		const height = this.stage.clientHeight;
		if (width === 0 || height === 0) return;
		const box = this.bounds;
		const spanW = box.maxX - box.minX;
		const spanH = box.maxY - box.minY;
		if (spanW <= 0 || spanH <= 0) return;
		// The viewport's world rect under the current camera.
		const left = -this.camX / this.camScale;
		const top = -this.camY / this.camScale;
		const right = left + width / this.camScale;
		const bottom = top + height / this.camScale;
		const fullyVisible = box.minX >= left && box.minY >= top && box.maxX <= right && box.maxY <= bottom;
		if (fullyVisible) return;
		if (spanW <= right - left && spanH <= bottom - top) {
			this.camX -= (box.minX + box.maxX) / 2 - (left + right) / 2;
			this.camY -= (box.minY + box.maxY) / 2 - (top + bottom) / 2;
		} else {
			this.fit();
			return;
		}
		this.applyCamera();
	}

	/* ---------- The card handlers (the classic window's vocabulary) ---------- */

	private onCardClick(key: string): void {
		// The card's one click is the definition jump — the relation window's own click.
		// (The expander's own listener drills; it stops the click before this sees it.)
		const node = this.nodes.get(key);
		if (node) this.onOpen?.(node.path, node.line + 1);
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
		if (!fragment || generation !== this.generation || this.disposed) return;
		this.hideDecl();
		const card = el('div', 'rg-decl');
		// The declaration's own colors: the shared tokenizer's runs, one row per line —
		// the hover reads like the editor's code, not like plain text.
		const code = el('pre', 'rg-decl-code');
		const ext = extOf(fragment.path);
		for (const line of fragment.text.split('\n')) {
			const row = el('div', 'rg-decl-line');
			for (const segment of highlightLine(line, ext)) {
				row.appendChild(segment.cls ? el('span', segment.cls, [segment.text]) : document.createTextNode(segment.text));
			}
			code.appendChild(row);
		}
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

/** The card group's node id — the data attribute the handlers read back. */
function nodeIdOf(g: SVGElement): string {
	return g.dataset.id ?? '';
}

/** A label's pixel width at the card's 11 px font — the estimate that sizes the cards
 *  (CJK glyphs read full-width, everything else a mean Latin advance). */
function estimateLabelWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? 11 : 6.4;
	return width;
}

/** The canvas palette: the SVG reads attributes, not CSS variables, so the colours
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
	base: string;
} {
	const dark = document.documentElement.classList.contains('vscode-dark');
	return dark
		? { card: '#2c3544', cardStroke: '#454f5e', rootCard: '#2c3544', rootStroke: '#6dd4e9', rootText: '#e8edf5', text: '#e8edf5', edge: '#9da5b4', call: '#4fc1ff', use: '#9da5b4', member: '#89d185', base: '#c98ee9' }
		: { card: '#f7f7f7', cardStroke: '#c8c8c8', rootCard: '#f7f7f7', rootStroke: '#006abc', rootText: '#171717', text: '#171717', edge: '#5a5a5a', call: '#006abc', use: '#5a5a5a', member: '#2da44e', base: '#8250df' };
}

/** The workbench's UI font, resolved once — the SVG text needs the literal family. */
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
