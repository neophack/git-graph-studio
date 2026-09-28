// The Module Analysis drawing (module 17): the diagram the backend's
// `analysis_module_diagram` hands over as mermaid `flowchart TD` source, rendered by
// mermaid itself — the same renderer, the same ELK layered layout, spacing and
// classic look gitdiagram initializes (its mermaid-diagram.tsx), so the blocks can
// never overlap and the look is gitdiagram's by construction. The viewer around the
// SVG is a port of gitdiagram's own viewport (its use-mermaid-viewport /
// use-diagram-wheel-gestures): the zoom bounds and the percentage read against the
// fit level (100 % = fitted, 0.6×–12×), a mouse wheel zooms at the cursor while a
// trackpad's two-finger scroll pans (per-burst gesture latch, ctrl/cmd always
// pinch-zoom, WKWebView gesture events too), panning clamps to the 32–160 px gutter
// band, the toolbar's zoom and fit glide over 160 ms (skipped under
// prefers-reduced-motion), the keyboard pans by arrow and fits on 0/Home. The
// interactions the page owns — click highlight, double-click open, the right-click
// menus — are delegated onto mermaid's own node and edge elements and resolved
// live, so a rebuilt SVG never orphans them. mermaid loads lazily on the first
// drawing (a chunk the reports never pay for).

import { t } from './i18n';
import { actionButton, el } from './ui';

/* ---------- The backend shapes (`analysis_module_diagram`) ---------- */

export interface DiagramNode {
	path: string;
	label: string;
	/** The area whose subgraph holds the block; "" is the root, null the unboxed
	 *  overflow of a workspace with more areas than gitdiagram's group cap. */
	module: string | null;
	/** The area's pastel tone slot — the `t<n>` class in the mermaid source. */
	tone: number;
	callsIn: number;
	callsOut: number;
}

export interface DiagramEdge {
	id: string;
	from: string;
	to: string;
	calls: number;
	/** A cycle's back edge — mermaid's dashed `-.->`. */
	dashed: boolean;
}

export interface ModuleDiagram {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	droppedFiles: number;
	droppedEdges: number;
	/** The diagram as mermaid source — what this view renders and what the page's
	 *  copy action exports. */
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

/* ---------- the viewer constants (gitdiagram's own) ---------- */

/** The zoom step the toolbar and the keyboard move by (gitdiagram's 1.18). */
const ZOOM_STEP = 1.18;
/** The whitespace `fit` leaves around the diagram, in viewport pixels. */
const FIT_PADDING = 24;
/** The zoom range relative to the fit scale (gitdiagram's 0.6×–12×). */
const ZOOM_MIN_RELATIVE = 0.6;
const ZOOM_MAX_RELATIVE = 12;
/** Arrow-key pan distance, and the animated transition's length. */
const ARROW_PAN = 40;
const ANIMATE_MS = 160;
/** Pointer travel (px) after which a press stops being a click and becomes a pan. */
const DRAG_THRESHOLD = 4;
/** A wheel burst's gesture latch (gitdiagram's 180 ms). */
const WHEEL_LATCH_MS = 180;

/** The pan/zoom gutter: how much of the diagram may leave the viewport (clamped to
 *  gitdiagram's 32–160 px band, 12 % of the axis). */
function gutter(container: number): number {
	return Math.max(32, Math.min(160, container * 0.12));
}

/* ---------- mermaid, loaded once with gitdiagram's config ---------- */

type MermaidRenderer = {
	registerLayoutLoaders: (...loaders: unknown[]) => Promise<void> | void;
	initialize: (config: Record<string, unknown>) => void;
	render: (id: string, text: string, container?: HTMLElement) => Promise<{ svg: string }>;
};

let mermaidReady: Promise<MermaidRenderer> | null = null;

/** mermaid + its ELK layout, initialized once with gitdiagram's own configuration
 *  (its mermaid-diagram.tsx baseConfig): ELK layered layout, classic look, linear
 *  curves, htmlLabels off with the 200 px wrap, its spacing, and its light theme
 *  variables over our fixed light canvas. */
function ensureMermaid(): Promise<MermaidRenderer> {
	return (mermaidReady ??= (async () => {
		const [{ default: mermaid }, layout] = await Promise.all([
			import('mermaid'),
			import('@mermaid-js/layout-elk')
		]);
		await mermaid.registerLayoutLoaders(layout.default);
		mermaid.initialize({
			startOnLoad: false,
			suppressErrorRendering: true,
			securityLevel: 'strict',
			theme: 'base',
			htmlLabels: false,
			layout: 'elk',
			// gitdiagram's comment holds here too: mermaid 12 defaults to the neo look
			// and a 120 px wrap, which splits file paths mid-name — keep the classic
			// look and the old 200 px wrap.
			look: 'classic',
			flowchart: {
				wrappingWidth: 200,
				curve: 'linear',
				nodeSpacing: 50,
				rankSpacing: 50,
				padding: 15
			},
			themeVariables: {
				background: 'transparent',
				primaryColor: '#f7f7f7',
				primaryBorderColor: '#334155',
				primaryTextColor: '#171717',
				lineColor: '#334155',
				secondaryColor: '#f0f0f0',
				tertiaryColor: '#f7f7f7'
			}
		});
		return mermaid as MermaidRenderer;
	})());
}

export interface DiagramViewCallbacks {
	/** A block was double-clicked — the file opens. */
	onOpenNode: (path: string) => void;
	/** A block or arrow was clicked (null: the background) — the page highlights. */
	onSelect: (id: string | null) => void;
	onNodeContext: (x: number, y: number, id: string) => void;
	onEdgeContext: (x: number, y: number, id: string) => void;
}

interface ViewState {
	fitScale: number;
	width: number;
	height: number;
	scale: number;
	x: number;
	y: number;
}

/** The diagram viewport: one host element the page places, mermaid's SVG inside a
 *  content div the pan/zoom transform drives (gitdiagram's diagramRef), and the
 *  delegated interactions over mermaid's own node and edge elements. */
export class DiagramView {
	readonly host: HTMLElement;
	private readonly content: HTMLElement;
	private readonly zoomLevel: HTMLElement;
	private resizeObserver: ResizeObserver | null = null;
	/** Relabels whenever mermaid's tree grows — the markers always match the SVG
	 *  that is on screen. */
	private labelObserver: MutationObserver | null = null;
	private view: ViewState | null = null;
	/** Bumps on every render; an in-flight mermaid render whose token went stale
	 *  discards itself before touching the DOM. */
	private renderToken = 0;
	/** The user has zoomed or panned by hand — the auto refit stands aside. */
	private userMoved = false;
	/** The last pan moved far enough that the click after it must not land. */
	private dragMoved = false;
	private drag: { x: number; y: number } | null = null;
	private readonly pointers = new Map<number, { x: number; y: number }>();
	private pinch: { startDistance: number; startView: { x: number; y: number; scale: number }; start: { x: number; y: number } } | null = null;
	private wheelMode: 'pan' | 'zoom' | null = null;
	private lastWheelTime = -Infinity;
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
		this.content = el('div', 'an-mermaid');
		this.host.append(this.content);
		// The delegated interactions: one set of listeners on the content survives
		// mermaid rebuilding the SVG under us; the payload markers they resolve are
		// stamped onto whatever tree is on screen.
		this.content.addEventListener('click', (event) => {
			const hit = DiagramView.hitOf(event);
			if (!hit) return; // empty canvas — the svg-root listener clears
			event.stopPropagation();
			this.callbacks.onSelect(hit.id);
		});
		this.content.addEventListener('dblclick', (event) => {
			const hit = DiagramView.hitOf(event);
			if (!hit || hit.kind !== 'node') return;
			event.stopPropagation();
			this.callbacks.onOpenNode(hit.id);
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
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(() => this.onHostResized());
			this.resizeObserver.observe(this.host);
		}
	}

	/** The element a pointer event landed on, as the page knows it: a block (its
	 *  `data-path`) or an arrow (its `data-id`) — whichever marked ancestor the
	 *  event resolves to. */
	private static hitOf(event: Event): { kind: 'node' | 'edge'; id: string } | null {
		const target = event.target;
		if (!(target instanceof Element)) return null;
		const marked = target.closest('[data-path], [data-id]');
		if (!marked) return null;
		const path = marked.getAttribute('data-path');
		if (path) return { kind: 'node', id: path };
		const id = marked.getAttribute('data-id');
		return id ? { kind: 'edge', id } : null;
	}

	/** Render a new diagram (null: nothing to draw). mermaid loads and lays the
	 *  source out (ELK), the markers land on its elements, and the viewport resets
	 *  to the fit level — gitdiagram's render → fitDiagram sequence. */
	setDiagram(diagram: ModuleDiagram | null): void {
		const token = ++this.renderToken;
		this.labelObserver?.disconnect();
		this.labelObserver = null;
		this.content.textContent = '';
		this.userMoved = false;
		this.host.classList.toggle('empty', !diagram || diagram.nodes.length === 0);
		if (!diagram || diagram.nodes.length === 0) return;
		void this.render(diagram, token);
	}

	private async render(diagram: ModuleDiagram, token: number): Promise<void> {
		let svg: string;
		try {
			const mermaid = await ensureMermaid();
			// A hidden render target the width of the viewport — the wrap width the
			// labels measure against (gitdiagram's createHiddenRenderTarget).
			const target = el('div');
			target.style.position = 'absolute';
			target.style.visibility = 'hidden';
			target.style.pointerEvents = 'none';
			target.style.left = '0';
			target.style.top = '0';
			target.style.zIndex = '-1';
			target.style.width = `${Math.max(this.host.clientWidth || 800, 1)}px`;
			document.body.append(target);
			try {
				({ svg } = await mermaid.render(`ggs-diagram-${token}`, diagram.mermaid, target));
			} finally {
				target.remove();
			}
		} catch {
			// A newer render took over, or mermaid refused the source — the page's
			// empty/error state already stands.
			return;
		}
		if (token !== this.renderToken) return;
		// Parse as XML and import the whole tree: the HTML parser can truncate an
		// SVG document mid-stream (a jsdom quirk we hit head-on), DOMParser cannot.
		try {
			const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
			if (parsed.getElementsByTagName('parsererror').length > 0) throw new Error('parse error');
			const tree = document.importNode(parsed.documentElement, true);
			this.content.textContent = '';
			this.content.append(tree);
		} catch {
			this.content.innerHTML = svg; // a browser parses innerHTML fine — the quirk is jsdom's
		}
		this.labelElements(diagram);
		this.labelObserver?.disconnect();
		if (typeof MutationObserver !== 'undefined') {
			this.labelObserver = new MutationObserver(() => {
				if (token === this.renderToken) this.labelElements(diagram);
			});
			this.labelObserver.observe(this.content, { childList: true, subtree: true });
		}
		this.measureAndFit();
		// A click on empty canvas (the root or a cluster's blank area) clears.
		this.content.querySelector('svg')?.addEventListener('click', () => {
			if (token === this.renderToken) this.callbacks.onSelect(null);
		});
	}

	/** Every element under `root`, DOM-core (getElementsByTagName) — jsdom's
	 *  selector engine can lag on a freshly parsed SVG subtree, and the marker
	 *  passes must see the tree as it serializes. */
	private static walk(root: Element): Element[] {
		return [...root.getElementsByTagName('*')] as Element[];
	}

	/** Stamp mermaid's elements with the payload's markers: nodes carry
	 *  `flowchart-N<index>-<n>` ids and edges `L_N<from>_N<to>_<n>`, parsed back onto
	 *  the payload's paths (the ids are ours — the backend writes them). Idempotent,
	 *  so the late pass only fills what is missing. */
	private labelElements(diagram: ModuleDiagram): void {
		const svg = this.content.querySelector('svg');
		if (!svg) return;
		const paths = new Map(diagram.nodes.map((node, index) => [`N${index}`, node.path]));
		const edges = new Map<string, string>();
		for (const edge of diagram.edges) {
			const from = diagram.nodes.findIndex((node) => node.path === edge.from);
			const to = diagram.nodes.findIndex((node) => node.path === edge.to);
			if (from !== -1 && to !== -1) edges.set(`N${from}_N${to}`, edge.id);
		}
		for (const element of DiagramView.walk(svg)) {
			const id = element.getAttribute('id') ?? '';
			if (element.getAttribute('data-path') || element.getAttribute('data-id')) continue;
			const node = /flowchart-(N\d+)-\d+$/.exec(id);
			if (node) {
				const path = paths.get(node[1]);
				if (path) element.setAttribute('data-path', path);
				continue;
			}
			const edge = /^L_(N\d+_N\d+)_?\d*$/.exec(id);
			if (edge) {
				const edgeId = edges.get(edge[1]);
				if (edgeId) element.setAttribute('data-id', edgeId);
			}
		}
	}

	/** The SVG's viewBox is the content extent; the element itself is sized to it
	 *  (gitdiagram's render effect) and the viewport fits to that. */
	private measureAndFit(): void {
		const svg = this.content.querySelector('svg');
		if (!svg) return;
		svg.style.maxWidth = 'none';
		const box = svg.viewBox?.baseVal;
		const width = box && box.width > 0 ? box.width : 600;
		const height = box && box.height > 0 ? box.height : 400;
		svg.style.width = `${width}px`;
		svg.style.height = `${height}px`;
		this.fit();
	}

	/** One batched state pass: the classes the page's selection computed (`selected`,
	 *  `related`, `dim`) over the marked elements on screen. */
	setStates(states: Record<string, string[]>): void {
		const svg = this.content.querySelector('svg');
		if (!svg) return;
		for (const element of DiagramView.walk(svg)) {
			const id = element.getAttribute('data-path') ?? element.getAttribute('data-id');
			if (!id) continue;
			for (const state of ['selected', 'related', 'dim']) {
				element.classList.toggle(state, states[id]?.includes(state) ?? false);
			}
		}
	}

	/** Bring one block to the viewport's centre without changing the zoom — the menu
	 *  jumps land where the eye already is. */
	focusElement(id: string): void {
		const view = this.view;
		if (!view) return;
		const svg = this.content.querySelector('svg');
		for (const element of svg ? DiagramView.walk(svg) : []) {
			if (element.getAttribute('data-path') !== id) continue;
			if (!(element instanceof SVGGraphicsElement)) continue;
			try {
				// The node's own transform places it in the untransformed content box.
				const matrix = element.transform?.baseVal.consolidate()?.matrix;
				if (!matrix) continue;
				this.userMoved = true;
				const next = { ...view,
					x: this.host.clientWidth / 2 - matrix.e * view.scale,
					y: this.host.clientHeight / 2 - matrix.f * view.scale };
				this.commitView({ ...next, ...this.clamp(next) });
				return;
			} catch {
				// no transform support — the selection still lands
			}
		}
	}

	/** Fit the whole diagram into the host (also `0`/Home and the toolbar's fit);
	 *  a host that cannot be measured yet keeps a plain identity view. */
	fit(animate = false): void {
		const svg = this.content.querySelector('svg');
		const box = svg?.viewBox?.baseVal;
		const width = box && box.width > 0 ? box.width : 600;
		const height = box && box.height > 0 ? box.height : 400;
		const cw = this.host.clientWidth;
		const ch = this.host.clientHeight;
		this.userMoved = false;
		if (cw <= 0 || ch <= 0) {
			this.commitView({ fitScale: 1, width, height, scale: 1, x: 0, y: 0 });
			return;
		}
		const fitScale = Math.min((cw - FIT_PADDING * 2) / width, (ch - FIT_PADDING * 2) / height);
		const scale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
		this.animateOrCommit({
			fitScale,
			width,
			height,
			scale,
			x: (cw - width * scale) / 2,
			y: (ch - height * scale) / 2
		}, animate);
	}

	/** The page switched back to the diagram view — the host was display:none and its
	 *  measurements are fresh again. */
	onShown(): void {
		if (!this.userMoved) this.fit();
	}

	destroy(): void {
		this.renderToken++;
		this.labelObserver?.disconnect();
		this.labelObserver = null;
		this.cancelAnimation();
		if (this.viewFrame !== null) cancelAnimationFrame(this.viewFrame);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	/* ---------- the view state (the ported viewer core) ---------- */

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

	/** Batch transform writes per frame (gitdiagram's scheduleViewState). */
	private scheduleView(view: ViewState): void {
		this.view = view;
		if (this.viewFrame !== null) return;
		this.viewFrame = requestAnimationFrame(() => {
			this.viewFrame = null;
			this.applyTransform();
		});
	}

	/** The 160 ms eased glide the toolbar zoom and the fit move with (gitdiagram's
	 *  animateViewState; prefers-reduced-motion, or an unmeasurable host, jumps). */
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
			return true; // no matchMedia (jsdom): skip the glide rather than stall the tests
		}
	}

	private applyTransform(): void {
		const view = this.view;
		if (!view) return;
		// gitdiagram's applyViewState: translate3d + scale on the content element.
		this.content.style.left = '0';
		this.content.style.top = '0';
		this.content.style.position = 'absolute';
		this.content.style.transformOrigin = '0 0';
		this.content.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
		this.zoomLevel.textContent = `${Math.round((view.scale / view.fitScale) * 100)}%`;
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
			this.zoomAt(Math.exp(-Math.max(-240, Math.min(240, event.deltaY)) * 0.01), event.clientX, event.clientY);
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
			const next = { ...view, scale: nextScale, x: midpoint.x - rect.left - contentX * nextScale, y: midpoint.y - rect.top - contentY * nextScale };
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
