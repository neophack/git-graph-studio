// The shim's log line out: an anomaly reporter that never throws, throttled by
// a threshold and deduplicated by key. The sink defaults to the console; every
// host points it at the bridge's `log` request as it boots an api.

/* ---------- The shim's log line out ---------- */

export type ShimLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export const LOG_RANK: Record<ShimLogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

/** Where the shim reports an anomaly: an unsupported API reached for, a listener or
 *  provider that threw, a host request that failed. `createVscodeApi` points it at the
 *  bridge's `log` request (the host's extension-host log records it); until then — and
 *  if the bridge itself fails — the console keeps the line. */
let shimLogSink: (level: ShimLogLevel, message: string, detail?: string) => void = (level, message, detail) => {
	const line = `[ggs-ext] ${message}${detail ? `\n${detail}` : ''}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
};
let shimLogThreshold: ShimLogLevel = 'info';
const shimLoggedOnce = new Set<string>();

function detailText(detail: unknown): string | undefined {
	if (detail === undefined || detail === null) return undefined;
	if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
	if (typeof detail === 'string') return detail;
	try {
		return JSON.stringify(detail);
	} catch {
		return String(detail);
	}
}

/** Record one shim anomaly (never throws — logging must not add a failure). */
export function shimLog(level: ShimLogLevel, message: string, detail?: unknown): void {
	try {
		if (LOG_RANK[level] < LOG_RANK[shimLogThreshold]) return;
		shimLogSink(level, message, detailText(detail));
	} catch {
		// see the doc comment
	}
}

/** `shimLog` at most once per key (an unsupported API polled in a loop logs one line). */
export function shimLogOnce(key: string, level: ShimLogLevel, message: string, detail?: unknown): void {
	if (shimLoggedOnce.has(key)) return;
	shimLoggedOnce.add(key);
	shimLog(level, message, detail);
}

/** Run an extension callback; a throw is logged (with the stack) and swallowed, the way
 *  VS Code's event dispatch isolates one listener's failure from the others. */
export function guarded<T>(what: string, run: () => T): T | undefined {
	try {
		const result = run();
		if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
			(result as unknown as Promise<unknown>).then(undefined, (error: unknown) => shimLog('error', `${what} rejected: ${String(error)}`, error));
		}
		return result;
	} catch (error) {
		shimLog('error', `${what} threw: ${String(error)}`, error);
		return undefined;
	}
}

export function setShimLogThreshold(level: ShimLogLevel): void {
	shimLogThreshold = level;
}

export function setShimLogSink(sink: (level: ShimLogLevel, message: string, detail?: string) => void): void {
	shimLogSink = sink;
}

export function resetShimLoggedOnce(): void {
	shimLoggedOnce.clear();
}
