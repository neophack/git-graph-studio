// The Relation Graph (module 5) — the Symbol Window's lower half: the symbol under the
// cursor's ring on an interactive, module-diagram-inspired layered SVG board.
//
// Layout & routing (upgraded to match moduleDiagram.ts):
// - Sugiyama-style layered layout (L0, L1, L2...) with multi-pass barycenter crossing
//   minimization + local adjacent-swap refinement across both tree and cross edges so
//   connecting curves minimize crossings.
// - Spatially sorted distributed connection ports on every card + smooth cubic Bezier
//   curves (with outer-arc routing for same-layer/back/bidirectional edges so lines
//   never slice through cards).
// - Crisp vector cards with semantic kind accent bar, file:line subtitle, multi-site
//   numbered detail rows ("1. line N"), +/− branch expanders, O(degree) hover
//   neighborhood tracing, dot-grid parallax canvas, keyboard shortcuts, and rAF glide.

import { symbolRelationChildren, type RelationKind, type RelationNode, type SymSlotMetrics } from '../../platform/ipc/symbols';

import { t, type LocaleKey } from '../../platform/i18n';
import { load, save } from '../../platform/state';
import { el, icon, quickInput, showContextMenu, type MenuEntry } from '../../platform/ui/index';

import type { DefinitionSubject } from './definitionView';
import { KIND_ICONS } from './contextView';

import './relationGraph.css';

/** What the workbench resolved the symbol under the cursor to (0-based line). */
export interface RelationRoot {
	kind: string;
	name: string;
	path: string;
	line: number;
}

/** Base card height: header title row + file:line subtitle row. Multi-site detail rows
 *  grow downward below a subtle divider. */
const NODE_H = 44;
const CARD_RX = 9;
const HEADER_H = 24;

/** Generous breathing room between cards and layers (mirrors moduleDiagram.ts). */
const TB_COL_GAP = 28;
const TB_ROW_GAP = 64;
const TB_SUBROW_GAP = 24;
const LR_COL_GAP = 84;
const LR_ROW_GAP = 22;
const LR_SUBCOL_GAP = 26;
const MAX_PER_BAND = 8;
const PAD_X = 36;
const PAD_Y = 32;

const DETAIL_ROW_H = 15;
const DETAIL_X = 11;
const MAX_DEPTH = 4;

const EXPANDER_R = 8;
const EXPANDER_OFF = 13;
const MOVE_MS = 220;
const ARROW_PAN = 48;

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

export type RelationViewMode = 'outline' | 'graphVertical' | 'graphHorizontal';

const VIEW_MODES: RelationViewMode[] = ['outline', 'graphHorizontal', 'graphVertical'];

const VIEW_LABELS: Record<RelationViewMode, LocaleKey> = {
	outline: 'relations.view.outline',
	graphVertical: 'relations.view.graphVertical',
	graphHorizontal: 'relations.view.graphHorizontal'
};

const VIEW_KEY = 'relation.viewMode';

function ruleCategoryFor(symbolKind: string): string {
	switch (symbolKind) {
		case 'function':
		case 'method':
		case 'constructor':
			return 'function';
		case 'variable':
		case 'local':
		case 'constant':
		case 'field':
		case 'member':
		case 'property':
		case 'parameter':
		case 'macro':
			return 'variable';
		case 'struct':
		case 'enum':
		case 'union':
		case 'typedef':
		case 'type':
		case 'interface':
			return 'type';
		case 'class':
			return 'class';
		default:
			return symbolKind;
	}
}

function ruleKindFor(symbolKind: string): RelationKind | null {
	switch (ruleCategoryFor(symbolKind)) {
		case 'function':
			return 'callsAndCallers';
		case 'variable':
			return 'referencedByFunctions';
		case 'type':
			return 'contains';
		case 'class':
			return 'derivedClasses';
		default:
			return null;
	}
}

interface GraphNode {
	key: string;
	kind: string;
	name: string;
	container: string | null;
	path: string;
	line: number;
	parentKey: string | null;
	children: string[];
	edgePath: string;
	edgeKind: string;
	edgeCount: number;
	edgeLines: number[];
	access?: 'read' | 'write' | 'call' | 'readWrite';
	callerSide?: boolean;
	hasChildren: boolean;
	expanded: boolean;
	loaded: boolean;
	loading: boolean;
	truncated: boolean;
}

interface GraphEdge {
	id: string;
	from: string;
	to: string;
	kind: string;
	access?: 'read' | 'write' | 'call' | 'readWrite';
	count: number;
	hideCount: boolean;
}

interface LayoutPoint {
	x: number;
	y: number;
	w: number;
	h: number;
	layer: number;
}

interface LayerBand {
	layer: number;
	start: number;
	end: number;
}

interface RoutedLink {
	d: string;
	mx: number;
	my: number;
}

interface DetailRow {
	label: string;
	line: number | null;
}

interface Scene {
	nodes: {
		id: string;
		label: string;
		subtitle: string;
		kind: string;
		x: number;
		y: number;
		w: number;
		h: number;
		root: boolean;
		rows: DetailRow[];
	}[];
	expanders: { id: string; for: string; label: string; x: number; y: number }[];
	edges: GraphEdge[];
	bands: LayerBand[];
	canvasW: number;
	canvasH: number;
}


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
		edgeLines: node.edgeLines ?? [],
		access: node.access,
		callerSide: node.callerSide,
		hasChildren: node.hasChildren,
		expanded: false,
		loaded: false,
		loading: false,
		truncated: false
	};
}

function relationLabel(node: GraphNode): string {
	return `${node.container ? `${node.container}·` : ''}${node.name}${node.truncated ? ' ⋯' : ''}`;
}

function expanderLabel(node: GraphNode): string {
	return node.truncated && !node.expanded ? '⋯' : node.expanded ? '−' : '+';
}

function detailRows(node: GraphNode): DetailRow[] {
	if (node.edgeLines.length < 2) return [];
	const rows: DetailRow[] = node.edgeLines.map((line, index) => ({ label: `${index + 1}. line ${line + 1}`, line }));
	if (node.edgeCount > node.edgeLines.length) rows.push({ label: `… +${node.edgeCount - node.edgeLines.length}`, line: null });
	return rows;
}

/* ---------- Crossing-Minimizing Sugiyama Layer Ordering ---------- */

/** Count edge crossings between two adjacent ordered layers. */
function countPairCrossings(
	upper: GraphNode[],
	lower: GraphNode[],
	adj: Map<string, Set<string>>
): number {
	const posLower = new Map<string, number>();
	lower.forEach((n, i) => posLower.set(n.key, i));
	const pairs: [number, number][] = [];
	upper.forEach((u, ui) => {
		const nbs = adj.get(u.key);
		if (!nbs) return;
		for (const v of nbs) {
			const vi = posLower.get(v);
			if (vi !== undefined) pairs.push([ui, vi]);
		}
	});
	let crossings = 0;
	for (let i = 0; i < pairs.length; i++) {
		const [u1, v1] = pairs[i]!;
		for (let j = i + 1; j < pairs.length; j++) {
			const [u2, v2] = pairs[j]!;
			if ((u1 < u2 && v1 > v2) || (u1 > u2 && v1 < v2)) crossings++;
		}
	}
	return crossings;
}

/** Order nodes within each depth layer using multi-pass barycenter sweeps + adjacent-swap
 *  crossing reduction over BOTH tree edges and cross edges. */
function orderRelationLayers(
	visible: GraphNode[],
	edges: GraphEdge[],
	depthOf: (key: string) => number
): { layerKeys: number[]; byLayer: Map<number, GraphNode[]> } {
	const byLayer = new Map<number, GraphNode[]>();
	const layerOf = new Map<string, number>();
	for (const node of visible) {
		const layer = depthOf(node.key);
		layerOf.set(node.key, layer);
		const list = byLayer.get(layer);
		if (list) list.push(node);
		else byLayer.set(layer, [node]);
	}
	const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);

	// Undirected adjacency between adjacent/different layers for barycenter calculation.
	const neighbors = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		if (a === b) return;
		let sa = neighbors.get(a);
		if (!sa) { sa = new Set(); neighbors.set(a, sa); }
		sa.add(b);
		let sb = neighbors.get(b);
		if (!sb) { sb = new Set(); neighbors.set(b, sb); }
		sb.add(a);
	};
	for (const e of edges) link(e.from, e.to);
	// Also keep parent-child structure even when edge direction points upward.
	for (const n of visible) {
		if (n.parentKey && layerOf.has(n.parentKey)) link(n.parentKey, n.key);
	}

	const rankIndex = new Map<string, number>();
	const refreshIndices = () => {
		for (const key of layerKeys) {
			const list = byLayer.get(key)!;
			for (let i = 0; i < list.length; i++) rankIndex.set(list[i]!.key, i);
		}
	};
	refreshIndices();

	const barycenter = (id: string, targetLayer: number, fallback: number): number => {
		const nbs = neighbors.get(id);
		if (!nbs || nbs.size === 0) return fallback;
		let sum = 0;
		let count = 0;
		for (const nb of nbs) {
			if (layerOf.get(nb) !== targetLayer) continue;
			const idx = rankIndex.get(nb);
			if (idx !== undefined) {
				sum += idx;
				count++;
			}
		}
		return count > 0 ? sum / count : fallback;
	};

	// 4 forward + backward barycenter sweeps.
	for (let pass = 0; pass < 4; pass++) {
		for (let i = 1; i < layerKeys.length; i++) {
			const prevLayer = layerKeys[i - 1]!;
			const list = byLayer.get(layerKeys[i]!)!;
			const scores = new Map<string, number>();
			list.forEach((n, idx) => scores.set(n.key, barycenter(n.key, prevLayer, idx)));
			list.sort((a, b) => (scores.get(a.key)! - scores.get(b.key)!) || a.key.localeCompare(b.key));
			refreshIndices();
		}
		for (let i = layerKeys.length - 2; i >= 0; i--) {
			const nextLayer = layerKeys[i + 1]!;
			const list = byLayer.get(layerKeys[i]!)!;
			const scores = new Map<string, number>();
			list.forEach((n, idx) => scores.set(n.key, barycenter(n.key, nextLayer, idx)));
			list.sort((a, b) => (scores.get(a.key)! - scores.get(b.key)!) || a.key.localeCompare(b.key));
			refreshIndices();
		}
	}

	// Local adjacent-swap polish: swap adjacent siblings in a layer whenever it strictly
	// reduces total crossings with the neighboring layers.
	for (let i = 1; i < layerKeys.length; i++) {
		const prev = byLayer.get(layerKeys[i - 1]!)!;
		const list = byLayer.get(layerKeys[i]!)!;
		if (list.length < 2 || list.length > 32) continue;
		const next = i + 1 < layerKeys.length ? byLayer.get(layerKeys[i + 1]!)! : null;
		let improved = true;
		for (let iter = 0; iter < 3 && improved; iter++) {
			improved = false;
			for (let j = 0; j < list.length - 1; j++) {
				const before = countPairCrossings(prev, list, neighbors)
					+ (next ? countPairCrossings(list, next, neighbors) : 0);
				[list[j], list[j + 1]] = [list[j + 1]!, list[j]!];
				const after = countPairCrossings(prev, list, neighbors)
					+ (next ? countPairCrossings(list, next, neighbors) : 0);
				if (after < before) {
					improved = true;
				} else {
					[list[j], list[j + 1]] = [list[j + 1]!, list[j]!];
				}
			}
		}
	}

	return { layerKeys, byLayer };
}

/** Compute spatially sorted port offsets on each card so edges fan out/in without crossing. */
function computeRelationPorts(
	edges: GraphEdge[],
	layout: Map<string, LayoutPoint>,
	horizontal: boolean
): { outOffset: Map<string, number>; inOffset: Map<string, number> } {
	const outByNode = new Map<string, GraphEdge[]>();
	const inByNode = new Map<string, GraphEdge[]>();
	for (const e of edges) {
		if (!layout.has(e.from) || !layout.has(e.to)) continue;
		const ol = outByNode.get(e.from);
		if (ol) ol.push(e);
		else outByNode.set(e.from, [e]);
		const il = inByNode.get(e.to);
		if (il) il.push(e);
		else inByNode.set(e.to, [e]);
	}

	const outOffset = new Map<string, number>();
	const inOffset = new Map<string, number>();

	const assign = (groups: Map<string, GraphEdge[]>, targetMap: Map<string, number>, isOut: boolean) => {
		for (const [nodeId, list] of groups) {
			if (list.length <= 1) {
				if (list.length === 1) targetMap.set(list[0]!.id, 0);
				continue;
			}
			const host = layout.get(nodeId)!;
			const span = horizontal ? Math.min(host.h, NODE_H) * 0.56 : host.w * 0.62;
			list.sort((a, b) => {
				const otherA = layout.get(isOut ? a.to : a.from)!;
				const otherB = layout.get(isOut ? b.to : b.from)!;
				const coordA = horizontal ? otherA.y + otherA.h / 2 : otherA.x + otherA.w / 2;
				const coordB = horizontal ? otherB.y + otherB.h / 2 : otherB.x + otherB.w / 2;
				return coordA - coordB || a.id.localeCompare(b.id);
			});
			const n = list.length;
			for (let i = 0; i < n; i++) {
				const ratio = i / (n - 1) - 0.5;
				targetMap.set(list[i]!.id, ratio * Math.min(span, (n - 1) * 16));
			}
		}
	};

	assign(outByNode, outOffset, true);
	assign(inByNode, inOffset, false);
	return { outOffset, inOffset };
}

/** Route an edge as a smooth cubic Bezier curve with distributed ports and outer-arc
 *  avoidance for same-layer, reverse, self, and bidirectional edges. */
function routeRelationEdge(
	from: LayoutPoint,
	to: LayoutPoint,
	horizontal: boolean,
	outOff: number,
	inOff: number,
	isBidirectional: boolean,
	fromId: string,
	toId: string
): RoutedLink {
	// Self-recursion loop: neat arc on the card's right face.
	if (fromId === toId) {
		const sx = from.x + from.w;
		const sy = from.y + 12;
		const ex = from.x + from.w;
		const ey = from.y + Math.min(from.h - 10, NODE_H - 10);
		const loopX = sx + 34;
		return {
			d: `M ${sx} ${sy} C ${loopX} ${sy - 14}, ${loopX} ${ey + 14}, ${ex} ${ey}`,
			mx: sx + 26,
			my: (sy + ey) / 2
		};
	}

	const fx = from.x + from.w / 2;
	const fy = from.y + from.h / 2;
	const tx = to.x + to.w / 2;
	const ty = to.y + to.h / 2;
	const biShift = isBidirectional ? (fromId < toId ? -7 : 7) : 0;

	if (!horizontal) {
		// Vertical (TB) mode
		if (Math.abs(from.y - to.y) < 12) {
			// Same-row cross edge: arch cleanly above or below so it never cuts through cards.
			const archUp = from.x < to.x;
			const sx = fx + outOff * 0.45 + biShift;
			const sy = archUp ? from.y : from.y + from.h;
			const ex = tx + inOff * 0.45 + biShift;
			const ey = archUp ? to.y : to.y + to.h;
			const span = Math.abs(ex - sx);
			const lift = Math.min(68, 24 + span * 0.13) * (archUp ? -1 : 1);
			const cy = sy + lift;
			return {
				d: `M ${sx} ${sy} C ${sx} ${cy}, ${ex} ${cy}, ${ex} ${ey}`,
				mx: (sx + ex) / 2,
				my: sy + lift * 0.72
			};
		}

		if (from.y < to.y) {
			// Downward flow: bottom face → top face.
			const sx = fx + outOff + biShift * 0.5;
			const sy = from.y + from.h;
			const ex = tx + inOff + biShift * 0.5;
			const ey = to.y;
			const dy = Math.max(24, (ey - sy) * 0.46);
			const cx1 = sx;
			const cy1 = sy + dy;
			const cx2 = ex;
			const cy2 = ey - dy;
			return {
				d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
				mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
				my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey
			};
		}

		// Upward flow (callers pointing up to root/parent): top face → bottom face.
		const sx = fx + outOff + biShift * 0.5;
		const sy = from.y;
		const ex = tx + inOff + biShift * 0.5;
		const ey = to.y + to.h;
		const dy = Math.max(24, (sy - ey) * 0.46);
		const cx1 = sx;
		const cy1 = sy - dy;
		const cx2 = ex;
		const cy2 = ey + dy;
		return {
			d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
			mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
			my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey
		};
	}

	// Horizontal (LR) mode
	if (Math.abs(from.x - to.x) < 12) {
		const archLeft = from.y < to.y;
		const sx = archLeft ? from.x : from.x + from.w;
		const sy = fy + outOff * 0.45 + biShift;
		const ex = archLeft ? to.x : to.x + to.w;
		const ey = ty + inOff * 0.45 + biShift;
		const span = Math.abs(ey - sy);
		const lift = Math.min(68, 24 + span * 0.13) * (archLeft ? -1 : 1);
		const cx = sx + lift;
		return {
			d: `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ey}, ${ex} ${ey}`,
			mx: sx + lift * 0.72,
			my: (sy + ey) / 2
		};
	}

	if (from.x < to.x) {
		const sx = from.x + from.w;
		const sy = from.y + NODE_H / 2 + outOff + biShift * 0.5;
		const ex = to.x;
		const ey = to.y + NODE_H / 2 + inOff + biShift * 0.5;
		const dx = Math.max(28, (ex - sx) * 0.46);
		const cx1 = sx + dx;
		const cy1 = sy;
		const cx2 = ex - dx;
		const cy2 = ey;
		return {
			d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
			mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
			my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey
		};
	}

	const sx = from.x;
	const sy = from.y + NODE_H / 2 + outOff + biShift * 0.5;
	const ex = to.x + to.w;
	const ey = to.y + NODE_H / 2 + inOff + biShift * 0.5;
	const dx = Math.max(28, (sx - ex) * 0.46);
	const cx1 = sx - dx;
	const cy1 = sy;
	const cx2 = ex + dx;
	const cy2 = ey;
	return {
		d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
		mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
		my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey
	};
}

export class RelationGraphView {
	readonly element: HTMLElement;
	readonly controls: HTMLElement;

	onOpen?: (path: string, line: number) => void;
	onShowDefinition?: (subject: DefinitionSubject) => void;
	onPinChange?: (pinned: boolean) => void;
	onRootChange?: (root: RelationRoot | null) => void;
	resolvePath?: (path: string) => string;

	private readonly stage: HTMLElement;
	private readonly board: SVGSVGElement;
	private readonly world: SVGGElement;
	private readonly bandLayer: SVGGElement;
	private readonly edgeLayer: SVGGElement;
	private readonly cardLayer: SVGGElement;
	private readonly hint: HTMLElement;

	private root: RelationRoot | null = null;
	private kind: RelationKind = 'refsTo';
	private emptyVerdict = false;
	private readonly nodes = new Map<string, GraphNode>();
	private rootKey = '';
	private readonly crossEdges: GraphEdge[] = [];
	private readonly crossSeen = new Set<string>();
	private generation = 0;
	private rootLoading = false;
	private rootFailed = false;
	private rootNote: string | undefined;
	private rootMetrics: SymSlotMetrics | undefined;
	private pinned = false;
	private selectedKey: string | null = null;

	private readonly layout = new Map<string, LayoutPoint>();
	private readonly layoutExp = new Map<string, { x: number; y: number }>();
	private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

	private camX = 0;
	private camY = 0;
	private camScale = 1;

	private readonly moves = new Map<string, { fx: number; fy: number; start: number }>();
	private moveHandle: number | null = null;
	private settle: (() => void) | null = null;

	private readonly painted = new Map<string, { x: number; y: number }>();
	private readonly cardEls = new Map<string, SVGGElement>();
	private readonly edgeEls = new Map<string, SVGGElement>();
	private readonly edgeEnds = new Map<string, { from: string; to: string }>();
	private lastOutOffset = new Map<string, number>();
	private lastInOffset = new Map<string, number>();
	private lastPairSet = new Set<string>();
	private outEdgesByNode = new Map<string, GraphEdge[]>();
	private inEdgesByNode = new Map<string, GraphEdge[]>();
	private activeHoverEls: SVGElement[] = [];

	private readonly kindButton: HTMLButtonElement;
	private readonly pinButton: HTMLButtonElement;
	private readonly viewButton: HTMLButtonElement;
	private readonly backButton: HTMLButtonElement;
	private readonly forwardButton: HTMLButtonElement;


	private viewMode: RelationViewMode = load<RelationViewMode>(VIEW_KEY, 'graphVertical');
	private readonly outline: HTMLElement;
	private readonly outlineHead: HTMLElement;
	private readonly outlineList: HTMLElement;

	private readonly history: { root: RelationRoot; kind: RelationKind }[] = [];
	private historyAt = -1;
	private historying = false;
	private lastCategory = '';

	constructor() {
		this.stage = el('div', 'rg-stage');
		this.outlineHead = el('div', 'rg-ol-head');
		this.outlineList = el('div', 'rg-ol-list');
		this.outline = el('div', 'rg-outline', [this.outlineHead, this.outlineList]);
		this.board = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.board.classList.add('rg-board');
		this.board.setAttribute('tabindex', '0');
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		this.world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.bandLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.cardLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this.world.append(defs, this.bandLayer, this.edgeLayer, this.cardLayer);
		this.board.appendChild(this.world);
		this.hint = el('div', 'rg-hint rg-hint-overlay');
		this.element = el('div', 'rg-root', [this.stage, this.outline, this.hint]);
		this.stage.appendChild(this.board);
		this.applyViewSurface();

		this.board.addEventListener('wheel', this.onWheel, { passive: false });
		this.board.addEventListener('pointerdown', this.onPointerDown);
		this.board.addEventListener('keydown', this.onBoardKeyDown);

		this.kindButton = el('button', 'rg-dir rg-kind') as HTMLButtonElement;
		this.kindButton.addEventListener('click', (event) => this.showKindPicker(event));
		this.backButton = el('button', 'rg-dir rg-back', [icon('arrow-left')]) as HTMLButtonElement;
		this.backButton.addEventListener('click', () => this.goHistory(-1));
		this.forwardButton = el('button', 'rg-dir rg-forward', [icon('arrow-right')]) as HTMLButtonElement;
		this.forwardButton.addEventListener('click', () => this.goHistory(1));
		this.viewButton = el('button', 'rg-dir rg-view') as HTMLButtonElement;
		this.viewButton.addEventListener('click', () => this.cycleView());
		this.viewButton.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.showViewPicker(event);
		});
		const fit = el('button', 'rg-dir', [icon('screen-full')]);
		fit.title = t('symbols.graph.fit');
		fit.addEventListener('click', () => this.fit());
		this.pinButton = el('button', 'rg-dir rg-pin') as HTMLButtonElement;
		this.pinButton.addEventListener('click', () => this.togglePin());
		this.controls = el('div', 'rg-controls', [this.kindButton, this.backButton, this.forwardButton, this.viewButton, this.pinButton, fit]);
		this.paintControls();

		this.render();
	}

	dispose(): void {
		this.stopMoves();
	}

	pinRoot(sym: RelationRoot): void {
		this.pinned = true;
		this.paintControls();
		this.setRoot(sym);
	}

	private computeBounds(): void {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const span = (x: number, y: number, w: number, h: number): void => {
			minX = Math.min(minX, x); minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
		};
		for (const spot of this.layout.values()) span(spot.x, spot.y, spot.w, spot.h);
		for (const exp of this.layoutExp.values()) span(exp.x - EXPANDER_R, exp.y - EXPANDER_R, EXPANDER_R * 2, EXPANDER_R * 2);
		this.bounds = { minX, minY, maxX, maxY };
	}

	/* ---------- Root and direction ---------- */

	setRoot(root: RelationRoot | null, note?: string): void {
		const same =
			this.root !== null && root !== null && this.root.name === root.name && this.root.path === root.path && this.root.line === root.line;
		if (same && !note) return;
		this.root = root ? { kind: root.kind, name: root.name, path: root.path, line: root.line } : null;
		this.rootNote = note;
		this.onRootChange?.(this.root);
		if (root && !this.historying) {
			const category = ruleCategoryFor(root.kind);
			const rule = ruleKindFor(root.kind);
			if (rule !== null && category !== this.lastCategory) {
				this.kind = rule;
				this.paintControls();
			}
			this.lastCategory = category;
			this.pushHistory();
		}
		this.historying = false;
		void this.loadRoot();
	}

	private setKind(kind: RelationKind): void {
		if (this.kind === kind) return;
		this.kind = kind;
		const entry = this.history[this.historyAt];
		if (entry) entry.kind = kind;
		void this.loadRoot();
	}

	private showKindPicker(event: MouseEvent): void {
		const activeKind = this.kind === 'refsTo' ? 'referencedByFunctions' : this.kind;
		const entries: MenuEntry[] = PICKER_KINDS.map((entry) => ({
			label: t(entry.label),
			checked: activeKind === entry.kind,
			run: () => this.setKind(entry.kind)
		}));
		showContextMenu(event.clientX, event.clientY, entries);
	}

	private ringKind(node: GraphNode): RelationKind {
		if (this.kind !== 'callsAndCallers') return this.kind;
		return this.callsSide(node) ? 'calls' : 'callers';
	}

	private callsSide(node: GraphNode): boolean {
		if (node.callerSide !== undefined) return !node.callerSide;
		return node.edgePath === (this.root?.path ?? '');
	}

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
		this.clearHoverHighlight();
		this.selectedKey = null;
		this.rootMetrics = undefined;
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
				{ ...root, container: null, edgePath: root.path, edgeLine: root.line, edgeKind: '', edgeCount: 1, edgeLines: [root.line], hasChildren: true },
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
			this.rootMetrics = answer?.rootMetrics;
			const node = this.nodes.get(this.rootKey);
			if (node) {
				node.hasChildren = (answer?.nodes.length ?? 0) > 0;
				node.truncated = answer?.truncated === true;
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

	private absorbRing(node: GraphNode, ring: RelationNode[]): void {
		node.children = [];
		for (const entry of ring) {
			const key = nodeKey(entry.name, entry.path, entry.line);
			if (this.nodes.has(key)) {
				const up = this.kind === 'callsAndCallers'
					? (entry.callerSide !== undefined ? entry.callerSide : entry.edgePath !== (this.root?.path ?? ''))
					: this.pointsUp(node);
				const from = up ? key : node.key;
				const to = up ? node.key : key;
				const seen = `${from}\u0000${to}`;
				if (!this.crossSeen.has(seen)) {
					this.crossSeen.add(seen);
					this.crossEdges.push({ id: seen, from, to, kind: entry.edgeKind || 'member', access: entry.access, count: entry.edgeCount, hideCount: false });
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
		const displayKind = this.kind === 'refsTo' ? 'referencedByFunctions' : this.kind;
		const current = PICKER_KINDS.find((entry) => entry.kind === displayKind) ?? PICKER_KINDS[0];
		this.kindButton.textContent = '';
		this.kindButton.append(el('span', 'rg-kind-label', [t(current.label)]), icon('chevron-down'));
		this.kindButton.title = t('relations.kind.pick');
		this.kindButton.setAttribute('aria-label', this.kindButton.title);
		this.pinButton.title = this.pinned ? t('relations.unpin') : t('relations.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.textContent = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.pinButton.classList.toggle('active', this.pinned);
		this.paintNavButtons();
		this.paintViewButton();
	}

	private paintNavButtons(): void {
		this.backButton.title = t('relations.back');
		this.backButton.setAttribute('aria-label', this.backButton.title);
		this.backButton.disabled = this.historyAt <= 0;
		this.forwardButton.title = t('relations.forward');
		this.forwardButton.setAttribute('aria-label', this.forwardButton.title);
		this.forwardButton.disabled = this.historyAt >= this.history.length - 1;
	}

	private paintViewButton(): void {
		this.viewButton.textContent = '';
		this.viewButton.append(icon(this.viewMode === 'outline' ? 'list-flat' : 'graph'), el('span', 'rg-kind-label', [t(VIEW_LABELS[this.viewMode])]));
		this.viewButton.title = t('relations.view.next');
		this.viewButton.setAttribute('aria-label', this.viewButton.title);
	}

	/* ---------- Views ---------- */

	cycleView(): void {
		const at = VIEW_MODES.indexOf(this.viewMode);
		this.setViewMode(VIEW_MODES[(at + 1) % VIEW_MODES.length]!);
	}

	setViewMode(mode: RelationViewMode): void {
		if (this.viewMode === mode) return;
		this.viewMode = mode;
		save(VIEW_KEY, mode);
		this.applyViewSurface();
		this.paintControls();
		this.render();
		if (mode !== 'outline') window.requestAnimationFrame(() => this.fit());
	}

	private applyViewSurface(): void {
		const graph = this.viewMode !== 'outline';
		this.stage.style.display = graph ? '' : 'none';
		this.outline.style.display = graph ? 'none' : '';
	}

	private showViewPicker(event: MouseEvent): void {
		const entries: MenuEntry[] = VIEW_MODES.map((mode) => ({
			label: t(VIEW_LABELS[mode]),
			checked: this.viewMode === mode,
			run: () => this.setViewMode(mode)
		}));
		showContextMenu(event.clientX, event.clientY, entries);
	}

	/* ---------- History ---------- */

	private pushHistory(): void {
		if (!this.root) return;
		const top = this.history[this.historyAt];
		if (top && top.root.name === this.root.name && top.root.path === this.root.path && top.root.line === this.root.line) {
			top.kind = this.kind;
			return;
		}
		this.history.length = this.historyAt + 1;
		this.history.push({ root: { ...this.root }, kind: this.kind });
		if (this.history.length > 100) this.history.shift();
		this.historyAt = this.history.length - 1;
		this.paintNavButtons();
	}

	private goHistory(delta: number): void {
		const at = this.historyAt + delta;
		const entry = this.history[at];
		if (!entry) return;
		this.historyAt = at;
		this.paintNavButtons();
		this.historying = true;
		if (this.kind !== entry.kind) {
			this.kind = entry.kind;
			this.paintControls();
		}
		const current = this.root;
		const same = current !== null && current.name === entry.root.name && current.path === entry.root.path && current.line === entry.root.line;
		if (same) {
			this.historying = false;
			void this.loadRoot();
		} else {
			this.setRoot({ ...entry.root });
		}
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

	private depthOf(key: string): number {
		let depth = 0;
		let at = this.nodes.get(key);
		while (at && at.parentKey !== null) {
			depth++;
			at = this.nodes.get(at.parentKey);
		}
		return depth;
	}

	private layerOf(key: string, splitCallers: boolean): number {
		let depth = 0;
		let at = this.nodes.get(key);
		let branchRoot: GraphNode | undefined;
		while (at && at.parentKey !== null) {
			depth++;
			if (at.parentKey === this.rootKey) branchRoot = at;
			at = this.nodes.get(at.parentKey);
		}
		if (splitCallers && depth > 0 && branchRoot && !this.callsSide(branchRoot)) return -depth;
		return depth;
	}

	/* ---------- Module-Style Layered Layout with Crossing Minimization ---------- */

	private visibleEdgeList(): GraphEdge[] {
		const edges: GraphEdge[] = [];
		const visible = new Set(this.visibleNodes().map((node) => node.key));
		for (const node of this.nodes.values()) {
			if (!node.expanded || !visible.has(node.key)) continue;
			for (const key of node.children) {
				const child = this.nodes.get(key);
				if (!child) continue;
				const up = this.pointsUp(child);
				const from = up ? key : node.key;
				const to = up ? node.key : key;
				edges.push({
					id: `${from}\u0000${to}`,
					from,
					to,
					kind: child.edgeKind,
					access: child.access,
					count: child.edgeCount,
					hideCount: detailRows(child).length > 0
				});
			}
		}
		for (const edge of this.crossEdges) {
			if (visible.has(edge.from) && visible.has(edge.to)) edges.push(edge);
		}
		return edges;
	}

	private cardWidth(node: GraphNode): number {
		const titleW = estimateLabelWidth(relationLabel(node)) + 34;
		const subW = estimateLabelWidth(cardSubtitle(node, node.parentKey === null ? this.rootMetrics : undefined)) * 0.88 + 26;
		return Math.max(132, Math.min(320, Math.ceil(Math.max(titleW, subW))));
	}

	private nodeHeight(node: GraphNode): number {
		return NODE_H + detailRows(node).length * DETAIL_ROW_H;
	}

	/** Compute module-diagram-style layered positions (TB or LR) with barycenter
	 *  crossing minimization and balanced sub-band wrapping. */
	private buildScene(): Scene {
		this.layout.clear();
		this.layoutExp.clear();
		const visible = this.visibleNodes();
		const edges = this.visibleEdgeList();
		const bands: LayerBand[] = [];
		let canvasW = 360;
		let canvasH = 240;

		if (visible.length > 0) {
			// Bi-directional Calls & Callers layout (Source Insight style): when a function
			// has BOTH callers and callees, callers sit upstream (layers -1, -2, ...) and
			// callees sit downstream (layers +1, +2, ...) with the root centered at layer 0.
			let splitCallers = false;
			if (this.kind === 'callsAndCallers') {
				const rootNode = this.nodes.get(this.rootKey);
				if (rootNode?.expanded) {
					let hasCaller = false;
					let hasCallee = false;
					for (const childKey of rootNode.children) {
						const child = this.nodes.get(childKey);
						if (!child) continue;
						if (this.callsSide(child)) hasCallee = true;
						else hasCaller = true;
					}
					splitCallers = hasCaller && hasCallee;
				}
			}
			const { layerKeys, byLayer } = orderRelationLayers(visible, edges, (k) => this.layerOf(k, splitCallers));
			const horizontal = this.viewMode === 'graphHorizontal';

			if (!horizontal) {
				// Top-to-Bottom layered bands.
				const rows: {
					layer: number;
					items: GraphNode[];
					widths: number[];
					maxH: number;
					rowWidth: number;
					gapAbove: number;
					firstInLayer: boolean;
				}[] = [];
				let maxRowWidth = 160;

				for (const layer of layerKeys) {
					const items = byLayer.get(layer)!;
					const numSubRows = Math.ceil(items.length / MAX_PER_BAND);
					const cols = Math.min(MAX_PER_BAND, Math.max(1, Math.ceil(items.length / numSubRows)));
					for (let i = 0; i < items.length; i += cols) {
						const chunk = items.slice(i, i + cols);
						const widths = chunk.map((n) => this.cardWidth(n));
						const maxH = Math.max(...chunk.map((n) => this.nodeHeight(n)));
						const rowWidth = widths.reduce((a, b) => a + b, 0) + Math.max(0, chunk.length - 1) * TB_COL_GAP;
						if (rowWidth > maxRowWidth) maxRowWidth = rowWidth;
						rows.push({
							layer,
							items: chunk,
							widths,
							maxH,
							rowWidth,
							gapAbove: rows.length === 0 ? 0 : i === 0 ? TB_ROW_GAP : TB_SUBROW_GAP,
							firstInLayer: i === 0
						});
					}
				}

				canvasW = Math.max(360, maxRowWidth + PAD_X * 2);
				let cursorY = PAD_Y;
				let activeBand: LayerBand | null = null;

				for (const row of rows) {
					cursorY += row.gapAbove;
					if (row.firstInLayer) {
						if (activeBand) bands.push(activeBand);
						activeBand = { layer: row.layer, start: cursorY - 12, end: cursorY + row.maxH + 12 };
					} else if (activeBand) {
						activeBand.end = cursorY + row.maxH + 12;
					}
					let cursorX = (canvasW - row.rowWidth) / 2;
					row.items.forEach((node, idx) => {
						const w = row.widths[idx]!;
						const h = this.nodeHeight(node);
						this.layout.set(node.key, { x: cursorX, y: cursorY, w, h, layer: row.layer });
						if (node.hasChildren) {
							const expY = row.layer < 0 ? cursorY - EXPANDER_OFF : cursorY + h + EXPANDER_OFF;
							this.layoutExp.set(node.key, { x: cursorX + w / 2, y: expY });
						}
						cursorX += w + TB_COL_GAP;
					});
					cursorY += row.maxH;
				}
				if (activeBand) bands.push(activeBand);
				canvasH = Math.max(240, cursorY + PAD_Y + 14);
			} else {
				// Left-to-Right layered columns.
				const cols: {
					layer: number;
					items: GraphNode[];
					heights: number[];
					maxW: number;
					colHeight: number;
					gapLeft: number;
					firstInLayer: boolean;
				}[] = [];
				let maxColHeight = NODE_H;

				for (const layer of layerKeys) {
					const items = byLayer.get(layer)!;
					const numSubCols = Math.ceil(items.length / MAX_PER_BAND);
					const perCol = Math.min(MAX_PER_BAND, Math.max(1, Math.ceil(items.length / numSubCols)));
					for (let i = 0; i < items.length; i += perCol) {
						const chunk = items.slice(i, i + perCol);
						const heights = chunk.map((n) => this.nodeHeight(n));
						const maxW = Math.max(...chunk.map((n) => this.cardWidth(n)));
						const colHeight = heights.reduce((a, b) => a + b, 0) + Math.max(0, chunk.length - 1) * LR_ROW_GAP;
						if (colHeight > maxColHeight) maxColHeight = colHeight;
						cols.push({
							layer,
							items: chunk,
							heights,
							maxW,
							colHeight,
							gapLeft: cols.length === 0 ? 0 : i === 0 ? LR_COL_GAP : LR_SUBCOL_GAP,
							firstInLayer: i === 0
						});
					}
				}

				canvasH = Math.max(240, maxColHeight + PAD_Y * 2);
				let cursorX = PAD_X;
				let activeBand: LayerBand | null = null;

				for (const col of cols) {
					cursorX += col.gapLeft;
					if (col.firstInLayer) {
						if (activeBand) bands.push(activeBand);
						activeBand = { layer: col.layer, start: cursorX - 12, end: cursorX + col.maxW + 12 };
					} else if (activeBand) {
						activeBand.end = cursorX + col.maxW + 12;
					}
					let cursorY = (canvasH - col.colHeight) / 2;
					col.items.forEach((node, idx) => {
						const w = this.cardWidth(node);
						const h = col.heights[idx]!;
						this.layout.set(node.key, { x: cursorX, y: cursorY, w, h, layer: col.layer });
						if (node.hasChildren) {
							const expX = col.layer < 0 ? cursorX - EXPANDER_OFF : cursorX + w + EXPANDER_OFF;
							this.layoutExp.set(node.key, { x: expX, y: cursorY + NODE_H / 2 });
						}
						cursorY += h + LR_ROW_GAP;
					});
					cursorX += col.maxW;
				}
				if (activeBand) bands.push(activeBand);
				canvasW = Math.max(360, cursorX + PAD_X + 14);
			}
		}

		this.computeBounds();
		const nodes: Scene['nodes'] = [];
		const expanders: Scene['expanders'] = [];
		for (const node of visible) {
			const spot = this.layout.get(node.key);
			if (!spot) continue;
			nodes.push({
				id: node.key,
				label: relationLabel(node),
				subtitle: cardSubtitle(node, node.parentKey === null ? this.rootMetrics : undefined),
				kind: node.kind,
				x: spot.x,
				y: spot.y,
				w: spot.w,
				h: spot.h,
				root: node.parentKey === null,
				rows: detailRows(node)
			});
			if (node.hasChildren) {
				const exp = this.layoutExp.get(node.key)!;
				expanders.push({ id: `${node.key}\u0000+`, for: node.key, label: expanderLabel(node), x: exp.x, y: exp.y });
			}
		}
		return { nodes, expanders, edges, bands, canvasW, canvasH };
	}

	/* ---------- Rendering ---------- */

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
			this.hint.appendChild(el('span', undefined, [t(EMPTY_VERDICTS[this.kind] ?? 'relations.empty.refsFrom')]));
			this.hint.hidden = false;
		}
		if (this.viewMode === 'outline') this.paintOutline();
		else this.paintBoard(this.buildScene());
	}

	/* ---------- Outline View ---------- */

	private paintOutline(): void {
		const activeKind = this.kind === 'refsTo' ? 'referencedByFunctions' : this.kind;
		const current = PICKER_KINDS.find((entry) => entry.kind === activeKind) ?? PICKER_KINDS[0];
		this.outlineHead.textContent = '';
		this.outlineHead.append(
			el('span', 'rg-ol-twistie'),
			el('span', 'rg-ol-name', [t(current.label)]),
			el('span', 'rg-ol-count', [t('relations.outline.count')]),
			el('span', 'rg-ol-file', [t('relations.outline.file')]),
			el('span', 'rg-ol-line', [t('relations.outline.line')])
		);
		this.outlineList.textContent = '';
		for (const node of this.visibleNodes()) this.outlineList.appendChild(this.outlineRow(node));
	}

	private branchSuffix(node: GraphNode): string {
		const kind = node.parentKey === null ? this.kind : this.ringKind(node);
		if (kind === 'calls') return ` ${t('relations.suffix.calls')}`;
		if (kind === 'callers' || kind === 'referencedByFunctions') return ` ${t('relations.suffix.callers')}`;
		return '';
	}

	private outlineRow(node: GraphNode): HTMLElement {
		const row = el('div', 'rg-ol-row');
		row.dataset['id'] = node.key;
		const depth = this.depthOf(node.key);
		if (depth > 0) row.style.paddingLeft = `${4 + depth * 14}px`;
		const twist = el('span', 'rg-ol-twistie');
		if (node.hasChildren) {
			twist.textContent = expanderLabel(node);
			twist.classList.add('rg-ol-toggle');
			twist.title = node.expanded ? t('relations.collapse') : t('relations.expand');
			twist.addEventListener('click', (event) => {
				event.stopPropagation();
				void this.toggleExpand(node.key);
			});
		}
		const name = el('span', 'rg-ol-name', [
			icon(KIND_ICONS[node.kind] ?? 'symbol-misc'),
			el('span', 'rg-ol-label', [relationLabel(node)])
		]);
		if (node.access === 'write' || node.access === 'readWrite') {
			const cls = node.access === 'write' ? 'rg-access-badge rg-access-w' : 'rg-access-badge rg-access-rw';
			const tag = node.access === 'write' ? '[W]' : '[R/W]';
			name.appendChild(el('span', cls, [tag]));
		}
		const suffix = this.branchSuffix(node);
		if (suffix) name.appendChild(el('span', 'rg-ol-suffix', [suffix]));
		const count = el('span', 'rg-ol-count', [node.edgeCount > 1 ? String(node.edgeCount) : '']);
		const file = el('span', 'rg-ol-file', [baseName(node.path)]);
		const line = el('span', 'rg-ol-line', [String(node.line + 1)]);
		row.append(twist, name, count, file, line);
		row.title = `${node.path}:${node.line + 1}`;
		row.addEventListener('click', () => this.showInDefinition(node, node.path, node.line));
		row.addEventListener('dblclick', () => this.onOpen?.(node.path, node.line + 1));
		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.showCardMenu(event.clientX, event.clientY, node.key);
		});
		return row;
	}

	private clearBoard(): void {
		this.stopMoves();
		this.clearHoverHighlight();
		this.painted.clear();
		this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		this.outlineHead.textContent = '';
		this.outlineList.textContent = '';

		while (this.bandLayer.firstChild) this.bandLayer.firstChild.remove();
		for (const g of this.cardEls.values()) g.remove();
		for (const g of this.edgeEls.values()) g.remove();
		this.cardEls.clear();
		this.edgeEls.clear();
		this.edgeEnds.clear();
		this.outEdgesByNode.clear();
		this.inEdgesByNode.clear();
		this.applyCamera();
	}

	private paintBoard(scene: Scene): void {
		this.clearHoverHighlight();
		const palette = themePalette();
		this.paintMarkers(palette);
		this.paintBands(scene);

		// Build adjacency indices for O(degree) hover neighborhood highlighting.
		this.outEdgesByNode.clear();
		this.inEdgesByNode.clear();
		this.lastPairSet = new Set(scene.edges.map((e) => `${e.from}\u0000${e.to}`));
		for (const e of scene.edges) {
			const ol = this.outEdgesByNode.get(e.from);
			if (ol) ol.push(e);
			else this.outEdgesByNode.set(e.from, [e]);
			const il = this.inEdgesByNode.get(e.to);
			if (il) il.push(e);
			else this.inEdgesByNode.set(e.to, [e]);
		}

		// Cards: diff in place, new ones fade in, moved ones glide.
		const seenCards = new Set<string>();
		for (const node of scene.nodes) {
			seenCards.add(node.id);
			let g = this.cardEls.get(node.id);
			if (!g) {
				g = this.makeCard(node, palette);
				this.cardEls.set(node.id, g);
				this.cardLayer.appendChild(g);
			}
			this.updateCard(g, node, palette);
			const prior = this.painted.get(node.id);
			this.painted.set(node.id, { x: node.x, y: node.y });
			if (prior && (prior.x !== node.x || prior.y !== node.y)) {
				this.startMove(node.id, prior.x, prior.y);
				this.placeCard(g, node.x, node.y);
			} else if (!prior) {
				this.placeCard(g, node.x, node.y);
				g.classList.add('rg-enter');
				window.setTimeout(() => g?.classList.remove('rg-enter'), 240);
			}
			g.classList.toggle('rg-root', node.root);
			g.classList.toggle('rg-selected', this.selectedKey === node.id);
		}

		// Expanders.
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
				window.setTimeout(() => g?.classList.remove('rg-enter'), 240);
			}
		}

		for (const [id, g] of this.cardEls) {
			if (!seenCards.has(id) && !seenExp.has(id)) {
				g.remove();
				this.cardEls.delete(id);
				this.painted.delete(id);
			}
		}

		// Compute spatially sorted port offsets so edges fan out/in without crossing.
		const horizontal = this.viewMode === 'graphHorizontal';
		const { outOffset, inOffset } = computeRelationPorts(scene.edges, this.layout, horizontal);
		this.lastOutOffset = outOffset;
		this.lastInOffset = inOffset;

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
			this.paintEdge(g, edge, palette, outOffset.get(edge.id) ?? 0, inOffset.get(edge.id) ?? 0);
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

	/** Subtle layer guide bands: in Calls & Callers shows Callers / Calls labels. */
	private paintBands(scene: Scene): void {
		while (this.bandLayer.firstChild) this.bandLayer.firstChild.remove();
		if (scene.bands.length < 2) return;
		const horizontal = this.viewMode === 'graphHorizontal';
		const hasNegative = scene.bands.some((b) => b.layer < 0);
		for (const band of scene.bands) {
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.classList.add('rg-layer-band');
			rect.setAttribute('rx', '12');
			const tag = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			tag.classList.add('rg-layer-tag');
			tag.textContent = hasNegative
				? (band.layer < 0 ? `${t('relations.kind.callers')}${band.layer < -1 ? ` (${-band.layer})` : ''}` : band.layer > 0 ? `${t('relations.kind.calls')}${band.layer > 1 ? ` (${band.layer})` : ''}` : '')
				: `L${band.layer}`;
			if (!horizontal) {
				rect.setAttribute('x', '12');
				rect.setAttribute('y', String(band.start));
				rect.setAttribute('width', String(Math.max(0, scene.canvasW - 24)));
				rect.setAttribute('height', String(Math.max(0, band.end - band.start)));
				tag.setAttribute('x', '20');
				tag.setAttribute('y', String(band.start + 13));
			} else {
				rect.setAttribute('x', String(band.start));
				rect.setAttribute('y', '12');
				rect.setAttribute('width', String(Math.max(0, band.end - band.start)));
				rect.setAttribute('height', String(Math.max(0, scene.canvasH - 24)));
				tag.setAttribute('x', String(band.start + 10));
				tag.setAttribute('y', '26');
			}
			this.bandLayer.append(rect, tag);
		}
	}

	private paintMarkers(palette: ReturnType<typeof themePalette>): void {
		const defs = this.world.querySelector('defs')!;
		while (defs.firstChild) defs.firstChild.remove();
		const makeMarker = (id: string, color: string) => {
			const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
			marker.setAttribute('id', id);
			marker.setAttribute('viewBox', '0 0 10 10');
			marker.setAttribute('refX', '8.5');
			marker.setAttribute('refY', '5');
			marker.setAttribute('markerWidth', '7');
			marker.setAttribute('markerHeight', '7');
			marker.setAttribute('markerUnits', 'userSpaceOnUse');
			marker.setAttribute('orient', 'auto-start-reverse');
			const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			head.setAttribute('d', 'M 1 1.6 L 8.8 5 L 1 8.4 L 2.8 5 z');
			head.setAttribute('fill', color);
			marker.appendChild(head);
			return marker;
		};
		defs.append(
			makeMarker('rg-arr', palette.link),
			makeMarker('rg-arr-in', '#4ec9b0'),
			makeMarker('rg-arr-out', '#569cd6')
		);
	}

	/** Build a module-diagram-style vector card: main rounded shell (`rect` first for
	 *  geometry queries), subtle header tint, semantic kind accent bar, title (`text` first),
	 *  file:line subtitle, and detail rows container. */
	private makeCard(node: Scene['nodes'][number], palette: ReturnType<typeof themePalette>): SVGGElement {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.classList.add('rg-card');
		g.dataset.id = node.id;

		// First <rect>: main card shell (preserves geometry & stroke-width queries).
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.classList.add('rg-card-bg');
		rect.setAttribute('x', '0');
		rect.setAttribute('y', '0');
		rect.setAttribute('width', String(node.w));
		rect.setAttribute('height', String(node.h));
		rect.setAttribute('rx', String(CARD_RX));

		// Subtle header tint path.
		const header = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		header.classList.add('rg-card-header');
		header.setAttribute('fill', node.root ? palette.rootHeader : palette.cardHeader);

		// Semantic accent pill on the left of the header.
		const accent = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		accent.classList.add('rg-card-accent');
		accent.setAttribute('x', '8');
		accent.setAttribute('y', '6');
		accent.setAttribute('width', '3.5');
		accent.setAttribute('height', '12');
		accent.setAttribute('rx', '1.75');
		accent.setAttribute('fill', node.root ? palette.rootStroke : kindAccent(node.kind, palette));

		// First <text>: symbol title.
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.classList.add('rg-card-title');
		label.setAttribute('x', '17');
		label.setAttribute('y', String(HEADER_H / 2 + 0.5));
		label.setAttribute('dominant-baseline', 'central');
		label.setAttribute('font-size', '11.5');
		label.setAttribute('font-family', uiFontFamily());
		label.textContent = node.label;

		// Second <text>: file:line subtitle.
		const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		sub.classList.add('rg-card-sub');
		sub.setAttribute('x', '11');
		sub.setAttribute('y', String(HEADER_H + 11));
		sub.setAttribute('dominant-baseline', 'central');
		sub.setAttribute('font-size', '9.5');
		sub.setAttribute('font-family', uiFontFamily());
		sub.textContent = node.subtitle;

		const details = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		details.classList.add('rg-details');

		g.append(rect, header, accent, label, sub, details);

		g.addEventListener('click', (event) => {
			if ((event.target as Element).closest('.rg-expander, .rg-detail-row')) return;
			this.onCardClick(node.id);
		});
		g.addEventListener('dblclick', () => {
			const live = this.nodes.get(nodeIdOf(g));
			if (live) this.onOpen?.(live.path, live.line + 1);
		});
		g.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.showCardMenu(event.clientX, event.clientY, nodeIdOf(g));
		});
		g.addEventListener('pointerenter', (event) => {
			if ((event.target as Element).closest('.rg-expander')) return;
			this.applyHoverHighlight(nodeIdOf(g));
		});
		g.addEventListener('pointerleave', () => {
			this.clearHoverHighlight();
		});
		return g;
	}

	private updateCard(g: SVGGElement, node: Scene['nodes'][number], palette: ReturnType<typeof themePalette>): void {
		const rect = g.querySelector('rect.rg-card-bg')!;
		const header = g.querySelector('path.rg-card-header')!;
		const accent = g.querySelector('rect.rg-card-accent')!;
		const label = g.querySelector('text.rg-card-title')!;
		const sub = g.querySelector('text.rg-card-sub')!;

		if (label.textContent !== node.label) label.textContent = node.label;
		if (sub.textContent !== node.subtitle) sub.textContent = node.subtitle;
		rect.setAttribute('width', String(node.w));
		rect.setAttribute('height', String(node.h));
		header.setAttribute(
			'd',
			`M ${CARD_RX} 0 H ${node.w - CARD_RX} A ${CARD_RX} ${CARD_RX} 0 0 1 ${node.w} ${CARD_RX} V ${HEADER_H} H 0 V ${CARD_RX} A ${CARD_RX} ${CARD_RX} 0 0 1 ${CARD_RX} 0 Z`
		);
		header.setAttribute('fill', node.root ? palette.rootHeader : palette.cardHeader);
		accent.setAttribute('fill', node.root ? palette.rootStroke : kindAccent(node.kind, palette));

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
			label.setAttribute('font-weight', '500');
		}
		sub.setAttribute('fill', palette.subText);
		this.paintCardRows(g, node, palette);
	}

	private paintCardRows(g: SVGGElement, node: Scene['nodes'][number], palette: ReturnType<typeof themePalette>): void {
		const details = g.querySelector('g.rg-details') as SVGGElement;
		const signature = `${node.w}\u0001${node.rows.map((row) => row.label).join('\u0000')}`;
		if (details.dataset['sig'] === signature) return;
		details.dataset['sig'] = signature;
		details.textContent = '';
		if (node.rows.length === 0) return;
		const sep = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		sep.setAttribute('x1', '0');
		sep.setAttribute('x2', String(node.w));
		sep.setAttribute('y1', String(NODE_H));
		sep.setAttribute('y2', String(NODE_H));
		sep.setAttribute('stroke', palette.cardStroke);
		sep.setAttribute('stroke-width', '1');
		details.appendChild(sep);
		node.rows.forEach((row, index) => {
			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', String(DETAIL_X));
			text.setAttribute('y', String(NODE_H + index * DETAIL_ROW_H + DETAIL_ROW_H * 0.75));
			text.setAttribute('font-size', '10');
			text.setAttribute('font-family', uiFontFamily());
			text.setAttribute('fill', palette.text);
			text.textContent = row.label;
			if (row.line !== null) {
				text.classList.add('rg-detail-row');
				const site = row.line;
				const id = node.id;
				text.addEventListener('click', (event) => {
					event.stopPropagation();
					const live = this.nodes.get(id);
					if (live) this.showInDefinition(live, live.edgePath, site);
				});
			} else {
				text.setAttribute('fill', palette.subText);
			}
			details.appendChild(text);
		});
	}

	private makeExpander(exp: Scene['expanders'][number], palette: ReturnType<typeof themePalette>): SVGGElement {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.classList.add('rg-expander');
		g.dataset.for = exp.for;
		const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('r', String(EXPANDER_R));
		circle.setAttribute('fill', palette.card);
		circle.setAttribute('stroke', palette.cardStroke);
		circle.setAttribute('stroke-width', '1.2');
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('dominant-baseline', 'central');
		label.setAttribute('font-size', '11.5');
		label.setAttribute('font-weight', '600');
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

	private makeEdge(edge: GraphEdge, palette: ReturnType<typeof themePalette>): SVGGElement {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		g.classList.add('rg-edge');
		g.dataset.from = edge.from;
		g.dataset.to = edge.to;
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		const badge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		badge.classList.add('rg-edge-badge');
		const pill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		pill.setAttribute('rx', '8');
		pill.setAttribute('height', '16');
		pill.setAttribute('y', '-8');
		pill.setAttribute('fill', palette.badgeBg);
		pill.setAttribute('stroke', palette.cardStroke);
		const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		label.setAttribute('text-anchor', 'middle');
		label.setAttribute('y', '3.5');
		label.setAttribute('font-family', uiFontFamily());
		label.setAttribute('fill', palette.text);
		badge.append(pill, label);
		g.append(path, badge);
		return g;
	}

	private paintEdge(
		g: SVGGElement,
		edge: GraphEdge,
		palette: ReturnType<typeof themePalette>,
		outOff: number,
		inOff: number
	): void {
		const from = this.layout.get(edge.from);
		const to = this.layout.get(edge.to);
		if (!from || !to) return;
		const path = g.querySelector('path')!;
		const badge = g.querySelector('g.rg-edge-badge') as SVGGElement;
		const pill = badge.querySelector('rect')!;
		const label = badge.querySelector('text')!;
		const horizontal = this.viewMode === 'graphHorizontal';
		const bi = this.lastPairSet.has(`${edge.to}\u0000${edge.from}`);
		const routed = routeRelationEdge(from, to, horizontal, outOff, inOff, bi, edge.from, edge.to);
		path.setAttribute('d', routed.d);
		const isWrite = edge.access === 'write' || edge.access === 'readWrite';
		path.setAttribute('stroke', isWrite ? palette.accentWrite : palette.link);
		path.setAttribute('stroke-width', edge.count > 1 || isWrite ? '1.85' : '1.35');
		if (edge.kind === 'use') path.setAttribute('stroke-dasharray', '4 3');
		else path.removeAttribute('stroke-dasharray');
		path.setAttribute('marker-end', 'url(#rg-arr)');

		const accessTag = edge.access === 'write' ? 'W' : edge.access === 'readWrite' ? 'R/W' : '';
		const countPart = !edge.hideCount && edge.count > 1 ? `×${edge.count}` : '';
		const text = accessTag && countPart ? `${accessTag} ${countPart}` : countPart || accessTag;
		label.textContent = text;
		if (text) {
			const pillW = Math.max(24, text.length * 6.5 + 10);
			pill.setAttribute('width', String(pillW));
			pill.setAttribute('x', String(-pillW / 2));
			pill.setAttribute('fill', palette.badgeBg);
			pill.setAttribute('stroke', palette.cardStroke);
			label.setAttribute('fill', palette.text);
			badge.setAttribute('transform', `translate(${routed.mx}, ${routed.my})`);
			badge.style.display = '';
		} else {
			badge.style.display = 'none';
		}
	}

	/* ---------- O(degree) Hover Neighborhood Highlighting ---------- */

	private applyHoverHighlight(nodeId: string): void {
		this.clearHoverHighlight();
		const nextActive: SVGElement[] = [];
		const mark = (elRef: SVGElement | undefined, cls: 'hover-self' | 'hover-in' | 'hover-out') => {
			if (!elRef) return;
			elRef.classList.add(cls);
			nextActive.push(elRef);
		};
		mark(this.cardEls.get(nodeId), 'hover-self');
		for (const e of this.outEdgesByNode.get(nodeId) ?? []) {
			const eg = this.edgeEls.get(e.id);
			if (eg) {
				mark(eg, 'hover-out');
				eg.querySelector('path')?.setAttribute('marker-end', 'url(#rg-arr-out)');
			}
			if (e.to !== nodeId) mark(this.cardEls.get(e.to), 'hover-out');
		}
		for (const e of this.inEdgesByNode.get(nodeId) ?? []) {
			const eg = this.edgeEls.get(e.id);
			if (eg) {
				mark(eg, 'hover-in');
				eg.querySelector('path')?.setAttribute('marker-end', 'url(#rg-arr-in)');
			}
			if (e.from !== nodeId) mark(this.cardEls.get(e.from), 'hover-in');
		}
		this.activeHoverEls = nextActive;
		this.board.classList.add('has-hover');
	}

	private clearHoverHighlight(): void {
		this.board.classList.remove('has-hover');
		for (const elRef of this.activeHoverEls) {
			elRef.classList.remove('hover-self', 'hover-in', 'hover-out');
			if (elRef.classList.contains('rg-edge')) {
				elRef.querySelector('path')?.setAttribute('marker-end', 'url(#rg-arr)');
			}
		}
		this.activeHoverEls = [];
	}

	private placeCard(g: SVGGElement, x: number, y: number): void {
		g.setAttribute('transform', `translate(${x} ${y})`);
	}

	/* ---------- Glide Animation ---------- */

	private startMove(id: string, fx: number, fy: number): void {
		this.moves.set(id, { fx, fy, start: performance.now() });
	}

	private beginMoves(): void {
		if (this.moveHandle !== null) return;
		if (typeof requestAnimationFrame !== 'function') {
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
			const horizontal = this.viewMode === 'graphHorizontal';
			for (const [id, g] of this.edgeEls) {
				const ends = this.edgeEnds.get(id);
				if (!ends) continue;
				const from = this.renderedSpot(ends.from);
				const to = this.renderedSpot(ends.to);
				if (from && to) {
					const bi = this.lastPairSet.has(`${ends.to}\u0000${ends.from}`);
					const routed = routeRelationEdge(
						from,
						to,
						horizontal,
						this.lastOutOffset.get(id) ?? 0,
						this.lastInOffset.get(id) ?? 0,
						bi,
						ends.from,
						ends.to
					);
					g.querySelector('path')!.setAttribute('d', routed.d);
					const badge = g.querySelector('g.rg-edge-badge') as SVGGElement | null;
					if (badge && badge.style.display !== 'none') {
						badge.setAttribute('transform', `translate(${routed.mx}, ${routed.my})`);
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
		this.settle?.();
		this.settle = null;
	}

	private renderedSpot(id: string): LayoutPoint | null {
		const move = this.moves.get(id);
		const spot = this.layout.get(id);
		if (!spot) return null;
		if (move) {
			const p = Math.min(1, (performance.now() - move.start) / MOVE_MS);
			const e = 1 - Math.pow(1 - p, 3);
			return { x: move.fx + (spot.x - move.fx) * e, y: move.fy + (spot.y - move.fy) * e, w: spot.w, h: spot.h, layer: spot.layer };
		}
		return spot;
	}

	whenSettled(): Promise<void> {
		if (this.moves.size === 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.settle = resolve;
		});
	}

	/* ---------- Camera (pan / zoom / fit / keyboard) ---------- */

	private applyCamera(): void {
		this.world.setAttribute('transform', `translate(${this.camX} ${this.camY}) scale(${this.camScale})`);
		const gridStep = Math.max(12, Math.min(40, 20 * this.camScale));
		this.stage.style.backgroundSize = `${gridStep}px ${gridStep}px`;
		this.stage.style.backgroundPosition = `${this.camX % gridStep}px ${this.camY % gridStep}px`;
	}

	private stepZoom(factor: number): void {
		const width = this.stage.clientWidth || 300;
		const height = this.stage.clientHeight || 200;
		const px = width / 2;
		const py = height / 2;
		const next = Math.max(0.15, Math.min(3, this.camScale * factor));
		this.camX = px - ((px - this.camX) / this.camScale) * next;
		this.camY = py - ((py - this.camY) / this.camScale) * next;
		this.camScale = next;
		this.applyCamera();
	}

	private readonly onBoardKeyDown = (event: KeyboardEvent): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === '+' || event.key === '=') this.stepZoom(1.18);
		else if (event.key === '-' || event.key === '_') this.stepZoom(1 / 1.18);
		else if (event.key === '0' || event.key === 'Home' || event.key === 'f' || event.key === 'F') this.fit();
		else if (event.key === 'ArrowLeft') { this.camX += ARROW_PAN; this.applyCamera(); }
		else if (event.key === 'ArrowRight') { this.camX -= ARROW_PAN; this.applyCamera(); }
		else if (event.key === 'ArrowUp') { this.camY += ARROW_PAN; this.applyCamera(); }
		else if (event.key === 'ArrowDown') { this.camY -= ARROW_PAN; this.applyCamera(); }
		else if (event.key === 'Escape') {
			if (this.selectedKey) {
				this.cardEls.get(this.selectedKey)?.classList.remove('rg-selected');
				this.selectedKey = null;
			}
		} else return;
		event.preventDefault();
	};

	private readonly onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const rect = this.board.getBoundingClientRect();
		const px = event.clientX - rect.left;
		const py = event.clientY - rect.top;
		const factor = Math.exp(-event.deltaY * 0.002);
		const next = Math.max(0.15, Math.min(3, this.camScale * factor));
		this.camX = px - ((px - this.camX) / this.camScale) * next;
		this.camY = py - ((py - this.camY) / this.camScale) * next;
		this.camScale = next;
		this.applyCamera();
	};

	private panFrom: { x: number; y: number; camX: number; camY: number } | null = null;

	private readonly onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0 && event.button !== 1) return;
		if (event.button === 0 && (event.target as Element).closest('.rg-card, .rg-expander')) return;
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

	fit(): void {
		const [width, height] = [this.stage.clientWidth, this.stage.clientHeight];
		const box = this.bounds;
		const spanW = box.maxX - box.minX;
		const spanH = box.maxY - box.minY;
		if (width === 0 || height === 0 || spanW <= 0 || spanH <= 0) return;
		const pad = 24;
		const scale = Math.max(0.15, Math.min(1.25, Math.min((width - pad * 2) / spanW, (height - pad * 2) / spanH)));
		this.camScale = scale;
		this.camX = (width - spanW * scale) / 2 - box.minX * scale;
		this.camY = (height - spanH * scale) / 2 - box.minY * scale;
		this.applyCamera();
	}

	frame(): void {
		const width = this.stage.clientWidth;
		const height = this.stage.clientHeight;
		if (width === 0 || height === 0) return;
		const box = this.bounds;
		const spanW = box.maxX - box.minX;
		const spanH = box.maxY - box.minY;
		if (spanW <= 0 || spanH <= 0) return;
		const left = -this.camX / this.camScale;
		const top = -this.camY / this.camScale;
		const right = left + width / this.camScale;
		const bottom = top + height / this.camScale;
		const fullyVisible = box.minX >= left && box.minY >= top && box.maxX <= right && box.maxY <= bottom;
		if (fullyVisible) return;
		if (spanW <= right - left && spanH <= bottom - top) {
			this.camX -= ((box.minX + box.maxX) / 2 - (left + right) / 2) * this.camScale;
			this.camY -= ((box.minY + box.maxY) / 2 - (top + bottom) / 2) * this.camScale;
		} else {
			this.fit();
			return;
		}
		this.applyCamera();
	}

	/* ---------- Card Handlers ---------- */

	private onCardClick(key: string): void {
		if (this.selectedKey && this.selectedKey !== key) {
			this.cardEls.get(this.selectedKey)?.classList.remove('rg-selected');
		}
		this.selectedKey = key;
		this.cardEls.get(key)?.classList.add('rg-selected');
		const node = this.nodes.get(key);
		if (node) this.showInDefinition(node, node.path, node.line);
	}

	private showInDefinition(node: GraphNode, path: string, line: number): void {
		this.onShowDefinition?.({ kind: node.kind, name: node.name, path, line });
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
			entries.push({ label: t('relations.expandSpecial'), run: () => void this.expandSpecialPrompt(key) });
		}
		entries.push(
			{ label: t('relations.reRoot'), run: () => this.setRoot({ kind: node.kind, name: node.name, path: node.path, line: node.line }) },
			{ label: t('relations.openDef'), run: () => this.onOpen?.(node.path, node.line + 1) }
		);
		showContextMenu(x, y, entries);
	}

	/* ---------- Expand Special ---------- */

	private async expandSpecialPrompt(key: string): Promise<void> {
		const raw = await quickInput({
			title: t('relations.expandSpecial'),
			placeholder: t('relations.expandSpecial.prompt'),
			validate: (value) => (/^[1-8]$/.test(value.trim()) ? null : t('relations.expandSpecial.bad'))
		});
		if (raw === null) return;
		const levels = Number(raw.trim());
		if (!Number.isFinite(levels) || levels < 1) return;
		await this.expandLevels(key, Math.min(8, Math.round(levels)));
	}

	async expandLevels(key: string, levels: number): Promise<void> {
		const generation = this.generation;
		let frontier = [key];
		for (let level = 0; level < levels && frontier.length > 0; level++) {
			const next: string[] = [];
			for (const at of frontier) {
				if (generation !== this.generation) return;
				const node = this.nodes.get(at);
				if (!node || !node.hasChildren) continue;
				if (!node.expanded) {
					if (this.depthOf(at) >= MAX_DEPTH) continue;
					await this.toggleExpand(at);
				}
				const after = this.nodes.get(at);
				if (after?.expanded) next.push(...after.children);
			}
			frontier = next;
		}
		if (generation !== this.generation) return;
		this.render();
	}

}

function nodeIdOf(g: SVGElement): string {
	return g.dataset.id ?? '';
}

function cardSubtitle(node: GraphNode, metrics?: SymSlotMetrics): string {
	const file = baseName(node.path);
	const loc = file ? `${file}:${node.line + 1}` : node.kind;
	if (!metrics) return loc;
	const parts: string[] = [];
	if (metrics.effectiveLines > 0) parts.push(`${metrics.effectiveLines}L`);
	if (metrics.controlFlow > 0) parts.push(`${metrics.controlFlow}br`);
	if (metrics.paramCount > 0) parts.push(metrics.paramCount === 255 ? '…p' : `${metrics.paramCount}p`);
	return parts.length > 0 ? `${loc} · ${parts.join(' ')}` : loc;
}

function estimateLabelWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? 11.5 : 6.7;
	return width;
}

function kindAccent(kind: string, palette: ReturnType<typeof themePalette>): string {
	switch (kind) {
		case 'function':
		case 'method':
		case 'constructor':
			return palette.accentFn;
		case 'class':
		case 'struct':
		case 'interface':
		case 'enum':
		case 'union':
		case 'type':
		case 'typedef':
			return palette.accentType;
		case 'macro':
		case 'constant':
			return palette.accentMacro;
		case 'variable':
		case 'field':
		case 'member':
		case 'parameter':
			return palette.accentVar;
		case 'file':
		case 'module':
			return palette.accentFile;
		default:
			return palette.cardStroke;
	}
}

function themePalette(): {
	card: string;
	cardHeader: string;
	cardStroke: string;
	rootCard: string;
	rootHeader: string;
	rootStroke: string;
	rootText: string;
	text: string;
	subText: string;
	link: string;
	badgeBg: string;
	accentFn: string;
	accentType: string;
	accentMacro: string;
	accentVar: string;
	accentFile: string;
	accentWrite: string;
} {
	const dark = document.documentElement.classList.contains('vscode-dark');
	return dark
		? {
			card: '#242b36',
			cardHeader: '#2c3544',
			cardStroke: '#3e4a5c',
			rootCard: '#223042',
			rootHeader: '#2a3d55',
			rootStroke: '#4fc1ff',
			rootText: '#eef4fc',
			text: '#e2e8f0',
			subText: '#94a3b8',
			link: '#7c8ea6',
			badgeBg: '#1e242e',
			accentFn: '#569cd6',
			accentType: '#4ec9b0',
			accentMacro: '#dcdcaa',
			accentVar: '#9cdcfe',
			accentFile: '#c586c0',
			accentWrite: '#e59956'
		}
		: {
			card: '#ffffff',
			cardHeader: '#f3f6fa',
			cardStroke: '#cfd8e3',
			rootCard: '#f4f9ff',
			rootHeader: '#e5f1ff',
			rootStroke: '#006abc',
			rootText: '#10243a',
			text: '#1e293b',
			subText: '#64748b',
			link: '#64748b',
			badgeBg: '#ffffff',
			accentFn: '#0066b8',
			accentType: '#0d9488',
			accentMacro: '#b45309',
			accentVar: '#0284c7',
			accentFile: '#7c3aed',
			accentWrite: '#d97706'
		};
}

function uiFontFamily(): string {
	try {
		const family = getComputedStyle(document.body).fontFamily;
		return family || 'sans-serif';
	} catch {
		return 'sans-serif';
	}
}

function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}
