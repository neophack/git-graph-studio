// Small SVG charts for the CAN statistics view's analysis panel, drawn with nothing but
// the DOM: a time-series line for the interval/jitter plot (with a dashed reference line
// at the configured cycle and red markers where the frame-loss check blames a gap) and a
// bar chart for the cycle-time distribution. Everything scales through one viewBox, so the
// charts follow the panel width without a redraw.
//
// Every chart carries an ECharts-style indicator: moving the mouse over the plot snaps
// the crosshair to the nearest sample (it steps from sample to sample, ECharts'
// axisPointer), labels that value in a small box on the x axis, marks every series'
// sample there and floats a tooltip anchored to the snap — the time, each channel's
// value, the range and count a histogram bin tallies. Bar charts light the hovered
// column and label its bin on the axis. Bucket timelines (the load and rate profiles)
// resolve the bucket that COVERS the snap rather than merely the nearest sample, so the
// number the tooltip names is the window the indicator sits in.
//
// The dashboard's bus-level charts are multi-series — one line per channel — so the file
// also carries the palette mapping (`seriesStyle`) and the stacked category bars the
// payload-length distribution draws. Line strokes, bar fills, hover dots and legend
// swatches all read the same class so a channel keeps its colour across every chart.

import { el } from '../../platform/ui/index';
import { t } from '../../platform/i18n';

/** The margins a chart's axes and labels carve out of its viewBox. */
const PAD = { left: 56, right: 12, top: 12, bottom: 24 };

/** The viewBox width every chart draws at — the hover layer maps the pointer's CSS pixels
 *  back through the rendered width into these units. */
const VBW = 800;

/** The chart palette: one class per series, mapped onto the theme's chart colours in
 *  `shell.css` (six of them — a bus with more channels cycles, which the legend still
 *  disambiguates). */
const SERIES_STYLES = ['can-series-0', 'can-series-1', 'can-series-2', 'can-series-3', 'can-series-4', 'can-series-5'] as const;

/** The palette class of series `i` — the position of the channel in the view's channel
 *  list, so a channel is the same colour in the table legend and every chart. */
export function seriesStyle(i: number): string {
	return SERIES_STYLES[i % SERIES_STYLES.length]!;
}

/** An axis time in CANoe's style: seconds under a minute, `m:ss` to an hour, `h:mm:ss`
 *  beyond — the x labels of the timeline charts. */
export function formatAxisSeconds(v: number): string {
	if (v < 60) return v.toFixed(v < 10 ? 1 : 0);
	const s = Math.round(v);
	if (v < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function niceCeil(value: number): number {
	if (value <= 0) return 1;
	const pow = 10 ** Math.floor(Math.log10(value));
	for (const m of [1, 2, 2.5, 5, 10]) {
		if (value <= m * pow) return m * pow;
	}
	return 10 * pow;
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

function svgNode(tag: string, attrs: Record<string, string | number>): SVGElement {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	return node;
}

/** The axes a chart shares: x over [0, xMax], y over [0, yMax], each labelled in the unit the
 *  caller's data carries (yUnit '' draws no unit label - the histogram's y is a plain count).
 *  `fmtX` overrides the x tick labels (the timeline charts' `m:ss` times). */
function axes(width: number, height: number, xMax: number, yMax: number, xUnit: string, yUnit: string, fmtX?: (v: number) => string): { svg: SVGElement } {
	const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, class: 'can-chart', role: 'img' });
	const x0 = PAD.left;
	const y0 = height - PAD.bottom;
	const x1 = width - PAD.right;
	const y1 = PAD.top;
	// The frame: left and bottom axis lines.
	svg.append(svgNode('line', { x1: x0, y1: y0, x2: x1, y2: y0, class: 'can-chart-axis' }));
	svg.append(svgNode('line', { x1: x0, y1: y0, x2: x0, y2: y1, class: 'can-chart-axis' }));
	// Four y grid lines at "nice" steps, labelled in the y unit.
	const yStep = niceCeil(yMax / 4);
	for (let v = yStep; v <= yMax + 1e-12; v += yStep) {
		const y = y0 - ((v / yMax) * (y0 - y1));
		svg.append(svgNode('line', { x1: x0, y1: y, x2: x1, y2: y, class: 'can-chart-grid' }));
		svg.append(svgText(x0 - 6, y + 4, v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0), 'end', 'can-chart-tick'));
	}
	// x labels: start, middle (only when a formatter expresses it tersely), end.
	svg.append(svgText(x0, y0 + 16, fmtX ? fmtX(0) : '0', 'middle', 'can-chart-tick'));
	if (fmtX) svg.append(svgText((x0 + x1) / 2, y0 + 16, fmtX(xMax / 2), 'middle', 'can-chart-tick'));
	svg.append(svgText(x1, y0 + 16, (fmtX ? fmtX(xMax) : `${xMax.toFixed(xMax < 10 ? 2 : 1)} ${xUnit}`), 'end', 'can-chart-tick'));
	if (yUnit !== '') svg.append(svgText(4, y1 + 4, yUnit, 'start', 'can-chart-tick'));
	return { svg };
}

/* ---------- The measure cursor every chart shares ---------- */

export interface SeriesPoint {
	x: number;
	y: number;
	/** The sample covers [x, xEnd) — a load/rate profile bucket's window. A hover inside
	 *  the window reads this point even when another sample's edge sits nearer. */
	xEnd?: number;
	missed?: boolean;
}

/** One value row of the hover tooltip: the series' palette class (empty for a plain row,
 *  which draws no swatch), its name and the formatted value. */
interface TipRow {
	cls: string;
	name: string;
	value: string;
}

/** What one pointer position over a chart reads: the crosshair's x and the per-series dots
 *  (the line charts) or the lit column (the bar charts), all in viewBox pixels, plus the
 *  tooltip's head line (the x value under the cursor), its value rows and an optional
 *  note (a missed-frame blame). */
interface HoverState {
	crossX?: number;
	dots?: { x: number; y: number; cls: string }[];
	colX?: number;
	colW?: number;
	/** ECharts' axisPointer label: the value the indicator sits at, drawn in a small filled
	 *  box on the x axis under the crosshair / hovered column. */
	axisLabel?: string;
	/** The tooltip's horizontal anchor (viewBox px) — the snapped crosshair or the hovered
	 *  column's centre, where ECharts pins its tooltip; it flips to the anchor's left
	 *  before it would overflow the chart's right edge. Defaults to the pointer. */
	anchorX?: number;
	head: string;
	rows: TipRow[];
	note?: string;
}

/** A number the way the tooltips print it: two decimals under ten, one under a hundred,
 *  whole numbers beyond — the magnitudes the CAN charts carry (single-digit loads in %,
 *  three-digit frame rates, sub-ten-millisecond cycles) — with bare trailing zeros
 *  trimmed (`9.50` reads as `9.5`). */
function fmtNum(v: number): string {
	return String(parseFloat(v.toFixed(Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0)));
}

/** The sample a cursor at data-x reads: a bucket that covers it (`xEnd`) wins — the
 *  readout then names the window the cursor sits in — else the sample whose x is nearest. */
function sampleAt(points: SeriesPoint[], x: number): SeriesPoint | null {
	let best: SeriesPoint | null = null;
	for (const p of points) {
		if (p.xEnd !== undefined && x >= p.x && x < p.xEnd) return p;
		if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
	}
	return best;
}

/** ECharts' axisPointer label: a small filled box on the x axis naming the value the
 *  indicator sits at, centred on it and clamped inside the plot's width. */
function axisPointerLabel(cx: number, text: string, plot: { left: number; right: number; bottom: number }): SVGElement {
	const group = svgNode('g', { class: 'can-chart-axislabel' });
	const w = text.length * 6 + 10;
	const x = Math.min(Math.max(plot.left, cx - w / 2), Math.max(plot.left, plot.right - w));
	group.append(svgNode('rect', { x, y: plot.bottom + 2, width: w, height: 15, rx: 2 }));
	group.append(svgText(x + w / 2, plot.bottom + 13, text, 'middle', 'can-chart-axislabel-text'));
	return group;
}

/** Installs the measure cursor on a drawn chart: `mousemove` over the plot area resolves
 *  the pointer's viewBox x into a readout — the snapped crosshair, dots and hovered column
 *  drawn into the SVG, the tooltip floated as HTML (text renders crisp there and never
 *  scales with the viewBox) — and leaving the chart, or hovering its margins, clears it.
 *  The tooltip anchors to the readout's own x (`anchorX`, ECharts' snap) a hand's width
 *  right, flipping to its left before it would overflow the chart's right edge. */
function installHover(svg: SVGElement, wrap: HTMLElement, plot: { left: number; right: number; top: number; bottom: number }, resolve: (vx: number) => HoverState | null): void {
	let overlay: SVGElement[] = [];
	let tip: HTMLElement | null = null;
	const hide = (): void => {
		for (const node of overlay) node.remove();
		overlay = [];
		tip?.remove();
		tip = null;
	};
	svg.addEventListener('mousemove', (event: MouseEvent) => {
		hide();
		const rect = svg.getBoundingClientRect();
		if (rect.width <= 0) return;
		const vx = ((event.clientX - rect.left) / rect.width) * VBW;
		if (vx < plot.left || vx > plot.right) return;
		const state = resolve(vx);
		if (!state) return;
		if (state.colX !== undefined && state.colW !== undefined) {
			overlay.push(svgNode('rect', { x: state.colX, y: plot.top, width: state.colW, height: plot.bottom - plot.top, class: 'can-chart-col' }));
		}
		if (state.crossX !== undefined) {
			overlay.push(svgNode('line', { x1: state.crossX, y1: plot.top, x2: state.crossX, y2: plot.bottom, class: 'can-chart-cross' }));
		}
		for (const d of state.dots ?? []) {
			overlay.push(svgNode('circle', { cx: d.x, cy: d.y, r: 4, class: `can-chart-dot${d.cls ? ` ${d.cls}` : ''}` }));
		}
		if (state.axisLabel !== undefined) {
			const cx = state.crossX ?? (state.colX !== undefined && state.colW !== undefined ? state.colX + state.colW / 2 : vx);
			overlay.push(axisPointerLabel(cx, state.axisLabel, plot));
		}
		svg.append(...overlay);
		tip = el('div', 'can-chart-tip', [
			el('div', 'can-chart-tip-head', [state.head]),
			...state.rows.map((row) => el('div', 'can-chart-tip-row', [
				...(row.cls ? [el('i', `can-swatch ${row.cls}`)] : []),
				el('span', undefined, [row.name]),
				el('b', undefined, [row.value])
			])),
			...(state.note ? [el('div', 'can-chart-tip-note', [state.note])] : [])
		]);
		const wrapRect = wrap.getBoundingClientRect();
		const pointerX = event.clientX - wrapRect.left;
		const anchorCss = state.anchorX !== undefined ? (state.anchorX / VBW) * rect.width : pointerX;
		const w = tip.offsetWidth;
		tip.style.left = `${Math.max(0, anchorCss + 14 + w + 8 > wrapRect.width ? anchorCss - w - 14 : anchorCss + 14)}px`;
		tip.style.top = `${Math.max(0, Math.min(event.clientY - wrapRect.top - 12, wrapRect.height - tip.offsetHeight - 4))}px`;
		wrap.append(tip);
	});
	svg.addEventListener('mouseleave', hide);
}

/** A time-series of cycle intervals: the line the message actually ran at, a dashed line
 *  at `ref` (the median cycle, i.e. what it is configured at) and a red marker on every
 *  point the frame-loss check blames. `xUnit`/`yUnit` label the axes (ms for the cycles). */
export function cycleSeriesChart(points: SeriesPoint[], ref: number, xUnit: string, yUnit: string): HTMLElement {
	const width = VBW;
	const height = 240;
	const yMax = niceCeil(Math.max(1e-9, ...points.map((p) => p.y), ref) * 1.1);
	const xMax = Math.max(1e-9, ...points.map((p) => p.x));
	const { svg } = axes(width, height, xMax, yMax, xUnit, yUnit);
	const x0 = PAD.left;
	const y0 = height - PAD.bottom;
	const x1 = width - PAD.right;
	const y1 = PAD.top;
	const px = (x: number) => x0 + (x / xMax) * (x1 - x0);
	const py = (y: number) => y0 - (y / yMax) * (y0 - y1);
	if (points.length > 1) {
		svg.append(svgNode('path', {
			d: points.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(''),
			class: 'can-chart-line'
		}));
	}
	if (ref > 0 && ref <= yMax) {
		svg.append(svgNode('line', { x1: x0, y1: py(ref), x2: x1, y2: py(ref), class: 'can-chart-ref' }));
		svg.append(svgText(x1 - 4, py(ref) - 4, 'median', 'end', 'can-chart-tick'));
	}
	for (const p of points) {
		if (p.missed) svg.append(svgNode('circle', { cx: px(p.x), cy: py(Math.min(p.y, yMax)), r: 3, class: 'can-chart-missed' }));
	}
	const wrap = el('div', 'can-chart-wrap', [svg]);
	// ECharts-style: the indicator snaps to the nearest interval sample — the crosshair,
	// the axis label, the dot and the tooltip's head all read that one sample, its cycle,
	// and the frame-loss blame when it carries one.
	installHover(svg, wrap, { left: x0, right: x1, top: y1, bottom: y0 }, (vx) => {
		const hit = sampleAt(points, ((vx - x0) / Math.max(1e-9, x1 - x0)) * xMax);
		if (!hit) return null;
		const head = `${fmtNum(hit.x)} ${xUnit}`;
		return {
			crossX: px(hit.x),
			dots: [{ x: px(hit.x), y: py(Math.min(hit.y, yMax)), cls: '' }],
			axisLabel: head,
			anchorX: px(hit.x),
			head,
			rows: [{ cls: '', name: t('can.chart.cycleValue'), value: `${fmtNum(hit.y)} ${yUnit}` }],
			note: hit.missed ? t('can.chart.missed') : undefined
		};
	});
	return wrap;
}

/** The cycle-time distribution: one bar per bin, the median marked by a dashed line.
 *  `xUnit` labels the cycle axis; the y axis is a frame count and carries no unit. */
export function histogramChart(bins: { fromS: number; toS: number; count: number }[], median: number, xUnit: string): HTMLElement {
	const width = VBW;
	const height = 200;
	const xMax = Math.max(1e-9, ...bins.map((b) => b.toS));
	const yMax = niceCeil(Math.max(1, ...bins.map((b) => b.count)) * 1.1);
	const { svg } = axes(width, height, xMax, yMax, xUnit, '');
	const x0 = PAD.left;
	const y0 = height - PAD.bottom;
	const x1 = width - PAD.right;
	const y1 = PAD.top;
	const bw = (x1 - x0) / Math.max(1, bins.length);
	for (const [i, b] of bins.entries()) {
		if (!b.count) continue;
		const h = (b.count / yMax) * (y0 - y1);
		svg.append(svgNode('rect', { x: x0 + i * bw + 0.5, y: y0 - h, width: Math.max(1, bw - 1), height: h, class: 'can-chart-bar' }));
	}
	if (median > 0 && median <= xMax) {
		const mx = x0 + (median / xMax) * (x1 - x0);
		svg.append(svgNode('line', { x1: mx, y1: y1, x2: mx, y2: y0, class: 'can-chart-ref' }));
	}
	const wrap = el('div', 'can-chart-wrap', [svg]);
	// The cursor lights the column it is over — zero-count bins included, their range
	// still reads back with a count of 0 — and the axis label names the bin on the axis.
	installHover(svg, wrap, { left: x0, right: x1, top: y1, bottom: y0 }, (vx) => {
		const i = Math.floor((vx - x0) / bw);
		if (i < 0 || i >= bins.length) return null;
		const b = bins[i]!;
		const head = `${fmtNum(b.fromS)} – ${fmtNum(b.toS)} ${xUnit}`;
		return {
			colX: x0 + i * bw,
			colW: bw,
			axisLabel: head,
			anchorX: x0 + i * bw + bw / 2,
			head,
			rows: [{ cls: '', name: t('can.status.frames'), value: b.count.toLocaleString() }]
		};
	});
	return wrap;
}

/** One named series of a multi-channel chart, in its palette class. */
export interface ChartSeries {
	name: string;
	cls: string;
	points: SeriesPoint[];
}

/** The legend a multi-series chart sits above its plot: one chip per series, the swatch
 *  carrying the same palette class the line or bar segments do. */
function legend(series: ChartSeries[]): HTMLElement {
	return el('div', 'can-legend', series.map((s) => el('span', 'can-legend-chip', [el('i', `can-swatch ${s.cls}`), s.name])));
}

/** A multi-series timeline — the dashboard's bus-load and frame-rate charts: one line per
 *  channel in its palette colour over a shared x axis, an optional dashed reference line
 *  (`ref`, the median cycle on the analysis chart) and a legend of chips. `fmtX` labels
 *  the x ticks (the timelines pass `formatAxisSeconds`); `height` defaults to the compact
 *  pane height. */
export function multiLineChart(series: ChartSeries[], opts: { xUnit: string; yUnit: string; height?: number; ref?: number; fmtX?: (v: number) => string }): HTMLElement {
	const width = VBW;
	const height = opts.height ?? 220;
	const ref = opts.ref ?? 0;
	const yMax = niceCeil(Math.max(1e-9, ...series.flatMap((s) => s.points.map((p) => p.y)), ref) * 1.1);
	const xMax = Math.max(1e-9, ...series.flatMap((s) => s.points.map((p) => p.x)));
	const { svg } = axes(width, height, xMax, yMax, opts.xUnit, opts.yUnit, opts.fmtX);
	const x0 = PAD.left;
	const y0 = height - PAD.bottom;
	const x1 = width - PAD.right;
	const y1 = PAD.top;
	const px = (x: number) => x0 + (x / xMax) * (x1 - x0);
	const py = (y: number) => y0 - (y / yMax) * (y0 - y1);
	if (ref > 0 && ref <= yMax) {
		svg.append(svgNode('line', { x1: x0, y1: py(ref), x2: x1, y2: py(ref), class: 'can-chart-ref' }));
	}
	for (const s of series) {
		if (s.points.length < 2) continue;
		svg.append(svgNode('path', {
			d: s.points.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(''),
			class: `can-chart-line ${s.cls}`
		}));
	}
	const wrap = el('div', 'can-chart-wrap', [legend(series), svg]);
	// ECharts-style: the crosshair snaps to the nearest sample across every series (the
	// union of their xs), so it steps from sample to sample instead of sliding; each
	// channel's dot sits on its covering bucket — clamped into the bucket's window when
	// the channel is sparser than the snap — or on its own nearest sample.
	const snaps = series.flatMap((s) => s.points.map((p) => p.x));
	installHover(svg, wrap, { left: x0, right: x1, top: y1, bottom: y0 }, (vx) => {
		if (!snaps.length) return null;
		const cursorX = ((vx - x0) / Math.max(1e-9, x1 - x0)) * xMax;
		const snapX = snaps.reduce((best, x) => (Math.abs(x - cursorX) < Math.abs(best - cursorX) ? x : best), snaps[0]!);
		const rows: TipRow[] = [];
		const dots: { x: number; y: number; cls: string }[] = [];
		for (const s of series) {
			const hit = sampleAt(s.points, snapX);
			if (!hit) continue;
			rows.push({ cls: s.cls, name: s.name, value: `${fmtNum(hit.y)} ${opts.yUnit}` });
			const dotX = hit.xEnd !== undefined ? Math.min(Math.max(snapX, hit.x), hit.xEnd) : hit.x;
			dots.push({ x: px(dotX), y: py(Math.min(hit.y, yMax)), cls: s.cls });
		}
		if (!rows.length) return null;
		const head = opts.fmtX ? `${opts.fmtX(snapX)} ${opts.xUnit}` : `${fmtNum(snapX)} ${opts.xUnit}`;
		return { crossX: px(snapX), dots, axisLabel: head, anchorX: px(snapX), head, rows };
	});
	return wrap;
}

/** A stacked category chart — the payload-length distribution: one bar per label (the
 *  length bins), stacked one segment per series (the channels) in their palette colours.
 *  The y axis is a frame count and carries no unit. */
export function stackedBars(labels: string[], series: ChartSeries[], opts: { height?: number } = {}): HTMLElement {
	const width = VBW;
	const height = opts.height ?? 180;
	const xUnit = 'B';
	const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.points[i]?.y ?? 0), 0));
	const yMax = niceCeil(Math.max(1, ...totals) * 1.1);
	const xMax = Math.max(1, labels.length);
	const { svg } = axes(width, height, xMax, yMax, xUnit, '');
	const x0 = PAD.left;
	const y0 = height - PAD.bottom;
	const x1 = width - PAD.right;
	const y1 = PAD.top;
	const bw = (x1 - x0) / labels.length;
	for (const [i, label] of labels.entries()) {
		let stacked = 0;
		for (const s of series) {
			const v = s.points[i]?.y ?? 0;
			if (!v) continue;
			const h = (v / yMax) * (y0 - y1);
			svg.append(svgNode('rect', {
				x: x0 + i * bw + 0.5,
				y: y0 - stacked - h,
				width: Math.max(1, bw - 1),
				height: h,
				class: `can-chart-bar ${s.cls}`
			}));
			stacked += h;
		}
		// One x tick every k labels, where k keeps them from colliding at the viewBox width.
		const every = Math.max(1, Math.ceil(labels.length / 16));
		if (i % every === 0) svg.append(svgText(x0 + i * bw + bw / 2, y0 + 16, label, 'middle', 'can-chart-tick'));
	}
	const wrap = el('div', 'can-chart-wrap', [legend(series), svg]);
	// The cursor lights the length bin it is over, the axis label names the bin on the
	// axis, and the tooltip reads each channel's share of it.
	installHover(svg, wrap, { left: x0, right: x1, top: y1, bottom: y0 }, (vx) => {
		const i = Math.floor((vx - x0) / bw);
		if (i < 0 || i >= labels.length) return null;
		const head = `${labels[i]} ${xUnit}`;
		const rows: TipRow[] = series.map((s) => ({ cls: s.cls, name: s.name, value: (s.points[i]?.y ?? 0).toLocaleString() }));
		rows.push({ cls: '', name: t('can.chart.total'), value: (totals[i] ?? 0).toLocaleString() });
		return {
			colX: x0 + i * bw,
			colW: bw,
			axisLabel: head,
			anchorX: x0 + i * bw + bw / 2,
			head,
			rows
		};
	});
	return wrap;
}
