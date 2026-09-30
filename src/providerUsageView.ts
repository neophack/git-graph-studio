// The AI provider bridge's usage surfaces (module 12): the token-usage curve over the
// redirected Claude state's session history (`provider_usage`'s per-UTC-hour answer,
// re-bucketed into local "today / 7 days / 30 days" ranges) and the chat pane's gate —
// a bridged extension's chat pane shows the set-key page while the active third-party
// provider has no key (instead of the provider's own login page), and the usage strip
// once it has one. Tokens only: no money, no durations — the bridge bills nothing.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { commands } from './commands';
import { locale, t, tf } from './i18n';
import { actionButton, el, icon, notify } from './ui';
import {
	PROVIDERS_CHANGED_EVENT,
	cachedProviders,
	loadProviders,
	saveProvider,
	type ProviderList,
	type ProviderProfile
} from './aiProviders';

/* ---------- The data ---------- */

/** One UTC hour's token usage, as `provider_usage` answers it. */
export interface UsageHour {
	startMs: number;
	cacheRead: number;
	cacheCreation: number;
	input: number;
	output: number;
}

export type UsageRange = 'today' | 'week' | 'month';

/** The curve's ranges, in switcher order. */
export const USAGE_RANGES: UsageRange[] = ['today', 'week', 'month'];

/** The backend's usage answer; null is a failed read (the chart's error state), an
 *  empty array an honest "nothing used yet". */
export async function fetchProviderUsage(): Promise<UsageHour[] | null> {
	try {
		return (await invoke<UsageHour[] | null>('provider_usage')) ?? [];
	} catch {
		return null;
	}
}

/** One rendered bucket: a local-time span (an hour of today, or a day) and its totals. */
export interface UsageBucket {
	startMs: number;
	cacheRead: number;
	cacheCreation: number;
	input: number;
	output: number;
	total(): number;
}

function bucket(startMs: number): UsageBucket {
	const totals: Omit<UsageBucket, 'total'> = { startMs, cacheRead: 0, cacheCreation: 0, input: 0, output: 0 };
	return {
		...totals,
		total(): number {
			return this.cacheRead + this.cacheCreation + this.input + this.output;
		}
	};
}

/** The local-time buckets a range covers: today's 24 hours, or the last N days
 *  (oldest first). Pure over `now` — the seam the tests pin. */
export function rangeBuckets(range: UsageRange, now = new Date()): UsageBucket[] {
	const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const out: UsageBucket[] = [];
	if (range === 'today') {
		for (let hour = 0; hour < 24; hour++) out.push(bucket(dayStart + hour * 3_600_000));
		return out;
	}
	const days = range === 'week' ? 7 : 30;
	for (let back = days - 1; back >= 0; back--) out.push(bucket(dayStart - back * 86_400_000));
	return out;
}

/** Fold the backend's UTC hours into a range's local buckets. */
export function totalsForRange(hours: UsageHour[], range: UsageRange, now = new Date()): UsageBucket[] {
	const buckets = rangeBuckets(range, now);
	const span = buckets.length > 1 ? buckets[1].startMs - buckets[0].startMs : 3_600_000;
	const first = buckets[0].startMs;
	for (const hour of hours) {
		const index = Math.floor((hour.startMs - first) / span);
		if (index < 0 || index >= buckets.length) continue;
		buckets[index].cacheRead += hour.cacheRead;
		buckets[index].cacheCreation += hour.cacheCreation;
		buckets[index].input += hour.input;
		buckets[index].output += hour.output;
	}
	return buckets;
}

/** A token count the axis and the tooltip share: `1.2k`, `3.4M`, never a money shape. */
export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
	return String(value);
}

/** The bucket a tooltip names: an hour span for today, a date for the day ranges. */
export function bucketTitle(startMs: number, range: UsageRange): string {
	const date = new Date(startMs);
	if (range === 'today') {
		const hour = date.getHours();
		const pad = (value: number): string => String(value).padStart(2, '0');
		return `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`;
	}
	return new Intl.DateTimeFormat(locale() === 'zh-cn' ? 'zh-CN' : 'en-US', {
		month: 'numeric',
		day: 'numeric'
	}).format(date);
}

/* ---------- The chart ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
	return element;
}

/** A y-axis maximum rounded up to a 1/2/5 step, so the gridlines land on round numbers. */
function niceMax(value: number): number {
	if (value <= 0) return 1;
	const scale = 10 ** Math.floor(Math.log10(value));
	for (const step of [1, 2, 5, 10]) {
		if (value <= step * scale) return step * scale;
	}
	return 10 * scale; // unreachable, but the type wants it
}

/** A smooth curve through the points (Catmull-Rom as cubic beziers, control points
 *  clamped to the plot so the curve never dips below zero or above the top). */
function smoothPath(points: [number, number][]): string {
	if (points.length === 0) return '';
	if (points.length < 3) {
		return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0]},${point[1]}`).join(' ');
	}
	const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
	const bottom = Math.min(...points.map((point) => point[1]));
	const top = Math.max(...points.map((point) => point[1]));
	let path = `M${points[0][0]},${points[0][1]}`;
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)]!;
		const p1 = points[i]!;
		const p2 = points[i + 1]!;
		const p3 = points[Math.min(points.length - 1, i + 2)]!;
		const c1x = p1[0] + (p2[0] - p0[0]) / 6;
		const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6, bottom, top);
		const c2x = p2[0] - (p3[0] - p1[0]) / 6;
		const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6, bottom, top);
		path += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
	}
	return path;
}

/** The chart's drawn half: the totals as one smooth curve with an area fill, gridline
 *  labels, and a hover guide whose tooltip breaks the bucket into cache hits, cache
 *  writes, uncached input and output. Tokens only. */
class UsageChart {
	private readonly root: HTMLElement;
	private drawn: {
		points: [number, number][];
		guide: SVGLineElement;
		dot: SVGCircleElement;
	} | null = null;
	private readonly tooltip = el('div', 'usage-tooltip');

	constructor(container: HTMLElement, private readonly height: number) {
		this.root = el('div', 'usage-chart');
		this.root.style.height = `${height}px`;
		this.tooltip.hidden = true;
		container.appendChild(this.root);
	}

	/** Drop the plot (the panel's empty and error states draw their own words). */
	clear(): void {
		this.drawn = null;
		this.root.replaceChildren(this.tooltip);
		this.tooltip.hidden = true;
	}

	/** One full redraw — the totals array owns the plot until the next render. */
	render(buckets: UsageBucket[], range: UsageRange, width: number): void {
		this.drawn = null;
		this.tooltip.hidden = true;
		const padLeft = 40;
		const padRight = 8;
		const padTop = 8;
		const padBottom = 15;
		const plotWidth = Math.max(40, width - padLeft - padRight);
		const plotHeight = Math.max(20, this.height - padTop - padBottom);
		const max = niceMax(Math.max(1, ...buckets.map((bucket) => bucket.total())));
		const step = buckets.length > 1 ? plotWidth / (buckets.length - 1) : plotWidth;
		const points: [number, number][] = buckets.map((bucket, index) => [
			padLeft + index * step,
			padTop + plotHeight - (bucket.total() / max) * plotHeight
		]);

		const svg = svgEl('svg', { viewBox: `0 0 ${width} ${this.height}`, width, height: this.height });
		svg.classList.add('usage-chart-svg');
		// The gridlines with their round-number labels: zero, half, top.
		for (const fraction of [0, 0.5, 1]) {
			const y = padTop + plotHeight - fraction * plotHeight;
			svg.appendChild(svgEl('line', {
				x1: padLeft, x2: padLeft + plotWidth, y1: y, y2: y,
				class: fraction === 0 ? 'usage-axis' : 'usage-grid'
			}));
			const label = svgEl('text', { x: padLeft - 6, y: y + 3, 'text-anchor': 'end', class: 'usage-tick' });
			label.textContent = formatTokens(Math.round(max * fraction));
			svg.appendChild(label);
		}
		// The x labels: an even handful, never one per bucket.
		const dateLocale = locale() === 'zh-cn' ? 'zh-CN' : 'en-US';
		const weekday = new Intl.DateTimeFormat(dateLocale, { weekday: 'short' });
		const monthDay = new Intl.DateTimeFormat(dateLocale, { month: 'numeric', day: 'numeric' });
		const every = Math.max(1, Math.ceil(buckets.length / 6));
		for (let index = 0; index < buckets.length; index += every) {
			const label = svgEl('text', {
				x: padLeft + index * step, y: this.height - 3, 'text-anchor': index === 0 ? 'start' : 'middle', class: 'usage-tick'
			});
			const date = new Date(buckets[index]!.startMs);
			label.textContent = range === 'today'
				? `${date.getHours()}${locale() === 'zh-cn' ? '时' : ':00'}`
				: range === 'week' ? weekday.format(date) : monthDay.format(date);
			svg.appendChild(label);
		}
		// The curve and its area fill.
		const curve = smoothPath(points);
		if (curve !== '') {
			const area = svgEl('path', {
				d: `${curve} L${points[points.length - 1]![0]},${padTop + plotHeight} L${points[0]![0]},${padTop + plotHeight} Z`,
				class: 'usage-area'
			});
			svg.appendChild(area);
			svg.appendChild(svgEl('path', { d: curve, class: 'usage-line' }));
		}
		const guide = svgEl('line', { x1: 0, x2: 0, y1: padTop, y2: padTop + plotHeight, class: 'usage-guide' });
		guide.setAttribute('visibility', 'hidden');
		const dot = svgEl('circle', { r: 2.5, class: 'usage-dot' });
		dot.setAttribute('visibility', 'hidden');
		svg.append(guide, dot);
		this.root.replaceChildren(svg, this.tooltip);

		svg.addEventListener('mousemove', (event) => this.hover(event, buckets, range, padLeft, step, width));
		svg.addEventListener('mouseleave', () => {
			guide.setAttribute('visibility', 'hidden');
			dot.setAttribute('visibility', 'hidden');
			this.tooltip.hidden = true;
		});
		this.drawn = { points, guide, dot };
	}

	/** The hover: the nearest bucket's guide, dot and breakdown tooltip. The `x`
	 *  mapping tolerates a zero-width layout (jsdom) by anchoring to the first bucket. */
	private hover(event: MouseEvent, buckets: UsageBucket[], range: UsageRange, padLeft: number, step: number, width: number): void {
		const drawn = this.drawn;
		if (drawn === null) return;
		const rect = this.root.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const index = step > 0 ? Math.max(0, Math.min(buckets.length - 1, Math.round((x - padLeft) / step))) : 0;
		const point = drawn.points[index];
		if (point === undefined) return;
		drawn.guide.setAttribute('x1', String(point[0]));
		drawn.guide.setAttribute('x2', String(point[0]));
		drawn.guide.setAttribute('visibility', 'visible');
		drawn.dot.setAttribute('cx', String(point[0]));
		drawn.dot.setAttribute('cy', String(point[1]));
		drawn.dot.setAttribute('visibility', 'visible');

		const totals = buckets[index]!;
		const row = (labelKey: Parameters<typeof t>[0], value: number, color: string): HTMLElement => {
			const swatch = el('span', 'dot');
			swatch.style.setProperty('--dot', color);
			return el('div', 'row', [swatch, el('span', 'name', [t(labelKey)]), el('span', 'value', [formatTokens(value)])]);
		};
		this.tooltip.replaceChildren(
			el('div', 'title', [bucketTitle(totals.startMs, range)]),
			row('providers.usage.cacheRead', totals.cacheRead, 'var(--vscode-charts-green, #89d185)'),
			row('providers.usage.cacheCreation', totals.cacheCreation, 'var(--vscode-charts-blue, #3794ff)'),
			row('providers.usage.input', totals.input, 'var(--vscode-charts-yellow, #cca700)'),
			row('providers.usage.output', totals.output, 'var(--vscode-charts-purple, #b180d7)')
		);
		this.tooltip.hidden = false;
		// Keep the tooltip inside the chart whatever its host's padding.
		this.tooltip.style.left = `${Math.max(0, Math.min(width - 140, point[0] + 8))}px`;
		this.tooltip.style.top = '2px';
	}
}

/* ---------- The panel (the head + the chart, shared by the strip and the page) ---------- */

export interface UsagePanelOptions {
	/** The chat pane's strip: a short chart and a collapse toggle. */
	compact?: boolean;
}

/** The usage curve as one self-contained panel: title, the range's total, the
 *  today / 7-day / 30-day switcher, and the chart. Fetches on mount and follows the
 *  store's changes (a provider switch restarts the chat; the refresh is cheap).
 *  Returns the disposer. */
export function mountUsagePanel(container: HTMLElement, options: UsagePanelOptions = {}): () => void {
	let range: UsageRange = 'today';
	let hours: UsageHour[] | null = null;
	let collapsed = false;
	let width = 320;
	let unobserve: (() => void) | null = null;

	const totalLabel = el('span', 'usage-total', []);
	// The chart's siblings for the states the plot itself cannot draw: a failed read
	// (with its retry) and an all-zero range (the honest empty curve).
	const errorRow = el('div', 'usage-empty');
	const emptyRow = el('div', 'usage-empty');
	const chartHost = el('div', 'usage-chart-host', [errorRow, emptyRow]);
	const chart = new UsageChart(chartHost, options.compact ? 60 : 150);

	const draw = (): void => {
		errorRow.replaceChildren();
		emptyRow.replaceChildren();
		if (hours === null) {
			chart.clear();
			errorRow.replaceChildren(
				el('span', '', [t('providers.usage.loadFailed') + ' ']),
				actionButton('refresh', t('providers.retry'), () => void refresh())
			);
			totalLabel.textContent = '';
			return;
		}
		const buckets = totalsForRange(hours, range);
		chart.render(buckets, range, width);
		totalLabel.textContent = tf('providers.usage.total', formatTokens(buckets.reduce((sum, bucket) => sum + bucket.total(), 0)));
		if (buckets.every((bucket) => bucket.total() === 0)) {
			emptyRow.replaceChildren(t('providers.usage.empty'));
		}
	};

	const refresh = async (): Promise<void> => {
		const answer = await fetchProviderUsage();
		// The panel may have been disposed mid-flight.
		if (!panel.isConnected) return;
		hours = answer;
		if (!collapsed) draw();
	};

	const setRange = (next: UsageRange): void => {
		range = next;
		for (const button of switchBar.querySelectorAll('button')) {
			button.classList.toggle('active', button.dataset.range === range);
		}
		if (!collapsed) draw();
	};

	const switchBar = el('div', 'usage-range-switch',
		USAGE_RANGES.map((candidate) => {
			const button = el('button', `usage-range${candidate === range ? ' active' : ''}`, [t(`providers.usage.range.${candidate}`)]);
			button.type = 'button';
			button.dataset.range = candidate;
			button.addEventListener('click', () => setRange(candidate));
			return button;
		}));

	const head = el('div', 'usage-head', [
		icon('pulse'),
		el('span', 'usage-title', [t('providers.usage.title')]),
		totalLabel,
		switchBar
	]);
	const body = el('div', 'usage-body', [chartHost]);
	const panel = el('div', `usage-panel${options.compact ? ' compact' : ''}`, [head, body]);
	if (options.compact) {
		const toggle = el('button', 'usage-collapse', [icon('chevron-down')]);
		toggle.type = 'button';
		toggle.title = t('providers.usage.collapse');
		toggle.addEventListener('click', () => {
			collapsed = !collapsed;
			toggle.replaceChildren(icon(collapsed ? 'chevron-right' : 'chevron-down'));
			body.hidden = collapsed;
			if (!collapsed) draw();
		});
		head.appendChild(toggle);
	}
	container.appendChild(panel);

	// The width follows the host (the sidebar resizes); jsdom has no ResizeObserver.
	if (typeof ResizeObserver !== 'undefined') {
		const observer = new ResizeObserver((entries) => {
			const next = Math.round(entries[0]?.contentRect.width ?? width);
			if (next > 40 && Math.abs(next - width) > 1 && !collapsed) {
				width = next;
				draw();
			}
		});
		observer.observe(panel);
		unobserve = (): void => observer.disconnect();
	}

	const onStoreChange = (): void => void refresh();
	document.addEventListener(PROVIDERS_CHANGED_EVENT, onStoreChange);
	let unlisten: (() => void) | null = null;
	void listen('providers-changed', onStoreChange)
		.then((off) => {
			unlisten = off;
		})
		.catch(() => undefined);

	void refresh();
	return () => {
		document.removeEventListener(PROVIDERS_CHANGED_EVENT, onStoreChange);
		unlisten?.();
		unobserve?.();
		panel.remove();
	};
}

/* ---------- The chat pane's gate ---------- */

/** The active third-party profile, or null when the official service (or nothing) is
 *  active — the chat pane's gate and strip key on this. */
export function activeThirdParty(list: ProviderList): ProviderProfile | null {
	const profile = list.profiles.find((candidate) => candidate.id === list.activeId);
	return profile !== undefined && profile.preset !== 'official' ? profile : null;
}

/** Whether a profile's preset shape cannot run without a key (a custom or NewAPI
 *  gateway may be a keyless local proxy — gating it would hide a working chat). */
export function presetRequiresKey(list: ProviderList, profile: ProviderProfile): boolean {
	return list.presets.find((preset) => preset.id === profile.preset)?.requiresKey ?? true;
}

/** The gate over a bridged extension's chat pane (`workbench.ts` mounts it beside the
 *  webview view): while the active third-party provider has no key, the pane carries
 *  the set-key page instead of the provider's own login one; once the key is set, the
 *  usage strip rides above the chat. Every other state renders nothing — the pane is
 *  the extension's alone. Returns the disposer the section's rebuild calls. */
export function mountProviderPaneGate(extId: string, pane: HTMLElement): () => void {
	let mode: 'none' | 'key' | 'usage' = 'none';
	let strip: HTMLElement | null = null;
	let overlay: HTMLElement | null = null;
	let disposePanel: (() => void) | null = null;

	const clear = (): void => {
		overlay?.remove();
		overlay = null;
		strip?.remove();
		strip = null;
		disposePanel?.();
		disposePanel = null;
		pane.classList.remove('provider-pane-usage');
	};

	const apply = (list: ProviderList | null): void => {
		if (list === null || !list.bridgedExtIds.includes(extId)) {
			if (mode !== 'none') {
				clear();
				mode = 'none';
			}
			return;
		}
		const profile = activeThirdParty(list);
		// The strip wants a key set (the usage exists then); the set-key page wants a
		// preset that cannot run without one.
		const next: 'none' | 'key' | 'usage' = profile === null
			? 'none'
			: profile.hasKey ? 'usage' : presetRequiresKey(list, profile) ? 'key' : 'none';
		if (next === mode) return;
		clear();
		mode = next;
		if (next === 'key' && profile !== null) {
			overlay = buildSetKeyPage(profile);
			pane.appendChild(overlay);
		} else if (next === 'usage') {
			// The pane hosts the chat's iframe; the strip rides above it.
			pane.classList.add('provider-pane-usage');
			strip = el('div', 'provider-usage-strip');
			pane.prepend(strip);
			disposePanel = mountUsagePanel(strip, { compact: true });
		}
	};

	/** The set-key page: the provider's name, its key field, and the save that
	 *  rewrites the active profile (the backend restarts the chat on the saved key). */
	const buildSetKeyPage = (profile: ProviderProfile): HTMLElement => {
		const key = el('input', 'input') as HTMLInputElement;
		key.type = 'password';
		key.spellcheck = false;
		key.autocomplete = 'off';
		key.placeholder = t('providers.apiKey.placeholder');
		const save = el('button', 'button primary', [t('providers.gate.save')]);
		save.type = 'button';
		const manage = el('button', 'button secondary', [t('providers.manage')]);
		manage.type = 'button';
		manage.addEventListener('click', () => void commands.execute('ai.providers'));

		const submit = (): void => {
			const typed = key.value.trim();
			if (typed === '' || save.disabled) return;
			save.disabled = true;
			save.textContent = `${t('providers.gate.saving')}…`;
			void (async () => {
				const list = await saveProvider({
					id: profile.id,
					preset: profile.preset,
					label: profile.label,
					baseUrl: profile.baseUrl ?? '',
					model: profile.model ?? '',
					smallModel: profile.smallModel ?? '',
					apiKey: typed
				});
				// A failed save already toasted; the gate stays for a retry. A good one
				// announces the store — the gate re-renders into the usage strip itself.
				if (list !== null) notify('info', tf('providers.gate.saved', profile.label));
			})();
		};
		save.addEventListener('click', submit);
		key.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') submit();
		});

		return el('div', 'provider-gate', [
			el('div', 'provider-gate-card', [
				el('div', 'gate-head', [icon('key'), el('span', 'title', [tf('providers.gate.title', profile.label)])]),
				el('div', 'gate-body', [tf('providers.gate.body', profile.label)]),
				key,
				el('div', 'gate-actions', [save, manage])
			])
		]);
	};

	if (cachedProviders() !== null) apply(cachedProviders());
	else void loadProviders().then(apply);
	const onChange = (): void => apply(cachedProviders());
	document.addEventListener(PROVIDERS_CHANGED_EVENT, onChange);
	// A switch in another window: the backend pushed, re-read and follow it.
	let unlisten: (() => void) | null = null;
	void listen('providers-changed', () => void loadProviders(true).then(apply))
		.then((off) => {
			unlisten = off;
		})
		.catch(() => undefined);
	return () => {
		document.removeEventListener(PROVIDERS_CHANGED_EVENT, onChange);
		unlisten?.();
		clear();
	};
}
