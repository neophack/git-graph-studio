// Netron-inspired Interactive SVG Module Architecture Canvas (module 17):
// Zero-dependency, theme-reactive SVG architecture explorer over the `ModuleOverview`
// payload with Sugiyama-style barycenter crossing minimization, vertical (TB) &
// horizontal (LR) layouts, distributed connection ports, draggable nodes with live edge
// re-routing, directional hover neighborhood tracing, floating inspector tooltip,
// interactive overview minimap, and SVG export.

import { t, tf } from '../../platform/i18n';
import { actionButton, el } from '../../platform/ui/index';
import type { ModuleEdge, ModuleNode } from '../../platform/ipc/analysis';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export type { ModuleEdge, ModuleNode, ModuleOverview } from '../../platform/ipc/analysis';

export type DiagramDirection = 'TB' | 'LR';

/** How a module names itself on the page — the workspace root gets a label. */
export function moduleLabel(name: string): string {
	return name || t('analysis.modules.root');
}

/* ---------- Viewport & Layout Constants ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CARD_W = 236;
const CARD_H = 92;
const CARD_RX = 12;
const HEADER_H = 30;
const TB_COL_GAP = 36;
const TB_ROW_GAP = 80;
const TB_SUBROW_GAP = 28;
const LR_COL_GAP = 96;
const LR_ROW_GAP = 28;
const LR_SUBCOL_GAP = 30;
const MAX_PER_BAND = 7;
const PAD_X = 60;
const PAD_Y = 52;

const ZOOM_STEP = 1.18;
const FIT_PADDING = 36;
const ZOOM_MIN_RELATIVE = 0.2;
const ZOOM_MAX_RELATIVE = 8;
const ARROW_PAN = 56;
const ANIMATE_MS = 160;
const DRAG_THRESHOLD = 4;
const MINIMAP_W = 172;
const MINIMAP_H = 114;
const LARGE_GRAPH_NODES = 40;
const LARGE_GRAPH_EDGES = 80;
const HOVER_CLEAR_DELAY_MS = 48;

function svgEl<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number> = {},
	children: (Node | string)[] = []
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	for (const child of children) {
		node.append(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export interface DiagramViewCallbacks {
	/** Double-click on a module (drill down) or file (open in editor). */
	onActivateNode: (node: ModuleNode) => void;
	/** Single-click on a node, edge, or empty background (null). */
	onSelect: (hit: { kind: 'node' | 'edge'; id: string } | null) => void;
	onNodeContext: (x: number, y: number, id: string) => void;
	onEdgeContext: (x: number, y: number, id: string) => void;
	/** Optional callback when Escape is pressed on the canvas. */
	onEscape?: () => void;
}

interface PlacedNode {
	node: ModuleNode;
	x: number;
	y: number;
	w: number;
	h: number;
	baseX: number;
	baseY: number;
}

interface LayerBand {
	layer: number;
	start: number;
	end: number;
}

interface ViewState {
	fitScale: number;
	width: number;
	height: number;
	scale: number;
	x: number;
	y: number;
}

interface RoutedEdge {
	d: string;
	mx: number;
	my: number;
	sx: number;
	sy: number;
	ex: number;
	ey: number;
}

interface EdgeDomRef {
	g: SVGGElement;
	hit: SVGPathElement;
	path: SVGPathElement;
	badge: SVGGElement | null;
}

/** Order nodes within each layer using multi-pass barycenter heuristic to minimize edge crossings. */
function orderLayers(nodes: ModuleNode[], edges: ModuleEdge[]): { layerKeys: number[]; byLayer: Map<number, ModuleNode[]> } {
	const byLayer = new Map<number, ModuleNode[]>();
	for (const node of nodes) {
		const list = byLayer.get(node.layer);
		if (list) list.push(node);
		else byLayer.set(node.layer, [node]);
	}
	const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);

	// Initial deterministic sort: higher connectivity in the middle, stable by id.
	for (const key of layerKeys) {
		byLayer.get(key)!.sort((a, b) => (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut) || a.id.localeCompare(b.id));
	}

	const incoming = new Map<string, string[]>();
	const outgoing = new Map<string, string[]>();
	for (const e of edges) {
		if (e.from === e.to) continue;
		const out = outgoing.get(e.from);
		if (out) out.push(e.to);
		else outgoing.set(e.from, [e.to]);
		const inn = incoming.get(e.to);
		if (inn) inn.push(e.from);
		else incoming.set(e.to, [e.from]);
	}

	const rankIndex = new Map<string, number>();
	const refreshIndices = () => {
		for (const key of layerKeys) {
			const list = byLayer.get(key)!;
			for (let i = 0; i < list.length; i++) rankIndex.set(list[i].id, i);
		}
	};
	refreshIndices();

	const barycenter = (id: string, neighbors: string[] | undefined, fallback: number): number => {
		if (!neighbors || neighbors.length === 0) return fallback;
		let sum = 0;
		let count = 0;
		for (const nb of neighbors) {
			const idx = rankIndex.get(nb);
			if (idx !== undefined) {
				sum += idx;
				count++;
			}
		}
		return count > 0 ? sum / count : fallback;
	};

	// 3 forward + backward sweeps reduce crossings cleanly without adding latency.
	for (let pass = 0; pass < 3; pass++) {
		for (let i = 1; i < layerKeys.length; i++) {
			const list = byLayer.get(layerKeys[i])!;
			const scores = new Map<string, number>();
			list.forEach((n, idx) => scores.set(n.id, barycenter(n.id, incoming.get(n.id), idx)));
			list.sort((a, b) => (scores.get(a.id)! - scores.get(b.id)!) || a.id.localeCompare(b.id));
			refreshIndices();
		}
		for (let i = layerKeys.length - 2; i >= 0; i--) {
			const list = byLayer.get(layerKeys[i])!;
			const scores = new Map<string, number>();
			list.forEach((n, idx) => scores.set(n.id, barycenter(n.id, outgoing.get(n.id), idx)));
			list.sort((a, b) => (scores.get(a.id)! - scores.get(b.id)!) || a.id.localeCompare(b.id));
			refreshIndices();
		}
	}

	return { layerKeys, byLayer };
}

/** Compute deterministic Netron-style layered positions for TB or LR orientation. */
function layoutGraph(
	nodes: ModuleNode[],
	edges: ModuleEdge[],
	direction: DiagramDirection
): { placed: Map<string, PlacedNode>; bands: LayerBand[]; width: number; height: number } {
	const placed = new Map<string, PlacedNode>();
	const bands: LayerBand[] = [];
	if (nodes.length === 0) return { placed, bands, width: 640, height: 360 };

	const { layerKeys, byLayer } = orderLayers(nodes, edges);

	if (direction === 'TB') {
		const rows: { layer: number; items: ModuleNode[]; gapAbove: number; firstInLayer: boolean }[] = [];
		let maxRowWidth = CARD_W;
		for (const layer of layerKeys) {
			const items = byLayer.get(layer)!;
			const numSubRows = Math.ceil(items.length / MAX_PER_BAND);
			const cols = Math.min(MAX_PER_BAND, Math.max(1, Math.ceil(items.length / numSubRows)));
			for (let i = 0; i < items.length; i += cols) {
				const chunk = items.slice(i, i + cols);
				const rowWidth = chunk.length * CARD_W + (chunk.length - 1) * TB_COL_GAP;
				if (rowWidth > maxRowWidth) maxRowWidth = rowWidth;
				rows.push({
					layer,
					items: chunk,
					gapAbove: rows.length === 0 ? 0 : i === 0 ? TB_ROW_GAP : TB_SUBROW_GAP,
					firstInLayer: i === 0
				});
			}
		}

		const totalWidth = Math.max(520, maxRowWidth + PAD_X * 2);
		let cursorY = PAD_Y;
		let activeBand: LayerBand | null = null;
		for (const row of rows) {
			cursorY += row.gapAbove;
			if (row.firstInLayer) {
				if (activeBand) bands.push(activeBand);
				activeBand = { layer: row.layer, start: cursorY - 14, end: cursorY + CARD_H + 14 };
			} else if (activeBand) {
				activeBand.end = cursorY + CARD_H + 14;
			}
			const rowWidth = row.items.length * CARD_W + (row.items.length - 1) * TB_COL_GAP;
			let cursorX = (totalWidth - rowWidth) / 2;
			for (const node of row.items) {
				placed.set(node.id, { node, x: cursorX, y: cursorY, w: CARD_W, h: CARD_H, baseX: cursorX, baseY: cursorY });
				cursorX += CARD_W + TB_COL_GAP;
			}
			cursorY += CARD_H;
		}
		if (activeBand) bands.push(activeBand);
		const totalHeight = Math.max(360, cursorY + PAD_Y);
		return { placed, bands, width: totalWidth, height: totalHeight };
	}

	// Horizontal Left-to-Right (LR) layout: layers advance left-to-right.
	const cols: { layer: number; items: ModuleNode[]; gapLeft: number; firstInLayer: boolean }[] = [];
	let maxColHeight = CARD_H;
	for (const layer of layerKeys) {
		const items = byLayer.get(layer)!;
		const numSubCols = Math.ceil(items.length / MAX_PER_BAND);
		const perCol = Math.min(MAX_PER_BAND, Math.max(1, Math.ceil(items.length / numSubCols)));
		for (let i = 0; i < items.length; i += perCol) {
			const chunk = items.slice(i, i + perCol);
			const colHeight = chunk.length * CARD_H + (chunk.length - 1) * LR_ROW_GAP;
			if (colHeight > maxColHeight) maxColHeight = colHeight;
			cols.push({
				layer,
				items: chunk,
				gapLeft: cols.length === 0 ? 0 : i === 0 ? LR_COL_GAP : LR_SUBCOL_GAP,
				firstInLayer: i === 0
			});
		}
	}

	const totalHeight = Math.max(380, maxColHeight + PAD_Y * 2);
	let cursorX = PAD_X;
	let activeBand: LayerBand | null = null;
	for (const col of cols) {
		cursorX += col.gapLeft;
		if (col.firstInLayer) {
			if (activeBand) bands.push(activeBand);
			activeBand = { layer: col.layer, start: cursorX - 16, end: cursorX + CARD_W + 16 };
		} else if (activeBand) {
			activeBand.end = cursorX + CARD_W + 16;
		}
		const colHeight = col.items.length * CARD_H + (col.items.length - 1) * LR_ROW_GAP;
		let cursorY = (totalHeight - colHeight) / 2;
		for (const node of col.items) {
			placed.set(node.id, { node, x: cursorX, y: cursorY, w: CARD_W, h: CARD_H, baseX: cursorX, baseY: cursorY });
			cursorY += CARD_H + LR_ROW_GAP;
		}
		cursorX += CARD_W;
	}
	if (activeBand) bands.push(activeBand);
	const totalWidth = Math.max(520, cursorX + PAD_X);
	return { placed, bands, width: totalWidth, height: totalHeight };
}

/** Compute spatially sorted port offsets on each node so edges fan out cleanly without piling up. */
function computePortOffsets(
	edges: ModuleEdge[],
	placed: Map<string, PlacedNode>,
	direction: DiagramDirection
): { outOffset: Map<string, number>; inOffset: Map<string, number> } {
	const outByNode = new Map<string, ModuleEdge[]>();
	const inByNode = new Map<string, ModuleEdge[]>();
	for (const e of edges) {
		if (!placed.has(e.from) || !placed.has(e.to)) continue;
		const ol = outByNode.get(e.from);
		if (ol) ol.push(e);
		else outByNode.set(e.from, [e]);
		const il = inByNode.get(e.to);
		if (il) il.push(e);
		else inByNode.set(e.to, [e]);
	}

	const outOffset = new Map<string, number>();
	const inOffset = new Map<string, number>();
	const span = direction === 'TB' ? CARD_W * 0.64 : CARD_H * 0.56;

	const assign = (groups: Map<string, ModuleEdge[]>, targetMap: Map<string, number>, isOut: boolean) => {
		for (const [, list] of groups) {
			if (list.length <= 1) {
				if (list.length === 1) targetMap.set(list[0].id, 0);
				continue;
			}
			list.sort((a, b) => {
				const otherA = placed.get(isOut ? a.to : a.from)!;
				const otherB = placed.get(isOut ? b.to : b.from)!;
				const coordA = direction === 'TB' ? otherA.x + otherA.w / 2 : otherA.y + otherA.h / 2;
				const coordB = direction === 'TB' ? otherB.x + otherB.w / 2 : otherB.y + otherB.h / 2;
				return coordA - coordB || a.id.localeCompare(b.id);
			});
			const n = list.length;
			for (let i = 0; i < n; i++) {
				const ratio = (i / (n - 1)) - 0.5;
				targetMap.set(list[i].id, ratio * Math.min(span, (n - 1) * 18));
			}
		}
	};

	assign(outByNode, outOffset, true);
	assign(inByNode, inOffset, false);
	return { outOffset, inOffset };
}

/** Route an edge with Netron-style smooth cubic Bezier curves and distributed ports. */
function routeEdge(
	from: PlacedNode,
	to: PlacedNode,
	direction: DiagramDirection,
	outOff: number,
	inOff: number,
	isBidirectional: boolean,
	isCycle: boolean
): RoutedEdge {
	const fx = from.x + from.w / 2;
	const fy = from.y + from.h / 2;
	const tx = to.x + to.w / 2;
	const ty = to.y + to.h / 2;
	const biShift = isBidirectional ? (from.node.id < to.node.id ? -8 : 8) : 0;

	if (direction === 'TB') {
		if (Math.abs(from.y - to.y) < 10) {
			// Same horizontal band: arch cleanly above (forward) or below (cycle/reverse).
			const archUp = !isCycle && from.x < to.x;
			const sx = fx + outOff * 0.5 + biShift;
			const sy = archUp ? from.y : from.y + from.h;
			const ex = tx + inOff * 0.5 + biShift;
			const ey = archUp ? to.y : to.y + to.h;
			const span = Math.abs(ex - sx);
			const lift = Math.min(82, 28 + span * 0.14) * (archUp ? -1 : 1);
			const cy = sy + lift;
			return {
				d: `M ${sx} ${sy} C ${sx} ${cy}, ${ex} ${cy}, ${ex} ${ey}`,
				mx: (sx + ex) / 2,
				my: sy + lift * 0.75,
				sx, sy, ex, ey
			};
		}

		if (from.y < to.y) {
			// Downward architectural flow: bottom port → top port.
			const sx = fx + outOff + biShift * 0.5;
			const sy = from.y + from.h;
			const ex = tx + inOff + biShift * 0.5;
			const ey = to.y;
			const dy = Math.max(28, (ey - sy) * 0.46);
			const cx1 = sx;
			const cy1 = sy + dy;
			const cx2 = ex;
			const cy2 = ey - dy;
			return {
				d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
				mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
				my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey,
				sx, sy, ex, ey
			};
		}

		// Upward back-edge / cycle: sweep smoothly around the outer side.
		const sx = fx + outOff * 0.5 + biShift;
		const sy = from.y;
		const ex = tx + inOff * 0.5 + biShift;
		const ey = to.y + to.h;
		const bend = (fx <= tx ? -1 : 1) * Math.min(96, 38 + Math.abs(fy - ty) * 0.16);
		const dy = Math.max(28, (sy - ey) * 0.36);
		const cx1 = sx + bend;
		const cy1 = sy - dy;
		const cx2 = ex + bend;
		const cy2 = ey + dy;
		return {
			d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
			mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
			my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey,
			sx, sy, ex, ey
		};
	}

	// Horizontal Left-to-Right (LR) routing.
	if (Math.abs(from.x - to.x) < 10) {
		const archLeft = !isCycle && from.y < to.y;
		const sx = archLeft ? from.x : from.x + from.w;
		const sy = fy + outOff * 0.5 + biShift;
		const ex = archLeft ? to.x : to.x + to.w;
		const ey = ty + inOff * 0.5 + biShift;
		const span = Math.abs(ey - sy);
		const lift = Math.min(82, 28 + span * 0.14) * (archLeft ? -1 : 1);
		const cx = sx + lift;
		return {
			d: `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ey}, ${ex} ${ey}`,
			mx: sx + lift * 0.75,
			my: (sy + ey) / 2,
			sx, sy, ex, ey
		};
	}

	if (from.x < to.x) {
		// Forward LR flow: right port → left port.
		const sx = from.x + from.w;
		const sy = fy + outOff + biShift * 0.5;
		const ex = to.x;
		const ey = ty + inOff + biShift * 0.5;
		const dx = Math.max(34, (ex - sx) * 0.46);
		const cx1 = sx + dx;
		const cy1 = sy;
		const cx2 = ex - dx;
		const cy2 = ey;
		return {
			d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
			mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
			my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey,
			sx, sy, ex, ey
		};
	}

	// Backward / cycle LR edge: sweep cleanly above or below.
	const sx = from.x;
	const sy = fy + outOff * 0.5 + biShift;
	const ex = to.x + to.w;
	const ey = ty + inOff * 0.5 + biShift;
	const bend = (fy <= ty ? -1 : 1) * Math.min(92, 38 + Math.abs(fx - tx) * 0.15);
	const dx = Math.max(30, (sx - ex) * 0.36);
	const cx1 = sx - dx;
	const cy1 = sy + bend;
	const cx2 = ex + dx;
	const cy2 = ey + bend;
	return {
		d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
		mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
		my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey,
		sx, sy, ex, ey
	};
}

/** Netron-inspired Interactive SVG Module Architecture Canvas. */
export class DiagramView {
	readonly host: HTMLElement;
	private readonly content: HTMLElement;
	private readonly zoomLevel: HTMLElement;
	private readonly dirBtn: HTMLButtonElement;
	private readonly minimapBtn: HTMLButtonElement;
	private readonly resetBtn: HTMLButtonElement;
	private readonly minimap: HTMLElement;
	private readonly tooltip: HTMLElement;
	private resizeObserver: ResizeObserver | null = null;
	private view: ViewState | null = null;
	private direction: DiagramDirection = 'TB';
	private minimapVisible = true;
	private hasCustomPositions = false;
	private hasSelection = false;

	private currentNodes: ModuleNode[] = [];
	private currentEdges: ModuleEdge[] = [];
	private graphWidth = 640;
	private graphHeight = 360;
	private svgElRef: SVGSVGElement | null = null;
	private viewportGroup: SVGGElement | null = null;
	private placed = new Map<string, PlacedNode>();
	private nodesById = new Map<string, ModuleNode>();
	private edgesById = new Map<string, ModuleEdge>();
	private outEdgesByNode = new Map<string, ModuleEdge[]>();
	private inEdgesByNode = new Map<string, ModuleEdge[]>();
	private nodeElById = new Map<string, SVGGElement>();
	private edgeDomById = new Map<string, EdgeDomRef>();
	private pairSet = new Set<string>();
	private edgeMidpoints = new Map<string, { x: number; y: number }>();

	private userMoved = false;
	private dragMoved = false;
	private spacePressed = false;
	private panDrag: { x: number; y: number } | null = null;
	private nodeDrag: {
		id: string;
		startClientX: number;
		startClientY: number;
		origX: number;
		origY: number;
		active: boolean;
		pendingX: number;
		pendingY: number;
	} | null = null;
	private nodeDragFrame: number | null = null;
	private minimapDragging = false;
	private hoveredHit: { kind: 'node' | 'edge'; id: string } | null = null;
	private pendingHoverHit: { kind: 'node' | 'edge'; id: string } | null = null;
	private pendingHoverPos: { x: number; y: number } | null = null;
	private hoverFrame: number | null = null;
	private hoverClearTimer: ReturnType<typeof setTimeout> | null = null;
	private activeHoverEls: SVGElement[] = [];
	private tooltipFrame: number | null = null;
	private pendingTooltipPos: { x: number; y: number } | null = null;
	private cachedHostRect: DOMRect | null = null;
	private cachedTooltipSize: { w: number; h: number } | null = null;
	private lastNodeStates: Record<string, string[]> = {};
	private lastEdgeStates: Record<string, string[]> = {};

	private readonly pointers = new Map<number, { x: number; y: number }>();
	private pinch: {
		startDistance: number;
		startView: { x: number; y: number; scale: number };
		start: { x: number; y: number };
	} | null = null;
	private viewFrame: number | null = null;
	private animationFrame: number | null = null;
	private gestureScale: number | null = null;

	constructor(private readonly callbacks: DiagramViewCallbacks) {
		this.host = el('div', 'an-diagram');
		this.host.tabIndex = 0;
		this.host.setAttribute('role', 'region');
		const hint = t('analysis.modules.hint');
		this.host.setAttribute('aria-label', hint);
		this.host.title = hint;

		this.zoomLevel = el('span', 'an-zoom-level', ['100%']);
		this.dirBtn = actionButton('split-horizontal', t('analysis.modules.layoutLR'), () => {
			this.setDirection(this.direction === 'TB' ? 'LR' : 'TB');
		}) as HTMLButtonElement;
		this.minimapBtn = actionButton('map', t('analysis.modules.minimap'), () => {
			this.minimapVisible = !this.minimapVisible;
			this.minimapBtn.classList.toggle('active', this.minimapVisible);
			this.syncMinimapVisibility();
		}) as HTMLButtonElement;
		this.minimapBtn.classList.add('active');
		this.resetBtn = actionButton('discard', t('analysis.modules.resetLayout'), () => this.resetPositions()) as HTMLButtonElement;
		this.resetBtn.hidden = true;
		let exportReset: ReturnType<typeof setTimeout> | null = null;
		const exportBtn = actionButton('export', t('analysis.modules.exportSvg'), () => {
			const svg = this.exportSvg();
			if (!svg) return;
			void writeText(svg).then(() => {
				const ic = exportBtn.querySelector('.codicon');
				if (ic) ic.className = 'codicon codicon-check';
				exportBtn.classList.add('active');
				if (exportReset !== null) clearTimeout(exportReset);
				exportReset = setTimeout(() => {
					exportReset = null;
					const iconEl = exportBtn.querySelector('.codicon');
					if (iconEl) iconEl.className = 'codicon codicon-export';
					exportBtn.classList.remove('active');
				}, 1600);
			}, () => {});
		});

		this.host.append(el('div', 'an-zoombar', [
			el('div', 'pill an-tools-pill', [
				this.dirBtn,
				this.minimapBtn,
				this.resetBtn,
				exportBtn
			]),
			el('div', 'pill', [
				actionButton('remove', t('analysis.modules.zoomOut'), () => this.stepZoom(1 / ZOOM_STEP)),
				this.zoomLevel,
				actionButton('add', t('analysis.modules.zoomIn'), () => this.stepZoom(ZOOM_STEP))
			]),
			actionButton('screen-full', t('analysis.modules.fit'), () => this.fit(true))
		]));

		this.content = el('div', 'an-svg-stage');
		this.minimap = el('div', 'an-minimap');
		this.minimap.hidden = true;
		this.tooltip = el('div', 'an-hover-tip');
		this.tooltip.hidden = true;
		this.host.append(this.content, this.minimap, this.tooltip);

		this.content.addEventListener('click', (event) => {
			const hit = DiagramView.hitOf(event);
			event.stopPropagation();
			this.callbacks.onSelect(hit);
		});
		this.content.addEventListener('dblclick', (event) => {
			const hit = DiagramView.hitOf(event);
			if (!hit || hit.kind !== 'node') return;
			const node = this.nodesById.get(hit.id);
			if (!node) return;
			event.stopPropagation();
			this.callbacks.onActivateNode(node);
		});
		this.content.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			const hit = DiagramView.hitOf(event);
			if (!hit) return;
			event.stopPropagation();
			const point = event as MouseEvent;
			if (hit.kind === 'node') this.callbacks.onNodeContext(point.clientX, point.clientY, hit.id);
			else this.callbacks.onEdgeContext(point.clientX, point.clientY, hit.id);
		});
		this.content.addEventListener('pointerover', (event) => this.onHoverMove(event));
		this.content.addEventListener('pointermove', (event) => this.onTooltipMove(event));
		this.content.addEventListener('pointerout', (event) => this.onHoverOut(event));

		this.minimap.addEventListener('pointerdown', (event) => this.onMinimapPointerDown(event));
		this.minimap.addEventListener('pointermove', (event) => this.onMinimapPointerMove(event));
		this.minimap.addEventListener('pointerup', () => { this.minimapDragging = false; });
		this.minimap.addEventListener('pointercancel', () => { this.minimapDragging = false; });

		this.host.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.host.addEventListener('gesturestart', (event) => this.onGestureStart(event), { passive: false } as AddEventListenerOptions);
		this.host.addEventListener('gesturechange', (event) => this.onGestureChange(event), { passive: false } as AddEventListenerOptions);
		this.host.addEventListener('gestureend', () => { this.gestureScale = null; });
		this.host.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		this.host.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.host.addEventListener('pointerup', (event) => this.onPointerUp(event));
		this.host.addEventListener('pointercancel', (event) => this.onPointerUp(event));
		this.host.addEventListener('keydown', (event) => this.onKeyDown(event));
		this.host.addEventListener('keyup', (event) => this.onKeyUp(event));
		this.host.addEventListener('blur', () => {
			this.spacePressed = false;
			this.host.classList.remove('space-pan');
		});
		this.host.addEventListener('contextmenu', (event) => event.preventDefault());
		this.host.addEventListener('click', (event) => {
			if (!this.dragMoved) return;
			this.dragMoved = false;
			event.stopPropagation();
		}, true);

		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(() => this.onHostResized());
			this.resizeObserver.observe(this.host);
		}
	}

	private static hitOf(event: Event): { kind: 'node' | 'edge'; id: string } | null {
		const target = event.target;
		if (!(target instanceof Element)) return null;
		const marked = target.closest('[data-node-id], [data-edge-id]');
		if (!marked) return null;
		const nodeId = marked.getAttribute('data-node-id');
		if (nodeId !== null) return { kind: 'node', id: nodeId };
		const edgeId = marked.getAttribute('data-edge-id');
		return edgeId !== null ? { kind: 'edge', id: edgeId } : null;
	}

	setDirection(direction: DiagramDirection): void {
		if (this.direction === direction) return;
		this.direction = direction;
		const iconEl = this.dirBtn.querySelector('.codicon');
		if (iconEl) {
			iconEl.className = `codicon codicon-${direction === 'TB' ? 'split-horizontal' : 'split-vertical'}`;
		}
		this.dirBtn.title = direction === 'TB' ? t('analysis.modules.layoutLR') : t('analysis.modules.layoutTB');
		if (this.currentNodes.length > 0) {
			const hadSelection = this.hasSelection;
			const nodeStates = this.lastNodeStates;
			const edgeStates = this.lastEdgeStates;
			this.setGraph(this.currentNodes, this.currentEdges);
			if (hadSelection) this.setStates(nodeStates, edgeStates);
		}
	}

	resetPositions(): void {
		if (!this.hasCustomPositions) return;
		this.hasCustomPositions = false;
		this.resetBtn.hidden = true;
		for (const item of this.placed.values()) {
			item.x = item.baseX;
			item.y = item.baseY;
			const nodeEl = this.nodeElById.get(item.node.id);
			if (nodeEl) nodeEl.setAttribute('transform', `translate(${item.x}, ${item.y})`);
		}
		this.rerouteAllEdges();
		this.renderMinimap();
		this.fit(true);
	}

	exportSvg(): string {
		const svg = this.svgElRef ?? this.content.querySelector('svg');
		if (!svg) return '';
		const bounds = this.getContentBounds();
		const clone = svg.cloneNode(true) as SVGSVGElement;
		clone.classList.remove('has-hover');
		for (const el of clone.querySelectorAll('.hover-self, .hover-in, .hover-out')) {
			el.classList.remove('hover-self', 'hover-in', 'hover-out');
		}
		clone.setAttribute('xmlns', SVG_NS);
		clone.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`);
		clone.setAttribute('width', String(Math.round(bounds.width)));
		clone.setAttribute('height', String(Math.round(bounds.height)));
		const vp = clone.querySelector('.an-viewport');
		if (vp) vp.removeAttribute('transform');
		return new XMLSerializer().serializeToString(clone);
	}

	/** Synchronously build and mount the Netron-style pure-vector SVG architecture graph. */
	setGraph(nodes: ModuleNode[], edges: ModuleEdge[]): void {
		this.cancelPendingHover();
		this.content.textContent = '';
		this.svgElRef = null;
		this.viewportGroup = null;
		this.activeHoverEls = [];
		this.hideTooltip();
		this.hoveredHit = null;
		this.hasSelection = false;
		this.lastNodeStates = {};
		this.lastEdgeStates = {};
		this.userMoved = false;
		this.hasCustomPositions = false;
		this.resetBtn.hidden = true;
		this.currentNodes = nodes;
		this.currentEdges = edges;
		this.nodesById = new Map(nodes.map((n) => [n.id, n]));
		this.edgesById = new Map(edges.map((e) => [e.id, e]));
		this.outEdgesByNode.clear();
		this.inEdgesByNode.clear();
		for (const e of edges) {
			const out = this.outEdgesByNode.get(e.from);
			if (out) out.push(e);
			else this.outEdgesByNode.set(e.from, [e]);
			const inn = this.inEdgesByNode.get(e.to);
			if (inn) inn.push(e);
			else this.inEdgesByNode.set(e.to, [e]);
		}
		if (this.nodeDragFrame !== null) {
			cancelAnimationFrame(this.nodeDragFrame);
			this.nodeDragFrame = null;
		}
		this.nodeElById.clear();
		this.edgeDomById.clear();
		this.pairSet = new Set(edges.map((e) => `${e.from}\0${e.to}`));
		this.edgeMidpoints.clear();
		this.host.classList.toggle('empty', nodes.length === 0);
		this.host.classList.toggle('large-graph', nodes.length >= LARGE_GRAPH_NODES || edges.length >= LARGE_GRAPH_EDGES);
		if (nodes.length === 0) {
			this.placed.clear();
			this.view = null;
			this.minimap.hidden = true;
			return;
		}

		const { placed, bands, width, height } = layoutGraph(nodes, edges, this.direction);
		this.placed = placed;
		this.graphWidth = width;
		this.graphHeight = height;

		// Pure vector <defs> (no raster feDropShadow filter so text & strokes stay razor-sharp at every zoom).
		const defs = svgEl('defs', {}, [
			this.makeArrowMarker('an-arrow-norm', 'an-marker-norm', 6),
			this.makeArrowMarker('an-arrow-cycle', 'an-marker-cycle', 6),
			this.makeArrowMarker('an-arrow-sel', 'an-marker-sel', 6.5),
			this.makeArrowMarker('an-arrow-in', 'an-marker-in', 6.5),
			this.makeArrowMarker('an-arrow-out', 'an-marker-out', 6.5)
		]);

		// Subtle architectural layer guide bands (L0, L1, L2...) behind edges & nodes.
		const bandsLayer = svgEl('g', { class: 'an-bands-layer' });
		if (bands.length > 1) {
			for (const band of bands) {
				if (this.direction === 'TB') {
					bandsLayer.append(
						svgEl('rect', {
							class: 'an-layer-band',
							x: 16,
							y: band.start,
							width: Math.max(0, width - 32),
							height: Math.max(0, band.end - band.start),
							rx: 14
						}),
						svgEl('text', { class: 'an-layer-tag', x: 26, y: band.start + 16 }, [`L${band.layer}`])
					);
				} else {
					bandsLayer.append(
						svgEl('rect', {
							class: 'an-layer-band',
							x: band.start,
							y: 16,
							width: Math.max(0, band.end - band.start),
							height: Math.max(0, height - 32),
							rx: 14
						}),
						svgEl('text', { class: 'an-layer-tag', x: band.start + 12, y: 32 }, [`L${band.layer}`])
					);
				}
			}
		}

		const { outOffset, inOffset } = computePortOffsets(edges, placed, this.direction);
		const showAllLabels = edges.length <= 32;
		const skipHiddenBadges = edges.length > 120;

		const edgesLayer = svgEl('g', { class: 'an-edges-layer' });
		for (const edge of edges) {
			const from = placed.get(edge.from);
			const to = placed.get(edge.to);
			if (!from || !to) continue;
			const bi = this.pairSet.has(`${edge.to}\0${edge.from}`);
			const routed = routeEdge(
				from,
				to,
				this.direction,
				outOffset.get(edge.id) ?? 0,
				inOffset.get(edge.id) ?? 0,
				bi,
				edge.isCycle
			);
			this.edgeMidpoints.set(edge.id, { x: routed.mx, y: routed.my });
			const strokeW = Math.min(2.35, 1.2 + Math.log2(edge.weight + 1) * 0.28).toFixed(2);
			const g = svgEl('g', {
				class: `an-mod-edge${edge.isCycle ? ' cycle' : ''}`,
				'data-edge-id': edge.id
			});
			const hit = svgEl('path', { d: routed.d, class: 'an-edge-hit' });
			const path = svgEl('path', {
				d: routed.d,
				class: 'an-edge-path',
				'stroke-width': strokeW,
				'stroke-linecap': 'round',
				'stroke-linejoin': 'round',
				'marker-end': edge.isCycle ? 'url(#an-arrow-cycle)' : 'url(#an-arrow-norm)'
			});
			g.append(hit, path);
			let badge: SVGGElement | null = null;
			if (!skipHiddenBadges || edge.isCycle) {
				const badgeText = edge.isCycle ? `⟳ ${edge.weight}` : String(edge.weight);
				const pillW = Math.max(edge.isCycle ? 34 : 24, badgeText.length * 6.2 + 12);
				badge = svgEl('g', {
					class: `an-edge-badge${showAllLabels || edge.isCycle ? '' : ' auto-hide'}`,
					transform: `translate(${routed.mx}, ${routed.my})`
				}, [
					svgEl('rect', { x: -pillW / 2, y: -9, width: pillW, height: 18, rx: 9 }),
					svgEl('text', { x: 0, y: 3.5, 'text-anchor': 'middle' }, [badgeText])
				]);
				g.append(badge);
			}
			this.edgeDomById.set(edge.id, { g, hit, path, badge });
			edgesLayer.append(g);
		}

		// Clean Apple/Google/VS Code inspired vector cards with soft ambient depth and precision ports.
		const headerPath = `M ${CARD_RX} 0 H ${CARD_W - CARD_RX} A ${CARD_RX} ${CARD_RX} 0 0 1 ${CARD_W} ${CARD_RX} V ${HEADER_H} H 0 V ${CARD_RX} A ${CARD_RX} ${CARD_RX} 0 0 1 ${CARD_RX} 0 Z`;
		const nodesLayer = svgEl('g', { class: 'an-nodes-layer' });
		for (const item of placed.values()) {
			const { node, x, y, w, h } = item;
			const classes = ['an-mod-node', `kind-${node.kind}`];
			if (node.inCycle) classes.push('cycle');
			if (node.expandable) classes.push('expandable');
			const g = svgEl('g', {
				class: classes.join(' '),
				'data-node-id': node.id,
				transform: `translate(${x}, ${y})`
			});

			// Pure-vector two-layer ambient shadow + focus halo + crisp rounded card shell.
			g.append(svgEl('rect', { class: 'an-node-shadow-far', x: -0.5, y: 4.5, width: w + 1, height: h, rx: CARD_RX + 0.5 }));
			g.append(svgEl('rect', { class: 'an-node-shadow-vec', x: 0, y: 1.5, width: w, height: h, rx: CARD_RX }));
			g.append(svgEl('rect', { class: 'an-node-halo', x: -3, y: -3, width: w + 6, height: h + 6, rx: CARD_RX + 2.5 }));
			g.append(svgEl('rect', { class: 'an-node-card', x: 0, y: 0, width: w, height: h, rx: CARD_RX }));
			g.append(svgEl('path', { class: 'an-node-header', d: headerPath }));
			g.append(svgEl('line', { class: 'an-node-divider', x1: 0, y1: HEADER_H, x2: w, y2: HEADER_H }));

			// Header content: sleek semantic accent bar + title + drill/kind badge.
			g.append(svgEl('rect', { class: 'an-node-kind-dot', x: 11, y: (HEADER_H - 14) / 2, width: 3.5, height: 14, rx: 1.75 }));
			const titleLabel = truncate(node.label || t('analysis.modules.root'), node.expandable ? 22 : 24);
			g.append(svgEl('text', { class: 'an-node-title', x: 21, y: 19.5 }, [titleLabel]));
			if (node.expandable) {
				g.append(svgEl('text', { class: 'an-node-drill', x: w - 12, y: 19.5, 'text-anchor': 'end' }, ['▸']));
			} else if (node.kind === 'external' || node.kind === 'file') {
				const tagText = node.kind === 'external' ? 'EXT' : 'FILE';
				const tagW = node.kind === 'external' ? 28 : 30;
				g.append(
					svgEl('rect', { class: 'an-node-tag-bg', x: w - 10 - tagW, y: 7.5, width: tagW, height: 15, rx: 4.5 }),
					svgEl('text', { class: 'an-node-ext-tag', x: w - 10 - tagW / 2, y: 18, 'text-anchor': 'middle' }, [tagText])
				);
			}

			// Body row 1: files/symbols summary + subtle layer pill.
			const sub = node.kind === 'file'
				? `${node.symbols} syms`
				: `${node.files} files · ${node.symbols} syms`;
			g.append(svgEl('text', { class: 'an-node-sub', x: 13, y: 51 }, [sub]));
			const layerLabel = `L${node.layer}`;
			const layerW = Math.max(24, layerLabel.length * 6.5 + 10);
			g.append(
				svgEl('rect', { class: 'an-node-layer-bg', x: w - 12 - layerW, y: 39.5, width: layerW, height: 16, rx: 5 }),
				svgEl('text', { class: 'an-node-layer', x: w - 12 - layerW / 2, y: 50.5, 'text-anchor': 'middle' }, [layerLabel])
			);

			// Body row 2: fan-in/fan-out + visual instability bar + value.
			const coupling = `↓${node.fanIn}  ↑${node.fanOut}`;
			g.append(svgEl('text', { class: 'an-node-meta', x: 13, y: 76 }, [coupling]));

			const barW = 38;
			const barX = w - 13 - barW - 46;
			const barY = 70.5;
			const instClamped = Math.max(0, Math.min(1, node.instability));
			const instTier = node.inCycle ? 'cycle' : instClamped >= 0.75 ? 'high' : instClamped >= 0.35 ? 'mid' : 'low';
			g.append(
				svgEl('rect', { class: 'an-inst-track', x: barX, y: barY, width: barW, height: 3.5, rx: 1.75 }),
				svgEl('rect', { class: `an-inst-fill ${instTier}`, x: barX, y: barY, width: Math.max(3, barW * instClamped), height: 3.5, rx: 1.75 })
			);
			const instLabel = node.inCycle ? `⟳ ${node.instability.toFixed(2)}` : `I=${node.instability.toFixed(2)}`;
			g.append(svgEl('text', {
				class: `an-node-inst${node.inCycle ? ' cycle' : ''}`,
				x: w - 13,
				y: 76,
				'text-anchor': 'end'
			}, [instLabel]));

			// Precision input/output port sockets on the card boundary.
			if (node.fanIn > 0) {
				const px = this.direction === 'TB' ? w / 2 : 0;
				const py = this.direction === 'TB' ? 0 : h / 2;
				g.append(svgEl('circle', { class: 'an-node-port in', cx: px, cy: py, r: 2.8 }));
			}
			if (node.fanOut > 0) {
				const px = this.direction === 'TB' ? w / 2 : w;
				const py = this.direction === 'TB' ? h : h / 2;
				g.append(svgEl('circle', { class: 'an-node-port out', cx: px, cy: py, r: 2.8 }));
			}

			this.nodeElById.set(node.id, g);
			nodesLayer.append(g);
		}

		// Full-viewport SVG with vector-space <g class="an-viewport"> transform so zooming
		// in or out always re-rasterizes crisp vector text and curves (like Netron).
		const viewport = svgEl('g', { class: 'an-viewport' }, [bandsLayer, edgesLayer, nodesLayer]);
		this.viewportGroup = viewport;
		const svg = svgEl('svg', {
			class: 'an-svg-canvas',
			width: '100%',
			height: '100%'
		}, [defs, viewport]);
		this.svgElRef = svg;
		this.content.append(svg);

		this.fit();
		this.renderMinimap();
	}

	private makeArrowMarker(id: string, cls: string, size: number): SVGMarkerElement {
		return svgEl('marker', {
			id,
			viewBox: '0 0 10 10',
			refX: 8.2,
			refY: 5,
			markerWidth: size,
			markerHeight: size,
			orient: 'auto-start-reverse'
		}, [svgEl('path', { d: 'M 1 1.6 L 8.8 5 L 1 8.4 L 2.8 5 z', class: cls })]);
	}

	/** Recompute edges incident to a dragged node (and preserve neighbor port distribution). */
	private rerouteIncidentEdges(nodeId: string): void {
		if (!this.svgElRef) return;
		const outList = this.outEdgesByNode.get(nodeId) ?? [];
		const inList = this.inEdgesByNode.get(nodeId) ?? [];
		if (outList.length === 0 && inList.length === 0) return;
		const portScope: ModuleEdge[] = [];
		const seen = new Set<string>();
		const addEdge = (e: ModuleEdge) => {
			if (!seen.has(e.id)) {
				seen.add(e.id);
				portScope.push(e);
			}
		};
		for (const e of outList) {
			addEdge(e);
			for (const peer of this.inEdgesByNode.get(e.to) ?? []) addEdge(peer);
		}
		for (const e of inList) {
			addEdge(e);
			for (const peer of this.outEdgesByNode.get(e.from) ?? []) addEdge(peer);
		}
		const { outOffset, inOffset } = computePortOffsets(portScope, this.placed, this.direction);
		for (const edge of portScope) {
			this.updateEdgeDom(edge, outOffset.get(edge.id) ?? 0, inOffset.get(edge.id) ?? 0);
		}
	}

	/** Recompute all edge paths & badges after a layout reset. */
	private rerouteAllEdges(): void {
		if (!this.svgElRef) return;
		const { outOffset, inOffset } = computePortOffsets(this.currentEdges, this.placed, this.direction);
		for (const edge of this.currentEdges) {
			this.updateEdgeDom(edge, outOffset.get(edge.id) ?? 0, inOffset.get(edge.id) ?? 0);
		}
	}

	private updateEdgeDom(edge: ModuleEdge, outOff: number, inOff: number): void {
		const from = this.placed.get(edge.from);
		const to = this.placed.get(edge.to);
		if (!from || !to) return;
		const ref = this.edgeDomById.get(edge.id);
		if (!ref) return;
		const bi = this.pairSet.has(`${edge.to}\0${edge.from}`);
		const routed = routeEdge(from, to, this.direction, outOff, inOff, bi, edge.isCycle);
		this.edgeMidpoints.set(edge.id, { x: routed.mx, y: routed.my });
		ref.hit.setAttribute('d', routed.d);
		ref.path.setAttribute('d', routed.d);
		if (ref.badge) ref.badge.setAttribute('transform', `translate(${routed.mx}, ${routed.my})`);
	}

	/** Apply batched selection/dimming state classes onto nodes and edges. */
	setStates(nodeStates: Record<string, string[]>, edgeStates: Record<string, string[]>): void {
		this.lastNodeStates = nodeStates;
		this.lastEdgeStates = edgeStates;
		if (!this.svgElRef) return;
		this.hasSelection = Object.keys(nodeStates).length > 0 || Object.keys(edgeStates).length > 0;
		this.cancelPendingHover();
		this.clearHoverHighlight();
		for (const [id, nodeEl] of this.nodeElById) {
			const list = nodeStates[id] ?? [];
			for (const state of ['selected', 'related', 'dim', 'upstream', 'downstream']) {
				nodeEl.classList.toggle(state, list.includes(state));
			}
		}
		for (const [id, ref] of this.edgeDomById) {
			const list = edgeStates[id] ?? [];
			for (const state of ['selected', 'dim', 'upstream', 'downstream']) {
				ref.g.classList.toggle(state, list.includes(state));
			}
			if (list.includes('selected')) {
				if (list.includes('upstream')) ref.path.setAttribute('marker-end', 'url(#an-arrow-in)');
				else if (list.includes('downstream')) ref.path.setAttribute('marker-end', 'url(#an-arrow-out)');
				else ref.path.setAttribute('marker-end', 'url(#an-arrow-sel)');
			} else if (ref.g.classList.contains('cycle')) {
				ref.path.setAttribute('marker-end', 'url(#an-arrow-cycle)');
			} else {
				ref.path.setAttribute('marker-end', 'url(#an-arrow-norm)');
			}
		}
		this.renderMinimap();
	}

	/** Compute the live bounding box of all placed nodes (including user-dragged positions). */
	private getContentBounds(): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
		if (this.placed.size === 0) {
			const width = this.graphWidth || 640;
			const height = this.graphHeight || 360;
			return { minX: 0, minY: 0, maxX: width, maxY: height, width, height };
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const item of this.placed.values()) {
			if (item.x < minX) minX = item.x;
			if (item.y < minY) minY = item.y;
			if (item.x + item.w > maxX) maxX = item.x + item.w;
			if (item.y + item.h > maxY) maxY = item.y + item.h;
		}
		minX -= PAD_X;
		minY -= PAD_Y;
		maxX += PAD_X;
		maxY += PAD_Y;
		return {
			minX,
			minY,
			maxX,
			maxY,
			width: Math.max(320, maxX - minX),
			height: Math.max(240, maxY - minY)
		};
	}

	/** Smoothly centre one node or edge in the viewport without changing zoom. */
	focusElement(id: string): void {
		const view = this.view;
		if (!view) return;
		let cx: number | null = null;
		let cy: number | null = null;
		const item = this.placed.get(id);
		if (item) {
			cx = item.x + item.w / 2;
			cy = item.y + item.h / 2;
		} else {
			const mid = this.edgeMidpoints.get(id);
			if (mid) {
				cx = mid.x;
				cy = mid.y;
			}
		}
		if (cx === null || cy === null) return;
		this.userMoved = true;
		const next: ViewState = {
			...view,
			x: this.host.clientWidth / 2 - cx * view.scale,
			y: this.host.clientHeight / 2 - cy * view.scale
		};
		this.animateOrCommit(next, true);
	}

	/** Fit the whole architecture graph (including any moved nodes) into the host viewport. */
	fit(animate = false): void {
		const bounds = this.getContentBounds();
		const width = bounds.width || 640;
		const height = bounds.height || 360;
		const cw = this.host.clientWidth;
		const ch = this.host.clientHeight;
		this.userMoved = false;
		if (cw <= 0 || ch <= 0) {
			this.commitView({ fitScale: 1, width, height, scale: 1, x: -bounds.minX, y: -bounds.minY });
			return;
		}
		const fitScale = Math.min(
			1.15,
			Math.min((cw - FIT_PADDING * 2) / width, (ch - FIT_PADDING * 2) / height)
		);
		const scale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
		this.animateOrCommit({
			fitScale: scale,
			width,
			height,
			scale,
			x: (cw - width * scale) / 2 - bounds.minX * scale,
			y: (ch - height * scale) / 2 - bounds.minY * scale
		}, animate);
	}

	onShown(): void {
		if (!this.userMoved && this.placed.size > 0) this.fit();
	}

	destroy(): void {
		this.cancelAnimation();
		this.cancelPendingHover();
		if (this.viewFrame !== null) cancelAnimationFrame(this.viewFrame);
		if (this.nodeDragFrame !== null) cancelAnimationFrame(this.nodeDragFrame);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	/* ---------- Hover Neighborhood Highlight & Floating Tooltip ---------- */

	private cancelPendingHover(): void {
		if (this.hoverClearTimer !== null) {
			clearTimeout(this.hoverClearTimer);
			this.hoverClearTimer = null;
		}
		if (this.hoverFrame !== null) {
			cancelAnimationFrame(this.hoverFrame);
			this.hoverFrame = null;
		}
		if (this.tooltipFrame !== null) {
			cancelAnimationFrame(this.tooltipFrame);
			this.tooltipFrame = null;
		}
		this.pendingHoverHit = null;
		this.pendingHoverPos = null;
		this.pendingTooltipPos = null;
	}

	private scheduleHoverClear(): void {
		if (this.hoverClearTimer !== null) return;
		this.hoverClearTimer = setTimeout(() => {
			this.hoverClearTimer = null;
			this.hoveredHit = null;
			this.clearHoverHighlight();
			this.hideTooltip();
		}, HOVER_CLEAR_DELAY_MS);
	}

	private onHoverMove(event: PointerEvent): void {
		if (this.nodeDrag?.active || this.panDrag) return;
		const hit = DiagramView.hitOf(event);
		if (!hit) {
			if (this.hoveredHit || this.pendingHoverHit) {
				this.pendingHoverHit = null;
				this.scheduleHoverClear();
			}
			return;
		}
		if (this.hoverClearTimer !== null) {
			clearTimeout(this.hoverClearTimer);
			this.hoverClearTimer = null;
		}
		if (this.hoveredHit && this.hoveredHit.kind === hit.kind && this.hoveredHit.id === hit.id) return;
		this.pendingHoverHit = hit;
		this.pendingHoverPos = { x: event.clientX, y: event.clientY };
		if (this.hoverFrame !== null) return;
		this.hoverFrame = requestAnimationFrame(() => {
			this.hoverFrame = null;
			const nextHit = this.pendingHoverHit;
			const nextPos = this.pendingHoverPos;
			this.pendingHoverHit = null;
			this.pendingHoverPos = null;
			if (!nextHit || !nextPos || this.nodeDrag?.active || this.panDrag) return;
			if (this.hoveredHit && this.hoveredHit.kind === nextHit.kind && this.hoveredHit.id === nextHit.id) return;
			this.hoveredHit = nextHit;
			if (!this.hasSelection) this.applyHoverHighlight(nextHit);
			this.showTooltip(nextHit, nextPos.x, nextPos.y);
		});
	}

	private onTooltipMove(event: PointerEvent): void {
		if (this.pendingHoverHit) {
			this.pendingHoverPos = { x: event.clientX, y: event.clientY };
		}
		if (!this.hoveredHit || this.tooltip.hidden) return;
		this.pendingTooltipPos = { x: event.clientX, y: event.clientY };
		if (this.tooltipFrame !== null) return;
		this.tooltipFrame = requestAnimationFrame(() => {
			this.tooltipFrame = null;
			const pos = this.pendingTooltipPos;
			this.pendingTooltipPos = null;
			if (!pos || !this.hoveredHit || this.tooltip.hidden) return;
			this.positionTooltip(pos.x, pos.y);
		});
	}

	private onHoverOut(event: PointerEvent): void {
		const related = event.relatedTarget;
		if (related instanceof Node && this.content.contains(related)) {
			const nextHit = DiagramView.hitOf({ target: related } as unknown as Event);
			if (nextHit) {
				// Pointer moved straight onto another node/edge (or stayed inside the same one);
				// keep `has-hover` steady so background dimming never flashes between nodes.
				return;
			}
		}
		this.pendingHoverHit = null;
		this.scheduleHoverClear();
	}

	/** O(degree) hover highlight: keep `has-hover` on the SVG root and touch only incident nodes/edges. */
	private applyHoverHighlight(hit: { kind: 'node' | 'edge'; id: string }): void {
		const svg = this.svgElRef;
		if (!svg) return;

		for (const prev of this.activeHoverEls) {
			prev.classList.remove('hover-self', 'hover-in', 'hover-out');
		}
		const nextActive: SVGElement[] = [];
		const mark = (elRef: SVGElement | undefined, cls: 'hover-self' | 'hover-in' | 'hover-out') => {
			if (!elRef) return;
			elRef.classList.add(cls);
			nextActive.push(elRef);
		};

		if (hit.kind === 'node') {
			mark(this.nodeElById.get(hit.id), 'hover-self');
			const outEdges = this.outEdgesByNode.get(hit.id);
			if (outEdges) {
				for (const e of outEdges) {
					mark(this.edgeDomById.get(e.id)?.g, 'hover-out');
					if (e.to !== hit.id) mark(this.nodeElById.get(e.to), 'hover-out');
				}
			}
			const inEdges = this.inEdgesByNode.get(hit.id);
			if (inEdges) {
				for (const e of inEdges) {
					mark(this.edgeDomById.get(e.id)?.g, 'hover-in');
					if (e.from !== hit.id) mark(this.nodeElById.get(e.from), 'hover-in');
				}
			}
		} else {
			const edge = this.edgesById.get(hit.id);
			if (edge) {
				mark(this.edgeDomById.get(edge.id)?.g, 'hover-out');
				mark(this.nodeElById.get(edge.from), 'hover-in');
				mark(this.nodeElById.get(edge.to), 'hover-out');
			}
		}

		this.activeHoverEls = nextActive;
		if (!svg.classList.contains('has-hover')) svg.classList.add('has-hover');
	}

	private clearHoverHighlight(): void {
		const svg = this.svgElRef;
		if (svg) svg.classList.remove('has-hover');
		for (const prev of this.activeHoverEls) {
			prev.classList.remove('hover-self', 'hover-in', 'hover-out');
		}
		this.activeHoverEls = [];
	}

	private showTooltip(hit: { kind: 'node' | 'edge'; id: string }, clientX: number, clientY: number): void {
		this.tooltip.textContent = '';
		if (hit.kind === 'node') {
			const node = this.nodesById.get(hit.id);
			if (!node) return;
			this.tooltip.append(
				el('div', 'an-tip-head', [
					el('span', `an-tip-dot kind-${node.kind}${node.inCycle ? ' cycle' : ''}`),
					el('span', 'an-tip-title', [moduleLabel(node.id)]),
					el('span', 'an-tip-badge', [`L${node.layer}`])
				]),
				el('div', 'an-tip-grid', [
					el('span', undefined, [`${node.files} files · ${node.symbols} syms`]),
					el('span', undefined, [`In ${node.fanIn} · Out ${node.fanOut} · I=${node.instability.toFixed(2)}`])
				])
			);
			if (node.inCycle) {
				this.tooltip.append(el('div', 'an-tip-warn', [t('analysis.modules.inspector.cycleTag')]));
			}
		} else {
			const edge = this.edgesById.get(hit.id);
			if (!edge) return;
			const breakdown: string[] = [];
			if ((edge.callRefs ?? 0) > 0) breakdown.push(`${t('analysis.modules.edgeType.calls')} ${edge.callRefs}`);
			if ((edge.typeRefs ?? 0) > 0) breakdown.push(`${t('analysis.modules.edgeType.typeRefs')} ${edge.typeRefs}`);
			if (edge.baseRefs > 0) breakdown.push(`${t('analysis.modules.edgeType.baseRefs')} ${edge.baseRefs}`);
			if ((edge.importRefs ?? 0) > 0) breakdown.push(`${t('analysis.modules.edgeType.imports')} ${edge.importRefs}`);
			this.tooltip.append(
				el('div', 'an-tip-head', [
					el('span', 'an-tip-title', [`${moduleLabel(edge.from)} → ${moduleLabel(edge.to)}`])
				]),
				el('div', 'an-tip-grid', [
					el('span', undefined, [`${tf('analysis.modules.calls', edge.weight)} · ${tf('analysis.modules.filePairs', edge.filePairs)}`]),
					...(breakdown.length > 0 ? [el('span', undefined, [breakdown.join(' · ')])] : [])
				])
			);
			if (edge.topSymbols.length > 0) {
				this.tooltip.append(el('div', 'an-tip-syms', [edge.topSymbols.slice(0, 5).join(', ')]));
			}
			if (edge.isCycle) {
				this.tooltip.append(el('div', 'an-tip-warn', [t('analysis.modules.inspector.cycleTag')]));
			}
		}
		this.tooltip.hidden = false;
		this.cachedHostRect = this.host.getBoundingClientRect();
		this.cachedTooltipSize = { w: this.tooltip.offsetWidth, h: this.tooltip.offsetHeight };
		this.positionTooltip(clientX, clientY);
	}

	private positionTooltip(clientX: number, clientY: number): void {
		const rect = this.cachedHostRect ?? this.host.getBoundingClientRect();
		const tipW = this.cachedTooltipSize?.w ?? this.tooltip.offsetWidth;
		const tipH = this.cachedTooltipSize?.h ?? this.tooltip.offsetHeight;
		const x = clientX - rect.left + 14;
		const y = clientY - rect.top + 14;
		const maxX = Math.max(8, rect.width - tipW - 10);
		const maxY = Math.max(8, rect.height - tipH - 10);
		const tx = Math.round(Math.max(8, Math.min(x, maxX)));
		const ty = Math.round(Math.max(8, Math.min(y, maxY)));
		this.tooltip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
	}

	private hideTooltip(): void {
		this.tooltip.hidden = true;
		this.cachedTooltipSize = null;
	}

	/* ---------- Interactive Minimap ---------- */

	private syncMinimapVisibility(): void {
		this.minimap.hidden = !this.minimapVisible || this.placed.size < 2;
		if (!this.minimap.hidden) this.updateMinimapViewport();
	}

	private renderMinimap(): void {
		this.minimap.textContent = '';
		const view = this.view;
		if (!view || this.placed.size < 2) {
			this.minimap.hidden = true;
			return;
		}
		this.syncMinimapVisibility();
		const bounds = this.getContentBounds();
		const scale = Math.min((MINIMAP_W - 14) / bounds.width, (MINIMAP_H - 14) / bounds.height);
		const ox = (MINIMAP_W - bounds.width * scale) / 2 - bounds.minX * scale;
		const oy = (MINIMAP_H - bounds.height * scale) / 2 - bounds.minY * scale;
		const svg = svgEl('svg', { width: MINIMAP_W, height: MINIMAP_H, viewBox: `0 0 ${MINIMAP_W} ${MINIMAP_H}` });
		for (const item of this.placed.values()) {
			const nodeEl = this.nodeElById.get(item.node.id);
			const isSel = nodeEl?.classList.contains('selected') ?? false;
			const cls = `an-mini-node kind-${item.node.kind}${item.node.inCycle ? ' cycle' : ''}${isSel ? ' selected' : ''}`;
			svg.append(svgEl('rect', {
				class: cls,
				x: ox + item.x * scale,
				y: oy + item.y * scale,
				width: Math.max(4, item.w * scale),
				height: Math.max(3, item.h * scale),
				rx: 1.5
			}));
		}
		svg.append(svgEl('rect', { class: 'an-minimap-vp', x: 0, y: 0, width: 10, height: 10, rx: 2.5 }));
		this.minimap.append(svg);
		this.updateMinimapViewport();
	}

	private updateMinimapViewport(): void {
		const view = this.view;
		const vp = this.minimap.querySelector<SVGRectElement>('.an-minimap-vp');
		if (!view || !vp || this.host.clientWidth <= 0 || this.host.clientHeight <= 0) return;
		const bounds = this.getContentBounds();
		const scale = Math.min((MINIMAP_W - 14) / bounds.width, (MINIMAP_H - 14) / bounds.height);
		const ox = (MINIMAP_W - bounds.width * scale) / 2 - bounds.minX * scale;
		const oy = (MINIMAP_H - bounds.height * scale) / 2 - bounds.minY * scale;
		const vx = (-view.x / view.scale) * scale + ox;
		const vy = (-view.y / view.scale) * scale + oy;
		const vw = (this.host.clientWidth / view.scale) * scale;
		const vh = (this.host.clientHeight / view.scale) * scale;
		const clampedW = Math.max(10, Math.min(MINIMAP_W - 2, vw));
		const clampedH = Math.max(8, Math.min(MINIMAP_H - 2, vh));
		vp.setAttribute('x', String(Math.max(1, Math.min(MINIMAP_W - clampedW - 1, vx))));
		vp.setAttribute('y', String(Math.max(1, Math.min(MINIMAP_H - clampedH - 1, vy))));
		vp.setAttribute('width', String(clampedW));
		vp.setAttribute('height', String(clampedH));
	}

	private panToMinimapPoint(clientX: number, clientY: number): void {
		const view = this.view;
		if (!view) return;
		const rect = this.minimap.getBoundingClientRect();
		const bounds = this.getContentBounds();
		const scale = Math.min((MINIMAP_W - 14) / bounds.width, (MINIMAP_H - 14) / bounds.height);
		const ox = (MINIMAP_W - bounds.width * scale) / 2 - bounds.minX * scale;
		const oy = (MINIMAP_H - bounds.height * scale) / 2 - bounds.minY * scale;
		const gx = (clientX - rect.left - ox) / scale;
		const gy = (clientY - rect.top - oy) / scale;
		const next: ViewState = {
			...view,
			x: this.host.clientWidth / 2 - gx * view.scale,
			y: this.host.clientHeight / 2 - gy * view.scale
		};
		this.userMoved = true;
		this.scheduleView(next);
	}

	private onMinimapPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.stopPropagation();
		this.minimapDragging = true;
		try {
			this.minimap.setPointerCapture(event.pointerId);
		} catch {
			// ignore
		}
		this.panToMinimapPoint(event.clientX, event.clientY);
	}

	private onMinimapPointerMove(event: PointerEvent): void {
		if (!this.minimapDragging) return;
		event.stopPropagation();
		this.panToMinimapPoint(event.clientX, event.clientY);
	}

	/* ---------- Viewport Transform Core ---------- */

	private commitView(view: ViewState): void {
		this.cancelAnimation();
		this.view = view;
		this.applyTransform();
	}

	private scheduleView(view: ViewState): void {
		this.view = view;
		if (this.viewFrame !== null) return;
		this.viewFrame = requestAnimationFrame(() => {
			this.viewFrame = null;
			this.applyTransform();
		});
	}

	private animateOrCommit(target: ViewState, animate: boolean): void {
		const from = this.view;
		if (!animate || !from || this.prefersReducedMotion()) {
			this.commitView(target);
			return;
		}
		this.cancelAnimation();
		let start: number | null = null;
		const tick = (now: number) => {
			start ??= now;
			const progress = Math.max(0, Math.min((now - start) / ANIMATE_MS, 1));
			const eased = 1 - (1 - progress) ** 3;
			this.view = {
				...target,
				x: from.x + (target.x - from.x) * eased,
				y: from.y + (target.y - from.y) * eased,
				scale: from.scale + (target.scale - from.scale) * eased
			};
			this.applyTransform();
			if (progress < 1) this.animationFrame = requestAnimationFrame(tick);
			else this.commitView(target);
		};
		this.animationFrame = requestAnimationFrame(tick);
	}

	private cancelAnimation(): void {
		if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
		this.animationFrame = null;
	}

	private prefersReducedMotion(): boolean {
		try {
			return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
		} catch {
			return true;
		}
	}

	private applyTransform(): void {
		const view = this.view;
		if (!view) return;
		if (this.viewportGroup) {
			this.viewportGroup.setAttribute(
				'transform',
				`translate(${view.x.toFixed(3)} ${view.y.toFixed(3)}) scale(${view.scale.toFixed(6)})`
			);
		}
		this.zoomLevel.textContent = `${Math.round((view.scale / view.fitScale) * 100)}%`;
		// Subtle dot-grid parallax matching canvas pan & zoom.
		const gridStep = Math.max(12, Math.min(40, 20 * view.scale));
		this.host.style.backgroundSize = `${gridStep}px ${gridStep}px`;
		this.host.style.backgroundPosition = `${view.x % gridStep}px ${view.y % gridStep}px`;
		this.updateMinimapViewport();
	}

	private zoomAt(factor: number, clientX: number, clientY: number, animate = false): void {
		const current = this.view;
		if (!current) return;
		const rect = this.host.getBoundingClientRect();
		const localX = clientX - rect.left;
		const localY = clientY - rect.top;
		const nextScale = Math.min(
			current.fitScale * ZOOM_MAX_RELATIVE,
			Math.max(current.fitScale * ZOOM_MIN_RELATIVE, current.scale * factor)
		);
		const contentX = (localX - current.x) / current.scale;
		const contentY = (localY - current.y) / current.scale;
		const next: ViewState = {
			...current,
			scale: nextScale,
			x: localX - contentX * nextScale,
			y: localY - contentY * nextScale
		};
		this.userMoved = true;
		if (animate) this.animateOrCommit(next, true);
		else this.scheduleView(next);
	}

	private stepZoom(factor: number): void {
		const rect = this.host.getBoundingClientRect();
		this.zoomAt(factor, rect.left + this.host.clientWidth / 2, rect.top + this.host.clientHeight / 2, true);
	}

	private panBy(deltaX: number, deltaY: number): void {
		const current = this.view;
		if (!current) return;
		this.cancelAnimation();
		this.userMoved = true;
		this.scheduleView({ ...current, x: current.x + deltaX, y: current.y + deltaY });
	}

	private onWheel(event: WheelEvent): void {
		if (event.deltaX === 0 && event.deltaY === 0) return;
		event.preventDefault();
		const rate = event.ctrlKey || event.metaKey ? 0.01 : 0.0015;
		this.zoomAt(Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * rate), event.clientX, event.clientY);
	}

	private onGestureStart(event: Event): void {
		event.preventDefault();
		this.gestureScale = 1;
	}

	private onGestureChange(event: Event): void {
		if (this.gestureScale === null) return;
		event.preventDefault();
		const gesture = event as unknown as { scale?: number; clientX?: number; clientY?: number };
		const scale = gesture.scale;
		if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return;
		const rect = this.host.getBoundingClientRect();
		this.zoomAt(
			scale / this.gestureScale,
			gesture.clientX ?? rect.left + this.host.clientWidth / 2,
			gesture.clientY ?? rect.top + this.host.clientHeight / 2
		);
		this.gestureScale = scale;
	}

	private onHostResized(): void {
		this.cachedHostRect = null;
		const view = this.view;
		if (!view || this.host.clientWidth <= 0) return;
		if (this.userMoved) {
			const centreX = (this.host.clientWidth / 2 - view.x) / view.scale;
			const centreY = (this.host.clientHeight / 2 - view.y) / view.scale;
			const fitScale = Math.min(
				1.15,
				Math.min(
					Math.max(this.host.clientWidth - FIT_PADDING * 2, 1) / (view.width || 1),
					Math.max(this.host.clientHeight - FIT_PADDING * 2, 1) / (view.height || 1)
				)
			);
			const next: ViewState = {
				...view,
				fitScale,
				scale: Math.min(fitScale * ZOOM_MAX_RELATIVE, Math.max(fitScale * ZOOM_MIN_RELATIVE, view.scale))
			};
			const recentered = {
				...next,
				x: this.host.clientWidth / 2 - centreX * next.scale,
				y: this.host.clientHeight / 2 - centreY * next.scale
			};
			this.commitView(recentered);
			return;
		}
		this.fit();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 && event.button !== 1) return;
		const target = event.target;
		if (target instanceof Element && target.closest('.an-zoombar, .an-minimap, .an-graphbar')) return;

		this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (this.pointers.size === 2) {
			const [first, second] = [...this.pointers.values()];
			this.pinch = {
				startDistance: Math.hypot(second.x - first.x, second.y - first.y),
				startView: { x: this.view?.x ?? 0, y: this.view?.y ?? 0, scale: this.view?.scale ?? 1 },
				start: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
			};
			this.panDrag = null;
			this.nodeDrag = null;
			return;
		}

		// Middle mouse button or Space+drag always pans the infinite canvas freely (even over nodes).
		if (event.button === 1 || this.spacePressed) {
			event.preventDefault();
			this.panDrag = { x: event.clientX, y: event.clientY };
			return;
		}

		// If pressing on a node card, prepare a node drag (falls back to click if below threshold).
		const hit = DiagramView.hitOf(event);
		if (hit && hit.kind === 'node') {
			const item = this.placed.get(hit.id);
			if (item) {
				this.nodeDrag = {
					id: hit.id,
					startClientX: event.clientX,
					startClientY: event.clientY,
					origX: item.x,
					origY: item.y,
					active: false,
					pendingX: item.x,
					pendingY: item.y
				};
				return;
			}
		}

		this.panDrag = { x: event.clientX, y: event.clientY };
	}

	private onPointerMove(event: PointerEvent): void {
		if (!this.pointers.has(event.pointerId)) return;
		// If the mouse button was released outside `this.host` before capture engaged,
		// drop the stale pointer state instead of dragging with no button held.
		if (event.pointerType === 'mouse' && event.buttons === 0) {
			this.onPointerUp(event);
			return;
		}
		this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

		if (this.pinch && this.pointers.size >= 2) {
			const [first, second] = [...this.pointers.values()];
			const distance = Math.hypot(second.x - first.x, second.y - first.y);
			const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
			const base = this.pinch;
			const view = this.view;
			if (!view || base.startDistance <= 0) return;
			const nextScale = Math.min(
				view.fitScale * ZOOM_MAX_RELATIVE,
				Math.max(view.fitScale * ZOOM_MIN_RELATIVE, base.startView.scale * (distance / base.startDistance))
			);
			const rect = this.host.getBoundingClientRect();
			const startLocalX = base.start.x - rect.left;
			const startLocalY = base.start.y - rect.top;
			const contentX = (startLocalX - base.startView.x) / base.startView.scale;
			const contentY = (startLocalY - base.startView.y) / base.startView.scale;
			this.userMoved = true;
			const next: ViewState = {
				...view,
				scale: nextScale,
				x: midpoint.x - rect.left - contentX * nextScale,
				y: midpoint.y - rect.top - contentY * nextScale
			};
			this.scheduleView(next);
			return;
		}

		if (this.nodeDrag && this.view) {
			const dx = event.clientX - this.nodeDrag.startClientX;
			const dy = event.clientY - this.nodeDrag.startClientY;
			if (!this.nodeDrag.active && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			if (!this.nodeDrag.active) {
				this.nodeDrag.active = true;
				this.dragMoved = true;
				this.cancelPendingHover();
				this.clearHoverHighlight();
				this.hoveredHit = null;
				this.hideTooltip();
				this.host.classList.add('dragging-node');
				try {
					this.host.setPointerCapture(event.pointerId);
				} catch {
					// ignore
				}
			}
			this.nodeDrag.pendingX = this.nodeDrag.origX + dx / this.view.scale;
			this.nodeDrag.pendingY = this.nodeDrag.origY + dy / this.view.scale;
			if (this.nodeDragFrame === null) {
				this.nodeDragFrame = requestAnimationFrame(() => {
					this.nodeDragFrame = null;
					const drag = this.nodeDrag;
					if (!drag || !drag.active) return;
					const item = this.placed.get(drag.id);
					if (!item) return;
					item.x = drag.pendingX;
					item.y = drag.pendingY;
					const nodeEl = this.nodeElById.get(item.node.id);
					if (nodeEl) nodeEl.setAttribute('transform', `translate(${item.x}, ${item.y})`);
					this.rerouteIncidentEdges(item.node.id);
					if (!this.hasCustomPositions) {
						this.hasCustomPositions = true;
						this.resetBtn.hidden = false;
					}
				});
			}
			return;
		}

		const drag = this.panDrag;
		if (!drag) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!this.dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
		this.dragMoved = true;
		this.userMoved = true;
		this.cancelPendingHover();
		this.clearHoverHighlight();
		this.hoveredHit = null;
		this.hideTooltip();
		this.host.classList.add('dragging');
		try {
			this.host.setPointerCapture(event.pointerId);
		} catch {
			// pointer already gone
		}
		this.panBy(dx, dy);
		this.panDrag = { x: event.clientX, y: event.clientY };
	}

	private onPointerUp(event: PointerEvent): void {
		this.pointers.delete(event.pointerId);
		if (this.pointers.size < 2) this.pinch = null;
		if (this.nodeDragFrame !== null) {
			cancelAnimationFrame(this.nodeDragFrame);
			this.nodeDragFrame = null;
		}
		if (this.nodeDrag?.active) {
			const item = this.placed.get(this.nodeDrag.id);
			if (item) {
				item.x = this.nodeDrag.pendingX;
				item.y = this.nodeDrag.pendingY;
				if (!this.hasCustomPositions) {
					this.hasCustomPositions = true;
					this.resetBtn.hidden = false;
				}
				const nodeEl = this.nodeElById.get(item.node.id);
				if (nodeEl) nodeEl.setAttribute('transform', `translate(${item.x}, ${item.y})`);
				this.rerouteIncidentEdges(item.node.id);
			}
			this.renderMinimap();
		}
		this.nodeDrag = null;
		this.panDrag = null;
		this.host.classList.remove('dragging', 'dragging-node');
		// Clear `dragMoved` after the current event turn so a cancelled drag (or release
		// outside the window that fires no `click`) never swallows the user's next click.
		if (this.dragMoved) {
			if (event.type === 'pointercancel') {
				this.dragMoved = false;
			} else {
				setTimeout(() => {
					this.dragMoved = false;
				}, 0);
			}
		}
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.code === 'Space') {
			this.spacePressed = true;
			this.host.classList.add('space-pan');
			event.preventDefault();
			return;
		}
		if (event.key === '+' || event.key === '=') this.stepZoom(ZOOM_STEP);
		else if (event.key === '-' || event.key === '_') this.stepZoom(1 / ZOOM_STEP);
		else if (event.key === '0' || event.key === 'Home' || event.key === 'f' || event.key === 'F') this.fit(true);
		else if (event.key === 'Escape') this.callbacks.onEscape?.();
		else if (event.key === 'ArrowLeft') { this.cancelAnimation(); this.panBy(ARROW_PAN, 0); }
		else if (event.key === 'ArrowRight') { this.cancelAnimation(); this.panBy(-ARROW_PAN, 0); }
		else if (event.key === 'ArrowUp') { this.cancelAnimation(); this.panBy(0, ARROW_PAN); }
		else if (event.key === 'ArrowDown') { this.cancelAnimation(); this.panBy(0, -ARROW_PAN); }
		else return;
		event.preventDefault();
	}

	private onKeyUp(event: KeyboardEvent): void {
		if (event.code === 'Space') {
			this.spacePressed = false;
			this.host.classList.remove('space-pan');
		}
	}
}
