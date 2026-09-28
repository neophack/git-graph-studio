// The Module Analysis drawing's viewport (module 17): everything the page does with
// the laid-out diagram the backend's `analysis_module_diagram` hands it — the SVG
// (module group boxes, call-count-labelled arrows, file blocks) rendered from the
// shipped geometry. The viewport is a port of gitdiagram's own viewer (its
// use-mermaid-viewport / use-diagram-wheel-gestures source): the view state carries
// the fit scale and the zoom bounds and the percentage are relative to it (100% =
// the fit level, 0.6×–12× the range); a mouse wheel zooms at the cursor while a
// trackpad's two-finger scroll pans (the gesture latches per 180 ms burst, ctrl/cmd
// wheel is always pinch-zoom, WKWebView gesture events too); panning clamps to the
// 32–160 px gutter band; toolbar zoom and fit animate over 160 ms (skipped under
// prefers-reduced-motion); the keyboard pans by arrow and fits on 0/Home. No layout
// math and no canvas engine live here — the geometry is the backend's, the drawing
// is DOM and CSS variables, so the theme follows for free.

import { t, tf } from './i18n';
import { actionButton, el } from './ui';

/* ---------- The backend shapes (`analysis_module_diagram`) ---------- */

export interface DiagramNode {
	path: string;
	label: string;
	/** The area whose group box holds the block; "" is the root, null the unboxed
	 *  overflow of a workspace with more areas than gitdiagram's group cap. */
	module: string | null;
	callsIn: number;
	callsOut: number;
	/** The area's pastel tone slot (gitdiagram's toneBlue &c.); 6 is the neutral. */
	tone: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface DiagramEdge {
	id: string;
	from: string;
	to: string;
	calls: number;
	width: number;
	/** A cycle's back edge — dashed around the side (gitdiagram's `-.->`). */
	dashed: boolean;
	/** The ready-to-set SVG geometry the backend computed. */
	path: string;
	head: string;
	labelX: number;
	labelY: number;
}

export interface DiagramGroup {
	name: string;
	tone: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ModuleDiagram {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	groups: DiagramGroup[];
	width: number;
	height: number;
	droppedFiles: number;
	droppedEdges: number;
	/** The diagram as mermaid `flowchart LR` source — the copy-the-source export. */
	mermaid: string;
}

/** A file's module: its directory; "" is the workspace root. */
export function moduleOf(path: string): string {
	const at = path.lastIndexOf('/');
	return at === -1 ? '' : path.slice(0, at);
}

/** How a module names itself on the page — the workspace root gets a label. */
export function moduleLabel(name: string): string {
	return name || t('analysis.modules.root');
}

/* ---------- The SVG kit ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG_NS, tag);
	if (className) element.setAttribute('class', className);
	return element;
}

/** The zoom step the toolbar and the keyboard move by (gitdiagram's 1.18). */
const ZOOM_STEP = 1.18;
/** The whitespace `fit` leaves around the diagram, in viewport pixels. */
const FIT_PADDING = 24;
/** The zoom range relative to the fit scale (gitdiagram's 0.6×–12×). */
const ZOOM_MIN_RELATIVE = 0.6;
const ZOOM_MAX_RELATIVE = 12;
/** Arrow-key pan distance, and the animated transition's length and ease. */
const ARROW_PAN = 40;
const ANIMATE_MS = 160;
/** The pan/zoom gutter: how much of the diagram may leave the viewport (clamped to
 *  gitdiagram's 32–160 px band, 12 % of the axis). */
function gutter(container: number): number {
	return Math.max(32, Math.min(160, container * 0.12));
}
/** Pointer travel (px) after which a press stops being a click and becomes a pan. */
const DRAG_THRESHOLD = 4;
/** A wheel burst's gesture latch: acceleration/momentum must not split one scroll
 *  into a pan and a zoom (gitdiagram's 180 ms). */
const WHEEL_LATCH_MS = 180;

export interface DiagramViewCallbacks {
	/** A block was double-clicked — the file opens. */
	onOpenNode: (path: string) => void;
	/** A block or arrow was clicked (null: the background) — the page highlights. */
	onSelect: (id: string | null) => void;
	onNodeContext: (x: number, y: number, id: string) => void;
	onEdgeContext: (x: number, y: number, id: string) => void;
}

/** The diagram viewport: one host element the page places, one SVG it owns. The
 *  pan/zoom state is a translate+scale on the viewport group — CSS variables colour
 *  everything, so a theme switch is instant and nothing here re-renders. */
export class DiagramView {
	readonly host: HTMLElement;
	private readonly svg: SVGSVGElement;
	private readonly viewport: SVGGElement;
	private readonly zoomLevel: HTMLElement;
	private readonly nodeElements = new Map<string, SVGGElement>();
	private readonly edgeElements = new Map<string, SVGGElement>();
	private resizeObserver: ResizeObserver | null = null;
	private diagram: ModuleDiagram | null = null;
	/** The view state, gitdiagram's shape: the fit scale the zoom reads against, the
	 *  content extent, and the translate+scale currently applied. */
	private view: { fitScale: number; width: number; height: number; scale: number; x: number; y: number } | null = null;
	/** The user has zoomed or panned by hand — the auto refit stands aside. */
	private userMoved = false;
	/** The last pan moved far enough that the click after it must not land. */
	private dragMoved = false;
	private drag: { x: number; y: number } | null = null;
	/** The pinch pair: the two pointers a two-finger gesture tracks. */
	private pinch: { startDistance: number; startView: { x: number; y: number; scale: number }; start: { x: number; y: number } } | null = null;
	private readonly pointers = new Map<number, { x: number; y: number }>();
	/** The wheel burst's latched mode, its last event time, and WKWebView's pinch. */
	private wheelMode: 'pan' | 'zoom' | null = null;
	private lastWheelTime = -Infinity;
	private viewFrame: number | null = null;
	private animationFrame: number | null = null;

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
		this.svg = svgEl('svg', 'an-svg');
		this.viewport = svgEl('g', 'an-viewport');
		this.svg.append(this.viewport);
		this.host.append(this.svg);
		this.svg.addEventListener('click', () => this.callbacks.onSelect(null));
		this.host.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.host.addEventListener('gesturestart', (event) => this.onGestureStart(event), { passive: false } as AddEventListenerOptions);
		this.host.addEventListener('gesturechange', (event) => this.onGestureChange(event), { passive: false } as AddEventListenerOptions);
		this.host.addEventListener('gestureend', () => { this.wheelMode = null; });
		this.host.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		this.host.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.host.addEventListener('pointerup', (event) => this.onPointerUp(event));
		this.host.addEventListener('pointercancel', (event) => this.onPointerUp(event));
		this.host.addEventListener('keydown', (event) => this.onKeyDown(event));
		// The canvas's own menu is never what the user wants — the blocks' and arrows'
		// right-click menus replace it.
		this.host.addEventListener('contextmenu', (event) => event.preventDefault());
		// A pan that moved the diagram swallows the click that follows it.
		this.host.addEventListener('click', (event) => {
			if (!this.dragMoved) return;
			this.dragMoved = false;
			event.stopPropagation();
		}, true);
		// A container resize (a view switch back, a panel open) refits an untouched
		// viewport and re-clamps a hand-moved one around its centre — the source's
		// resize branch. jsdom has no ResizeObserver; the fit there is the identity.
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(() => this.onHostResized());
			this.resizeObserver.observe(this.host);
		}
	}

	/** Render a new diagram (null: nothing to draw). A fresh diagram resets the
	 *  viewport to the fit level — the source's prepareForRender + fitDiagram; the
	 *  zoom percentage reads against the new fit afterwards. */
	setDiagram(diagram: ModuleDiagram | null): void {
		this.diagram = diagram;
		this.nodeElements.clear();
		this.edgeElements.clear();
		this.viewport.textContent = '';
		this.host.classList.toggle('empty', !diagram || diagram.nodes.length === 0);
		this.cancelAnimation();
		if (!diagram || diagram.nodes.length === 0) {
			this.view = null;
			return;
		}
		for (const group of diagram.groups) this.viewport.append(this.renderGroup(group));
		for (const edge of diagram.edges) this.viewport.append(this.renderEdge(edge));
		for (const node of diagram.nodes) this.viewport.append(this.renderNode(node));
		this.userMoved = false;
		this.fit();
	}

	/** One batched state pass: the classes the page's selection computed (`selected`,
	 *  `related`, `dim`) over the blocks and arrows of the current diagram. */
	setStates(states: Record<string, string[]>): void {
		for (const [id, element] of this.nodeElements) this.applyState(element, states[id]);
		for (const [id, element] of this.edgeElements) this.applyState(element, states[id]);
	}

	/** Bring one block to the viewport's centre without changing the zoom — the menu
	 *  jumps land where the eye already is. */
	focusElement(id: string): void {
		const node = this.diagram?.nodes.find((candidate) => candidate.path === id);
		const view = this.view;
		if (!node || !view) return;
		this.userMoved = true;
		this.commitView({ ...view, ...this.clamp({ ...view,
			x: this.host.clientWidth / 2 - (node.x + node.w / 2) * view.scale,
			y: this.host.clientHeight / 2 - (node.y + node.h / 2) * view.scale
		})});
	}

	/** Fit the whole diagram into the host (also `0`/Home and the toolbar's fit);
	 *  a host that cannot be measured yet (jsdom, a hidden view) keeps the identity
	 *  view so the toolbar still answers. */
	fit(animate = false): void {
		const diagram = this.diagram;
		const cw = this.host.clientWidth;
		const ch = this.host.clientHeight;
		this.userMoved = false;
		if (!diagram || diagram.width <= 0 || diagram.height <= 0 || cw <= 0 || ch <= 0) {
			this.commitView({ fitScale: 1, width: diagram?.width ?? 0, height: diagram?.height ?? 0, scale: 1, x: 0, y: 0 });
			return;
		}
		const fitScale = Math.min((cw - FIT_PADDING * 2) / diagram.width, (ch - FIT_PADDING * 2) / diagram.height);
		const scale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
		this.animateOrCommit({
			fitScale,
			width: diagram.width,
			height: diagram.height,
			scale,
			x: (cw - diagram.width * scale) / 2,
			y: (ch - diagram.height * scale) / 2
		}, animate);
	}

	/** The page switched back to the diagram view — the host was display:none and its
	 *  measurements are fresh again. */
	onShown(): void {
		if (!this.userMoved) this.fit();
	}

	destroy(): void {
		this.cancelAnimation();
		if (this.viewFrame !== null) cancelAnimationFrame(this.viewFrame);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	/* ---------- the view state (the ported viewer core) ---------- */

	/** Clamp a panned/zoomed view: content smaller than the viewport centres; larger
	 *  content keeps the gutter band on screen (gitdiagram's clampViewState). */
	private clamp(view: { fitScale: number; width: number; height: number; scale: number; x: number; y: number }): { x: number; y: number } {
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

	private commitView(view: NonNullable<typeof this.view>): void {
		this.cancelAnimation();
		this.view = view;
		this.applyTransform();
	}

	/** Batch transform writes per frame; the zoom label rides along (gitdiagram's
	 *  scheduleViewState). */
	private scheduleView(view: NonNullable<typeof this.view>): void {
		this.view = view;
		if (this.viewFrame !== null) return;
		this.viewFrame = requestAnimationFrame(() => {
			this.viewFrame = null;
			this.applyTransform();
		});
	}

	/** The 160 ms eased glide the toolbar zoom and the fit move with (gitdiagram's
	 *  animateViewState; prefers-reduced-motion, or an unmeasurable host, jumps). */
	private animateOrCommit(target: NonNullable<typeof this.view>, animate: boolean): void {
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
			return true; // no matchMedia (jsdom): skip the glide rather than stall the tests
		}
	}

	private applyTransform(): void {
		const view = this.view;
		if (!view) return;
		this.viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
		// The percentage reads against the fit level — 100 % is the fit, always.
		this.zoomLevel.textContent = `${Math.round((view.scale / view.fitScale) * 100)}%`;
		// The call-count labels are noise below readable size — a map's label LOD.
		this.svg.classList.toggle('labels-off', view.scale < Math.max(0.85, view.fitScale));
	}

	/** Zoom by `factor` around a viewport point (the cursor, or the centre), clamped
	 *  to the fit-relative range and the gutter band (gitdiagram's zoomAroundPoint). */
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
		const next = { ...current, scale: nextScale, x: localX - contentX * nextScale, y: localY - contentY * nextScale };
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

	/** The wheel, gitdiagram's split: ctrl/cmd is pinch-zoom; otherwise the burst's
	 *  first event latches the mode — a trackpad's two-finger scroll (pixel deltas,
	 *  any horizontal component, fractional Y) pans, a mouse wheel's notched line
	 *  zooms. */
	private onWheel(event: WheelEvent): void {
		if (event.deltaX === 0 && event.deltaY === 0) return;
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			this.wheelMode = null;
			this.zoomAt(Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * (0.01)), event.clientX, event.clientY);
			return;
		}
		if (!this.wheelMode || event.timeStamp - this.lastWheelTime > WHEEL_LATCH_MS) {
			this.wheelMode = DiagramView.isTrackpadScroll(event) ? 'pan' : 'zoom';
		}
		this.lastWheelTime = event.timeStamp;
		if (this.wheelMode === 'pan') this.panBy(-event.deltaX, -event.deltaY);
		else this.zoomAt(Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * 0.0015), event.clientX, event.clientY);
	}

	/** gitdiagram's isLikelyTrackpadGesture: pixel-mode deltas with horizontal drift
	 *  or fractional Y are a trackpad; whole-line notches are a mouse wheel. */
	private static isTrackpadScroll(event: WheelEvent): boolean {
		if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
		return Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 40 || !Number.isInteger(event.deltaY);
	}

	/* WKWebView's Safari-style pinch (macOS trackpads reach the app through it). */
	private gestureScale: number | null = null;

	private onGestureStart(event: Event): void {
		event.preventDefault();
		this.gestureScale = 1;
	}

	private onGestureChange(event: Event): void {
		if (this.gestureScale === null) return;
		event.preventDefault();
		const scale = (event as unknown as { scale?: number }).scale;
		if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return;
		const rect = this.host.getBoundingClientRect();
		this.zoomAt(
			scale / this.gestureScale,
			(event as unknown as { clientX?: number }).clientX ?? rect.left + this.host.clientWidth / 2,
			(event as unknown as { clientY?: number }).clientY ?? rect.top + this.host.clientHeight / 2
		);
		this.gestureScale = scale;
	}

	/* ---------- pan by pointer ---------- */

	private onHostResized(): void {
		const view = this.view;
		if (!view || this.host.clientWidth <= 0) return;
		if (this.userMoved) {
			// Keep the zoom, keep the centre, re-clamp to the new bounds.
			const centreX = (this.host.clientWidth / 2 - view.x) / view.scale;
			const centreY = (this.host.clientHeight / 2 - view.y) / view.scale;
			const fitScale = Math.min(
				Math.max(this.host.clientWidth - FIT_PADDING * 2, 1) / (view.width || 1),
				Math.max(this.host.clientHeight - FIT_PADDING * 2, 1) / (view.height || 1)
			);
			const next = { ...view, fitScale, scale: Math.min(fitScale * ZOOM_MAX_RELATIVE, Math.max(fitScale * ZOOM_MIN_RELATIVE, view.scale)) };
			const recentered = { ...next, x: this.host.clientWidth / 2 - centreX * next.scale, y: this.host.clientHeight / 2 - centreY * next.scale };
			this.commitView({ ...recentered, ...this.clamp(recentered) });
			return;
		}
		this.fit();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (this.pointers.size === 2) {
			// A second pointer turns the pan into a pinch (gitdiagram's pinchTo base).
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
			// The gesture's starting content point rides the moving midpoint.
			const rect = this.host.getBoundingClientRect();
			const startLocalX = base.start.x - rect.left;
			const startLocalY = base.start.y - rect.top;
			const contentX = (startLocalX - base.startView.x) / base.startView.scale;
			const contentY = (startLocalY - base.startView.y) / base.startView.scale;
			this.userMoved = true;
			this.scheduleView(this.clampInto({ ...view, scale: nextScale, x: midpoint.x - rect.left - contentX * nextScale, y: midpoint.y - rect.top - contentY * nextScale }));
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
			// the pointer is already gone — the pan simply ends with it
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

	/** Clamp with the viewport rect already subtracted (the pinch path works in
	 *  local coordinates; `clamp` reads fresh bounds for the pan path). */
	private clampInto(view: NonNullable<typeof this.view>): NonNullable<typeof this.view> {
		const cw = this.host.clientWidth;
		const ch = this.host.clientHeight;
		const scaledWidth = view.width * view.scale;
		const scaledHeight = view.height * view.scale;
		const gx = gutter(cw);
		const gy = gutter(ch);
		return {
			...view,
			x: scaledWidth <= cw ? (cw - scaledWidth) / 2 : Math.max(cw - scaledWidth - gx, Math.min(gx, view.x)),
			y: scaledHeight <= ch ? (ch - scaledHeight) / 2 : Math.max(ch - scaledHeight - gy, Math.min(gy, view.y))
		};
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

	/* ---------- the pieces ---------- */

	private renderGroup(group: DiagramGroup): SVGGElement {
		const element = svgEl('g', `an-group t${group.tone % 6}`);
		const rect = svgEl('rect');
		rect.setAttribute('x', String(group.x));
		rect.setAttribute('y', String(group.y));
		rect.setAttribute('width', String(group.w));
		rect.setAttribute('height', String(group.h));
		rect.setAttribute('rx', '10');
		const label = svgEl('text', 'an-group-label');
		label.setAttribute('x', String(group.x + group.w / 2));
		label.setAttribute('y', String(group.y + 19));
		label.setAttribute('text-anchor', 'middle');
		// A narrow run's title truncates to the box width — a long directory name must
		// not spill into the neighbouring box; the full name rides the hover tooltip.
		const full = moduleLabel(group.name);
		const maxChars = Math.max(4, Math.floor((group.w - 16) / 6.6));
		label.textContent = full.length > maxChars ? `${full.slice(0, Math.max(1, maxChars - 1))}…` : full;
		const title = svgEl('title');
		title.textContent = full;
		element.append(rect, label, title);
		return element;
	}

	private renderNode(node: DiagramNode): SVGGElement {
		const element = svgEl('g', `an-node t${node.tone % 7}`);
		element.dataset.path = node.path;
		element.setAttribute('transform', `translate(${node.x} ${node.y})`);
		const rect = svgEl('rect');
		rect.setAttribute('width', String(node.w));
		rect.setAttribute('height', String(node.h));
		rect.setAttribute('rx', '8');
		// gitdiagram's two-line card: the name over the bracketed directory.
		const text = svgEl('text');
		text.setAttribute('text-anchor', 'middle');
		const name = svgEl('tspan');
		name.setAttribute('x', String(node.w / 2));
		name.setAttribute('y', String(18));
		name.textContent = node.label;
		text.append(name);
		const dir = moduleOf(node.path);
		if (dir) {
			const shown = dir.length > 24 ? `${dir.slice(0, 23)}…` : dir;
			const sub = svgEl('tspan', 'sub');
			sub.setAttribute('x', String(node.w / 2));
			sub.setAttribute('y', String(33));
			sub.textContent = `[${shown}]`;
			text.append(sub);
		}
		const title = svgEl('title');
		title.textContent = node.path;
		element.append(rect, text, title);
		element.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onSelect(node.path);
		});
		element.addEventListener('dblclick', (event) => {
			event.stopPropagation();
			this.callbacks.onOpenNode(node.path);
		});
		element.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.callbacks.onNodeContext(event.clientX, event.clientY, node.path);
		});
		this.nodeElements.set(node.path, element);
		return element;
	}

	private renderEdge(edge: DiagramEdge): SVGGElement {
		const element = svgEl('g', edge.dashed ? 'an-edge dashed' : 'an-edge');
		element.dataset.id = edge.id;
		const hit = svgEl('path', 'hit');
		hit.setAttribute('d', edge.path);
		const line = svgEl('path', 'line');
		line.setAttribute('d', edge.path);
		line.style.strokeWidth = String(edge.width);
		const head = svgEl('polygon', 'head');
		head.setAttribute('points', edge.head);
		const label = svgEl('text');
		label.setAttribute('x', String(edge.labelX));
		label.setAttribute('y', String(edge.labelY + 4));
		label.textContent = tf('analysis.modules.calls', edge.calls);
		element.append(hit, line, head, label);
		element.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onSelect(edge.id);
		});
		element.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.callbacks.onEdgeContext(event.clientX, event.clientY, edge.id);
		});
		this.edgeElements.set(edge.id, element);
		return element;
	}

	private applyState(element: Element, states: string[] | undefined): void {
		for (const state of ['selected', 'related', 'dim']) {
			element.classList.toggle(state, states?.includes(state) ?? false);
		}
	}

}
