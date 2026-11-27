// The CAN log statistics & telemetry workbench (`.blf` / `.asc`): redesigned for fast,
// human-first CAN bus triage. The backend walks the trace asynchronously (`can_log_stats`)
// while the view paints immediately with live progress, then delivers:
//   - Instant Bus Health badge (Healthy / High Load / Errors) in the command bar
//   - One-click quick-filter chips (CAN FD, Classic, Extended, Periodic, Clear)
//   - Per-channel live arbitration/data bitrate selectors with inline visual load meters
//   - Top-pinned Periodic & Frame-Loss Analysis card on ID click or ↑/↓ keyboard navigation
//   - Smart partial re-rendering (ID/chip filters update only the table, never rebuilding SVGs)
//   - One-click Export CSV of the filtered identifier statistics table
//   - Full desktop resizable sash layout + compact phone/narrow layout (`canLayout.ts`)

import { Channel } from '../../platform/ipc/core';
import type { CanChannelStats, CanIdStats, CanIntervals, CanLogStats, CanProgress, LoadBucket } from '../../platform/ipc/can';
export type { CanChannelStats, CanIdStats, CanFrameFilter, CanIntervals, CanLogCount, CanLogStats, CanProgress, ChannelLoadProfile, ChannelPayloadDist, CycleBin, IntervalPoint, LoadBucket } from '../../platform/ipc/can';
import { canIntervals, canLogStats, convertCanLog as convertCanLogCmd } from '../../platform/ipc/can';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { cycleSeriesChart, formatAxisSeconds, histogramChart, multiLineChart, seriesStyle, stackedBars, CAN_CHART_VBW_COMPACT, type ChartSeries } from './canChart';
import { CanActionSheet, CanLayout, type CanSheetItem } from './canLayout';
import { t, tf } from '../../platform/i18n';
import { load as loadState, save as saveState } from '../../platform/state';
import { basename, el, formatBytes, icon, notify, quickPick } from '../../platform/ui/index';

/** The arbitration bitrates a CAN (FD) bus commonly runs at; the load is recomputed on any change. */
export const CAN_BITRATES = [1_000_000, 800_000, 500_000, 250_000, 125_000, 100_000, 50_000, 33_333, 20_000, 10_000, 5_000] as const;
export const DEFAULT_CAN_BITRATE = 500_000;
/** The data-phase bitrates a CAN FD bus switches to after BRS; classic traffic ignores them. */
export const CAN_DATA_BITRATES = [8_000_000, 5_000_000, 4_000_000, 2_000_000, 1_000_000] as const;
export const DEFAULT_FD_DATA_BITRATE = 2_000_000;

/** The payload-length labels, in the backend's bin order: classic 0..8 then the FD
 *  lengths 12..64 — the x axis of the distribution chart. */
export const PAYLOAD_LABELS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '12', '16', '20', '24', '32', '48', '64'] as const;

/** What a progress report reads as on the status line: percent through the file and how
 *  many frames have been handed over so far. */
export function progressText(progress: CanProgress, verb: string): string {
	const percent = progress.totalBytes > 0 ? Math.min(100, (progress.bytes / progress.totalBytes) * 100) : 0;
	return `${verb}… ${percent.toFixed(0)}%  ·  ${progress.frames.toLocaleString()} frames`;
}

/** A channel wired to a status-line writer, passed to the backend as `onProgress`. */
function progressChannel(verb: string, report: (text: string, progress: CanProgress) => void): Channel<CanProgress> {
	const channel = new Channel<CanProgress>();
	channel.onmessage = (progress) => report(progressText(progress, verb), progress);
	return channel;
}

/** The share of the measurement time the bus was busy, CANoe's arithmetic: each phase's
 *  bits at its own bitrate — the arbitration phase at the arbitration rate, the data
 *  phase (a CAN FD frame after the BRS switch) at the data rate — the busy seconds
 *  divided by the window. */
export function busLoad(arbBits: number, dataBits: number, durationS: number, arbRate: number, dataRate: number): number {
	if (durationS <= 0 || arbRate <= 0) return 0;
	const busyS = arbBits / arbRate + (dataRate > 0 ? dataBits / dataRate : 0);
	return (busyS / durationS) * 100;
}

/** `0x123` (or an 8-digit extended `0x18FF1234`), the way CANoe shows an identifier. */
export function idHex(id: number, extended: boolean): string {
	return '0x' + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0');
}

/** A cycle time in CANoe's units: milliseconds with µs resolution, `—` when unknown. */
export function formatCycle(seconds: number): string {
	if (!seconds) return '—';
	return `${(seconds * 1000).toFixed(seconds * 1000 < 10 ? 3 : 1)} ms`;
}

/** Parse the filter bar's identifier list into inclusive ranges: hex ids or `from-to`
 *  ranges, comma or space separated (`0x100, 1A0-1FF 300`). Returns null when the box is
 *  empty (or nothing in it parses). */
export function idFilterRanges(text: string): [number, number][] | null {
	const terms = text.split(/[\s,;]+/).filter(Boolean);
	if (!terms.length) return null;
	const ranges: [number, number][] = [];
	for (const term of terms) {
		const range = /^(\w+)-(\w+)$/.exec(term);
		const parseHex = (s: string) => parseInt(s.replace(/^0x/i, ''), 16);
		if (range) {
			const from = parseHex(range[1]);
			const to = parseHex(range[2]);
			if (!Number.isNaN(from) && !Number.isNaN(to)) ranges.push([Math.min(from, to), Math.max(from, to)]);
		} else {
			const id = parseHex(term);
			if (!Number.isNaN(id)) ranges.push([id, id]);
		}
	}
	return ranges.length ? ranges : null;
}

/** The same list as a predicate, for the views that filter client-side. */
export function parseIdFilter(text: string): ((id: number) => boolean) | null {
	const ranges = idFilterRanges(text);
	if (!ranges) return null;
	return (id) => ranges.some(([from, to]) => id >= from && id <= to);
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(3)} s`;
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	if (m < 60) return `${m}m ${s.toFixed(1)}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m ${Math.floor(s)}s`;
}

function formatStart(seconds: number): string {
	return new Date(seconds * 1000).toLocaleString();
}

function loadSeverity(pct: number): 'ok' | 'warn' | 'high' {
	if (pct >= 70) return 'high';
	if (pct >= 40) return 'warn';
	return 'ok';
}

/* ---------- The dashboard's resizable panes ---------- */

interface CanStatsLayout {
	/** The left column's share of the dashboard's width. */
	left: number;
	/** The dashboard's share of the body's height over the messages table. */
	top: number;
}

const DEFAULT_CAN_STATS_LAYOUT: CanStatsLayout = { left: 34, top: 62 };
const CAN_STATS_LAYOUT_KEY = 'canStats.layout';

function paneSash(axis: 'vertical' | 'horizontal', onMove: (sash: HTMLElement, delta: number) => void, onEnd?: () => void, onReset?: () => void): HTMLElement {
	const sash = el('div', `can-sash ${axis}`);
	sash.title = t('can.sash.title');
	sash.addEventListener('dblclick', () => onReset?.());
	sash.addEventListener('mousedown', (event) => {
		event.preventDefault();
		const origin = axis === 'vertical' ? event.clientX : event.clientY;
		let latest = origin;
		let applied = 0;
		let pending = 0;
		sash.classList.add('active');
		document.body.classList.add('resizing');
		const raf = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => window.setTimeout(callback, 16) as unknown as number);
		const apply = (): void => {
			pending = 0;
			onMove(sash, latest - origin - applied);
			applied = latest - origin;
		};
		const move = (e: MouseEvent): void => {
			latest = axis === 'vertical' ? e.clientX : e.clientY;
			if (pending) return;
			pending = raf(apply);
		};
		const up = () => {
			if (pending) {
				window.cancelAnimationFrame?.(pending);
				apply();
			}
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
			sash.classList.remove('active');
			document.body.classList.remove('resizing');
			onEnd?.();
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	});
	return sash;
}

/** The message-table sort keys (the sortable columns of the identifier table). */
type SortKey = 'count' | 'id' | 'cycle' | 'bytes' | 'jitter';

/** One-click facet filters over the identifier table. */
type MsgFacet = 'all' | 'fd' | 'classic' | 'ext' | 'periodic';

interface FilteredView {
	messages: CanIdStats[];
	channels: CanChannelStats[];
	totalFrames: number;
	errorFrames: number;
	payloadBytes: number;
	durationS: number;
}

export class CanLogView {
	readonly root: HTMLElement;
	private readonly paneLeft: HTMLElement;
	private readonly paneRight: HTMLElement;
	private readonly paneTop: HTMLElement;
	private readonly paneMessages: HTMLElement;
	private readonly liveDot: HTMLElement;
	private readonly liveText: HTMLElement;
	private readonly live: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly progress: HTMLElement;
	private readonly summaryLine: HTMLElement;
	private readonly healthBadge: HTMLElement;
	private readonly overviewBody: HTMLElement;
	private readonly channelsBody: HTMLElement;
	private readonly loadBody: HTMLElement;
	private readonly rateBody: HTMLElement;
	private readonly payloadBody: HTMLElement;
	private readonly analysisHost: HTMLElement;
	private readonly messagesBody: HTMLElement;
	private readonly messagesCountBadge: HTMLElement;
	private readonly filterBox: HTMLInputElement;
	private readonly channelSelect: HTMLSelectElement;
	private readonly convertButton: HTMLButtonElement;
	private readonly exportCsvButton: HTMLButtonElement;
	private readonly clearFilterButton: HTMLButtonElement;
	private readonly facetButtons = new Map<MsgFacet, HTMLButtonElement>();
	private stats: CanLogStats | null = null;
	private readonly channelRates = new Map<number, { arb: number; data: number }>();
	private sortKey: SortKey = 'count';
	private sortAsc = false;
	private facet: MsgFacet = 'all';
	private layout: CanStatsLayout = { ...DEFAULT_CAN_STATS_LAYOUT };
	private selected: { channel: number; id: number; extended: boolean } | null = null;
	private intervals: CanIntervals | null = null;
	private lastSortedMessages: CanIdStats[] = [];
	readonly form: CanLayout;
	private readonly sheet: CanActionSheet;

	constructor(private path: string) {
		this.filterBox = el('input', 'hex-search can-filter') as HTMLInputElement;
		this.filterBox.type = 'search';
		this.filterBox.placeholder = t('can.filter.placeholder');
		this.filterBox.spellcheck = false;
		// Typing an ID filter only narrows the Messages table & summary counts — never
		// rebuilds the three SVG bus charts on every keystroke.
		this.filterBox.addEventListener('input', () => this.onFilterChanged());

		this.channelSelect = el('select', 'can-channel') as HTMLSelectElement;
		this.channelSelect.title = t('can.channel');
		this.channelSelect.setAttribute('aria-label', t('can.channel'));
		this.channelSelect.addEventListener('change', () => {
			this.syncFilterChips();
			this.render();
		});

		this.healthBadge = el('span', 'can-health-pill can-health-idle');
		this.healthBadge.hidden = true;

		this.exportCsvButton = el('button', 'button secondary can-export-csv', [icon('export'), el('span', 'can-btn-label', [' CSV'])]) as HTMLButtonElement;
		this.exportCsvButton.title = 'Copy filtered CAN ID statistics table as CSV';
		this.exportCsvButton.disabled = true;
		this.exportCsvButton.addEventListener('click', () => void this.copyCsv());

		this.convertButton = el('button', 'button secondary can-convert', [icon('save-as'), el('span', 'can-btn-label', [` ${t('can.convert')}`])]) as HTMLButtonElement;
		this.convertButton.title = t('can.convert.title');
		this.convertButton.addEventListener('click', () => void this.convert());

		// One-click facet chips for rapid human triage (FD / Classic / Extended / Periodic).
		const makeFacetChip = (key: MsgFacet, label: string, title: string): HTMLButtonElement => {
			const chip = el('button', 'can-chip', [label]) as HTMLButtonElement;
			chip.type = 'button';
			chip.title = title;
			chip.addEventListener('click', () => {
				this.facet = this.facet === key ? 'all' : key;
				this.onFilterChanged();
			});
			this.facetButtons.set(key, chip);
			return chip;
		};
		this.clearFilterButton = el('button', 'can-chip can-chip-clear', [icon('clear-all')]) as HTMLButtonElement;
		this.clearFilterButton.type = 'button';
		this.clearFilterButton.title = 'Clear all filters';
		this.clearFilterButton.disabled = true;
		this.clearFilterButton.addEventListener('click', () => this.clearFilters());

		const quickFilters = el('div', 'can-quick can-stats-quick', [
			makeFacetChip('fd', 'FD', 'Show only CAN FD identifiers'),
			makeFacetChip('classic', 'Classic', 'Show only Classic CAN identifiers'),
			makeFacetChip('ext', 'Ext', 'Show only 29-bit extended identifiers'),
			makeFacetChip('periodic', 'Periodic', 'Show only periodic identifiers'),
			this.clearFilterButton
		]);

		const toolbar = el('div', 'hex-toolbar can-toolbar', [
			el('div', 'can-bar can-bar-main', [
				el('span', 'can-toolbar-title', [icon('pulse'), ` ${t('can.stats.title')} — ${basename(path)}`]),
				this.healthBadge,
				this.exportCsvButton,
				this.convertButton
			]),
			el('div', 'can-bar can-bar-filters', [
				this.filterBox,
				this.channelSelect,
				quickFilters
			])
		]);

		this.overviewBody = el('div', 'can-section-body');
		this.channelsBody = el('div', 'can-section-body can-section-flush');
		this.loadBody = el('div', 'can-section-body');
		this.rateBody = el('div', 'can-section-body');
		this.payloadBody = el('div', 'can-section-body');
		this.analysisHost = el('div', 'can-analysis-host');
		this.messagesBody = el('div', 'can-section-body can-section-flush');
		this.messagesCountBadge = el('span', 'can-section-badge');

		this.paneLeft = el('div', 'can-pane can-pane-left', [
			this.section('can-section-overview', 'pulse', t('can.section.overview'), this.overviewBody),
			this.section('can-section-channels', 'stack', t('can.section.channels'), this.channelsBody)
		]);
		// Place analysisHost at the TOP of the right pane so clicking any identifier shows
		// its cycle/jitter/frame-loss breakdown immediately without scrolling past 3 charts.
		this.paneRight = el('div', 'can-pane can-pane-right', [
			this.analysisHost,
			this.section('can-section-load', 'graph', t('can.section.load'), this.loadBody),
			this.section('can-section-rate', 'watch', t('can.section.rate'), this.rateBody),
			this.section('can-section-payload', 'layers', t('can.section.payload'), this.payloadBody)
		]);

		const sortButton = el('button', 'button secondary can-sort-menu', [icon('sort-precedence')]) as HTMLButtonElement;
		sortButton.title = t('can.sort.title');
		sortButton.setAttribute('aria-label', t('can.sort.title'));
		sortButton.addEventListener('click', () => this.openSortSheet());

		const messagesSection = this.section('can-section-messages', 'table', t('can.section.messages'), this.messagesBody, el('span', 'can-section-actions', [this.messagesCountBadge, sortButton]));
		this.paneMessages = el('div', 'can-pane can-pane-messages', [messagesSection]);
		this.paneMessages.tabIndex = 0;
		this.paneMessages.addEventListener('keydown', (event) => this.onMessagesKeyDown(event));

		this.paneTop = el('div', 'can-dash-top', [
			this.paneLeft,
			paneSash('vertical', (sash, delta) => this.dragLeft(sash, delta), () => this.saveLayout(), () => this.resetLayout()),
			this.paneRight
		]);
		const hSash = paneSash('horizontal', (sash, delta) => this.dragTop(sash, delta), () => this.saveLayout(), () => this.resetLayout());
		const body = el('div', 'can-body', [this.paneTop, hSash, this.paneMessages]);

		this.liveDot = el('span', 'can-live-dot');
		this.liveText = el('span', 'can-live-text', [t('can.live.opening')]);
		this.live = el('span', 'can-live can-live-parsing', [this.liveDot, this.liveText]);
		this.summaryLine = el('span', 'can-summary-line');
		const status = el('div', 'hex-status can-status', [this.live, this.summaryLine]);
		this.progressFill = el('i');
		this.progress = el('div', 'can-progress', [this.progressFill]);

		this.root = el('div', 'can-view can-log-view', [toolbar, body, this.progress, status]);
		this.sheet = new CanActionSheet(this.root);
		this.form = new CanLayout(this.root);
		this.form.onChange(() => {
			this.sheet.close();
			if (this.stats) this.render();
		});
		this.layout = loadState<CanStatsLayout>(CAN_STATS_LAYOUT_KEY, { ...DEFAULT_CAN_STATS_LAYOUT });
		this.applyLayout();
		for (const paneBody of [this.overviewBody, this.channelsBody, this.loadBody, this.rateBody, this.payloadBody, this.messagesBody]) {
			paneBody.append(el('div', 'can-loading', [t('can.parsing')]));
		}
		void this.load();
	}

	private section(cls: string, iconName: string, title: string, body: HTMLElement, extra?: HTMLElement): HTMLElement {
		const head = el('div', 'can-section-head', [icon(iconName), el('span', 'can-section-title', [title]), ...(extra ? [extra] : [])]);
		return el('div', `can-section ${cls}`, [head, body]);
	}

	private syncFilterChips(): void {
		for (const [key, chip] of this.facetButtons) {
			const on = this.facet === key;
			chip.classList.toggle('can-chip-on', on);
			chip.setAttribute('aria-pressed', String(on));
		}
		const hasFilter = this.filterBox.value.trim() !== '' || (Number(this.channelSelect.value) || 0) !== 0 || this.facet !== 'all';
		this.clearFilterButton.disabled = !hasFilter;
	}

	private clearFilters(): void {
		this.filterBox.value = '';
		this.facet = 'all';
		const channelChanged = this.channelSelect.value !== '0' && this.channelSelect.options.length > 0;
		if (channelChanged) this.channelSelect.value = '0';
		this.syncFilterChips();
		if (channelChanged) this.render();
		else this.onFilterChanged();
	}

	/** Fast partial update when only the ID box or quick facet chip changes: skips
	 *  rebuilding the channels table and all 3 SVG bus charts. */
	private onFilterChanged(): void {
		this.syncFilterChips();
		const stats = this.stats;
		if (!stats || (!stats.totalFrames && !stats.errorFrames)) return;
		const view = this.filtered()!;
		this.renderOverview(stats, view);
		this.renderMessages(view);
		this.renderSummaryLine(stats, view);
		// The health badge reads the same filtered view the summary line does, so a
		// filter change cannot leave the badge contradicting the numbers beside it.
		this.renderHealthBadge(view);
	}

	/** Keyboard navigation over the identifier table: ↑/↓ moves selection & opens cycle
	 *  analysis, Escape closes the analysis panel. */
	private onMessagesKeyDown(event: KeyboardEvent): void {
		if (!this.lastSortedMessages.length) return;
		if (event.key === 'Escape' && this.selected) {
			event.preventDefault();
			this.clearSelection();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const cur = this.selected
			? this.lastSortedMessages.findIndex((m) => m.channel === this.selected!.channel && m.id === this.selected!.id && m.extended === this.selected!.extended)
			: -1;
		const delta = event.key === 'ArrowDown' ? 1 : -1;
		const nextIdx = cur === -1 ? (delta > 0 ? 0 : this.lastSortedMessages.length - 1) : Math.max(0, Math.min(this.lastSortedMessages.length - 1, cur + delta));
		const target = this.lastSortedMessages[nextIdx];
		if (target) {
			void this.openAnalysis(target);
			const rowEl = this.messagesBody.querySelectorAll<HTMLElement>('.can-msg-row')[nextIdx];
			rowEl?.scrollIntoView({ block: 'nearest' });
		}
	}

	private clearSelection(): void {
		this.selected = null;
		this.intervals = null;
		this.renderAnalysis();
		this.messagesBody.querySelectorAll('.can-msg-row.can-selected').forEach((r) => r.classList.remove('can-selected'));
	}

	private openSortSheet(): void {
		const labels: Record<SortKey, string> = {
			count: t('can.msg.count'),
			id: t('can.msg.id'),
			bytes: t('can.msg.bytes'),
			cycle: t('can.msg.cycle'),
			jitter: t('can.msg.jitter')
		};
		const items: CanSheetItem[] = (Object.keys(labels) as SortKey[]).map((key) => ({
			action: () => {
				this.sortKey = key;
				this.sortAsc = false;
				if (this.stats) this.renderMessages(this.filtered()!);
			},
			label: labels[key],
			iconName: key === 'count' ? 'pulse' : key === 'id' ? 'symbol-numeric' : key === 'bytes' ? 'layers' : 'watch',
			checked: this.sortKey === key
		}));
		items.push({ divider: true }, {
			action: () => {
				this.sortAsc = !this.sortAsc;
				if (this.stats) this.renderMessages(this.filtered()!);
			},
			label: this.sortAsc ? t('can.sort.asc') : t('can.sort.desc'),
			iconName: this.sortAsc ? 'arrow-up' : 'arrow-down'
		});
		this.sheet.open(t('can.sort.title'), items);
	}

	/* ---------- The panes' shares ---------- */

	private applyLayout(): void {
		this.paneLeft.style.flexGrow = String(this.layout.left);
		this.paneRight.style.flexGrow = String(100 - this.layout.left);
		this.paneTop.style.flexGrow = String(this.layout.top);
		this.paneMessages.style.flexGrow = String(100 - this.layout.top);
	}

	private saveLayout(): void {
		saveState(CAN_STATS_LAYOUT_KEY, this.layout);
	}

	private dragLeft(sash: HTMLElement, delta: number): void {
		const span = Math.max(1, sash.parentElement?.getBoundingClientRect().width ?? 0);
		this.layout.left = Math.max(18, Math.min(82, this.layout.left + (delta / span) * 100));
		this.applyLayout();
	}

	private dragTop(sash: HTMLElement, delta: number): void {
		const span = Math.max(1, sash.parentElement?.getBoundingClientRect().height ?? 0);
		this.layout.top = Math.max(20, Math.min(85, this.layout.top + (delta / span) * 100));
		this.applyLayout();
	}

	private resetLayout(): void {
		this.layout = { ...DEFAULT_CAN_STATS_LAYOUT };
		this.applyLayout();
		this.saveLayout();
	}

	/* ---------- The backend walk ---------- */

	private async load(): Promise<void> {
		try {
			this.stats = await canLogStats(this.path, progressChannel(t('can.status.parsing'), (text, progress) => {
				this.liveText.textContent = text;
				const percent = progress.totalBytes > 0 ? Math.min(100, (progress.bytes / progress.totalBytes) * 100) : 0;
				this.progressFill.style.width = `${percent.toFixed(1)}%`;
			}));
			this.render();
		} catch (error) {
			this.live.classList.remove('can-live-parsing');
			this.liveDot.classList.add('can-live-dot-failed');
			this.progress.classList.add('can-progress-done');
			this.liveText.textContent = t('can.parseFailed');
			for (const paneBody of [this.overviewBody, this.channelsBody, this.loadBody, this.rateBody, this.payloadBody, this.messagesBody]) {
				paneBody.replaceChildren(el('div', 'can-error', [`${t('can.parseError')} '${basename(this.path)}': ${String(error)}`]));
			}
		}
	}

	private filtered(): FilteredView | null {
		const stats = this.stats;
		if (!stats) return null;
		const idOk = parseIdFilter(this.filterBox.value);
		const channel = Number(this.channelSelect.value) || 0;
		const messages = stats.messages.filter((m) => {
			if (channel && m.channel !== channel) return false;
			if (idOk && !idOk(m.id)) return false;
			if (this.facet === 'fd' && !m.fd) return false;
			if (this.facet === 'classic' && m.fd) return false;
			if (this.facet === 'ext' && !m.extended) return false;
			if (this.facet === 'periodic' && !(m.avgCycleS > 0)) return false;
			return true;
		});
		const channels = stats.channels.filter((c) => !channel || c.channel === channel);
		const totalFrames = channels.reduce((a, c) => a + c.frames, 0);
		const errorFrames = channels.reduce((a, c) => a + c.errorFrames, 0);
		const payloadBytes = channels.reduce((a, c) => a + c.payloadBytes, 0);
		const durationS = channels.length ? Math.max(...channels.map((c) => c.lastS - c.firstS)) : 0;
		return { messages, channels, totalFrames, errorFrames, payloadBytes, durationS };
	}

	private render(): void {
		const stats = this.stats;
		if (!stats) return;
		if (!stats.totalFrames && !stats.errorFrames) {
			this.doneLive();
			this.exportCsvButton.disabled = true;
			this.healthBadge.hidden = true;
			for (const paneBody of [this.overviewBody, this.channelsBody, this.loadBody, this.rateBody, this.payloadBody, this.messagesBody]) {
				paneBody.replaceChildren(el('div', 'can-error', [t('can.noFrames')]));
			}
			this.summaryLine.textContent = t('can.noFrames');
			return;
		}
		if (this.channelSelect.options.length === 0) {
			const all = el('option', undefined, [t('can.channel.all')]) as HTMLOptionElement;
			all.value = '0';
			this.channelSelect.append(all);
			for (const c of stats.channels) {
				const option = el('option', undefined, [`${t('can.channel')} ${c.channel}`]) as HTMLOptionElement;
				option.value = String(c.channel);
				this.channelSelect.append(option);
			}
			this.channelSelect.value = '0';
		}
		const view = this.filtered()!;
		this.exportCsvButton.disabled = false;
		this.doneLive();
		this.renderHealthBadge(view);
		this.renderOverview(stats, view);
		this.renderChannels(view);
		this.renderCharts(view);
		this.renderMessages(view);
		this.renderAnalysis();
		this.renderSummaryLine(stats, view);
	}

	private renderHealthBadge(view: FilteredView): void {
		let maxLoad = 0;
		for (const c of view.channels) {
			const rates = this.ratesOf(c.channel);
			const dur = Math.max(0, c.lastS - c.firstS);
			maxLoad = Math.max(maxLoad, busLoad(c.arbBits, c.dataBits, dur, rates.arb, rates.data));
		}
		this.healthBadge.hidden = false;
		this.healthBadge.className = 'can-health-pill';
		if (view.errorFrames > 0) {
			this.healthBadge.classList.add('can-health-err');
			this.healthBadge.textContent = `${view.errorFrames.toLocaleString()} ERR`;
			this.healthBadge.title = 'Error frames detected on the bus';
		} else if (maxLoad >= 70) {
			this.healthBadge.classList.add('can-health-warn');
			this.healthBadge.textContent = `Load ${maxLoad.toFixed(1)}%`;
			this.healthBadge.title = 'High bus load (>= 70%)';
		} else {
			this.healthBadge.classList.add('can-health-ok');
			this.healthBadge.textContent = `OK · ${maxLoad.toFixed(1)}%`;
			this.healthBadge.title = 'Bus load healthy, zero error frames';
		}
	}

	private renderSummaryLine(stats: CanLogStats, view: FilteredView): void {
		const notes: string[] = [];
		if (stats.messagesTruncated) notes.push(tf('can.status.topShown', stats.messages.length.toLocaleString(), (stats.messages.length + stats.messagesTruncated).toLocaleString()));
		if (view.messages.length < stats.messages.length) notes.push(tf('can.status.filteredFrom', stats.messages.length.toLocaleString()));
		if (stats.skippedObjects) notes.push(tf('can.status.skipped', stats.skippedObjects.toLocaleString()));
		this.summaryLine.textContent = [
			stats.format,
			`${view.totalFrames.toLocaleString()} ${t('can.status.frames')}`,
			`${view.errorFrames.toLocaleString()} ${t('can.status.errorFrames')}`,
			`${view.channels.length} ${view.channels.length === 1 ? t('can.status.channelOne') : t('can.status.channels')}`,
			...notes.map((note) => `(${note})`)
		].join('  ·  ');
	}

	private doneLive(): void {
		this.live.classList.remove('can-live-parsing');
		this.progress.classList.add('can-progress-done');
		this.liveText.textContent = `${this.stats!.totalFrames.toLocaleString()} ${t('can.status.frames')}`;
	}

	private renderOverview(stats: CanLogStats, view: FilteredView): void {
		const cell = (label: string, value: string, warn = false) =>
			el('div', 'can-summary-cell', [
				el('div', 'can-summary-label', [label]),
				el('div', `can-summary-value${warn ? ' can-warn' : ''}`, [value])
			]);
		this.overviewBody.replaceChildren(el('div', 'can-summary', [
			cell(t('can.overview.format'), stats.format),
			cell(t('can.overview.start'), stats.startTimestampS ? formatStart(stats.startTimestampS) : '—'),
			cell(t('can.overview.duration'), formatDuration(view.durationS)),
			cell(t('can.overview.frames'), view.totalFrames.toLocaleString()),
			cell(t('can.overview.errors'), view.errorFrames.toLocaleString(), view.errorFrames > 0),
			cell(t('can.overview.payload'), formatBytes(view.payloadBytes, { gb: true })),
			cell(t('can.overview.ids'), view.messages.length.toLocaleString()),
			cell(t('can.overview.rate'), view.durationS > 0 ? `${(view.totalFrames / view.durationS).toFixed(1)} fr/s` : '—')
		]));
	}

	private renderChannels(view: FilteredView): void {
		const profiles = new Map((this.stats?.loadProfiles ?? []).map((p) => [p.channel, p]));
		const head = el('div', 'can-table-head can-ch-grid', [t('can.ch.channel'), t('can.ch.frames'), t('can.ch.errors'), t('can.ch.payload'), t('can.ch.duration'), t('can.ch.rate'), t('can.ch.rates'), t('can.ch.load'), t('can.ch.peak')].map((label, i) => el('span', i === 0 ? 'can-left' : 'can-num', [label])));
		const rows = view.channels.map((c, idx) => {
			const rates = this.ratesOf(c.channel);
			const duration = Math.max(0, c.lastS - c.firstS);
			const load = busLoad(c.arbBits, c.dataBits, duration, rates.arb, rates.data);
			const buckets = profiles.get(c.channel)?.buckets ?? [];
			const peak = Math.max(0, ...buckets.map((b) => busLoad(b.arbBits, b.dataBits, b.durS, rates.arb, rates.data)));
			const sev = loadSeverity(load);
			const peakSev = loadSeverity(peak);
			const loadCell = el('span', `can-num can-load can-load-${sev}`, [load.toFixed(2) + ' %']);
			loadCell.style.setProperty('--can-load-pct', `${Math.min(100, load).toFixed(1)}%`);
			const peakCell = el('span', `can-num can-load can-load-${peakSev}`, [buckets.length ? peak.toFixed(2) + ' %' : '—']);
			const chLabel = el('span', 'can-left can-ch-name', [
				el('span', `can-swatch ${seriesStyle(idx)}`),
				`${t('can.channel')} ${c.channel}`
			]);
			const cells = [
				chLabel,
				el('span', 'can-ch-meta', [
					el('span', 'can-num', [c.frames.toLocaleString()]),
					el('span', `can-num${c.errorFrames ? ' can-warn' : ''}`, [c.errorFrames.toLocaleString()]),
					el('span', 'can-num', [formatBytes(c.payloadBytes, { gb: true })]),
					el('span', 'can-num', [duration.toFixed(3) + ' s']),
					el('span', 'can-num', [duration > 0 ? (c.frames / duration).toFixed(1) + ' fr/s' : '—'])
				]),
				el('span', 'can-rates', [
					this.rateSelect(c.channel, 'arb', CAN_BITRATES, rates.arb, t('can.rate.arb.title')),
					this.rateSelect(c.channel, 'data', CAN_DATA_BITRATES, rates.data, t('can.rate.data.title'))
				]),
				loadCell,
				peakCell
			];
			const row = el('div', 'can-table-row can-ch-grid can-mono', cells);
			row.title = tf('can.load.bitsTitle', ((c.arbBits + c.dataBits) / 1e6).toFixed(2));
			return row;
		});
		this.channelsBody.replaceChildren(el('div', 'can-channels can-table', [head, ...rows]));
	}

	private ratesOf(channel: number): { arb: number; data: number } {
		return this.channelRates.get(channel) ?? { arb: DEFAULT_CAN_BITRATE, data: DEFAULT_FD_DATA_BITRATE };
	}

	private rateSelect(channel: number, key: 'arb' | 'data', rates: readonly number[], value: number, title: string): HTMLSelectElement {
		const select = el('select', `can-rate can-rate-${key}`) as HTMLSelectElement;
		select.title = title;
		select.setAttribute('aria-label', title);
		for (const rate of rates) {
			const option = el('option', undefined, [rate >= 1_000_000 ? `${rate / 1_000_000} Mbit/s` : `${rate / 1000} kbit/s`]) as HTMLOptionElement;
			option.value = String(rate);
			if (rate === value) option.selected = true;
			select.append(option);
		}
		select.addEventListener('change', () => {
			const current = this.ratesOf(channel);
			this.channelRates.set(channel, { ...current, [key]: Number(select.value) });
			if (this.stats) this.render();
		});
		return select;
	}

	private renderCharts(view: FilteredView): void {
		const profiles = new Map((this.stats?.loadProfiles ?? []).map((p) => [p.channel, p]));
		const dists = new Map((this.stats?.payloadDist ?? []).map((d) => [d.channel, d]));
		const vbw = this.form.isCompact ? CAN_CHART_VBW_COMPACT : undefined;
		const seriesOf = (y: (b: LoadBucket, rates: { arb: number; data: number }) => number): ChartSeries[] => view.channels.map((c, i) => ({
			name: `${t('can.channel')} ${c.channel}`,
			cls: seriesStyle(i),
			points: (profiles.get(c.channel)?.buckets ?? []).map((b) => ({ x: b.tS, xEnd: b.tS + b.durS, y: y(b, this.ratesOf(c.channel)) }))
		}));
		this.loadBody.replaceChildren(
			multiLineChart(seriesOf((b, r) => busLoad(b.arbBits, b.dataBits, b.durS, r.arb, r.data)), { xUnit: 's', yUnit: '%', height: 200, fmtX: formatAxisSeconds, vbw })
		);
		this.rateBody.replaceChildren(
			multiLineChart(seriesOf((b) => (b.durS > 0 ? b.frames / b.durS : 0)), { xUnit: 's', yUnit: 'fr/s', height: 160, fmtX: formatAxisSeconds, vbw })
		);
		const payloadSeries: ChartSeries[] = view.channels.map((c, i) => ({
			name: `${t('can.channel')} ${c.channel}`,
			cls: seriesStyle(i),
			points: PAYLOAD_LABELS.map((_, bin) => ({ x: 0, y: dists.get(c.channel)?.counts[bin] ?? 0 }))
		}));
		this.payloadBody.replaceChildren(stackedBars([...PAYLOAD_LABELS], payloadSeries, { height: 170, vbw }));
	}

	private sortButton(key: SortKey, label: string): HTMLButtonElement {
		const button = el('button', `button secondary can-sort${this.sortKey === key ? ' can-sorted' : ''}`,
			[(this.sortKey === key ? (this.sortAsc ? '↑ ' : '↓ ') : '') + label]) as HTMLButtonElement;
		button.addEventListener('click', () => {
			if (this.sortKey === key) this.sortAsc = !this.sortAsc;
			else {
				this.sortKey = key;
				this.sortAsc = false;
			}
			if (this.stats) this.renderMessages(this.filtered()!);
		});
		return button;
	}

	private renderMessages(view: FilteredView): void {
		const messages = [...view.messages].sort((a, b) => {
			let d = 0;
			if (this.sortKey === 'count') d = a.count - b.count;
			else if (this.sortKey === 'id') d = (a.channel - b.channel) || (a.id - b.id);
			else if (this.sortKey === 'cycle') d = (a.avgCycleS || Infinity) - (b.avgCycleS || Infinity) || a.count - b.count;
			else if (this.sortKey === 'jitter') d = (a.stdCycleS || Infinity) - (b.stdCycleS || Infinity) || a.count - b.count;
			else d = a.payloadBytes - b.payloadBytes;
			return this.sortAsc ? d : -d;
		});
		this.lastSortedMessages = messages;
		const totalIds = this.stats?.messages.length ?? messages.length;
		this.messagesCountBadge.textContent = messages.length === totalIds
			? `${messages.length.toLocaleString()}`
			: `${messages.length.toLocaleString()} / ${totalIds.toLocaleString()}`;

		const header = el('div', 'can-table-head can-msg-grid', [
			el('span', 'can-left', [t('can.msg.id')]),
			el('span', 'can-num', [t('can.msg.ch')]),
			el('span', 'can-left', [t('can.msg.type')]),
			this.sortButton('count', t('can.msg.count')),
			el('span', 'can-num', [t('can.msg.txrx')]),
			this.sortButton('bytes', t('can.msg.bytes')),
			this.sortButton('cycle', t('can.msg.cycle')),
			this.sortButton('jitter', t('can.msg.jitter')),
			el('span', 'can-num', [t('can.msg.share')])
		]);

		const table = el('div', 'can-messages can-table', [header]);
		const frag = document.createDocumentFragment();
		for (const m of messages) {
			const share = view.totalFrames ? (m.count / view.totalFrames) * 100 : 0;
			const shareCell = el('span', 'can-num can-share-cell', [share.toFixed(share < 1 ? 2 : 1) + ' %']);
			shareCell.style.setProperty('--can-share-pct', `${Math.min(100, share).toFixed(1)}%`);
			const typeBadge = el('span', `can-left ${m.fd ? 'can-type-fd' : 'can-type-can'}`, [m.fd ? 'CAN FD' : 'CAN']);
			const row = el('div', 'can-table-row can-msg-grid can-mono can-msg-row', [
				el('span', 'can-left', [idHex(m.id, m.extended) + (m.extended ? ' x' : '')]),
				el('span', 'can-msg-meta', [
					el('span', 'can-num', [String(m.channel)]),
					typeBadge,
					el('span', 'can-num', [m.count.toLocaleString()]),
					el('span', 'can-num', [`${m.tx.toLocaleString()} / ${m.rx.toLocaleString()}`]),
					el('span', 'can-num', [formatBytes(m.payloadBytes, { gb: true })]),
					el('span', 'can-num', [`${formatCycle(m.minCycleS)} / ${formatCycle(m.avgCycleS)} / ${formatCycle(m.maxCycleS)}`]),
					el('span', 'can-num', [formatCycle(m.stdCycleS)])
				]),
				shareCell
			]);
			row.title = t('can.msg.clickHint');
			if (this.selected && this.selected.channel === m.channel && this.selected.id === m.id && this.selected.extended === m.extended) {
				row.classList.add('can-selected');
			}
			row.addEventListener('click', () => void this.openAnalysis(m));
			frag.appendChild(row);
		}
		if (!messages.length) {
			frag.appendChild(el('div', 'can-table-row can-empty', [t('can.msg.empty')]));
		}
		table.appendChild(frag);
		this.messagesBody.replaceChildren(table);
	}

	/* ---------- Periodic analysis ---------- */

	private async openAnalysis(m: CanIdStats): Promise<void> {
		this.selected = { channel: m.channel, id: m.id, extended: m.extended };
		this.renderMessages(this.filtered()!);
		if (this.intervals && this.intervals.channel === m.channel && this.intervals.id === m.id && this.intervals.extended === m.extended) {
			this.renderAnalysis();
			this.analysisHost.scrollIntoView({ block: 'nearest' });
			return;
		}
		const loading = el('div', 'can-loading', [`${t('can.analysis.analysing')} ${idHex(m.id, m.extended)}…`]);
		this.analysisHost.replaceChildren(loading);
		this.analysisHost.scrollIntoView({ block: 'nearest' });
		let intervals: CanIntervals;
		try {
			intervals = await canIntervals(this.path, m.channel, m.id, m.extended, progressChannel(t('can.analysis.loading'), (text) => (loading.textContent = text)));
		} catch (error) {
			this.analysisHost.replaceChildren(el('div', 'can-error', [`${t('can.analysis.failed')}: ${String(error)}`]));
			return;
		}
		if (!this.selected || this.selected.channel !== m.channel || this.selected.id !== m.id || this.selected.extended !== m.extended) return;
		this.intervals = intervals;
		this.renderAnalysis();
	}

	private renderAnalysis(): void {
		const intervals = this.intervals;
		if (!intervals) {
			this.analysisHost.replaceChildren();
			return;
		}
		const cell = (label: string, value: string, warn = false) => el('div', 'can-summary-cell', [el('div', 'can-summary-label', [label]), el('div', `can-summary-value${warn ? ' can-warn' : ''}`, [value])]);
		const frameWord = t(intervals.missedFrames === 1 ? 'can.analysis.frame' : 'can.analysis.frames');
		const gapWord = t(intervals.missedGaps === 1 ? 'can.analysis.gap' : 'can.analysis.gaps');
		const copyBtn = el('button', 'button secondary can-analysis-copy', [icon('copy')]) as HTMLButtonElement;
		copyBtn.title = 'Copy cycle analysis summary';
		copyBtn.addEventListener('click', () => {
			const summary = [
				`ID: ${idHex(intervals.id, intervals.extended)} (Ch ${intervals.channel}${intervals.fd ? ', CAN FD' : ''})`,
				`Frames: ${intervals.count}`,
				`Median: ${formatCycle(intervals.medianCycleS)} | Avg: ${formatCycle(intervals.avgCycleS)} | Min/Max: ${formatCycle(intervals.minCycleS)} / ${formatCycle(intervals.maxCycleS)} | Jitter: ${formatCycle(intervals.stdS)}`,
				`Lost: ${intervals.missedFrames} in ${intervals.missedGaps} gaps`
			].join('\n');
			void writeText(summary).then(() => notify('info', `Copied ${idHex(intervals.id, intervals.extended)} analysis`)).catch(() => undefined);
		});
		const head = el('div', 'can-section-head', [
			icon('variable'),
			el('span', 'can-section-title', [`${idHex(intervals.id, intervals.extended)} — ${t('can.section.analysis')}`]),
			el('span', `can-analysis-missed${intervals.missedFrames ? ' can-warn' : ''}`, [intervals.missedFrames
				? tf('can.analysis.lost', intervals.missedFrames.toLocaleString(), frameWord, intervals.missedGaps.toLocaleString(), gapWord)
				: t('can.analysis.noLoss')]),
			el('span', 'hex-toolbar-sep'),
			copyBtn,
			el('button', 'button secondary can-analysis-close', [t('can.analysis.close')])
		]);
		const panel = el('div', 'can-section can-analysis', [
			head,
			el('div', 'can-section-body', [
				el('div', 'can-summary', [
					cell(t('can.overview.frames'), intervals.count.toLocaleString()),
					cell(t('can.analysis.median'), formatCycle(intervals.medianCycleS)),
					cell(t('can.analysis.avg'), formatCycle(intervals.avgCycleS)),
					cell(t('can.analysis.minmax'), `${formatCycle(intervals.minCycleS)} / ${formatCycle(intervals.maxCycleS)}`),
					cell(t('can.analysis.jitter'), formatCycle(intervals.stdS)),
					cell(t('can.analysis.lostShort'), `${intervals.missedFrames.toLocaleString()} (${((intervals.missedFrames / Math.max(1, intervals.count + intervals.missedFrames)) * 100).toFixed(2)} %)`, !!intervals.missedFrames)
				]),
				el('div', 'can-chart-block', [
					el('div', 'can-chart-title', [t('can.chart.cycle')]),
					cycleSeriesChart(intervals.points.map((p) => ({ x: p.tS, y: p.cycleS * 1000, missed: p.missed })), intervals.medianCycleS * 1000, 's', 'ms', this.form.isCompact ? CAN_CHART_VBW_COMPACT : undefined),
				]),
				el('div', 'can-chart-block', [
					el('div', 'can-chart-title', [t('can.chart.histogram')]),
					histogramChart(intervals.histogram.map((b) => ({ fromS: b.fromS * 1000, toS: b.toS * 1000, count: b.count })), intervals.medianCycleS * 1000, 'ms', this.form.isCompact ? CAN_CHART_VBW_COMPACT : undefined)
				])
			])
		]);
		panel.querySelector('.can-analysis-close')!.addEventListener('click', () => this.clearSelection());
		this.analysisHost.replaceChildren(panel);
	}

	/* ---------- Export CSV ---------- */

	private async copyCsv(): Promise<void> {
		const view = this.filtered();
		if (!view || !this.lastSortedMessages.length) return;
		const lines = [
			'ID,Extended,Channel,Type,Count,Tx,Rx,Bytes,MinCycleMs,AvgCycleMs,MaxCycleMs,JitterMs,SharePct',
			...this.lastSortedMessages.map((m) => {
				const share = view.totalFrames ? (m.count / view.totalFrames) * 100 : 0;
				return [
					idHex(m.id, m.extended),
					m.extended ? '1' : '0',
					m.channel,
					m.fd ? 'CAN FD' : 'CAN',
					m.count,
					m.tx,
					m.rx,
					m.payloadBytes,
					(m.minCycleS * 1000).toFixed(3),
					(m.avgCycleS * 1000).toFixed(3),
					(m.maxCycleS * 1000).toFixed(3),
					(m.stdCycleS * 1000).toFixed(3),
					share.toFixed(2)
				].join(',');
			})
		];
		try {
			await writeText(lines.join('\n'));
			notify('info', `Copied ${this.lastSortedMessages.length.toLocaleString()} CAN IDs as CSV`);
		} catch (error) {
			notify('error', String(error));
		}
	}

	/* ---------- Lifecycle ---------- */

	dispose(): void {
		this.form.dispose();
		this.sheet.dispose();
		this.root.remove();
	}

	/* ---------- Conversion (Save As) ---------- */

	private async convert(): Promise<void> {
		this.convertButton.disabled = true;
		try {
			await convertCanLog(this.path, this.stats?.format ?? null, (text) => (this.liveText.textContent = text));
		} finally {
			this.convertButton.disabled = false;
		}
	}
}

/** The Save As conversion, shared by the raw view and the statistics view. */
export async function convertCanLog(path: string, format: 'BLF' | 'ASC' | null, report: (text: string) => void): Promise<void> {
	const detected = format ?? (/\.blf$/i.test(path) ? 'BLF' : 'ASC');
	const other = detected === 'BLF' ? 'ASC' : 'BLF';
	const labelOf = (f: string) => (f === 'blf' ? t('can.convert.blf') : t('can.convert.asc'));
	const choices = [
		{ label: labelOf(other.toLowerCase()), description: t('can.convert.other'), icon: 'file', value: other.toLowerCase() },
		{ label: labelOf(detected.toLowerCase()), description: t('can.convert.same'), icon: 'file', value: detected.toLowerCase() }
	];
	const picked = await quickPick(choices, tf('can.convert.title', basename(path)), t('can.convert.command'));
	if (!picked) return;
	const stem = basename(path).replace(/\.(blf|asc)$/i, '');
	const to = await saveDialog({ defaultPath: `${stem}.${picked}`, filters: [{ name: picked === 'blf' ? t('can.convert.blfFilter') : t('can.convert.ascFilter'), extensions: [picked] }] });
	if (!to) return;
	try {
		const frames = await convertCanLogCmd(path, to, picked as 'blf' | 'asc', progressChannel(t('can.status.converting'), (text) => report(text)));
		report(tf('can.convert.done', frames.toLocaleString(), basename(to)));
	} catch (error) {
		report(`${t('can.convert.failed')}: ${String(error)}`);
	}
}
