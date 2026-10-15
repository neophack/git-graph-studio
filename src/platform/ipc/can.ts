// The typed IPC seam of the CAN Trace Analyzer domain (plan §5.6): the parse-with-progress
// statistics, the per-identifier interval analysis, the blf/asc conversion and the raw
// frame browsing — the ggs-can crate behind the app's commands/can adapters. The result
// shapes the two views and the chart share live here once.
import { invoke, type Channel } from './core';

/** One progress report from a long backend walk (the channel Rust sends it over). */
export interface CanProgress {
	frames: number;
	bytes: number;
	totalBytes: number;
}

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
	/** The wire bits per phase, stuffing estimate included: the arbitration phase (all of
	 *  a classic or NoBRS frame) and the data phase (a BRS frame after the switch). */
	arbBits: number;
	dataBits: number;
	firstS: number;
	lastS: number;
}

/** One time slice of a channel's load timeline — the raw material of the load and
 *  frame-rate charts (the bits cross raw per phase, so the load follows the rate pair live). */
export interface LoadBucket {
	tS: number;
	durS: number;
	frames: number;
	errors: number;
	arbBits: number;
	dataBits: number;
}

export interface ChannelLoadProfile {
	channel: number;
	buckets: LoadBucket[];
}

export interface ChannelPayloadDist {
	channel: number;
	/** One count per payload bin — classic 0..8 then the FD lengths 12..64. */
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

/** `can_log_open`: the raw view's session handle over the parsed log. */
export interface CanOpenResult {
	docId: number;
	totalBytes: number;
}

export interface CanFrameLine {
	/** The frame's position in the whole log — the "No." column, whatever filter narrowed
	 *  the view (the lines arrive in filtered order but number in log order). */
	index: number;
	tS: number;
	channel: number;
	id: number;
	extended: boolean;
	fd: boolean;
	brs: boolean;
	esi: boolean;
	remote: boolean;
	error: boolean;
	tx: boolean;
	dlc: number;
	dataHex: string;
}

export interface CanLogCount {
	parsed: number;
	/** The frames that pass the current filter — the row model's length while one is on;
	 *  absent when a scripted backend predates filtering (then `parsed` is the count). */
	matched?: number;
	done: boolean;
	error: string | null;
	bytes?: number;
	totalBytes?: number;
	/** The channels the walk has named so far, ascending — the channel select's options. */
	channels?: number[];
}

/** One find's answer (`can_log_find`): the hit positions of the current row space (capped)
 *  and the true total behind them. */
export interface CanFindResult {
	positions: number[];
	total: number;
	capped: boolean;
}

/** The raw view's filter, one field per toolbar control — CANoe's Trace-window set. Sent
 *  on every poll and fetch; `null` while every control sits on its "all" default, so the
 *  unfiltered browse skips the backend's match index entirely. */
export interface CanFrameFilter {
	/** Channels to keep; empty = every channel. */
	channels: number[];
	direction: 'all' | 'rx' | 'tx';
	/** The frame types the Type column badges: can, canfd, error, remote. */
	kind: 'all' | 'can' | 'canfd' | 'error' | 'remote';
	/** Inclusive `[from, to]` id ranges; empty = every id. */
	idRanges: number[][];
}

export const canLogStats = (path: string, onProgress: Channel<CanProgress>) => invoke<CanLogStats>('can_log_stats', { path, onProgress });
export const canIntervals = (path: string, channel: number, id: number, extended: boolean, onProgress: Channel<CanProgress>) =>
	invoke<CanIntervals>('can_intervals', { path, channel, id, extended, onProgress });
export const convertCanLog = (from: string, to: string, format: 'blf' | 'asc', onProgress: Channel<CanProgress>) =>
	invoke<number>('convert_can_log', { from, to, format, onProgress });
export const canLogOpen = (path: string) => invoke<CanOpenResult>('can_log_open', { path });
export const canLogClose = (docId: number) => invoke<void>('can_log_close', { docId });
export const canLogCount = (docId: number, filter: CanFrameFilter | null) => invoke<CanLogCount>('can_log_count', { docId, filter });
export const canLogFind = (docId: number, query: string, filter: CanFrameFilter | null) => invoke<CanFindResult>('can_log_find', { docId, query, filter });
export const canLogFrames = (docId: number, start: number, end: number, filter: CanFrameFilter | null) =>
	invoke<CanFrameLine[]>('can_log_frames', { docId, start, end, filter });
