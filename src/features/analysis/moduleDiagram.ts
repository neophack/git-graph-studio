// Native interactive SVG Module Architecture Board (module 17): replaces the legacy
// Mermaid + ELK text compilation pipeline with a zero-dependency, theme-reactive SVG
// canvas over the nine-volume `ModuleOverview` payload.
//
// Layout: nodes arrive with condensed-DAG topological `layer` indices from Rust. Each
// layer arranges its cards horizontally (wrapping cleanly into sub-rows when a layer is
// wide so aspect ratios stay balanced), with smooth curved connectors, red dashed cycle
// arcs (never dropped), wide invisible hit-paths for effortless edge clicking, and
// smooth cursor-centered zoom / drag pan / keyboard navigation.

import { t } from '../../platform/i18n';
import { actionButton, el } from '../../platform/ui/index';
import type { ModuleEdge, ModuleNode } from '../../platform/ipc/analysis';

export type { ModuleEdge, ModuleNode, ModuleOverview } from '../../platform/ipc/analysis';

/** How a module names itself on the page — the workspace root gets a label. */
export function moduleLabel(name: string): string {
	return name || t('analysis.modules.root');
}

/* ---------- Viewport & Layout Constants ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CARD_W = 204;
const CARD_H = 72;
const COL_GAP = 28;
const ROW_GAP = 64;
const SUBROW_GAP = 22;
const MAX_COLS_PER_ROW = 6;
const PAD_X = 48;
const PAD_Y = 44;

const ZOOM_STEP = 1.18;
const FIT_PADDING = 28;
const ZOOM_MIN_RELATIVE = 0.45;
const ZOOM_MAX_RELATIVE = 8;
const ARROW_PAN = 48;
const ANIMATE_MS = 160;
const DRAG_THRESHOLD = 4;

function gutter(container: number): number {
	return Math.max(32, Math.min(160, container * 0.12));
}

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
}

interface PlacedNode {
	node: ModuleNode;
	x: number;
	y: number;
	w: number;
	h: number;
}

interface ViewState {
	fitScale: number;
	width: number;
	height: number;
	scale: number;
	x: number;
	y: number;
}

/** Compute deterministic layered positions for all visible nodes. */
function layoutNodes(nodes: ModuleNode[]): { placed: Map<string, PlacedNode>; width: number; height: number } {
	const placed = new Map<string, PlacedNode>();
	if (nodes.length === 0) return { placed, width: 640, height: 360 };

	// Group by Rust-computed topological layer.
	const byLayer = new Map<number, ModuleNode[]>();
	for (const node of nodes) {
		const list = byLayer.get(node.layer);
		if (list) list.push(node);
		else byLayer.set(node.layer, [node]);
	}
	const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);

	// First pass: split wide layers into balanced sub-rows and find max row width.
	const rows: { layer: number; items: ModuleNode[]; gapAbove: number }[] = [];
	let maxRowWidth = CARD_W;
	for (let li = 0; li < layerKeys.length; li++) {
		const layer = layerKeys[li];
		const items = byLayer.get(layer)!;
		const cols = Math.min(MAX_COLS_PER_ROW, Math.max(1, Math.ceil(items.length / Math.ceil(items.length / MAX_COLS_PER_ROW))));
		for (let i = 0; i < items.length; i += cols) {
			const chunk = items.slice(i, i + cols);
			const rowWidth = chunk.length * CARD_W + (chunk.length - 1) * COL_GAP;
			if (rowWidth > maxRowWidth) maxRowWidth = rowWidth;
			rows.push({
				layer,
				items: chunk,
				gapAbove: rows.length === 0 ? 0 : i === 0 ? ROW_GAP : SUBROW_GAP
			});
		}
	}

	const totalWidth = Math.max(480, maxRowWidth + PAD_X * 2);
	let cursorY = PAD_Y;
	for (const row of rows) {
		cursorY += row.gapAbove;
		const rowWidth = row.items.length * CARD_W + (row.items.length - 1) * COL_GAP;
		let cursorX = (totalWidth - rowWidth) / 2;
		for (const node of row.items) {
			placed.set(node.id, { node, x: cursorX, y: cursorY, w: CARD_W, h: CARD_H });
			cursorX += CARD_W + COL_GAP;
		}
		cursorY += CARD_H;
	}
	const totalHeight = Math.max(320, cursorY + PAD_Y);
	return { placed, width: totalWidth, height: totalHeight };
}

/** Route an edge cleanly between two placed cards; returns SVG path `d` and midpoint. */
function routeEdge(
	from: PlacedNode,
	to: PlacedNode,
	isBidirectional: boolean,
	isCycle: boolean
): { d: string; mx: number; my: number } {
	const fx = from.x + from.w / 2;
	const fy = from.y + from.h / 2;
	const tx = to.x + to.w / 2;
	const ty = to.y + to.h / 2;

	// Offset slightly when both A→B and B→A exist so arrows never overlap.
	const sep = isBidirectional ? (from.node.id < to.node.id ? -14 : 14) : 0;

	if (Math.abs(from.y - to.y) < 4) {
		// Same horizontal row: arch gently above (forward) or below (cycle/reverse).
		const archUp = !isCycle && from.x < to.x;
		const sy = archUp ? from.y : from.y + from.h;
		const ey = archUp ? to.y : to.y + to.h;
		const span = Math.abs(tx - fx);
		const lift = Math.min(72, 26 + span * 0.12) * (archUp ? -1 : 1);
		const sx = fx + sep;
		const ex = tx + sep;
		const cy = sy + lift;
		const d = `M ${sx} ${sy} C ${sx} ${cy}, ${ex} ${cy}, ${ex} ${ey}`;
		return { d, mx: (sx + ex) / 2, my: sy + lift * 0.75 };
	}

	if (from.y < to.y) {
		// Downward architectural flow: bottom port → top port.
		const sx = fx + sep;
		const sy = from.y + from.h;
		const ex = tx + sep;
		const ey = to.y;
		const dy = Math.max(24, (ey - sy) * 0.48);
		const d = `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`;
		return { d, mx: (sx + ex) / 2, my: (sy + ey) / 2 };
	}

	// Upward back-edge (often a cycle): curve smoothly around the side/back.
	const sx = fx + sep;
	const sy = from.y;
	const ex = tx + sep;
	const ey = to.y + to.h;
	const bend = (fx <= tx ? -1 : 1) * Math.min(76, 30 + Math.abs(fy - ty) * 0.14);
	const cx1 = sx + bend;
	const cy1 = sy - Math.max(24, (sy - ey) * 0.35);
	const cx2 = ex + bend;
	const cy2 = ey + Math.max(24, (sy - ey) * 0.35);
	const d = `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`;
	return {
		d,
		mx: 0.125 * sx + 0.375 * cx1 + 0.375 * cx2 + 0.125 * ex,
		my: 0.125 * sy + 0.375 * cy1 + 0.375 * cy2 + 0.125 * ey
	};
}

/** Interactive SVG Module Architecture Canvas. */
export class DiagramView {
	readonly host: HTMLElement;
	private readonly content: HTMLElement;
	private readonly zoomLevel: HTMLElement;
	private resizeObserver: ResizeObserver | null = null;
	private view: ViewState | null = null;
	private placed = new Map<string, PlacedNode>();
	private nodesById = new Map<string, ModuleNode>();
	private userMoved = false;
	private dragMoved = false;
	private drag: { x: number; y: number } | null = null;
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
		this.host.append(el('div', 'an-zoombar', [
			el('div', 'pill', [
				actionButton('remove', t('analysis.modules.zoomOut'), () => this.stepZoom(1 / ZOOM_STEP)),
				this.zoomLevel,
				actionButton('add', t('analysis.modules.zoomIn'), () => this.stepZoom(ZOOM_STEP))
			]),
			actionButton('screen-full', t('analysis.modules.fit'), () => this.fit(true))
		]));

		this.content = el('div', 'an-svg-stage');
		this.host.append(this.content);

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

		this.host.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.host.addEventListener('gesturestart', (event) => this.onGestureStart(event), { passive: false } as AddEventListenerOptions);
		this.host.addEventListener('gesturechange', (event) => this.onGestureChange(event), { passive: false } as AddEventListenerOptions);
		this.host.addEventListener('gestureend', () => { this.gestureScale = null; });
		this.host.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		this.host.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.host.addEventListener('pointerup', (event) => this.onPointerUp(event));
		this.host.addEventListener('pointercancel', (event) => this.onPointerUp(event));
		this.host.addEventListener('keydown', (event) => this.onKeyDown(event));
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

	/** Synchronously build and mount the native SVG architecture graph. */
	setGraph(nodes: ModuleNode[], edges: ModuleEdge[]): void {
		this.content.textContent = '';
		this.userMoved = false;
		this.nodesById = new Map(nodes.map((n) => [n.id, n]));
		this.host.classList.toggle('empty', nodes.length === 0);
		if (nodes.length === 0) {
			this.placed.clear();
			this.view = null;
			return;
		}

		const { placed, width, height } = layoutNodes(nodes);
		this.placed = placed;

		const pairSet = new Set(edges.map((e) => `${e.from}\0${e.to}`));
		const showAllLabels = edges.length <= 28;

		const defs = svgEl('defs', {}, [
			svgEl('marker', {
				id: 'an-arrow-norm',
				viewBox: '0 0 10 10',
				refX: 8.5,
				refY: 5,
				markerWidth: 6.5,
				markerHeight: 6.5,
				orient: 'auto-start-reverse'
			}, [svgEl('path', { d: 'M 0 1.5 L 9 5 L 0 8.5 z', class: 'an-marker-norm' })]),
			svgEl('marker', {
				id: 'an-arrow-cycle',
				viewBox: '0 0 10 10',
				refX: 8.5,
				refY: 5,
				markerWidth: 6.5,
				markerHeight: 6.5,
				orient: 'auto-start-reverse'
			}, [svgEl('path', { d: 'M 0 1.5 L 9 5 L 0 8.5 z', class: 'an-marker-cycle' })]),
			svgEl('marker', {
				id: 'an-arrow-sel',
				viewBox: '0 0 10 10',
				refX: 8.5,
				refY: 5,
				markerWidth: 7,
				markerHeight: 7,
				orient: 'auto-start-reverse'
			}, [svgEl('path', { d: 'M 0 1.5 L 9 5 L 0 8.5 z', class: 'an-marker-sel' })])
		]);

		const edgesLayer = svgEl('g', { class: 'an-edges-layer' });
		for (const edge of edges) {
			const from = placed.get(edge.from);
			const to = placed.get(edge.to);
			if (!from || !to) continue;
			const bi = pairSet.has(`${edge.to}\0${edge.from}`);
			const { d, mx, my } = routeEdge(from, to, bi, edge.isCycle);
			const strokeW = Math.min(3.4, 1.3 + Math.log2(edge.weight + 1) * 0.42).toFixed(2);
			const g = svgEl('g', {
				class: `an-mod-edge${edge.isCycle ? ' cycle' : ''}`,
				'data-edge-id': edge.id
			});
			const titleText = `${moduleLabel(edge.from)} → ${moduleLabel(edge.to)} · ${edge.weight} refs (${edge.filePairs} file pairs)${edge.isCycle ? ' [cycle]' : ''}`;
			g.append(svgEl('title', {}, [titleText]));
			// Wide transparent hit area so thin edges are easy to click.
			g.append(svgEl('path', { d, class: 'an-edge-hit' }));
			g.append(svgEl('path', {
				d,
				class: 'an-edge-path',
				'stroke-width': strokeW,
				'marker-end': edge.isCycle ? 'url(#an-arrow-cycle)' : 'url(#an-arrow-norm)'
			}));
			const badgeText = String(edge.weight);
			const pillW = Math.max(22, badgeText.length * 7 + 10);
			const labelG = svgEl('g', {
				class: `an-edge-badge${showAllLabels || edge.isCycle ? '' : ' auto-hide'}`,
				transform: `translate(${mx}, ${my})`
			}, [
				svgEl('rect', { x: -pillW / 2, y: -9, width: pillW, height: 18, rx: 9 }),
				svgEl('text', { x: 0, y: 3.5, 'text-anchor': 'middle' }, [badgeText])
			]);
			g.append(labelG);
			edgesLayer.append(g);
		}

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
			g.append(svgEl('title', {}, [
				`${moduleLabel(node.id)}\n${node.files} files · ${node.symbols} symbols · In ${node.fanIn} / Out ${node.fanOut} · I=${node.instability.toFixed(2)}`
			]));
			// Card body + top accent bar.
			g.append(svgEl('rect', { class: 'an-node-card', x: 0, y: 0, width: w, height: h, rx: 8 }));
			g.append(svgEl('rect', { class: 'an-node-accent', x: 0, y: 0, width: w, height: 4, rx: 2 }));

			// Title row.
			const titleLabel = truncate(node.label || t('analysis.modules.root'), node.expandable ? 21 : 24);
			g.append(svgEl('text', { class: 'an-node-title', x: 12, y: 26 }, [titleLabel]));
			if (node.expandable) {
				g.append(svgEl('text', { class: 'an-node-drill', x: w - 12, y: 26, 'text-anchor': 'end' }, ['▸']));
			} else if (node.kind === 'external') {
				g.append(svgEl('text', { class: 'an-node-ext-tag', x: w - 12, y: 25, 'text-anchor': 'end' }, ['EXT']));
			}

			// Subtitle: file & symbol counts.
			const sub = node.kind === 'file'
				? `${node.symbols} syms`
				: `${node.files} files · ${node.symbols} syms`;
			g.append(svgEl('text', { class: 'an-node-sub', x: 12, y: 44 }, [sub]));

			// Metrics footer: fan-in/out & instability.
			const coupling = `↓${node.fanIn}  ↑${node.fanOut}`;
			g.append(svgEl('text', { class: 'an-node-meta', x: 12, y: 61 }, [coupling]));
			const instLabel = node.inCycle ? `⟳ I=${node.instability.toFixed(2)}` : `I=${node.instability.toFixed(2)}`;
			g.append(svgEl('text', {
				class: `an-node-inst${node.inCycle ? ' cycle' : ''}`,
				x: w - 12,
				y: 61,
				'text-anchor': 'end'
			}, [instLabel]));

			nodesLayer.append(g);
		}

		const svg = svgEl('svg', {
			class: 'an-svg-canvas',
			viewBox: `0 0 ${width} ${height}`,
			width,
			height
		}, [defs, edgesLayer, nodesLayer]);
		svg.style.width = `${width}px`;
		svg.style.height = `${height}px`;
		this.content.append(svg);

		this.fit();
	}

	/** Apply batched selection/dimming state classes onto nodes and edges. */
	setStates(nodeStates: Record<string, string[]>, edgeStates: Record<string, string[]>): void {
		const svg = this.content.querySelector('svg');
		if (!svg) return;
		for (const el of svg.querySelectorAll<SVGElement>('[data-node-id]')) {
			const id = el.getAttribute('data-node-id')!;
			const list = nodeStates[id] ?? [];
			for (const state of ['selected', 'related', 'dim']) {
				el.classList.toggle(state, list.includes(state));
			}
		}
		for (const el of svg.querySelectorAll<SVGElement>('[data-edge-id]')) {
			const id = el.getAttribute('data-edge-id')!;
			const list = edgeStates[id] ?? [];
			for (const state of ['selected', 'dim']) {
				el.classList.toggle(state, list.includes(state));
			}
			const path = el.querySelector('.an-edge-path');
			if (path) {
				if (list.includes('selected')) {
					path.setAttribute('marker-end', 'url(#an-arrow-sel)');
				} else if (el.classList.contains('cycle')) {
					path.setAttribute('marker-end', 'url(#an-arrow-cycle)');
				} else {
					path.setAttribute('marker-end', 'url(#an-arrow-norm)');
				}
			}
		}
	}

	/** Smoothly centre one node in the viewport without changing zoom. */
	focusElement(id: string): void {
		const view = this.view;
		const item = this.placed.get(id);
		if (!view || !item) return;
		this.userMoved = true;
		const cx = item.x + item.w / 2;
		const cy = item.y + item.h / 2;
		const next: ViewState = {
			...view,
			x: this.host.clientWidth / 2 - cx * view.scale,
			y: this.host.clientHeight / 2 - cy * view.scale
		};
		this.commitView({ ...next, ...this.clamp(next) });
	}

	/** Fit the whole architecture graph into the host viewport. */
	fit(animate = false): void {
		const svg = this.content.querySelector('svg');
		const width = Number(svg?.getAttribute('width') ?? 640) || 640;
		const height = Number(svg?.getAttribute('height') ?? 360) || 360;
		const cw = this.host.clientWidth;
		const ch = this.host.clientHeight;
		this.userMoved = false;
		if (cw <= 0 || ch <= 0) {
			this.commitView({ fitScale: 1, width, height, scale: 1, x: 0, y: 0 });
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
			x: (cw - width * scale) / 2,
			y: (ch - height * scale) / 2
		}, animate);
	}

	onShown(): void {
		if (!this.userMoved && this.placed.size > 0) this.fit();
	}

	destroy(): void {
		this.cancelAnimation();
		if (this.viewFrame !== null) cancelAnimationFrame(this.viewFrame);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	/* ---------- Viewport Transform Core ---------- */

	private clamp(view: ViewState): { x: number; y: number } {
		const cw = this.host.clientWidth;
		const ch = this.host.clientHeight;
		const scaledWidth = view.width * view.scale;
		const scaledHeight = view.height * view.scale;
		const gx = gutter(cw);
		const gy = gutter(ch);
		return {
			x: scaledWidth <= cw ? (cw - scaledWidth) / 2 : Math.max(cw - scaledWidth - gx, Math.min(gx, view.x)),
			y: scaledHeight <= ch ? (ch - scaledHeight) / 2 : Math.max(ch - scaledHeight - gy, Math.min(gy, view.y))
		};
	}

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
		this.content.style.left = '0';
		this.content.style.top = '0';
		this.content.style.position = 'absolute';
		this.content.style.transformOrigin = '0 0';
		this.content.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
		this.zoomLevel.textContent = `${Math.round((view.scale / view.fitScale) * 100)}%`;
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
		const clamped = this.clamp(next);
		this.userMoved = true;
		if (animate) this.animateOrCommit({ ...next, ...clamped }, true);
		else this.scheduleView({ ...next, ...clamped });
	}

	private stepZoom(factor: number): void {
		const rect = this.host.getBoundingClientRect();
		this.zoomAt(factor, rect.left + this.host.clientWidth / 2, rect.top + this.host.clientHeight / 2, true);
	}

	private panBy(deltaX: number, deltaY: number): void {
		const current = this.view;
		if (!current) return;
		const clamped = this.clamp({ ...current, x: current.x + deltaX, y: current.y + deltaY });
		this.userMoved = true;
		this.scheduleView({ ...current, ...clamped });
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
			this.commitView({ ...recentered, ...this.clamp(recentered) });
			return;
		}
		this.fit();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (this.pointers.size === 2) {
			const [first, second] = [...this.pointers.values()];
			this.pinch = {
				startDistance: Math.hypot(second.x - first.x, second.y - first.y),
				startView: { x: this.view?.x ?? 0, y: this.view?.y ?? 0, scale: this.view?.scale ?? 1 },
				start: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
			};
			this.drag = null;
			return;
		}
		this.drag = { x: event.clientX, y: event.clientY };
	}

	private onPointerMove(event: PointerEvent): void {
		if (!this.pointers.has(event.pointerId)) return;
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
			this.scheduleView({ ...next, ...this.clamp(next) });
			return;
		}
		const drag = this.drag;
		if (!drag) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!this.dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
		this.dragMoved = true;
		this.userMoved = true;
		this.host.classList.add('dragging');
		try {
			this.host.setPointerCapture(event.pointerId);
		} catch {
			// pointer already gone
		}
		this.panBy(dx, dy);
		this.drag = { x: event.clientX, y: event.clientY };
	}

	private onPointerUp(event: PointerEvent): void {
		this.pointers.delete(event.pointerId);
		if (this.pointers.size < 2) this.pinch = null;
		this.drag = null;
		this.host.classList.remove('dragging');
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === '+' || event.key === '=') this.stepZoom(ZOOM_STEP);
		else if (event.key === '-' || event.key === '_') this.stepZoom(1 / ZOOM_STEP);
		else if (event.key === '0' || event.key === 'Home') this.fit(true);
		else if (event.key === 'ArrowLeft') { this.cancelAnimation(); this.panBy(ARROW_PAN, 0); }
		else if (event.key === 'ArrowRight') { this.cancelAnimation(); this.panBy(-ARROW_PAN, 0); }
		else if (event.key === 'ArrowUp') { this.cancelAnimation(); this.panBy(0, ARROW_PAN); }
		else if (event.key === 'ArrowDown') { this.cancelAnimation(); this.panBy(0, -ARROW_PAN); }
		else return;
		event.preventDefault();
	}
}
