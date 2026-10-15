// The Node `path` builtin: the API surface with posix and win32 spellings over
// one segment normalizer, and the platform-selected default.

import type { NodeEnv } from '../extModuleLoader';
import { makeChildProcess } from './processSurfaces';
import { makeHttpLike, makeReadline, makeReadlinePromises } from './processSurfaces';
import { Buffer, encodeString, isWindows, encoder, type ShimHost } from './shared';
import { callThrowsFn, unavailableModule } from './shared';
import { makeStreamModule } from './stream';

interface PathApi {
	normalize(p: string): string;
	join(...parts: string[]): string;
	resolve(...parts: string[]): string;
	relative(from: string, to: string): string;
	dirname(p: string): string;
	basename(p: string, suffix?: string): string;
	extname(p: string): string;
	isAbsolute(p: string): string | boolean;
	parse(p: string): { root: string; dir: string; base: string; ext: string; name: string };
	format(parts: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string;
	sep: string;
	delimiter: string;
	posix?: PathApi;
	win32?: PathApi;
}

/** Split a path into segments and normalize them ('.' and '..' collapsed, `keepRoot` keeps
 *  the leading separator so the rejoin stays absolute). */
function normalizeSegments(p: string): { segments: string[]; absolute: boolean } {
	const absolute = p.startsWith('/');
	const segments: string[] = [];
	for (const part of p.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
			else if (!absolute) segments.push('..');
			continue;
		}
		segments.push(part);
	}
	return { segments, absolute };
}

export const posixPath: PathApi = {
	normalize: (p) => {
		const { segments, absolute } = normalizeSegments(p);
		return (absolute ? '/' : '') + segments.join('/') || '.';
	},
	join: (...parts) => posixPath.normalize(parts.join('/')),
	resolve: (...parts) => {
		// The rightmost absolute part wins; everything before it is its prefix, everything
		// after — none — is dropped. An all-relative call anchors at the process cwd, exactly
		// like Node (`path.resolve` reads `process.cwd()`).
		let resolved = '';
		for (const part of parts) {
			if (part.startsWith('/')) resolved = part;
			else if (part !== '') resolved = resolved === '' ? part : resolved + '/' + part;
		}
		if (!resolved.startsWith('/')) {
			const cwd = String((globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/');
			resolved = (cwd.endsWith('/') ? cwd : cwd + '/') + resolved;
		}
		return posixPath.normalize(resolved);
	},
	relative: (from, to) => {
		const a = normalizeSegments(posixPath.resolve(from));
		const b = normalizeSegments(posixPath.resolve(to));
		if (a.absolute !== b.absolute) return posixPath.normalize(to);
		let shared = 0;
		while (shared < a.segments.length && shared < b.segments.length && a.segments[shared] === b.segments[shared]) shared++;
		const up = a.segments.length - shared;
		return [...Array<string>(up).fill('..'), ...b.segments.slice(shared)].join('/') || '.';
	},
	dirname: (p) => {
		const { segments, absolute } = normalizeSegments(p);
		segments.pop();
		return (absolute ? '/' : '') + segments.join('/');
	},
	basename: (p, suffix) => {
		const base = normalizeSegments(p).segments.pop() ?? '';
		return suffix !== undefined && base.endsWith(suffix) && base !== suffix ? base.slice(0, -suffix.length) : base;
	},
	extname: (p) => {
		const base = normalizeSegments(p).segments.pop() ?? '';
		const at = base.lastIndexOf('.');
		return at > 0 ? base.slice(at) : '';
	},
	isAbsolute: (p) => p.startsWith('/'),
	parse: (p) => {
		const absolute = p.startsWith('/');
		const segments = normalizeSegments(p).segments;
		const base = segments.pop() ?? '';
		const ext = posixPath.extname(base);
		return {
			root: absolute ? '/' : '',
			dir: (absolute ? '/' : '') + segments.join('/'),
			base,
			ext,
			name: base.slice(0, base.length - ext.length)
		};
	},
	format: (parts) => {
		if (parts.base !== undefined) return (parts.dir ? posixPath.join(parts.dir, parts.base) : parts.base);
		const ext = parts.ext ?? '';
		return (parts.dir ? posixPath.join(parts.dir, (parts.name ?? '') + ext) : (parts.name ?? '') + ext);
	},
	sep: '/',
	delimiter: ':'
};

/** The Windows path flavour: back or forward separators accepted, drive letters and UNC
 *  roots kept, comparisons case-insensitive (Node's win32 semantics). */
export const win32Path: PathApi = {
	normalize: (p) => {
		const { root, tail } = winSplitRoot(p);
		const { segments } = normalizeSegments(tail.replace(/\\/g, '/'));
		return root + segments.join('\\') || '.';
	},
	join: (...parts) => win32Path.normalize(parts.join('\\')),
	resolve: (...parts) => {
		// Node's right-to-left walk, simplified to the case extension code actually spells:
		// the rightmost ABSOLUTE part (a drive root, a UNC root or a rooted tail) restarts
		// the resolution and discards everything to its right; the parts left of it prefix
		// it; an all-relative call anchors at the process cwd.
		let device = '';
		let tailSegments: string[] | null = null;
		let relativeTail: string[] = [];
		for (let at = parts.length - 1; at >= 0; at--) {
			const part = parts[at]!.replace(/\\/g, '/');
			if (part === '') continue;
			const { root, tail } = winSplitRoot(part);
			if (root !== '' && (root.length > 2 || root === '\\')) {
				// A rooted device ('c:\\', '\\\\server\\share\\', '\\'): the anchor.
				device = root;
				tailSegments = tail === '' ? [] : tail.split('/').filter((segment) => segment !== '');
				break;
			}
			if (root !== '') {
				// A device without a root ('c:'), the relative tail of that device.
				device = root;
				relativeTail = [...(tail === '' ? [] : tail.split('/').filter((segment) => segment !== '')), ...relativeTail];
				continue;
			}
			relativeTail = [...part.split('/').filter((segment) => segment !== ''), ...relativeTail];
		}
		if (tailSegments === null) {
			const cwd = String((globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '');
			const { root, tail } = winSplitRoot(cwd.replace(/\\/g, '/'));
			device = device !== '' && root.length <= 2 ? device : root;
			const cwdTail = tail === '' ? [] : tail.split('/').filter((segment) => segment !== '');
			tailSegments = [...cwdTail, ...relativeTail];
		}
		const { segments } = normalizeSegments(tailSegments.join('/'));
		return device + segments.join('\\');
	},
	relative: (from, to) => {
		const a = win32Path.resolve(from);
		const b = win32Path.resolve(to);
		if (a.toLowerCase() === b.toLowerCase()) return '';
		const splitA = winSplitRoot(a);
		const splitB = winSplitRoot(b);
		if (splitA.root.toLowerCase() !== splitB.root.toLowerCase()) return b;
		const aSegments = normalizeSegments(splitA.tail.replace(/\\/g, '/')).segments;
		const bSegments = normalizeSegments(splitB.tail.replace(/\\/g, '/')).segments;
		let shared = 0;
		while (shared < aSegments.length && shared < bSegments.length && aSegments[shared]!.toLowerCase() === bSegments[shared]!.toLowerCase()) shared++;
		const up = aSegments.length - shared;
		return [...Array<string>(up).fill('..'), ...bSegments.slice(shared)].join('\\') || '.';
	},
	dirname: (p) => {
		const { root, tail } = winSplitRoot(p);
		const segments = normalizeSegments(tail.replace(/\\/g, '/')).segments;
		segments.pop();
		return root + segments.join('\\');
	},
	basename: (p, suffix) => {
		const { tail } = winSplitRoot(p);
		const base = normalizeSegments(tail.replace(/\\/g, '/')).segments.pop() ?? '';
		return suffix !== undefined && base.toLowerCase().endsWith(suffix.toLowerCase()) && base !== suffix ? base.slice(0, -suffix.length) : base;
	},
	extname: (p) => {
		const { tail } = winSplitRoot(p);
		const base = normalizeSegments(tail.replace(/\\/g, '/')).segments.pop() ?? '';
		const at = base.lastIndexOf('.');
		return at > 0 ? base.slice(at) : '';
	},
	isAbsolute: (p) => winSplitRoot(p).root !== '',
	parse: (p) => {
		const { root, tail } = winSplitRoot(p);
		const segments = normalizeSegments(tail.replace(/\\/g, '/')).segments;
		const base = segments.pop() ?? '';
		const ext = win32Path.extname(base);
		return {
			root,
			dir: root + segments.join('\\'),
			base,
			ext,
			name: base.slice(0, base.length - ext.length)
		};
	},
	format: (parts) => {
		const base = parts.base ?? (parts.name ?? '') + (parts.ext ?? '');
		return parts.dir ? win32Path.join(parts.dir, base) : base;
	},
	sep: '\\',
	delimiter: ';'
};

/** Split a Windows path into its root ('c:\\', '\\\\server\\share\\', '\\\\' or '') and tail. */
function winSplitRoot(p: string): { root: string; tail: string } {
	const forward = p.replace(/\\/g, '/');
	// UNC: //server/share/...
	if (forward.startsWith('//')) {
		const parts = forward.slice(2).split('/');
		if (parts.length >= 2 && parts[0] !== '' && parts[1] !== '') {
			return { root: `\\\\${parts[0]}\\${parts[1]}\\`, tail: parts.slice(2).join('/') };
		}
		return { root: '\\\\', tail: forward.slice(2) };
	}
	// Drive: c:/... (a bare 'c:' keeps its root — device-relative, as in Node)
	if (/^[a-zA-Z]:/.test(forward)) {
		const rest = forward.slice(2);
		return rest.startsWith('/') ? { root: forward.slice(0, 3), tail: rest.slice(1) } : { root: forward.slice(0, 2), tail: rest };
	}
	if (forward.startsWith('/')) return { root: '\\', tail: forward.slice(1) };
	return { root: '', tail: forward };
}

/** The default `path`: the platform's own flavour (the activation's `nodeEnv.platform` —
 *  the same word `process.platform` reports), with both nested (`path.posix`). */
export const defaultPath = (platform: string): PathApi => {
	const api = platform === 'win32' ? win32Path : posixPath;
	return { ...api, posix: posixPath, win32: win32Path };
};

/* ---------- events: Node's EventEmitter ---------- */

/** Node's EventEmitter — the real semantics (once, prepend, listener bookkeeping, the
 *  `newListener`/`removeListener` notifications), because extension code subclasses it. */
