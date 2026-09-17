// The CAN log statistics view a `.blf` or `.asc` trace opens in - CANoe's Statistics
// window and its graphics window in one: the backend parses the whole log
// (`can_log_stats`) and this view renders the result asynchronously, so even a
// multi-gigabyte trace only paints once the numbers are in.
//
// The summary shows the measurement window and totals; one row per bus channel shows its
// frame rate and bus load; and the per-identifier table shows each message's count,
// direction split and cycle statistics. The bus load divides the bits the frames put on
// the wire (stuffing estimate included) by the bitrate-time product - the bitrate is a
// toolbar choice, because neither log format records it.
//
// Beyond the statistics: a filter bar narrows the tables to chosen identifiers and
// channels; clicking an identifier opens the periodic-message analysis (`can_intervals`),
// whose cycle series and distribution are drawn as SVG charts with the missing-frame
// points marked; and the convert button exports the whole log to the other format
// (`convert_can_log`) through a save dialog.

import { invoke, Channel } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';

import { cycleSeriesChart, histogramChart } from './canChart';
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

/** A channel wired to a status-line writer, passed to the backend as `onProgress`. */
function progressChannel(report: (text: string) => void): Channel<CanProgress> {
	const channel = new Channel<CanProgress>();
	channel.onmessage = (progress) => report(progressText(progress, 'Parsing'));
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

/** The message-table sort keys (the sortable columns of the identifier table). */
type SortKey = 'count' | 'id' | 'cycle' | 'bytes';

export class CanLogView {
	readonly root: HTMLElement;
	private readonly body: HTMLElement;
	private readonly status: HTMLElement;
	private readonly bitrateSelect: HTMLSelectElement;
	private readonly filterBox: HTMLInputElement;
	private readonly channelSelect: HTMLSelectElement;
	private readonly convertButton: HTMLButtonElement;
	private stats: CanLogStats | null = null;
	private bitrate = DEFAULT_CAN_BITRATE;
	private sortKey: SortKey = 'count';
	private sortAsc = false;
	/** The identifier whose analysis panel is open, if any. */
	private selected: { channel: number; id: number; extended: boolean } | null = null;

	constructor(private path: string) {
		this.bitrateSelect = el('select', 'can-bitrate') as HTMLSelectElement;
		this.bitrateSelect.title = 'Bus bitrate (for the load calculation)';
		this.bitrateSelect.setAttribute('aria-label', 'Bus bitrate');
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
		this.filterBox.placeholder = 'Filter IDs (0x100, 1A0-1FF)';
		this.filterBox.spellcheck = false;
		this.filterBox.addEventListener('input', () => this.render());
		this.channelSelect = el('select', 'can-channel') as HTMLSelectElement;
		this.channelSelect.title = 'Channel';
		this.channelSelect.setAttribute('aria-label', 'Channel filter');
		this.channelSelect.addEventListener('change', () => this.render());
		this.convertButton = el('button', 'button secondary can-convert', [icon('save-as'), ' Convert…']) as HTMLButtonElement;
		this.convertButton.title = 'Convert this log to the other format (Save As)';
		this.convertButton.addEventListener('click', () => void this.convert());
		const toolbar = el('div', 'hex-toolbar can-toolbar', [
			el('span', 'can-toolbar-title', [icon('pulse'), ` CAN Statistics — ${basename(path)}`]),
			this.filterBox,
			this.channelSelect,
			el('span', 'hex-toolbar-sep'),
			this.bitrateSelect,
			this.convertButton
		]);
		this.body = el('div', 'can-body');
		this.status = el('div', 'hex-status', ['Parsing…']);
		this.root = el('div', 'can-view', [toolbar, this.body, this.status]);
		this.body.append(el('div', 'can-loading', ['Parsing the log…']));
		void this.load();
	}

	/** The backend walks the whole file on its blocking pool (a BLF container by
	 *  container, an .asc line by line) and reports progress over the channel; the view
	 *  itself painted the moment the tab opened, and this only fills the numbers in. */
	private async load(): Promise<void> {
		try {
			this.stats = await invoke<CanLogStats>('can_log_stats', { path: this.path, onProgress: progressChannel((text) => (this.status.textContent = text)) });
			this.render();
		} catch (error) {
			this.body.replaceChildren(el('div', 'can-error', [`Failed to parse '${basename(this.path)}': ${String(error)}`]));
			this.status.textContent = 'Parse failed';
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
			this.body.replaceChildren(el('div', 'can-error', ['No CAN frames found in this log.']));
			this.status.textContent = 'No frames';
			return;
		}
		// The channel filter's options follow the log's own channels once, over an
		// "All channels" default - without it the select would pin the first channel.
		if (this.channelSelect.options.length === 0) {
			const all = el('option', undefined, ['All channels']) as HTMLOptionElement;
			all.value = '0';
			this.channelSelect.append(all);
			for (const c of stats.channels) {
				const option = el('option', undefined, [`Channel ${c.channel}`]) as HTMLOptionElement;
				option.value = String(c.channel);
				this.channelSelect.append(option);
			}
			this.channelSelect.value = '0';
		}
		const view = this.filtered()!;
		// The tables the analysis was opened from are rebuilt here, so an open (or still
		// loading) analysis is cancelled: the panel and the row's selection go together, and a
		// late can_intervals answer finds no selection and is dropped.
		if (this.body.querySelector('.can-analysis')) this.selected = null;
		// The parse placeholder only awaits the first successful render (the analysis panel's
		// own "Analysing…" line sits inside it, not directly in the body).
		this.body.querySelector(':scope > .can-loading')?.remove();
		this.renderSummary(stats, view);
		this.renderChannels(view);
		this.renderMessages(view);
		this.body.querySelector('.can-analysis')?.remove();
		this.status.textContent = `${stats.format} · ${view.totalFrames.toLocaleString()} frames · ${view.errorFrames.toLocaleString()} error frames · ${view.channels.length} channel${view.channels.length === 1 ? '' : 's'}`
			+ (stats.messagesTruncated ? ` · top ${stats.messages.length.toLocaleString()} of ${(stats.messages.length + stats.messagesTruncated).toLocaleString()} identifiers shown` : '')
			+ (view.messages.length < stats.messages.length ? ` · filtered from ${stats.messages.length.toLocaleString()} identifiers` : '')
			+ (stats.skippedObjects ? ` · ${stats.skippedObjects.toLocaleString()} non-CAN objects skipped` : '');
	}

	/** The measurement summary: window, duration, totals - the header of CANoe's window. */
	private renderSummary(stats: CanLogStats, view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		const cell = (label: string, value: string) => el('div', 'can-summary-cell', [el('div', 'can-summary-label', [label]), el('div', 'can-summary-value', [value])]);
		const summary = el('div', 'can-summary', [
			cell('Format', stats.format),
			cell('Start', stats.startTimestampS ? formatStart(stats.startTimestampS) : '—'),
			cell('Duration', formatDuration(view.durationS)),
			cell('Frames', view.totalFrames.toLocaleString()),
			cell('Error frames', view.errorFrames.toLocaleString()),
			cell('Payload', formatBytes(view.payloadBytes)),
			cell('Identifiers', view.messages.length.toLocaleString()),
			cell('Avg rate', view.durationS > 0 ? `${(view.totalFrames / view.durationS).toFixed(1)} fr/s` : '—')
		]);
		this.body.querySelector('.can-summary')?.remove();
		this.body.prepend(summary);
	}

	/** One row per channel: counts, the window, the average rate and the load at the chosen
	 *  bitrate - the load column follows the toolbar's bitrate select live. */
	private renderChannels(view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		this.body.querySelector('.can-channels')?.remove();
		const head = el('div', 'can-table-head can-ch-grid', ['Channel', 'Frames', 'Errors', 'Payload', 'Duration', 'Avg rate', 'Bus load'].map((t, i) => el('span', i === 0 ? 'can-left' : 'can-num', [t])));
		const rows = view.channels.map((c) => {
			const duration = Math.max(0, c.lastS - c.firstS);
			const load = busLoad(c.busBits, duration, this.bitrate);
			const cells = [
				el('span', 'can-left', [`Channel ${c.channel}`]),
				el('span', 'can-num', [c.frames.toLocaleString()]),
				el('span', `can-num${c.errorFrames ? ' can-warn' : ''}`, [c.errorFrames.toLocaleString()]),
				el('span', 'can-num', [formatBytes(c.payloadBytes)]),
				el('span', 'can-num', [duration.toFixed(3) + ' s']),
				el('span', 'can-num', [duration > 0 ? (c.frames / duration).toFixed(1) + ' fr/s' : '—']),
				el('span', 'can-num can-load', [load.toFixed(2) + ' %'])
			];
			const row = el('div', 'can-table-row can-ch-grid can-mono', cells);
			row.title = `${(c.busBits / 1e6).toFixed(2)} Mbit on the bus`;
			return row;
		});
		this.body.append(el('div', 'can-channels can-table', [head, ...rows]));
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
			if (this.stats) this.render();
		});
		return button;
	}

	/** The per-identifier table, sorted by the clicked column (busiest first by default).
	 *  Clicking a row opens that identifier's analysis panel. */
	private renderMessages(view: NonNullable<ReturnType<CanLogView['filtered']>>): void {
		this.body.querySelector('.can-messages')?.remove();
		const messages = [...view.messages].sort((a, b) => {
			let d = 0;
			if (this.sortKey === 'count') d = a.count - b.count;
			else if (this.sortKey === 'id') d = (a.channel - b.channel) || (a.id - b.id);
			else if (this.sortKey === 'cycle') d = (a.avgCycleS || Infinity) - (b.avgCycleS || Infinity) || a.count - b.count;
			else d = a.payloadBytes - b.payloadBytes;
			return this.sortAsc ? d : -d;
		});
		const header = el('div', 'can-table-head can-msg-grid', [
			el('span', 'can-left', ['Identifier']),
			el('span', 'can-num', ['Ch']),
			el('span', 'can-left', ['Type']),
			this.sortButton('count', 'Count'),
			el('span', 'can-num', ['Tx / Rx']),
			this.sortButton('bytes', 'Payload'),
			this.sortButton('cycle', 'Cycle min / avg / max'),
			el('span', 'can-num', ['Share'])
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
				el('span', 'can-num', [share.toFixed(share < 1 ? 2 : 1) + ' %'])
			]);
			row.title = 'Click for the periodic analysis';
			if (this.selected && this.selected.channel === m.channel && this.selected.id === m.id) row.classList.add('can-selected');
			row.addEventListener('click', () => void this.openAnalysis(m));
			return row;
		});
		const empty = messages.length ? [] : [el('div', 'can-table-row can-empty', ['No identifiers match the filter.'])];
		this.body.append(el('div', 'can-messages can-table', [header, ...rows, ...empty]));
	}

	/* ---------- Periodic analysis ---------- */

	/** One identifier's analysis: the cycle statistics, the interval series with its
	 *  missing frames marked, and the distribution — CANoe's Graphics window. */
	private async openAnalysis(m: CanIdStats): Promise<void> {
		this.selected = { channel: m.channel, id: m.id, extended: m.extended };
		for (const row of Array.from(this.body.querySelectorAll('.can-msg-row'))) row.classList.remove('can-selected');
		this.body.querySelector('.can-analysis')?.remove();
		const panel = el('div', 'can-analysis');
		const loading = el('div', 'can-loading', [`Analysing ${idHex(m.id, m.extended)}…`]);
		panel.append(loading);
		this.body.append(panel);
		panel.scrollIntoView({ block: 'nearest' });
		let intervals: CanIntervals;
		try {
			intervals = await invoke<CanIntervals>('can_intervals', { path: this.path, channel: m.channel, id: m.id, extended: m.extended, onProgress: progressChannel((text) => (loading.textContent = text)) });
		} catch (error) {
			panel.replaceChildren(el('div', 'can-error', [`Analysis failed: ${String(error)}`]));
			return;
		}
		if (!this.selected || this.selected.channel !== m.channel || this.selected.id !== m.id) return;
		this.renderAnalysis(panel, intervals);
	}

	private renderAnalysis(panel: HTMLElement, intervals: CanIntervals): void {
		const cell = (label: string, value: string, warn = false) => el('div', 'can-summary-cell', [el('div', 'can-summary-label', [label]), el('div', `can-summary-value${warn ? ' can-warn' : ''}`, [value])]);
		panel.replaceChildren(
			el('div', 'can-analysis-head', [
				el('span', 'can-analysis-title', [`${idHex(intervals.id, intervals.extended)} — periodic analysis`]),
				el('span', `can-analysis-missed${intervals.missedFrames ? ' can-warn' : ''}`, [intervals.missedFrames
					? `${intervals.missedFrames.toLocaleString()} frame${intervals.missedFrames === 1 ? '' : 's'} lost in ${intervals.missedGaps.toLocaleString()} gap${intervals.missedGaps === 1 ? '' : 's'}`
					: 'no frames lost']),
				el('span', 'hex-toolbar-sep'),
				el('button', 'button secondary can-analysis-close', ['Close'])
			]),
			el('div', 'can-summary', [
				cell('Frames', intervals.count.toLocaleString()),
				cell('Median cycle', formatCycle(intervals.medianCycleS)),
				cell('Avg cycle', formatCycle(intervals.avgCycleS)),
				cell('Min / Max', `${formatCycle(intervals.minCycleS)} / ${formatCycle(intervals.maxCycleS)}`),
				cell('Jitter (σ)', formatCycle(intervals.stdS)),
				cell('Lost', `${intervals.missedFrames.toLocaleString()} (${((intervals.missedFrames / Math.max(1, intervals.count + intervals.missedFrames)) * 100).toFixed(2)} %)`, !!intervals.missedFrames)
			]),
			el('div', 'can-chart-block', [
				el('div', 'can-chart-title', ['Cycle time over the measurement — red marks a gap longer than 1.5 × the median cycle']),
				// The backend's cycles are seconds; the charts show CANoe's milliseconds.
				cycleSeriesChart(intervals.points.map((p) => ({ x: p.tS, y: p.cycleS * 1000, missed: p.missed })), intervals.medianCycleS * 1000, 's', 'ms')
			]),
			el('div', 'can-chart-block', [
				el('div', 'can-chart-title', ['Cycle-time distribution']),
				histogramChart(intervals.histogram.map((b) => ({ fromS: b.fromS * 1000, toS: b.toS * 1000, count: b.count })), intervals.medianCycleS * 1000, 'ms')
			])
		);
		panel.querySelector('.can-analysis-close')!.addEventListener('click', () => {
			panel.remove();
			this.selected = null;
			this.body.querySelectorAll('.can-msg-row.can-selected').forEach((r) => r.classList.remove('can-selected'));
		});
	}

	/* ---------- Conversion (Save As) ---------- */

	/** Converts the whole log through the shared flow (target picked, save dialog,
	 *  backend walk with progress on the status line). */
	private async convert(): Promise<void> {
		this.status.textContent = 'Converting…';
		this.convertButton.disabled = true;
		try {
			await convertCanLog(this.path, this.stats?.format ?? null, (text) => (this.status.textContent = text));
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
	const labelOf = (f: string) => (f === 'blf' ? 'BLF — Vector binary log' : 'ASC — CANoe text log');
	const choices = [
		{ label: labelOf(other.toLowerCase()), description: 'the other format', icon: 'file', value: other.toLowerCase() },
		{ label: labelOf(detected.toLowerCase()), description: 're-write in the same format', icon: 'file', value: detected.toLowerCase() }
	];
	const picked = await quickPick(choices, `Convert '${basename(path)}'`, 'Convert CAN log');
	if (!picked) return;
	const stem = basename(path).replace(/\.(blf|asc)$/i, '');
	const to = await saveDialog({ defaultPath: `${stem}.${picked}`, filters: [{ name: picked === 'blf' ? 'Vector Binary Log' : 'CANoe ASCII Log', extensions: [picked] }] });
	if (!to) return;
	report('Converting…');
	try {
		const frames = await invoke<number>('convert_can_log', { from: path, to, format: picked, onProgress: progressChannel((text) => report(text.replace('Parsing', 'Converting'))) });
		report(`Exported ${frames.toLocaleString()} frames to ${basename(to)}`);
	} catch (error) {
		report(`Conversion failed: ${String(error)}`);
	}
}
