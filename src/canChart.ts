// Small SVG charts for the CAN statistics view's analysis panel, drawn with nothing but
// the DOM: a time-series line for the interval/jitter plot (with a dashed reference line
// at the configured cycle and red markers where the frame-loss check blames a gap) and a
// bar chart for the cycle-time distribution. Everything scales through one viewBox, so the
// charts follow the panel width without a redraw.

import { el } from './ui';

/** The margins a chart's axes and labels carve out of its viewBox. */
const PAD = { left: 56, right: 12, top: 12, bottom: 24 };

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
 *  caller's data carries (yUnit '' draws no unit label - the histogram's y is a plain count). */
function axes(width: number, height: number, xMax: number, yMax: number, xUnit: string, yUnit: string): { svg: SVGElement } {
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
	// x labels: start, middle, end.
	svg.append(svgText(x0, y0 + 16, '0', 'middle', 'can-chart-tick'));
	svg.append(svgText(x1, y0 + 16, `${xMax.toFixed(xMax < 10 ? 2 : 1)} ${xUnit}`, 'end', 'can-chart-tick'));
	if (yUnit !== '') svg.append(svgText(4, y1 + 4, yUnit, 'start', 'can-chart-tick'));
	return { svg };
}

export interface SeriesPoint {
	x: number;
	y: number;
	missed?: boolean;
}

/** A time-series of cycle intervals: the line the message actually ran at, a dashed line
 *  at `ref` (the median cycle, i.e. what it is configured at) and a red marker on every
 *  point the frame-loss check blames. `xUnit`/`yUnit` label the axes (ms for the cycles). */
export function cycleSeriesChart(points: SeriesPoint[], ref: number, xUnit: string, yUnit: string): HTMLElement {
	const width = 800;
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
	return wrap;
}

/** The cycle-time distribution: one bar per bin, the median marked by a dashed line.
 *  `xUnit` labels the cycle axis; the y axis is a frame count and carries no unit. */
export function histogramChart(bins: { fromS: number; toS: number; count: number }[], median: number, xUnit: string): HTMLElement {
	const width = 800;
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
	return el('div', 'can-chart-wrap', [svg]);
}
