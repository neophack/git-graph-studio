// The CAN log statistics view a `.blf` or `.asc` trace opens in - CANoe's Statistics
// window and its graphics window in one dashboard. The backend parses the whole log
// (`can_log_stats`) and this view renders the result asynchronously, so even a
// multi-gigabyte trace only paints once the numbers are in.
//
// The layout is a resizable dashboard: the left column carries the measurement summary
// and the channel table, the right column the bus charts (per-channel load and frame
// rate over time, the payload-length distribution, and the periodic analysis of a clicked
// identifier), and the messages table spans the full width below. Two sashes divide the
// panes - drag to move, double-click to reset - and the shares persist across sessions.
// The status bar is the one live region: a pulsing chip and a progress bar report the
// backend walk while it runs, the summary line lands only when the numbers are in.
//
// The bus load divides the bits the frames put on the wire (stuffing estimate included)
// by the bitrate-time product - the bitrate is a toolbar choice, because neither log
// format records it, and every load figure (table, peak, charts) recomputes live on a
// change. A filter bar narrows the tables and charts to chosen identifiers and channels.

import { invoke, Channel } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';

import { cycleSeriesChart, formatAxisSeconds, histogramChart, multiLineChart, seriesStyle, stackedBars, type ChartSeries } from './canChart';
import { t, tf } from './i18n';
import { load as loadState, save as saveState } from './state';
import { basename, el, icon, quickPick } from './ui';

/** The bitrates a CAN (FD) bus commonly runs at; the load is recomputed on any change. */
export const CAN_BITRATES = [1_000_000, 800_000, 500_000, 250_000, 125_000, 100_000, 50_000, 33_333, 20_000, 10_000, 5_000] as const;
export const DEFAULT_CAN_BITRATE = 500_000;

export interface CanIdStats {
	channel: number;
	id: number;
	extended: boolean;
	fd: boolean;
	count: number;
	tx: number;
	rx: number;
	payloadBytes: number;
	firstS: number;
	lastS: number;
	minCycleS: number;
	maxCycleS: number;
	avgCycleS: number;
	/** The standard deviation of the cycle times — the jitter figure. */
	stdCycleS: number;
}

export interface CanChannelStats {
	channel: number;
	frames: number;
	errorFrames: number;
	payloadBytes: number;
	busBits: number;
	firstS: number;
	lastS: number;
}

/** One time slice of a channel's load timeline — the raw material of the load and
 *  frame-rate charts (the bits cross raw, so the load follows the bitrate choice live). */
export interface LoadBucket {
	tS: number;
	durS: number;
	frames: number;
	errors: number;
	busBits: number;
}

export interface ChannelLoadProfile {
	channel: number;
	buckets: LoadBucket[];
}

/** The payload-length labels, in the backend's bin order: classic 0..8 then the FD
 *  lengths 12..64 — the x axis of the distribution chart. */
export const PAYLOAD_LABELS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '12', '16', '20', '24', '32', '48', '64'] as const;

export interface ChannelPayloadDist {
	channel: number;
	/** One count per `PAYLOAD_LABELS` bin. */
	counts: number[];
}

export interface CanLogStats {
	format: 'BLF' | 'ASC';
	startTimestampS: number | null;
	durationS: number;
	totalFrames: number;
	errorFrames: number;
	channels: CanChannelStats[];
	messages: CanIdStats[];
	/** Identifiers beyond the response cap — noted in the status line, not as rows. */
	messagesTruncated: number;
	skippedObjects: number;
	loadProfiles: ChannelLoadProfile[];
	payloadDist: ChannelPayloadDist[];
}

export interface IntervalPoint {
	tS: number;
	cycleS: number;
	missed: boolean;
}

/** One progress report from a long backend walk (the channel Rust sends it over). */
export interface CanProgress {
	frames: number;
	bytes: number;
	totalBytes: number;
}

/** What a progress report reads as on the status line: percent through the file and how
 *  many frames have been handed over so far. */
export function progressText(progress: CanProgress, verb: string): string {
	const percent = progress.totalBytes > 0 ? Math.min(100, (progress.bytes / progress.totalBytes) * 100) : 0;
	return `${verb}… ${percent.toFixed(0)}%  ·  ${progress.frames.toLocaleString()} frames`;
}

/** A channel wired to a status-line writer, passed to the backend as `onProgress`. The
 *  raw report rides along, so a caller with a progress bar can fill it without parsing
 *  the text back. */
function progressChannel(verb: string, report: (text: string, progress: CanProgress) => void): Channel<CanProgress> {
	const channel = new Channel<CanProgress>();
	channel.onmessage = (progress) => report(progressText(progress, verb), progress);
	return channel;
}

export interface CycleBin {
	fromS: number;
	toS: number;
	count: number;
}

export interface CanIntervals {
	channel: number;
	id: number;
	extended: boolean;
	fd: boolean;
	count: number;
	firstS: number;
	lastS: number;
	medianCycleS: number;
	avgCycleS: number;
	minCycleS: number;
	maxCycleS: number;
	stdS: number;
	missedGaps: number;
	missedFrames: number;
	points: IntervalPoint[];
	histogram: CycleBin[];
}

/** The share of the measurement time the bus was busy: bits on the wire ÷ (time × bitrate). */
export function busLoad(busBits: number, durationS: number, bitrate: number): number {
	if (durationS <= 0 || bitrate <= 0) return 0;
	return (busBits / (durationS * bitrate)) * 100;
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
 *  empty (or nothing in it parses) — the raw view ships the ranges to the backend, which
 *  filters while it browses. */
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

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatStart(seconds: number): string {
	return new Date(seconds * 1000).toLocaleString();
}

/* ---------- The dashboard's resizable panes ---------- */

/** The pane shares the sashes move, in percent; persisted as one layout blob. */
interface CanStatsLayout {
	/** The left column's share of the dashboard's width. */
	left: number;
	/** The dashboard's share of the body's height over the messages table. */
	top: number;
}

const DEFAULT_CAN_STATS_LAYOUT: CanStatsLayout = { left: 34, top: 62 };
const CAN_STATS_LAYOUT_KEY = 'canStats.layout';

/** A drag handle between two panes: ew-resize (vertical sash) or ns-resize (horizontal),
 *  its moves coalesced to one apply per animation frame - the workbench's sash pattern,
 *  here over flexGrow shares the panes carry (the dashboard is not a grid the editor
 *  area's sashes could own). A double-click resets the shares (a drag's end saves them). */
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
		// The same marker the workbench's sashes set: git refreshes defer to after the drag.
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
	private readonly overviewBody: HTMLElement;
	private readonly channelsBody: HTMLElement;
	private readonly loadBody: HTMLElement;
	private readonly rateBody: HTMLElement;
	private readonly payloadBody: HTMLElement;
	private readonly analysisHost: HTMLElement;
	private readonly messagesBody: HTMLElement;
	private readonly bitrateSelect: HTMLSelectElement;
	private readonly filterBox: HTMLInputElement;
	private readonly channelSelect: HTMLSelectElement;
	private readonly convertButton: HTMLButtonElement;
	private stats: CanLogStats | null = null;
	private bitrate = DEFAULT_CAN_BITRATE;
	private sortKey: SortKey = 'count';
	private sortAsc = false;
	private layout: CanStatsLayout = { ...DEFAULT_CAN_STATS_LAYOUT };
	/** The identifier whose analysis panel is open, if any, and the walk's answer for it -
	 *  cached so a bitrate or filter change re-renders the panel without re-walking the log. */
	private selected: { channel: number; id: number; extended: boolean } | null = null;
	private intervals: CanIntervals | null = null;

	constructor(private path: string) {
		this.bitrateSelect = el('select', 'can-bitrate') as HTMLSelectElement;
		this.bitrateSelect.title = t('can.bitrate.title');
		this.bitrateSelect.setAttribute('aria-label', t('can.bitrate.title'));
		for (const rate of CAN_BITRATES) {
			const option = el('option', undefined, [rate >= 1_000_000 ? `${rate / 1_000_000} Mbit/s` : `${rate / 1000} kbit/s`]) as HTMLOptionElement;
			option.value = String(rate);
			if (rate === DEFAULT_CAN_BITRATE) option.selected = true;
			this.bitrateSelect.append(option);
		}
		this.bitrateSelect.addEventListener('change', () => {
			this.bitrate = Number(this.bitrateSelect.value);
			if (this.stats) this.render();
		});
		this.filterBox = el('input', 'hex-search can-filter') as HTMLInputElement;
		this.filterBox.type = 'search';
		this.filterBox.placeholder = t('can.filter.placeholder');
		this.filterBox.spellcheck = false;
		this.filterBox.addEventListener('input', () => this.render());
		this.channelSelect = el('select', 'can-channel') as HTMLSelectElement;
		this.channelSelect.title = t('can.channel');
		this.channelSelect.setAttribute('aria-label', t('can.channel'));
		this.channelSelect.addEventListener('change', () => this.render());
		this.convertButton = el('button', 'button secondary can-convert', [icon('save-as'), ` ${t('can.convert')}`]) as HTMLButtonElement;
		this.convertButton.title = t('can.convert.title');
		this.convertButton.addEventListener('click', () => void this.convert());
		const toolbar = el('div', 'hex-toolbar can-toolbar', [
			el('span', 'can-toolbar-title', [icon('pulse'), ` ${t('can.stats.title')} — ${basename(path)}`]),
			this.filterBox,
			this.channelSelect,
			el('span', 'hex-toolbar-sep'),
			this.bitrateSelect,
			this.convertButton
		]);
		// The dashboard skeleton: the panes and sashes are laid out once; every render
		// only fills the section bodies, so an open analysis panel or a drag share survives.
		this.overviewBody = el('div', 'can-section-body');
		this.channelsBody = el('div', 'can-section-body can-section-flush');
		this.loadBody = el('div', 'can-section-body');
		this.rateBody = el('div', 'can-section-body');
		this.payloadBody = el('div', 'can-section-body');
		this.analysisHost = el('div', 'can-analysis-host');
		this.messagesBody = el('div', 'can-section-body can-section-flush');
		this.paneLeft = el('div', 'can-pane can-pane-left', [
			this.section('can-section-overview', 'pulse', t('can.section.overview'), this.overviewBody),
			this.section('can-section-channels', 'stack', t('can.section.channels'), this.channelsBody)
		]);
		this.paneRight = el('div', 'can-pane can-pane-right', [
			this.section('can-section-load', 'graph', t('can.section.load'), this.loadBody),
			this.section('can-section-rate', 'watch', t('can.section.rate'), this.rateBody),
			this.section('can-section-payload', 'layers', t('can.section.payload'), this.payloadBody),
			this.analysisHost
		]);
		this.paneMessages = el('div', 'can-pane can-pane-messages', [
			this.section('can-section-messages', 'table', t('can.section.messages'), this.messagesBody)
		]);
		this.paneTop = el('div', 'can-dash-top', [this.paneLeft, paneSash('vertical', (sash, delta) => this.dragLeft(sash, delta), () => this.saveLayout(), () => this.resetLayout()), this.paneRight]);
		const hSash = paneSash('horizontal', (sash, delta) => this.dragTop(sash, delta), () => this.saveLayout(), () => this.resetLayout());
		const body = el('div', 'can-body', [this.paneTop, hSash, this.paneMessages]);
		this.liveDot = el('span', 'can-live-dot');
		this.liveText = el('span', 'can-live-text', [t('can.live.opening')]);
		this.live = el('span', 'can-live can-live-parsing', [this.liveDot, this.liveText]);
		this.summaryLine = el('span', 'can-summary-line');
		const status = el('div', 'hex-status can-status', [this.live, this.summaryLine]);
		this.progressFill = el('i');
		this.progress = el('div', 'can-progress', [this.progressFill]);
		this.root = el('div', 'can-view', [toolbar, body, this.progress, status]);
		this.layout = loadState<CanStatsLayout>(CAN_STATS_LAYOUT_KEY, { ...DEFAULT_CAN_STATS_LAYOUT });
		this.applyLayout();
		for (const paneBody of [this.overviewBody, this.channelsBody, this.loadBody, this.rateBody, this.payloadBody, this.messagesBody]) {
			paneBody.append(el('div', 'can-loading', [t('can.parsing')]));
		}
		void this.load();
	}

	/** A dashboard section: the compact head (icon, title, optional meta) over the body. */
	private section(cls: string, iconName: string, title: string, body: HTMLElement): HTMLElement {
		const head = el('div', 'can-section-head', [icon(iconName), el('span', 'can-section-title', [title])]);
		return el('div', `can-section ${cls}`, [head, body]);
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

	/** A vertical drag hands share to the left column: the delta is pixels of the sash's
	 *  parent span, the shares are percents of the pair. */
	private dragLeft(sash: HTMLElement, delta: number): void {
		const span = Math.max(1, sash.parentElement?.getBoundingClientRect().width ?? 0);
		this.layout.left = Math.max(18, Math.min(82, this.layout.left + (delta / span) * 100));
		this.applyLayout();
	}

	/** A horizontal drag hands height to the dashboard over the messages table. */
	private dragTop(sash: HTMLElement, delta: number): void {
		const span = Math.max(1, sash.parentElement?.getBoundingClientRect().height ?? 0);
		this.layout.top = Math.max(20, Math.min(85, this.layout.top - (delta / span) * 100));
		this.applyLayout();
	}

	/** Double-clicking a sash resets the shares to the defaults and saves them. */
	private resetLayout(): void {
		this.layout = { ...DEFAULT_CAN_STATS_LAYOUT };
		this.applyLayout();
		this.saveLayout();
	}

	/* ---------- The backend walk ---------- */

	/** The backend walks the whole file on its blocking pool (a BLF container by
	 *  container, an .asc line by line) and reports progress over the channel; the view
	 *  itself painted the moment the tab opened, and this only fills the numbers in. */
	private async load(): Promise<void> {
		try {
			this.stats = await invoke<CanLogStats>('can_log_stats', {
				path: this.path,
				onProgress: progressChannel(t('can.status.parsing'), (text, progress) => {
					this.liveText.textContent = text;
					const percent = progress.totalBytes > 0 ? Math.min(100, (progress.bytes / progress.totalBytes) * 100) : 0;
					this.progressFill.style.width = `${percent.toFixed(1)}%`;
				})
			});
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

	/** The tables narrowed by the filter bar: matching identifiers on the chosen channel. */
	private filtered(): { messages: CanIdStats[]; channels: CanChannelStats[]; totalFrames: number; errorFrames: number; payloadBytes: number; durationS: number } | null {
		const stats = this.stats;
		if (!stats) return null;
		const idOk = parseIdFilter(this.filterBox.value);
		const channel = Number(this.channelSelect.value) || 0;
		const messages = stats.messages.filter((m) => (!channel || m.channel === channel) && (!idOk || idOk(m.id)));
		const channels = stats.channels.filter((c) => !channel || c.channel === channel);
		const totalFrames = channels.reduce((a, c) => a + c.frames, 0);
		const errorFrames = channels.reduce((a, c) => a + c.errorFrames, 0);
		const payloadBytes = channels.reduce((a, c) => a + c.payloadBytes, 0);
		// The filter keeps whole channels' traffic (the channel's own window and load are
		// what they were); the duration stays the widest window still shown.
		const durationS = channels.length ? Math.max(...channels.map((c) => c.lastS - c.firstS)) : 0;
		return { messages, channels, totalFrames, errorFrames, payloadBytes, durationS };
	}

	private render(): void {
		const stats = this.stats;
		if (!stats) return;
		if (!stats.totalFrames && !stats.errorFrames) {
			this.doneLive();
			for (const paneBody of [this.overviewBody, this.channelsBody, this.loadBody, this.rateBody, this.payloadBody, this.messagesBody]) {
				paneBody.replaceChildren(el('div', 'can-error', [t('can.noFrames')]));
			}
			this.summaryLine.textContent = t('can.noFrames');
			return;
		}
		// The channel filter's options follow the log's own channels once, over an
		// "All channels" default - without it the select would pin the first channel.
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
		this.doneLive();
		this.renderOverview(stats, view);
		this.renderChannels(view);
		this.renderCharts(view);
		this.renderMessages(view);
		this.renderAnalysis();
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

	/** The walk is over: the pulsing dot and the progress bar stand down; the chip keeps
	 *  the frame total as the dashboard's one-line "done" state. */
	private doneLive(): void {
		this.live.classList.remove('can-live-parsing');
		this.progress.classList.add('can-progress-done');
		this.liveText.textContent = `${this.stats!.totalFrames.toLocaleString()} ${t('can.status.frames')}`;
	}

	/** The measurement summary: window, duration, totals - the header of CANoe's window. */
	private renderOverview(stats: CanLogStats, view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		const cell = (label: string, value: string) => el('div', 'can-summary-cell', [el('div', 'can-summary-label', [label]), el('div', 'can-summary-value', [value])]);
		this.overviewBody.replaceChildren(el('div', 'can-summary', [
			cell(t('can.overview.format'), stats.format),
			cell(t('can.overview.start'), stats.startTimestampS ? formatStart(stats.startTimestampS) : '—'),
			cell(t('can.overview.duration'), formatDuration(view.durationS)),
			cell(t('can.overview.frames'), view.totalFrames.toLocaleString()),
			cell(t('can.overview.errors'), view.errorFrames.toLocaleString()),
			cell(t('can.overview.payload'), formatBytes(view.payloadBytes)),
			cell(t('can.overview.ids'), view.messages.length.toLocaleString()),
			cell(t('can.overview.rate'), view.durationS > 0 ? `${(view.totalFrames / view.durationS).toFixed(1)} fr/s` : '—')
		]));
	}

	/** One row per channel: counts, the window, the average rate, and the load at the
	 *  chosen bitrate - the load columns follow the toolbar's bitrate select live, the
	 *  peak off the load profile's buckets. */
	private renderChannels(view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		const profiles = new Map((this.stats?.loadProfiles ?? []).map((p) => [p.channel, p]));
		const head = el('div', 'can-table-head can-ch-grid', [t('can.ch.channel'), t('can.ch.frames'), t('can.ch.errors'), t('can.ch.payload'), t('can.ch.duration'), t('can.ch.rate'), t('can.ch.load'), t('can.ch.peak')].map((label, i) => el('span', i === 0 ? 'can-left' : 'can-num', [label])));
		const rows = view.channels.map((c) => {
			const duration = Math.max(0, c.lastS - c.firstS);
			const load = busLoad(c.busBits, duration, this.bitrate);
			const buckets = profiles.get(c.channel)?.buckets ?? [];
			const peak = Math.max(0, ...buckets.map((b) => busLoad(b.busBits, b.durS, this.bitrate)));
			const cells = [
				el('span', 'can-left', [`${t('can.channel')} ${c.channel}`]),
				el('span', 'can-num', [c.frames.toLocaleString()]),
				el('span', `can-num${c.errorFrames ? ' can-warn' : ''}`, [c.errorFrames.toLocaleString()]),
				el('span', 'can-num', [formatBytes(c.payloadBytes)]),
				el('span', 'can-num', [duration.toFixed(3) + ' s']),
				el('span', 'can-num', [duration > 0 ? (c.frames / duration).toFixed(1) + ' fr/s' : '—']),
				el('span', 'can-num can-load', [load.toFixed(2) + ' %']),
				el('span', 'can-num can-load', [buckets.length ? peak.toFixed(2) + ' %' : '—'])
			];
			const row = el('div', 'can-table-row can-ch-grid can-mono', cells);
			row.title = tf('can.load.bitsTitle', (c.busBits / 1e6).toFixed(2));
			return row;
		});
		this.channelsBody.replaceChildren(el('div', 'can-channels can-table', [head, ...rows]));
	}

	/** The bus charts, one series per shown channel in its palette colour: the load over
	 *  time (percent of the chosen bitrate), the frame rate over time, and the payload
	 *  length distribution stacked per channel. All three are divisions of the walked
	 *  numbers, so a bitrate change redraws them without asking the backend anything. */
	private renderCharts(view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		const profiles = new Map((this.stats?.loadProfiles ?? []).map((p) => [p.channel, p]));
		const dists = new Map((this.stats?.payloadDist ?? []).map((d) => [d.channel, d]));
		const seriesOf = (y: (b: LoadBucket) => number): ChartSeries[] => view.channels.map((c, i) => ({
			name: `${t('can.channel')} ${c.channel}`,
			cls: seriesStyle(i),
			points: (profiles.get(c.channel)?.buckets ?? []).map((b) => ({ x: b.tS, y: y(b) }))
		}));
		this.loadBody.replaceChildren(
			multiLineChart(seriesOf((b) => busLoad(b.busBits, b.durS, this.bitrate)), { xUnit: 's', yUnit: '%', height: 200, fmtX: formatAxisSeconds })
		);
		this.rateBody.replaceChildren(
			multiLineChart(seriesOf((b) => (b.durS > 0 ? b.frames / b.durS : 0)), { xUnit: 's', yUnit: 'fr/s', height: 160, fmtX: formatAxisSeconds })
		);
		const payloadSeries: ChartSeries[] = view.channels.map((c, i) => ({
			name: `${t('can.channel')} ${c.channel}`,
			cls: seriesStyle(i),
			points: (dists.get(c.channel)?.counts ?? PAYLOAD_LABELS.map(() => 0)).map((y) => ({ x: 0, y }))
		}));
		this.payloadBody.replaceChildren(stackedBars([...PAYLOAD_LABELS], payloadSeries, { height: 170 }));
	}

	/** A column-header sort button: clicking it sorts by that key, clicking again flips. */
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

	/** The per-identifier table, sorted by the clicked column (busiest first by default).
	 *  Clicking a row opens that identifier's analysis panel. */
	private renderMessages(view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		const messages = [...view.messages].sort((a, b) => {
			let d = 0;
			if (this.sortKey === 'count') d = a.count - b.count;
			else if (this.sortKey === 'id') d = (a.channel - b.channel) || (a.id - b.id);
			else if (this.sortKey === 'cycle') d = (a.avgCycleS || Infinity) - (b.avgCycleS || Infinity) || a.count - b.count;
			else if (this.sortKey === 'jitter') d = (a.stdCycleS || Infinity) - (b.stdCycleS || Infinity) || a.count - b.count;
			else d = a.payloadBytes - b.payloadBytes;
			return this.sortAsc ? d : -d;
		});
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
		const rows = messages.map((m) => {
			const share = view.totalFrames ? (m.count / view.totalFrames) * 100 : 0;
			const row = el('div', 'can-table-row can-msg-grid can-mono can-msg-row', [
				el('span', 'can-left', [idHex(m.id, m.extended) + (m.extended ? ' x' : '')]),
				el('span', 'can-num', [String(m.channel)]),
				el('span', 'can-left', [m.fd ? 'CAN FD' : 'CAN']),
				el('span', 'can-num', [m.count.toLocaleString()]),
				el('span', 'can-num', [`${m.tx.toLocaleString()} / ${m.rx.toLocaleString()}`]),
				el('span', 'can-num', [formatBytes(m.payloadBytes)]),
				el('span', 'can-num', [`${formatCycle(m.minCycleS)} / ${formatCycle(m.avgCycleS)} / ${formatCycle(m.maxCycleS)}`]),
				el('span', 'can-num', [formatCycle(m.stdCycleS)]),
				el('span', 'can-num', [share.toFixed(share < 1 ? 2 : 1) + ' %'])
			]);
			row.title = t('can.msg.clickHint');
			if (this.selected && this.selected.channel === m.channel && this.selected.id === m.id) row.classList.add('can-selected');
			row.addEventListener('click', () => void this.openAnalysis(m));
			return row;
		});
		const empty = messages.length ? [] : [el('div', 'can-table-row can-empty', [t('can.msg.empty')])];
		this.messagesBody.replaceChildren(el('div', 'can-messages can-table', [header, ...rows, ...empty]));
	}

	/* ---------- Periodic analysis ---------- */

	/** One identifier's analysis: the cycle statistics, the interval series with its
	 *  missing frames marked, and the distribution — CANoe's Graphics window. The answer
	 *  is cached against the selection, so re-renders (a bitrate change, a filter) redraw
	 *  the panel instead of re-walking the log. */
	private async openAnalysis(m: CanIdStats): Promise<void> {
		this.selected = { channel: m.channel, id: m.id, extended: m.extended };
		// The repaint applies the new selection's highlight; the tables are already in
		// memory, so this is a redraw, not a backend round trip.
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
			intervals = await invoke<CanIntervals>('can_intervals', {
				path: this.path,
				channel: m.channel,
				id: m.id,
				extended: m.extended,
				onProgress: progressChannel(t('can.analysis.loading'), (text) => (loading.textContent = text))
			});
		} catch (error) {
			this.analysisHost.replaceChildren(el('div', 'can-error', [`${t('can.analysis.failed')}: ${String(error)}`]));
			return;
		}
		// A late answer for a selection the user has already moved off is dropped.
		if (!this.selected || this.selected.channel !== m.channel || this.selected.id !== m.id) return;
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
		// The frame-loss note pluralises its nouns in English and reorders them in Chinese -
		// both read their words from the table, the pattern key carries only the order.
		const frameWord = t(intervals.missedFrames === 1 ? 'can.analysis.frame' : 'can.analysis.frames');
		const gapWord = t(intervals.missedGaps === 1 ? 'can.analysis.gap' : 'can.analysis.gaps');
		const head = el('div', 'can-section-head', [
			icon('variable'),
			el('span', 'can-section-title', [`${idHex(intervals.id, intervals.extended)} — ${t('can.section.analysis')}`]),
			el('span', `can-analysis-missed${intervals.missedFrames ? ' can-warn' : ''}`, [intervals.missedFrames
				? tf('can.analysis.lost', intervals.missedFrames.toLocaleString(), frameWord, intervals.missedGaps.toLocaleString(), gapWord)
				: t('can.analysis.noLoss')]),
			el('span', 'hex-toolbar-sep'),
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
					// The backend's cycles are seconds; the charts show CANoe's milliseconds.
					cycleSeriesChart(intervals.points.map((p) => ({ x: p.tS, y: p.cycleS * 1000, missed: p.missed })), intervals.medianCycleS * 1000, 's', 'ms')
				]),
				el('div', 'can-chart-block', [
					el('div', 'can-chart-title', [t('can.chart.histogram')]),
					histogramChart(intervals.histogram.map((b) => ({ fromS: b.fromS * 1000, toS: b.toS * 1000, count: b.count })), intervals.medianCycleS * 1000, 'ms')
				])
			])
		]);
		panel.querySelector('.can-analysis-close')!.addEventListener('click', () => {
			this.selected = null;
			this.intervals = null;
			this.renderAnalysis();
			this.messagesBody.querySelectorAll('.can-msg-row.can-selected').forEach((r) => r.classList.remove('can-selected'));
		});
		this.analysisHost.replaceChildren(panel);
	}

	/* ---------- Conversion (Save As) ---------- */

	/** Converts the whole log through the shared flow (target picked, save dialog,
	 *  backend walk with progress on the status line). The result - exported or failed -
	 *  stays on the chip; it is the last thing that happened to this log. */
	private async convert(): Promise<void> {
		this.convertButton.disabled = true;
		try {
			await convertCanLog(this.path, this.stats?.format ?? null, (text) => (this.liveText.textContent = text));
		} finally {
			this.convertButton.disabled = false;
		}
	}
}

/** The Save As conversion, shared by the raw view and the statistics view: pick a target
 *  format (the other format preselected), pick where to save it, and run the backend walk
 *  with its progress reported on the caller's status line. `format` is the source's own
 *  format when the caller knows it; without it the file's extension decides. */
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
		const frames = await invoke<number>('convert_can_log', {
			from: path,
			to,
			format: picked,
			onProgress: progressChannel(t('can.status.converting'), (text) => report(text))
		});
		report(tf('can.convert.done', frames.toLocaleString(), basename(to)));
	} catch (error) {
		report(`${t('can.convert.failed')}: ${String(error)}`);
	}
}
