// Small pure helpers the shim's surfaces share: the base64 codec over the
// bridge's byte format, the watcher glob matcher, and the plain-data serializers
// for decorations, selectors and diagnostics.

import type { SerializableDiagnostic } from '../../platform/diagnostics';
import { Range } from './types/position';
import { Uri, pathOf } from './types/uri';

/** One watcher pattern against one base-relative path (forward slashes, `**` crossing
 *  segment boundaries, `*` / `?` within one) — the subset VS Code's glob patterns use. */
export function watcherGlobMatches(pattern: string, path: string): boolean {
	const segments = pattern.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
	const parts = path.split('/');
	const segmentMatches = (segment: string, part: string): boolean => {
		if (segment === part) return true;
		let s = 0;
		let p = 0;
		while (s < segment.length) {
			const char = segment[s]!;
			if (char === '*') {
				for (let rest = p; rest <= part.length; rest++) {
					if (segmentMatches(segment.slice(s + 1), part.slice(rest))) return true;
				}
				return false;
			}
			if (p >= part.length || (char !== '?' && char !== part[p])) return false;
			s++;
			p++;
		}
		return p === part.length;
	};
	const matches = (segmentAt: number, partAt: number): boolean => {
		if (segmentAt === segments.length) return partAt === parts.length;
		const segment = segments[segmentAt]!;
		if (segment === '**') {
			for (let skip = partAt; skip <= parts.length; skip++) {
				if (matches(segmentAt + 1, skip)) return true;
			}
			return false;
		}
		return partAt < parts.length && segmentMatches(segment, parts[partAt]!) && matches(segmentAt + 1, partAt + 1);
	};
	return matches(0, 0);
}

/** Base64 helpers over the bridge's byte format (`atob` gives a binary string; the loops
 *  move it into a real byte array without per-byte string ops on large buffers). */
export function decodeBase64(data: string): Uint8Array {
	const raw = atob(data);
	const bytes = new Uint8Array(raw.length);
	for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
	return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 8192;
	for (let at = 0; at < bytes.length; at += chunk) binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
	return btoa(binary);
}

/** A document filter as plain data for the host (a RelativePattern becomes its glob and
 *  base path). */
/** GGS-patch: the renderable subset of a DecorationRenderOptions object (see
 *  editorDecorations.ts); everything else is accepted and ignored. */
export function plainDecorationOptions(options: Record<string, unknown> | undefined): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	if (!options) return out;
	for (const [key, value] of Object.entries(options)) {
		if (typeof value !== 'string' && typeof value !== 'boolean') continue;
		if (key === 'backgroundColor' || key === 'border' || key === 'borderColor' || key === 'borderRadius'
			|| key === 'color' || key === 'fontWeight' || key === 'fontStyle' || key === 'textDecoration'
			|| key === 'cursor' || key === 'isWholeLine') {
			out[key] = value;
		}
	}
	return out;
}

/** GGS-patch: a DecorationOptions[] | Range[] argument — VS Code's setDecorations
 *  accepts either — flattened to the wire's line/character pairs. */
export function plainDecorationRanges(rangesOrOptions: unknown): { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[] {
	const list = Array.isArray(rangesOrOptions) ? rangesOrOptions : [];
	return list.map((entry) => {
		const range = (entry && typeof entry === 'object' && 'range' in (entry as Record<string, unknown>)
			? (entry as { range: unknown }).range
			: entry) as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined;
		return {
			startLine: range?.start?.line ?? 0,
			startCharacter: range?.start?.character ?? 0,
			endLine: range?.end?.line ?? 0,
			endCharacter: range?.end?.character ?? 0
		};
	});
}

export function plainSelector(entry: unknown): unknown {
	if (entry === null || typeof entry !== 'object') return entry;
	const filter = entry as { language?: string; scheme?: string; pattern?: unknown; notebookType?: string };
	const pattern = filter.pattern;
	return {
		language: filter.language,
		scheme: filter.scheme,
		pattern: typeof pattern === 'string' ? pattern : pattern !== null && typeof pattern === 'object' ? (pattern as { pattern?: string }).pattern : undefined,
		base: pattern !== null && typeof pattern === 'object' ? ((pattern as { baseUri?: Uri }).baseUri?.fsPath ?? pathOf((pattern as { base?: string }).base)) : undefined
	};
}

/** A Diagnostic as the plain shape the editor's diagnostics store renders. */
export function serializeDiagnostic(value: unknown): SerializableDiagnostic {
	const diagnostic = value as { range?: Range; severity?: number; message?: string; source?: string; code?: unknown };
	const code = diagnostic.code !== null && typeof diagnostic.code === 'object' ? (diagnostic.code as { value?: string | number }).value : diagnostic.code as string | number | undefined;
	const range = diagnostic.range ?? new Range(0, 0, 0, 0);
	return {
		range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } },
		severity: diagnostic.severity,
		message: String(diagnostic.message ?? ''),
		source: diagnostic.source,
		code
	};
}
