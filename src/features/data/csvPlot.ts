// The Data Table's plot: every selected column as a line over one shared x axis, drawn
// straight into the DOM the way the CAN charts are (an SVG that scales through its
// viewBox; the theme's chart classes give the lines, grid, crosshair and tooltip their
// colours). Where the CAN charts stop at a hover readout, this one drives its own
// navigation: the wheel zooms the x range about the cursor, a drag pans it, double-click
// resets — each change asks the view to refetch the visible window at full resolution
// (the backend decimates per range, so a zoom-in redraws sharper, never blurrier), and
// the y axis rescales to whatever the window now shows.
//
// A finger reads it like a mouse: a press shows the readout under it, a drag pans, a
// double-tap resets, and the lift lets the readout linger a moment before it fades.

import type { CsvColumnStats, CsvSeriesPoint } from '../../platform/ipc/csv';
import { tf } from '../../platform/i18n';
import { el } from '../../platform/ui/index';

/** The margins a chart's axes and labels carve out of its plot box (CSS pixels). */
const PAD = { left: 64, right: 16, top: 14, bottom: 30 };

/** The default plot height (CSS pixels) when the container has no say. */
const DEFAULT_HEIGHT = 300;

/** The series palette, the CAN charts' classes — the theme's six chart colours, so both
 *  pages read as one application. */
const SERIES_CLASSES = ['can-series-0', 'can-series-1', 'can-series-2', 'can-series-3', 'can-series-4', 'can-series-5'] as const;

/** The palette class of the plot's `i`th selected series. */
export function plotSeriesCls(i: number): string {
	return SERIES_CLASSES[i % SERIES_CLASSES.length]!;
}

function svgNode(tag: string, attrs: Record<string, string | number>): SVGElement {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	return node;
}

function svgText(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end', cls = ''): SVGElement {
	const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	node.setAttribute('x', String(x));
	node.setAttribute('y', String(y));
	node.setAttribute('text-anchor', anchor);
	if (cls) node.setAttribute('class', cls);
	node.textContent = text;
	return node;
}

/** A number the way axes and tooltips print it: enough digits to be exact, never
 *  engineering noise — integers plain, magnitudes through fixed decimals, extremes in
 *  exponential form. */
export function fmtPlotNum(v: number): string {
	if (!Number.isFinite(v)) return String(v);
	const abs = Math.abs(v);
	if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) return v.toExponential(2);
	if (Number.isInteger(v)) return String(v);
	const digits = abs < 1 ? 4 : abs < 10 ? 3 : abs < 1000 ? 2 : 1;
	return String(parseFloat(v.toFixed(digits)));
}

/** "Nice" tick positions covering [min, max]: a round step whose count lands near
 *  `want`, from min (floored to the step) up through max. */
function niceTicks(min: number, max: number, want: number): { ticks: number[]; step: number } {
	if (!(max > min)) {
		const mid = Number.isFinite(min) ? min : 0;
		return { ticks: [mid], step: 1 };
	}
	const span = max - min;
	const rough = span / Math.max(1, want);
	const pow = 10 ** Math.floor(Math.log10(rough));
	let step = pow;
	for (const m of [1, 2, 2.5, 5, 10]) {
		if (rough <= m * pow) {
			step = m * pow;
			break;
		}
	}
	const first = Math.ceil(min / step) * step;
	const ticks: number[] = [];
	for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(parseFloat(v.toPrecision(12)));
	return { ticks, step };
}

/** The plot's model: which x window the lines draw. `full` is the data's own range. */
export interface PlotWindow {
	x0: number;
	x1: number;
}

export interface PlotSeries {
	column: number;
	name: string;
	cls: string;
	points: CsvSeriesPoint[];
	stats: CsvColumnStats;
}

export interface CsvPlotOptions {
	/** The x axis's unit/label (a column name, or the row label). */
	xLabel: string;
	/** The reset control calls this with the data's full range; the wheel and the drag
	 *  call it with every zoom and pan. The view owns the refetch. */
	onView?: (x0: number, x1: number) => void;
	height?: number;
}

/** One drawn plot with its navigation. `render` rebuilds the SVG; the wheel, the drag
 *  and the double-click re-render in place through the view window they maintain. */
export class CsvPlot {
	readonly root: HTMLElement;
	private readonly host: HTMLElement;
	private readonly tipHost: HTMLElement;
	private series: PlotSeries[] = [];
	private full: { min: number; max: number } = { min: 0, max: 1 };
	private view: PlotWindow = { x0: 0, x1: 1 };
	private opts: CsvPlotOptions;
	private sizer: ResizeObserver | null = null;
	private tip: HTMLElement | null = null;
	/** The readout's SVG marks — the crosshair, the dots, the axis label — lifted with
	 *  the tooltip; without the sweep every mousemove leaves its set behind. */
	private tipOverlay: SVGElement[] = [];
	/** The drag in flight: its pointer, its start x and the view it started from. A move
	 *  past the drag's slop turns into a pan; anything shorter stays a readout (tap). */
	private drag: { pointerId: number; startX: number; view: PlotWindow; panning: boolean } | null = null;
	private disposed = false;

	constructor(opts: CsvPlotOptions) {
		this.opts = opts;
		this.host = el('div', 'csv-plot-host');
		this.tipHost = el('div', 'csv-plot-tiphost');
		this.root = el('div', 'csv-plot', [this.host, this.tipHost]);
		this.host.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.host.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		this.host.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.host.addEventListener('pointerup', (event) => this.onPointerUp(event));
		this.host.addEventListener('pointercancel', () => (this.drag = null));
		this.host.addEventListener('dblclick', () => this.reset());
		this.host.addEventListener('mouseleave', () => this.hideTip());
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.render());
		this.sizer?.observe(this.host);
	}

	/** The data changed (a refetch, a selection): store it and draw. */
	setData(series: PlotSeries[], xMin: number, xMax: number, view: PlotWindow): void {
		this.series = series;
		this.full = { min: xMin, max: xMax };
		this.view = { ...view };
		this.render();
	}

	/** The view window moved (the caller's own navigation): draw at it. */
	setView(view: PlotWindow): void {
		this.view = { ...view };
		this.render();
	}

	/** Back to the whole file. */
	reset(): void {
		this.view = { x0: this.full.min, x1: this.full.max };
		this.opts.onView?.(this.view.x0, this.view.x1);
		this.render();
	}

	dispose(): void {
		this.disposed = true;
		this.sizer?.disconnect();
		this.root.remove();
	}

	/** The plot box in CSS pixels — the container's real width where layout runs, a
	 *  fixed stand-in where it does not (jsdom, a hidden pane). */
	private box(): { width: number; height: number } {
		const width = Math.max(240, Math.round(this.host.clientWidth) || 800);
		const height = Math.max(160, this.opts.height ?? DEFAULT_HEIGHT);
		return { width, height };
	}

	/** The data-x a pointer event sits at, or null outside the plot box. */
	private xAt(clientX: number): { dataX: number; frac: number } | null {
		const svg = this.host.querySelector('svg');
		if (!svg) return null;
		const rect = svg.getBoundingClientRect();
		if (rect.width <= 0) return null;
		const frac = (clientX - rect.left) / rect.width;
		return { dataX: this.view.x0 + frac * (this.view.x1 - this.view.x0), frac };
	}

	private onWheel(event: WheelEvent): void {
		event.preventDefault();
		const at = this.xAt(event.clientX);
		if (!at) return;
		const span = this.view.x1 - this.view.x0;
		const fullSpan = this.full.max - this.full.min || 1;
		const factor = event.deltaY < 0 ? 1 / 1.25 : 1.25;
		const next = Math.min(fullSpan, Math.max(fullSpan / 1e6, span * factor));
		const anchorShift = (at.dataX - this.view.x0) / span;
		let x0 = at.dataX - anchorShift * next;
		let x1 = x0 + next;
		if (x0 < this.full.min) {
			x1 += this.full.min - x0;
			x0 = this.full.min;
		}
		if (x1 > this.full.max) {
			x0 = Math.max(this.full.min, x0 - (x1 - this.full.max));
			x1 = this.full.max;
		}
		this.view = { x0, x1 };
		this.opts.onView?.(x0, x1);
		this.render();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		this.drag = { pointerId: event.pointerId, startX: event.clientX, view: { ...this.view }, panning: false };
	}

	private onPointerMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.pointerId) {
			if (event.pointerType === 'mouse') this.showTip(event.clientX, event.clientY);
			return;
		}
		const width = this.box().width;
		const span = drag.view.x1 - drag.view.x0;
		const dxPx = event.clientX - drag.startX;
		if (!drag.panning) {
			if (Math.abs(dxPx) < 4) return;
			drag.panning = true;
			this.host.setPointerCapture?.(event.pointerId);
			this.hideTip();
		}
		const dx = (dxPx / width) * span;
		let x0 = drag.view.x0 - dx;
		let x1 = drag.view.x1 - dx;
		if (x0 < this.full.min) {
			x1 += this.full.min - x0;
			x0 = this.full.min;
		}
		if (x1 > this.full.max) {
			x0 = Math.max(this.full.min, x0 - (x1 - this.full.max));
			x1 = this.full.max;
		}
		this.view = { x0, x1 };
		this.render();
	}

	private onPointerUp(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		this.drag = null;
		if (drag.panning) {
			this.opts.onView?.(this.view.x0, this.view.x1);
		} else if (event.pointerType !== 'mouse') {
			// A finger's tap is its hover: one readout, kept a moment, then gone.
			this.showTip(event.clientX, event.clientY);
			window.setTimeout(() => this.hideTip(), 1600);
		}
	}

	private hideTip(): void {
		for (const node of this.tipOverlay) node.remove();
		this.tipOverlay = [];
		this.tip?.remove();
		this.tip = null;
	}

	/** The readout: the crosshair snaps to the nearest sample across the visible series,
	 *  each series' dot and value float with it — the CAN charts' vocabulary. */
	private showTip(clientX: number, clientY: number): void {
		this.hideTip();
		const svg = this.host.querySelector('svg') as SVGElement | null;
		if (!svg || this.series.length === 0) return;
		const rect = svg.getBoundingClientRect();
		if (rect.width <= 0) return;
		const box = this.box();
		const frac = (clientX - rect.left) / rect.width;
		if (frac < 0 || frac > 1) return;
		const dataX = this.view.x0 + frac * (this.view.x1 - this.view.x0);
		const { x0px, y0px, x1px, y1px } = this.plotBox(box);
		const sx = (x: number) => x0px + ((x - this.view.x0) / (this.view.x1 - this.view.x0)) * (x1px - x0px);
		// The snap: the sample whose x sits nearest the cursor, across every series.
		let snapX = Number.NaN;
		let snapDist = Number.POSITIVE_INFINITY;
		for (const s of this.series) {
			for (const p of s.points) {
				const d = Math.abs(p.x - dataX);
				if (d < snapDist) {
					snapDist = d;
					snapX = p.x;
				}
			}
		}
		if (!Number.isFinite(snapX)) return;
		const yMax = this.yMax();
		const yMin = this.yMin();
		const sy = (y: number) => y1px - ((y - yMin) / (yMax - yMin || 1)) * (y1px - y0px);
		const overlay: SVGElement[] = [];
		const crossX = Math.min(Math.max(x0px, sx(snapX)), x1px);
		overlay.push(svgNode('line', { x1: crossX, y1: y0px, x2: crossX, y2: y1px, class: 'can-chart-cross' }));
		const rows: HTMLElement[] = [];
		for (const s of this.series) {
			let best: CsvSeriesPoint | null = null;
			for (const p of s.points) {
				if (!best || Math.abs(p.x - snapX) < Math.abs(best.x - snapX)) best = p;
			}
			if (!best) continue;
			overlay.push(svgNode('circle', { cx: sx(best.x), cy: sy(best.y), r: 4, class: `can-chart-dot ${s.cls}` }));
			rows.push(el('div', 'can-chart-tip-row', [
				el('i', `can-swatch ${s.cls}`),
				el('span', undefined, [s.name]),
				el('b', undefined, [fmtPlotNum(best.y)])
			]));
		}
		const head = `${fmtPlotNum(snapX)}${this.opts.xLabel ? ` ${this.opts.xLabel}` : ''}`;
		const label = svgNode('g', { class: 'can-chart-axislabel' });
		const w = head.length * 6 + 10;
		const lx = Math.min(Math.max(x0px, crossX - w / 2), Math.max(x0px, x1px - w));
		label.append(svgNode('rect', { x: lx, y: y1px + 2, width: w, height: 15, rx: 2 }));
		label.append(svgText(lx + w / 2, y1px + 13, head, 'middle', 'can-chart-axislabel-text'));
		this.tipOverlay = [...overlay, label];
		svg.append(...this.tipOverlay);
		this.tip = el('div', 'can-chart-tip', [el('div', 'can-chart-tip-head', [head]), ...rows]);
		const hostRect = this.root.getBoundingClientRect();
		const px = clientX - hostRect.left;
		const tipW = this.tip.offsetWidth;
		this.tip.style.left = `${Math.max(0, px + 14 + tipW + 8 > hostRect.width ? px - tipW - 14 : px + 14)}px`;
		this.tip.style.top = `${Math.max(0, Math.min(clientY - hostRect.top - 12, hostRect.height - this.tip.offsetHeight - 4))}px`;
		this.tipHost.append(this.tip);
	}

	/** The y range the current window's samples actually span, padded a little. */
	private yExtent(): { min: number; max: number } {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const s of this.series) {
			for (const p of s.points) {
				if (!Number.isFinite(p.y)) continue;
				min = Math.min(min, p.y);
				max = Math.max(max, p.y);
			}
		}
		if (!Number.isFinite(min)) return { min: 0, max: 1 };
		if (min === max) {
			const pad = Math.abs(min) * 0.1 || 1;
			return { min: min - pad, max: max + pad };
		}
		const pad = (max - min) * 0.06;
		return { min: min - pad, max: max + pad };
	}

	private yMin(): number {
		return this.yExtent().min;
	}

	private yMax(): number {
		return this.yExtent().max;
	}

	private plotBox(box: { width: number; height: number }) {
		return { x0px: PAD.left, y0px: PAD.top, x1px: box.width - PAD.right, y1px: box.height - PAD.bottom };
	}

	/** One full redraw: the axes over the current view window, the grid, every series'
	 *  polyline, the legend. */
	private render(): void {
		if (this.disposed) return;
		this.hideTip();
		const box = this.box();
		const height = this.opts.height ?? DEFAULT_HEIGHT;
		const svg = svgNode('svg', { viewBox: `0 0 ${box.width} ${height}`, width: box.width, height, class: 'can-chart', role: 'img' });
		const { x0px, y0px, x1px, y1px } = this.plotBox(box);
		const span = this.view.x1 - this.view.x0 || 1;
		const sx = (x: number) => x0px + ((x - this.view.x0) / span) * (x1px - x0px);
		const yMin = this.yMin();
		const yMax = this.yMax();
		const sy = (y: number) => y1px - ((y - yMin) / (yMax - yMin || 1)) * (y1px - y0px);
		// The frame.
		svg.append(svgNode('line', { x1: x0px, y1: y1px, x2: x1px, y2: y1px, class: 'can-chart-axis' }));
		svg.append(svgNode('line', { x1: x0px, y1: y1px, x2: x0px, y2: y0px, class: 'can-chart-axis' }));
		// Ticks and grid, both axes "nice".
		const yTicks = niceTicks(yMin, yMax, 5);
		for (const v of yTicks.ticks) {
			const y = sy(v);
			if (y < y0px - 1 || y > y1px + 1) continue;
			svg.append(svgNode('line', { x1: x0px, y1: y, x2: x1px, y2: y, class: 'can-chart-grid' }));
			svg.append(svgText(x0px - 6, y + 4, fmtPlotNum(v), 'end', 'can-chart-tick'));
		}
		const xTicks = niceTicks(this.view.x0, this.view.x1, Math.max(3, Math.floor((x1px - x0px) / 90)));
		for (const v of xTicks.ticks) {
			const x = sx(v);
			if (x < x0px - 1 || x > x1px + 1) continue;
			svg.append(svgNode('line', { x1: x, y1: y1px, x2: x, y2: y0px, class: 'can-chart-grid' }));
			svg.append(svgText(x, y1px + 16, fmtPlotNum(v), 'middle', 'can-chart-tick'));
		}
		if (this.opts.xLabel) svg.append(svgText(x1px, height - 2, this.opts.xLabel, 'end', 'can-chart-tick'));
		// The lines: consecutive points connect; a NaN y is a gap the polyline walks
		// around (the backend never sends one, the guard costs nothing).
		for (const s of this.series) {
			if (s.points.length === 0) continue;
			let d = '';
			let pen = false;
			for (const p of s.points) {
				if (!Number.isFinite(p.y)) {
					pen = false;
					continue;
				}
				d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
				pen = true;
			}
			if (d) svg.append(svgNode('path', { d, class: `can-chart-line ${s.cls}` }));
		}
		this.host.replaceChildren(svg);
		// The legend above the plot: one chip per series, its stats as the tooltip.
		const legend = el('div', 'can-legend', this.series.map((s) => {
			const chip = el('span', 'can-legend-chip', [el('i', `can-swatch ${s.cls}`), s.name]);
			chip.title = tf('csv.plot.seriesTip', fmtPlotNum(s.stats.min), fmtPlotNum(s.stats.max), fmtPlotNum(s.stats.avg), s.stats.count.toLocaleString());
			return chip;
		}));
		this.root.replaceChildren(legend, this.host, this.tipHost);
	}
}
