// The extension host log (module 12): one place every extension-platform anomaly is
// recorded — activation failures with their stacks, command / provider / event-listener
// exceptions, host requests that failed, every unsupported VS Code API a package reached
// for, frame console errors, backend start failures. VS Code keeps the same record in its
// "Extension Host" output channel; here it lands in three sinks at once:
//
//   * the Output view's "Extension Host" channel (the workbench wires `setExtLogOutput`),
//   * `~/.ggs/logs/ext-host.log` (batched through `ext_log_append`, rotated at 4 MB — a
//     GUI app has no console, and a failure must be readable after the fact),
//   * the devtools console (warnings and errors always; the rest at the chosen level).
//
// The threshold is the `extensionLogLevel` setting (Settings → General); the legacy
// `localStorage['ggs-ext-debug']` switch still forces `trace`. An in-memory ring of the
// last entries backs the tests and anything that wants to show recent history.

import { invoke } from '@tauri-apps/api/core';
import { settings, SETTINGS_EVENT, type ExtensionLogLevel } from './settings';

export type ExtLogLevel = ExtensionLogLevel;

export interface ExtLogEntry {
	time: number;
	level: ExtLogLevel;
	/** Who logged: an extension id, or `host` for the workbench side of the platform. */
	source: string;
	message: string;
	/** A stack or a structured payload, kept apart from the one-line message. */
	detail?: string;
}

const RANK: Record<ExtLogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const RING_SIZE = 1000;
const FLUSH_DELAY_MS = 250;
const MAX_BATCH = 500;

const ring: ExtLogEntry[] = [];
let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let fileSinkBroken = false;
let outputSink: ((line: string) => void) | null = null;
/** Messages already logged once (`extLogOnce`): an unsupported API polled in a loop
 *  must not flood the log. */
const onceKeys = new Set<string>();

function debugSwitch(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem('ggs-ext-debug') !== null;
	} catch {
		return false;
	}
}

/** The effective threshold: the setting, or `trace` under the legacy debug switch. */
export function extLogLevel(): ExtLogLevel {
	if (debugSwitch()) return 'trace';
	const level = settings.extensionLogLevel;
	return level in RANK ? level : 'info';
}

/** Would an entry at `level` be recorded? (Lets callers skip building costly messages.) */
export function extLogEnabled(level: ExtLogLevel): boolean {
	return RANK[level] >= RANK[extLogLevel()];
}

/** Wire the Output view's channel (the extension host does, at construction). */
export function setExtLogOutput(sink: ((line: string) => void) | null): void {
	outputSink = sink;
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0');
}

/** `2026-09-26 14:03:07.412` in local time — the Output view's and the file's stamp. */
function stamp(time: number): string {
	const date = new Date(time);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** One entry as a single line (a detail's newlines fold into ` | ` for the file). */
export function formatExtLogEntry(entry: ExtLogEntry): string {
	const head = `${stamp(entry.time)} [${entry.level}] [${entry.source}] ${entry.message}`;
	return entry.detail ? `${head} :: ${entry.detail}` : head;
}

function scheduleFlush(): void {
	if (flushTimer !== null || fileSinkBroken) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushExtLog();
	}, FLUSH_DELAY_MS);
}

/** Write the buffered lines to `~/.ggs/logs/ext-host.log` now. */
export async function flushExtLog(): Promise<void> {
	if (pendingLines.length === 0 || fileSinkBroken) return;
	const lines = pendingLines;
	pendingLines = [];
	try {
		await invoke('ext_log_append', { lines: lines.map((line) => line.replace(/\r?\n/g, ' | ')) });
	} catch (error) {
		// No backend (a browser preview) or no writable home: keep the other sinks and stop
		// retrying — logging must never become a failure loop of its own.
		fileSinkBroken = true;
		console.warn(`[ext-log] the log file is unavailable: ${String(error)}`);
	}
}

/** Record one entry. Never throws: a logging failure must not add a failure. */
export function extLog(level: ExtLogLevel, source: string, message: string, detail?: unknown): void {
	try {
		if (!extLogEnabled(level)) return;
		const entry: ExtLogEntry = { time: Date.now(), level, source, message, detail: describeDetail(detail) };
		ring.push(entry);
		if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
		const line = formatExtLogEntry(entry);
		const consoleLine = `[ext-host] ${line}`;
		if (level === 'error') console.error(consoleLine);
		else if (level === 'warn') console.warn(consoleLine);
		else console.info(consoleLine);
		// The Output view shows a stack on its own lines; the file keeps one line per entry.
		outputSink?.((entry.detail ? `${formatExtLogEntry({ ...entry, detail: undefined })}\n    ${entry.detail.replace(/\n/g, '\n    ')}` : line) + '\n');
		pendingLines.push(line);
		if (pendingLines.length >= MAX_BATCH) void flushExtLog();
		else scheduleFlush();
	} catch {
		// see the doc comment
	}
}

/** `extLog`, but at most once per `key` per session (unsupported-API notices). */
export function extLogOnce(key: string, level: ExtLogLevel, source: string, message: string, detail?: unknown): void {
	if (onceKeys.has(key)) return;
	onceKeys.add(key);
	extLog(level, source, message, detail);
}

/** An error's stack (or its text), a string as-is, anything else as JSON. */
export function describeDetail(detail: unknown): string | undefined {
	if (detail === undefined || detail === null || detail === '') return undefined;
	if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
	if (typeof detail === 'string') return detail;
	try {
		return JSON.stringify(detail);
	} catch {
		return String(detail);
	}
}

/** The recent entries, oldest first (a copy). */
export function extLogEntries(): ExtLogEntry[] {
	return [...ring];
}

/** Tests: forget the ring, the pending batch and the once-keys. */
export function resetExtLog(): void {
	ring.length = 0;
	pendingLines = [];
	onceKeys.clear();
	fileSinkBroken = false;
	if (flushTimer !== null) clearTimeout(flushTimer);
	flushTimer = null;
}

/** The level a frame's own console method maps to: a package's errors and warnings are
 *  anomalies worth the default log; its chatter (`log` / `info` / `debug`) is debug. */
export function levelForConsole(method: string): ExtLogLevel {
	if (method === 'error') return 'error';
	if (method === 'warn') return 'warn';
	return 'debug';
}

// A level change announces itself in the log (a support report then shows when detail
// began), and the pending batch goes out before the window closes.
if (typeof document !== 'undefined') {
	document.addEventListener(SETTINGS_EVENT, (event) => {
		if ((event as CustomEvent<unknown>).detail === 'extensionLogLevel') {
			extLog('info', 'host', `log level set to ${extLogLevel()}`);
		}
	});
}
if (typeof window !== 'undefined') {
	window.addEventListener('beforeunload', () => void flushExtLog());
}
