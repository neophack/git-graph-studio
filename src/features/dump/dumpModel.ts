// The dump list's pure model (module 21): the name a carved entry extracts under, the
// byte formatting, the filter the toolbar drives, and the preview's mime decisions.
// No DOM and no IPC — the vitest suite exercises these directly.

import type { CarvedEntry } from '../../platform/ipc/dump';

/** The image formats the preview pane renders as a picture (the rest preview as hex). */
const IMAGE_MIMES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif',
	bmp: 'image/bmp',
	webp: 'image/webp',
	tif: 'image/tiff',
	ico: 'image/x-icon',
	cur: 'image/x-icon',
};

/** The mime a carved format previews as, or `null` for the hex preview. */
export function imageMime(format: string): string | null {
	return IMAGE_MIMES[format] ?? null;
}

/** The name a carved entry extracts under: its position stamped into the file name, so
 *  two hits of one format never collide and the offset stays traceable. */
export function carvedName(entry: Pick<CarvedEntry, 'id' | 'format'>): string {
	return `carved_${String(entry.id).padStart(6, '0')}.${entry.format}`;
}

/** Bytes as the list prints them: whole units, one decimal past bytes. */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = n;
	let unit = -1;
	do {
		value /= 1024;
		unit += 1;
	} while (value >= 1024 && unit < units.length - 1);
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The hex preview's text: offset, hex pairs, and the printable-ASCII gutter. */
export function hexDump(bytes: Uint8Array, maxRows = 16): string {
	const lines: string[] = [];
	const rowBytes = 16;
	for (let row = 0; row * rowBytes < bytes.length && row < maxRows; row += 1) {
		const slice = bytes.subarray(row * rowBytes, row * rowBytes + rowBytes);
		const hex: string[] = [];
		const ascii: string[] = [];
		for (const b of slice) {
			hex.push(b.toString(16).padStart(2, '0'));
			ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
		}
		while (hex.length < rowBytes) hex.push('  ');
		lines.push(
			`${(row * rowBytes).toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex
				.slice(8)
				.join(' ')}  |${ascii.join('')}|`
		);
	}
	return lines.join('\n');
}

/** The list's filter: a format family chip and a concrete format (either may narrow;
 *  empty = all), a name query, a minimum size, and the verification gate — `pass` (the
 *  default) hides the structurally-failed false positives. */
export interface DumpFilter {
	tag: string;
	format: string;
	query: string;
	minSize: number;
	check: 'pass' | 'fail' | 'all';
}

/** The carved rows the filter keeps, in scan order. */
export function filterCarved(entries: CarvedEntry[], filter: DumpFilter): CarvedEntry[] {
	const query = filter.query.trim().toLowerCase();
	return entries.filter((e) => {
		if (filter.tag && e.tag !== filter.tag) return false;
		if (filter.format && e.format !== filter.format) return false;
		if (e.size < filter.minSize) return false;
		if (filter.check === 'pass' && !e.verified) return false;
		if (filter.check === 'fail' && e.verified) return false;
		if (query) {
			const name = carvedName(e);
			const where = (e.inModule ?? '').toLowerCase();
			if (!name.includes(query) && !e.format.includes(query) && !where.includes(query)) {
				return false;
			}
		}
		return true;
	});
}

/** One count per family tag, in the order the filter chips render them. */
export const TAG_ORDER = ['image', 'media', 'archive', 'doc', 'db', 'font'] as const;

export function countByTag(entries: CarvedEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const e of entries) counts[e.tag] = (counts[e.tag] ?? 0) + 1;
	return counts;
}

/** The distinct formats the scan found, most common first — the format filter's
 *  options, each carrying its own count so the user sees what narrowing buys. */
export function countByFormat(entries: CarvedEntry[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const e of entries) counts.set(e.format, (counts.get(e.format) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
