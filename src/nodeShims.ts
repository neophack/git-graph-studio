// The Node builtins as the extension host frame serves them (module 12's Node compatibility
// layer). VS Code's extension host is a Node process: extension code — bundled or not —
// reaches for `path`, `os`, `util`, `events`, `fs`, `Buffer`, `process` and dozens of other
// Node surfaces at load time, before any of it can degrade gracefully. This module answers
// the commonly loaded ones with real implementations over the frame's facts (the activation
// context's `nodeEnv`, the preloaded code map for `fs` reads), and answers the rest with
// modules whose functions fail loudly when *called* rather than when *required* — a
// `require('child_process')` at module top level must not kill an activation whose code
// path never spawns anything.
//
// Everything here runs inside the sandboxed frame; the only escapes are the host bridge's
// workspace-confined `fs.op` (async reads of workspace files) and nothing else.

import type { NodeEnv } from './extModuleLoader';

/** What the shims need: the environment facts, the preloaded code map, and the bridge. */
export interface ShimHost {
	nodeEnv: NodeEnv;
	extensionPath: string;
	/** Package-relative ('/'-separated) path -> text, the activation preload. */
	files: Record<string, string>;
	/** The package's binary native modules (`.node`), as package-relative paths: `fs` sees
	 *  them (exists/stat/list), the module loader serves them as native proxies. */
	binaries: string[];
	/** The host bridge (`fs.op` is the one fs escape, workspace-confined on the Rust side). */
	bridge: { request(method: string, args: unknown[]): Promise<unknown> };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `true` when the host is Windows — the host's own word (`process.platform`), not the
 *  browser's, is what Node-flavoured code branches on. Read lazily through the shim host
 *  where one is in scope; the module-level default answers from the user agent, which is
 *  only the right guess in a real WebView2 (jsdom answers empty). */
const isWindows = (): boolean => {
	try {
		return navigator.platform.toLowerCase().includes('win');
	} catch {
		return false;
	}
};

/* ---------- Buffer: the byte container bundled extension code reads and writes ---------- */

/** The Buffer value type: a Uint8Array with Node's codec and comparison surface. */
export type Buffer = BufferImpl;

/** The `Buffer` factory as extension code uses it (`Buffer.from('x', 'utf8')`, `Buffer.alloc(n)`). */
interface BufferFactory {
	new (sizeOrArray: number | ArrayLike<number> | ArrayBuffer | Uint8Array): Buffer;
	from(input: string | ArrayLike<number> | ArrayBuffer | Uint8Array | { data: number[]; type?: string }, encoding?: string): Buffer;
	alloc(size: number, fill?: number | string): Buffer;
	allocUnsafe(size: number): Buffer;
	allocUnsafeSlow(size: number): Buffer;
	of(...bytes: number[]): Buffer;
	isBuffer(value: unknown): value is Buffer;
	byteLength(text: string, encoding?: string): number;
	concat(parts: (Uint8Array | Buffer)[]): Buffer;
	constants: { MAX_LENGTH: number; MIN_LENGTH: number };
}

/** A Buffer is a Uint8Array in Node; enough of one serves here — construction, base64 and
 *  utf8 codecs, the comparison and slicing basics. The class stays module-private: its
 *  static surface cannot extend Uint8Array's under strict types (Node's `from` signature
 *  is incompatible), so the export is the factory-typed binding below. */
class BufferImpl extends Uint8Array {
	constructor(sizeOrArray: number | ArrayLike<number> | ArrayBuffer | Uint8Array) {
		// The union needs one settled type for `super`; every branch is a real Uint8Array
		// constructor shape at runtime.
		super(sizeOrArray as never);
	}

	toString(encoding = 'utf8', start = 0, end = this.length): string {
		const view = super.subarray(start, end);
		if (encoding === 'base64') {
			let binary = '';
			for (let at = 0; at < view.length; at += 0x8000) binary += String.fromCharCode(...view.subarray(at, at + 0x8000));
			return btoa(binary);
		}
		if (encoding === 'hex') return [...view].map((byte) => byte.toString(16).padStart(2, '0')).join('');
		if (encoding === 'binary' || encoding === 'latin1') return String.fromCharCode(...view);
		if (encoding === 'utf16le' || encoding === 'ucs2') {
			const bytes = new Uint8Array(view.length + view.length % 2);
			bytes.set(view);
			return new TextDecoder('utf-16le').decode(bytes);
		}
		return decoder.decode(view);
	}

	fill(value: number | string): this {
		if (typeof value === 'number') super.fill(value);
		else this.set(encodeString(value), 0);
		return this;
	}

	// A slice stays a Buffer (with Buffer's codecs): the override is the point.
	subarray(start?: number, end?: number): Buffer {
		return BufferHelper.make(super.subarray(start, end));
	}

	slice(start?: number, end?: number): Buffer {
		return this.subarray(start, end);
	}

	indexOf(value: string | number | Uint8Array, byteOffset = 0): number {
		if (typeof value === 'number') return super.indexOf(value, byteOffset);
		const needle = typeof value === 'string' ? encodeString(value) : value;
		outer: for (let at = byteOffset; at <= this.length - needle.length; at++) {
			for (let at2 = 0; at2 < needle.length; at2++) {
				if (this[at + at2] !== needle[at2]) continue outer;
			}
			return at;
		}
		return -1;
	}

	includes(value: string | number | Uint8Array, byteOffset = 0): boolean {
		return this.indexOf(value, byteOffset) !== -1;
	}

	equals(other: Uint8Array): boolean {
		if (this.length !== other.length) return false;
		for (let at = 0; at < this.length; at++) {
			if (this[at] !== other[at]) return false;
		}
		return true;
	}

	compare(other: Uint8Array): number {
		const shared = Math.min(this.length, other.length);
		for (let at = 0; at < shared; at++) {
			if (this[at]! !== other[at]!) return this[at]! - other[at]!;
		}
		return this.length - other.length;
	}

	write(text: string, offset = 0, encoding = 'utf8'): number {
		const bytes = encodeString(text, encoding);
		this.set(bytes, offset);
		return bytes.length;
	}

	readUInt8(offset = 0): number {
		return this[offset]!;
	}

	readUInt32LE(offset = 0): number {
		return (this[offset]! | (this[offset + 1]! << 8) | (this[offset + 2]! << 16) | (this[offset + 3]! << 24)) >>> 0;
	}

	readUInt32BE(offset = 0): number {
		return ((this[offset]! << 24) | (this[offset + 1]! << 16) | (this[offset + 2]! << 8) | this[offset + 3]!) >>> 0;
	}

	writeUInt32LE(value: number, offset = 0): void {
		this[offset] = value & 0xff;
		this[offset + 1] = (value >>> 8) & 0xff;
		this[offset + 2] = (value >>> 16) & 0xff;
		this[offset + 3] = (value >>> 24) & 0xff;
	}

	toJSON(): { type: 'Buffer'; data: number[] } {
		return { type: 'Buffer', data: [...this] };
	}
}

/** The statics, attached onto the class after its declaration (see the class doc). */
const BufferHelper = {
	make(source: Uint8Array): Buffer {
		return new BufferImpl(source as never);
	}
};

Object.assign(BufferImpl, {
	from: (input: string | ArrayLike<number> | ArrayBuffer | Uint8Array | { data: number[]; type?: string }, encoding = 'utf8'): Buffer => {
		if (typeof input === 'string') return BufferHelper.make(encodeString(input, encoding));
		if (input instanceof Uint8Array) return BufferHelper.make(input);
		if (input instanceof ArrayBuffer) return BufferHelper.make(new Uint8Array(input));
		if (Array.isArray(input)) return BufferHelper.make(new Uint8Array(input));
		if (input && typeof input === 'object' && 'data' in input && Array.isArray((input as { data: number[] }).data)) {
			return BufferHelper.make(new Uint8Array((input as { data: number[] }).data));
		}
		throw new TypeError('Buffer.from: unsupported input');
	},
	alloc: (size: number, fill: number | string = 0): Buffer => {
		const buffer = new BufferImpl(size);
		buffer.fill(fill);
		return buffer;
	},
	allocUnsafe: (size: number) => new BufferImpl(size),
	allocUnsafeSlow: (size: number) => new BufferImpl(size),
	of: (...bytes: number[]) => new BufferImpl(bytes as never),
	isBuffer: (value: unknown): value is Buffer => value instanceof BufferImpl,
	byteLength: (text: string, encoding = 'utf8') => encodeString(text, encoding).length,
	concat: (parts: (Uint8Array | Buffer)[]): Buffer => {
		const total = parts.reduce((sum, part) => sum + part.length, 0);
		const out = new BufferImpl(total);
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	},
	constants: { MAX_LENGTH: 0x7fffffff, MIN_LENGTH: 22 }
});

/** `Buffer` as extension code imports it: the class binding, typed by its factory surface. */
export const Buffer: BufferFactory = BufferImpl as unknown as BufferFactory;

/** Encode text by Node's encoding names (the three that actually appear: utf8, base64, hex). */
function encodeString(text: string, encoding = 'utf8'): Uint8Array {
	if (encoding === 'base64') {
		const binary = atob(text);
		const bytes = new Uint8Array(binary.length);
		for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
		return bytes;
	}
	if (encoding === 'hex') {
		const clean = text.length % 2 === 0 ? text : '0' + text;
		const bytes = new Uint8Array(clean.length / 2);
		for (let at = 0; at < bytes.length; at++) bytes[at] = parseInt(clean.slice(at * 2, at * 2 + 2), 16);
		return bytes;
	}
	return encoder.encode(text);
}

/* ---------- path: Node's two flavours, with the platform's own as the default ---------- */

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

const posixPath: PathApi = {
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
const win32Path: PathApi = {
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
const defaultPath = (platform: string): PathApi => {
	const api = platform === 'win32' ? win32Path : posixPath;
	return { ...api, posix: posixPath, win32: win32Path };
};

/* ---------- events: Node's EventEmitter ---------- */

/** Node's EventEmitter — the real semantics (once, prepend, listener bookkeeping, the
 *  `newListener`/`removeListener` notifications), because extension code subclasses it. */
export class EventEmitter {
	static defaultMaxListeners = 10;

	private readonly events = new Map<string | symbol, { listener: (...args: unknown[]) => unknown; once: boolean }[]>();
	private maxListeners = EventEmitter.defaultMaxListeners;

	setMaxListeners(n: number): this {
		this.maxListeners = n;
		return this;
	}

	getMaxListeners(): number {
		return this.maxListeners;
	}

	emit(event: string | symbol, ...args: unknown[]): boolean {
		const list = this.events.get(event);
		if (list === undefined || list.length === 0) return false;
		for (const entry of [...list]) {
			if (entry.once) {
				const at = list.indexOf(entry);
				if (at !== -1) list.splice(at, 1);
			}
			entry.listener(...args);
		}
		return true;
	}

	addListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		this.emit('newListener', event, listener);
		const list = this.events.get(event) ?? [];
		if (this.maxListeners !== 0 && list.length >= this.maxListeners && event !== 'newListener' && event !== 'removeListener') {
			console.warn(`(node) warning: possible EventEmitter memory leak detected. ${list.length + 1} ${String(event)} listeners added.`);
		}
		list.push({ listener, once: false });
		this.events.set(event, list);
		return this;
	}

	on(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		return this.addListener(event, listener);
	}

	once(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event) ?? [];
		list.push({ listener, once: true });
		this.events.set(event, list);
		return this;
	}

	prependListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event) ?? [];
		list.unshift({ listener, once: false });
		this.events.set(event, list);
		return this;
	}

	prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event) ?? [];
		list.unshift({ listener, once: true });
		this.events.set(event, list);
		return this;
	}

	removeListener(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		const list = this.events.get(event);
		if (list !== undefined) {
			const at = list.findIndex((entry) => entry.listener === listener);
			if (at !== -1) list.splice(at, 1);
			if (list.length === 0) this.events.delete(event);
		}
		this.emit('removeListener', event, listener);
		return this;
	}

	off(event: string | symbol, listener: (...args: unknown[]) => unknown): this {
		return this.removeListener(event, listener);
	}

	removeAllListeners(event?: string | symbol): this {
		if (event === undefined) this.events.clear();
		else this.events.delete(event);
		return this;
	}

	listeners(event: string | symbol): (() => unknown)[] {
		return (this.events.get(event) ?? []).map((entry) => entry.listener as () => unknown);
	}

	rawListeners(event: string | symbol): (() => unknown)[] {
		return this.listeners(event);
	}

	listenerCount(event: string | symbol): number {
		return (this.events.get(event) ?? []).length;
	}

	eventNames(): (string | symbol)[] {
		return [...this.events.keys()];
	}
}

/* ---------- util, assert, url, querystring, string_decoder, timers, punycode ---------- */

function inspectValue(value: unknown, depth = 2): string {
	if (typeof value === 'string') return depth === 2 ? `'${value}'` : value;
	if (value === null || value === undefined || typeof value !== 'object') return String(value);
	if (value instanceof Error) return `${(value as Error).name}: ${(value as Error).message}`;
	if (Array.isArray(value)) return depth <= 0 ? '[Array]' : `[ ${value.map((item) => inspectValue(item, depth - 1)).join(', ')} ]`;
	if (value instanceof Date) return value.toISOString();
	const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
	const entries = Object.entries(value as Record<string, unknown>);
	if (depth <= 0) return `[${name}]`;
	return `${name} { ${entries.slice(0, 20).map(([key, item]) => `${key}: ${inspectValue(item, depth - 1)}`).join(', ')}${entries.length > 20 ? ', …' : ''} }`;
}

const promisifyCustom = Symbol('util.promisify.custom');

const utilShim = {
	format(format?: unknown, ...values: unknown[]): string {
		if (typeof format !== 'string') return [format, ...values].map((value) => inspectValue(value)).join(' ');
		let at = 0;
		return format.replace(/%[sdifjoO%]/g, (token) => {
			if (token === '%%') return '%';
			if (at >= values.length) return token;
			const value = values[at++];
			if (token === '%d') return Number(value).toString();
			if (token === '%i') return parseInt(String(value), 10).toString();
			if (token === '%f') return parseFloat(String(value)).toString();
			if (token === '%j' || token === '%o' || token === '%O') return JSON.stringify(value);
			return String(value);
		}) + (at < values.length ? (values.length - at ? ' ' : '') + values.slice(at).map((value) => inspectValue(value)).join(' ') : '');
	},
	inspect: (value: unknown, options?: { depth?: number }) => inspectValue(value, options?.depth ?? 2),
	isArray: Array.isArray,
	isBoolean: (v: unknown) => typeof v === 'boolean',
	isNull: (v: unknown) => v === null,
	isNullOrUndefined: (v: unknown) => v === null || v === undefined,
	isNumber: (v: unknown) => typeof v === 'number',
	isString: (v: unknown) => typeof v === 'string',
	isSymbol: (v: unknown) => typeof v === 'symbol',
	isUndefined: (v: unknown) => v === undefined,
	isRegExp: (v: unknown) => v instanceof RegExp,
	isObject: (v: unknown) => v !== null && typeof v === 'object',
	isDate: (v: unknown) => v instanceof Date,
	isError: (v: unknown) => v instanceof Error,
	isFunction: (v: unknown) => typeof v === 'function',
	isPrimitive: (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
	isBuffer: (v: unknown) => Buffer.isBuffer(v),
	isDeepStrictEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
	deprecate: <T extends (...args: unknown[]) => unknown>(fn: T, message: string): T => {
		let warned = false;
		return ((...args: unknown[]) => {
			if (!warned) {
				warned = true;
				console.warn(`(deprecated) ${message}`);
			}
			return fn(...args);
		}) as T;
	},
	promisify: Object.assign(
		<T>(fn: (callback: (error: unknown, value: unknown) => void, ...args: unknown[]) => unknown): ((...args: unknown[]) => Promise<unknown>) =>
			Object.defineProperty((...args: unknown[]) => new Promise((resolve, reject) => {
				fn((error, value) => (error ? reject(error) : resolve(value)), ...args);
			}), promisifyCustom, { value: fn }),
		{ custom: promisifyCustom }
	),
	callbackify: (fn: (...args: unknown[]) => Promise<unknown>) => ((callback: (error: unknown, value?: unknown) => void, ...args: unknown[]) => {
		fn(...args).then((value) => callback(null, value), (error) => callback(error));
	}),
	inherit: (ctor: unknown, superCtor: unknown) => undefined,
	log: (message: string) => console.log(Date.now().toLocaleString() + ' - ' + message),
	types: {
		isPromise: (v: unknown) => v instanceof Promise,
		isDate: (v: unknown) => v instanceof Date,
		isRegExp: (v: unknown) => v instanceof RegExp,
		isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
		isMap: (v: unknown) => v instanceof Map,
		isSet: (v: unknown) => v instanceof Set,
		isTypedArray: (v: unknown) => ArrayBuffer.isView(v)
	},
	TextDecoder: TextDecoder as unknown,
	TextEncoder: TextEncoder as unknown,
	stripVTControlCharacters: (text: string) => text.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
};

function assertShim(truth: unknown, message?: string | Error): void {
	if (truth) return;
	throw typeof message === 'string' ? new Error(`Assertion failed: ${message}`) : message instanceof Error ? message : new Error('Assertion failed');
}

const assert = Object.assign(assertShim, {
	ok: assertShim,
	fail: (message?: string): never => {
		throw new Error(message ?? 'assert.fail');
	},
	equal: (a: unknown, b: unknown, message?: string) => assertShim(a == b, message ?? `${String(a)} == ${String(b)}`),
	notEqual: (a: unknown, b: unknown, message?: string) => assertShim(a != b, message ?? `${String(a)} != ${String(b)}`),
	strictEqual: (a: unknown, b: unknown, message?: string) => assertShim(a === b, message ?? `${String(a)} === ${String(b)}`),
	notStrictEqual: (a: unknown, b: unknown, message?: string) => assertShim(a !== b, message ?? `${String(a)} !== ${String(b)}`),
	deepEqual: (a: unknown, b: unknown, message?: string) => assertShim(JSON.stringify(a) === JSON.stringify(b), message ?? 'deep equal'),
	notDeepEqual: (a: unknown, b: unknown, message?: string) => assertShim(JSON.stringify(a) !== JSON.stringify(b), message ?? 'not deep equal'),
	deepStrictEqual: (a: unknown, b: unknown, message?: string) => assertShim(utilShim.isDeepStrictEqual(a, b), message ?? 'deep strict equal'),
	throws: (fn: () => unknown): void => {
		try {
			fn();
		} catch {
			return; // it threw — the assertion holds (the expected-shape checks do not steer extension code)
		}
		throw new Error('Missing expected exception');
	},
	doesNotThrow: (fn: () => unknown): void => {
		fn();
	}
});

const querystring = {
	parse: (text: string, sep = '&', eq = '='): Record<string, string | string[]> => {
		const out: Record<string, string | string[]> = {};
		for (const pair of text.split(sep)) {
			if (pair === '') continue;
			const at = pair.indexOf(eq);
			const key = decodeURIComponent(at === -1 ? pair : pair.slice(0, at)).replace(/\+/g, ' ');
			const value = at === -1 ? '' : decodeURIComponent(pair.slice(at + 1)).replace(/\+/g, ' ');
			const existing = out[key];
			if (existing === undefined) out[key] = value;
			else if (Array.isArray(existing)) existing.push(value);
			else out[key] = [existing, value];
		}
		return out;
	},
	stringify: (values: Record<string, unknown>, sep = '&', eq = '='): string =>
		Object.entries(values)
			.flatMap(([key, value]) => (Array.isArray(value) ? value.map((item) => [key, item] as const) : [[key, value] as const]))
			.map(([key, value]) => `${encodeURIComponent(key)}${eq}${encodeURIComponent(String(value))}`)
			.join(sep),
	escape: encodeURIComponent,
	unescape: (text: string) => decodeURIComponent(text.replace(/\+/g, ' ')),
	encode: encodeURIComponent,
	decode: (text: string) => decodeURIComponent(text.replace(/\+/g, ' '))
};

class StringDecoder {
	private readonly textDecoder: TextDecoder;
	constructor(encoding = 'utf8') {
		const name = encoding === 'utf8' || encoding === 'utf-8' || encoding === 'base64' ? 'utf-8'
			: encoding === 'utf16le' || encoding === 'ucs2' ? 'utf-16le'
			: encoding === 'binary' || encoding === 'latin1' ? 'latin1' : encoding;
		this.textDecoder = new TextDecoder(name);
	}
	write(buffer: Uint8Array): string {
		return this.textDecoder.decode(buffer, { stream: true });
	}
	end(buffer?: Uint8Array): string {
		return buffer === undefined ? this.textDecoder.decode() : this.textDecoder.decode(buffer);
	}
}

const timers = {
	setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => setTimeout(() => handler(...args), timeout),
	clearTimeout: (handle: unknown) => clearTimeout(handle as number),
	setInterval: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => setInterval(() => handler(...args), timeout),
	clearInterval: (handle: unknown) => clearInterval(handle as number),
	setImmediate: (handler: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => handler(...args), 0),
	clearImmediate: (handle: unknown) => clearTimeout(handle as number)
};

/** Node's legacy url module: parse/format/resolve over WHATWG's URL for the cases that
 *  matter (absolute http(s) URLs and plain paths). */
const urlShim = {
	URL: globalThis.URL,
	parse: (text: string, parseQueryString = false) => {
		try {
			const parsed = new URL(text, 'file:///');
			const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
			return {
				href: parsed.href,
				protocol: parsed.protocol,
				slashes: true,
				host: parsed.host,
				hostname: parsed.hostname,
				port: parsed.port,
				pathname: parsed.pathname,
				path: parsed.pathname + parsed.search,
				search: parsed.search,
				query: parseQueryString ? querystring.parse(query) : query,
				hash: parsed.hash
			};
		} catch {
			return { href: text, protocol: null, slashes: null, host: null, hostname: null, port: null, pathname: text, path: text, search: null, query: null, hash: null };
		}
	},
	format: (value: unknown) => {
		if (typeof value === 'string') return value;
		const parts = value as { protocol?: string; host?: string; pathname?: string; search?: string; hash?: string };
		const scheme = parts.protocol ?? 'https:';
		const base = `${parts.host ? `${scheme}//${parts.host}` : scheme}${parts.pathname ?? '/'}`;
		return base + (parts.search ?? '') + (parts.hash ?? '');
	},
	resolve: (from: string, to: string) => {
		try {
			return new URL(to, new URL(from, 'file:///')).href.replace('file:///', '/');
		} catch {
			return to;
		}
	},
	domainToASCII: (domain: string) => domain,
	domainToUnicode: (domain: string) => domain,
	pathToFileURL: (path: string) => new URL('file:///' + path.replace(/\\/g, '/').replace(/^\//, '')),
	fileURLToPath: (value: URL | string) => decodeURIComponent(String(value)).replace(/^file:\/\/\//, '').replace(/\//g, isWindows() ? '\\' : '/')
};

/* ---------- fs: the preload map synchronously, the workspace bridge asynchronously ---------- */

/** Normalize a path an extension handed `fs` into a package-relative map key, or `null`
 *  when it points outside the extension's install (the workspace bridge's world). */
function extensionRelative(path: string, host: ShimHost): string | null {
	const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
	const root = host.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	if (normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) {
		return normalized.slice(root.length + 1);
	}
	if (!normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)) return normalized;
	return null;
}

/** Every map key under a directory (the directory listing a synchronous `readdir` answers). */
function directoryEntries(dir: string, host: ShimHost): string[] | undefined {
	const prefix = dir === '' ? '' : dir.replace(/\/+$/, '') + '/';
	const names = new Set<string>();
	let any = false;
	for (const key of [...Object.keys(host.files), ...host.binaries]) {
		if (key.startsWith(prefix) && key.length > prefix.length) {
			any = true;
			names.add(key.slice(prefix.length).split('/')[0]!);
		}
	}
	return any ? [...names] : undefined;
}

/** Is this package-relative path one of the package's binary native modules? (Compared
 *  case-insensitively: the install sits on a case-insensitive filesystem on Windows.) */
function isBinary(rel: string, host: ShimHost): boolean {
	const folded = rel.toLowerCase();
	return host.binaries.some((candidate) => candidate.toLowerCase() === folded);
}

function fsError(code: string, message: string): Error {
	const error = new Error(`${code}: ${message}`);
	(error as { code?: string }).code = code;
	(error as { errno?: number }).errno = code === 'ENOENT' ? -2 : -13;
	return error;
}

function makeFs(host: ShimHost) {
	const mapFile = (path: string): string | undefined => {
		const rel = extensionRelative(path, host);
		return rel === null ? undefined : host.files[rel] ?? host.files[rel.replace(/^\/+/, '')!];
	};

	const fs = {
		readFileSync: (path: string, encoding?: string | { encoding?: string }): string | Buffer => {
			const text = mapFile(path);
			if (text === undefined) throw fsError('ENOENT', `no such file or directory, open '${path}'`);
			const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
			return enc === undefined || enc === 'buffer' ? Buffer.from(encoder.encode(text)) : text;
		},
		existsSync: (path: string): boolean => {
			const rel = extensionRelative(path, host);
			if (rel !== null) {
				if (host.files[rel] !== undefined) return true;
				if (isBinary(rel, host)) return true;
				return directoryEntries(rel, host) !== undefined;
			}
			return false;
		},
		statSync: (path: string) => {
			const rel = extensionRelative(path, host);
			if (rel === null) throw fsError('ENOENT', `no such file or directory, stat '${path}'`);
			const isDir = rel === '' || directoryEntries(rel, host) !== undefined;
			const text = host.files[rel];
			const binary = !isDir && text === undefined && isBinary(rel, host);
			if (!isDir && text === undefined && !binary) throw fsError('ENOENT', `no such file or directory, stat '${path}'`);
			const size = text === undefined ? 0 : encoder.encode(text).length;
			const stats = {
				isFile: () => !isDir,
				isDirectory: () => isDir,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isSymbolicLink: () => false,
				isFIFO: () => false,
				isSocket: () => false,
				size,
				blksize: 4096,
				blocks: Math.ceil(size / 512),
				atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
				atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
				dev: 0, ino: 0, mode: isDir ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0
			};
			return stats;
		},
		lstatSync: (path: string) => fs.statSync(path),
		readdirSync: (path: string): string[] => {
			const rel = extensionRelative(path, host);
			const names = rel === null ? undefined : directoryEntries(rel, host);
			if (names === undefined) throw fsError('ENOENT', `no such file or directory, scandir '${path}'`);
			return names;
		},
		/** The callback flavours: a package file answers synchronously from the map; a
		 *  workspace path goes through the bridge (confined there, as VS Code confines
		 *  `workspace.fs` to the open folders). */
		readdir: (path: string, cb: (error: Error | null, names?: string[]) => void) => {
			const rel = extensionRelative(path, host);
			const names = rel === null ? undefined : directoryEntries(rel, host);
			if (names !== undefined) {
				cb(null, names);
				return;
			}
			void host.bridge.request('fs.op', ['list', path]).then(
				(answer) => cb(null, ((answer as { name: string }[]) ?? []).map((entry) => entry.name)),
				(error) => cb(fsError('ENOENT', String(error)))
			);
		},
		stat: (path: string, cb: (error: Error | null, stats?: unknown) => void) => {
			try {
				cb(null, fs.statSync(path));
			} catch {
				void host.bridge.request('fs.op', ['stat', path]).then(
					(answer) => {
						const stat = answer as { type: number; size: number };
						cb(null, {
							isFile: () => stat.type === 1,
							isDirectory: () => stat.type === 2,
							isSymbolicLink: () => stat.type === 64,
							isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
							size: stat.size, blksize: 4096, blocks: Math.ceil(stat.size / 512),
							atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
							atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
							dev: 0, ino: 0, mode: stat.type === 2 ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0
						});
					},
					(error) => cb(fsError('ENOENT', String(error)))
				);
			}
		},
		readFile: (path: string, encodingOrCallback?: string | ((error: Error | null, data?: unknown) => void), maybeCallback?: (error: Error | null, data?: unknown) => void) => {
			const cb = (typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback)!;
			const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
			const text = mapFile(path);
			if (text === undefined) {
				// Not in the map: an extension-dir file the preload skipped, or a workspace
				// file — the host bridge reads workspace files (confined there, as in VS Code).
				void host.bridge.request('fs.op', ['read', path]).then(
					(answer) => cb(null, decodeBase64ToBuffer((answer as { data: string }).data, encoding)),
					(error) => cb(fsError('ENOENT', String(error)))
				);
				return;
			}
			cb(null, encoding === undefined ? Buffer.from(encoder.encode(text)) : text);
		},
		writeFile: (path: string, data: unknown, cb: (error: Error | null) => void) => {
			void host.bridge.request('fs.op', ['write', path, undefined, bufferToBase64(data)]).then(
				() => cb(null),
				(error) => cb(fsError('EACCES', `cannot write '${path}' here: ${String(error)}`))
			);
		},
		mkdir: (path: string, cb: (error: Error | null) => void) => void host.bridge.request('fs.op', ['mkdir', path]).then(() => cb(null), (error) => cb(error as Error)),
		/** The map has no directories to create; an existing directory (any file beneath
		 *  it) succeeds silently — the `if (!existsSync(dir)) mkdirSync(dir)` shape every
		 *  activation-time setup uses — and anything else fails with its reason. */
		mkdirSync: (path: string, options?: { recursive?: boolean }): void => {
			const rel = extensionRelative(path, host);
			if (rel !== null && (rel === '' || directoryEntries(rel, host) !== undefined)) return;
			if (options?.recursive === true) return;
			throw fsError('EACCES', `cannot create directory '${path}' in the Git Graph Studio extension host`);
		},
		appendFile: (path: string, data: unknown, cb: (error: Error | null) => void) => {
			const existing = mapFile(path);
			const text = existing === undefined ? '' : existing;
			void host.bridge.request('fs.op', ['write', path, undefined, bufferToBase64(text + String(data))]).then(() => cb(null), (error) => cb(error as Error));
		},
		unlink: (path: string, cb: (error: Error | null) => void) => void host.bridge.request('fs.op', ['delete', path]).then(() => cb(null), (error) => cb(error as Error)),
		rmdir: (path: string, cb: (error: Error | null) => void) => void host.bridge.request('fs.op', ['delete', path]).then(() => cb(null), (error) => cb(error as Error)),
		copyFile: (from: string, to: string, cb: (error: Error | null) => void) => {
			const text = mapFile(from);
			if (text === undefined) return void cb(fsError('ENOENT', `no such file or directory, copy '${from}'`));
			void host.bridge.request('fs.op', ['write', to, undefined, bufferToBase64(text)]).then(() => cb(null), (error) => cb(error as Error));
		},
		createReadStream: () => {
			throw new Error('fs.createReadStream is not supported by the Git Graph Studio extension host');
		},
		/** File descriptors need real file handles the sandboxed frame has not got: an `open`
		 *  fails at call time with the reason (a binary viewer built on `fs.read` degrades,
		 *  an activation that never opens one does not notice). */
		open: callThrowsFn('fs.open') as never,
		read: callThrowsFn('fs.read') as never,
		close: callThrowsFn('fs.close') as never,
		fstat: callThrowsFn('fs.fstat') as never,
		/** A watch needs the host's file-event stream, which this frame does not receive;
		 *  the watcher answers nothing rather than failing the subscribe (VS Code's own
		 *  `createFileSystemWatcher` is the API extension code should prefer, and the shim
		 *  serves that). */
		watch: ((_target: unknown, _listenerOrOptions?: unknown) => ({
			close: () => undefined,
			add: () => undefined,
			unwatch: () => undefined,
			on: () => ({ close: () => undefined }),
			addListener: () => ({ close: () => undefined })
		})) as never,
		watchFile: (() => {
			const noop = () => ({ removeListener: () => undefined, close: () => undefined });
			return (target: unknown, listener: unknown) => {
				if (typeof listener === 'function') {
					// A registered callback that never fires is the honest degradation of "the
					// frame receives no file events"; firing it falsely would be worse.
				}
				return noop();
			};
		})() as never,
		unwatchFile: (): void => undefined,
		constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
		promises: null as unknown
	};
	fs.promises = {
		readFile: (path: string, encoding?: string) => new Promise<unknown>((resolve, reject) => fs.readFile(path, encoding, (error, data) => (error ? reject(error) : resolve(data)))),
		writeFile: (path: string, data: unknown) => new Promise<void>((resolve, reject) => fs.writeFile(path, data, (error) => (error ? reject(error) : resolve()))),
		stat: (path: string) => new Promise<unknown>((resolve, reject) => {
			try {
				resolve(fs.statSync(path));
			} catch (error) {
				reject(error);
			}
		}),
		readdir: (path: string) => new Promise<unknown>((resolve, reject) => {
			try {
				resolve(fs.readdirSync(path));
			} catch (error) {
				reject(error);
			}
		}),
		mkdir: (path: string) => new Promise<void>((resolve, reject) => fs.mkdir(path, (error) => (error ? reject(error) : resolve()))),
		unlink: (path: string) => new Promise<void>((resolve, reject) => fs.unlink(path, (error) => (error ? reject(error) : resolve())))
	};
	return fs;
}

function bufferToBase64(data: unknown): string {
	if (typeof data === 'string') {
		let binary = '';
		const bytes = encoder.encode(data);
		for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
		return btoa(binary);
	}
	const bytes = data as Uint8Array;
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

function decodeBase64ToBuffer(base64: string, encoding?: string): unknown {
	let binary = '';
	try {
		binary = atob(base64);
	} catch {
		binary = base64;
	}
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	if (encoding === undefined) return new Buffer(bytes);
	return new TextDecoder(encoding === 'utf-8' ? 'utf-8' : encoding).decode(bytes);
}

/* ---------- crypto: what can be real (random bytes), and honest failures elsewhere ---------- */

const cryptoShim = {
	getRandomValues: (array: Uint8Array) => crypto.getRandomValues(array),
	randomBytes: (size: number): Buffer => {
		const bytes = new Uint8Array(size);
		crypto.getRandomValues(bytes);
		return new Buffer(bytes);
	},
	randomFillSync: (buffer: Uint8Array): Uint8Array => {
		crypto.getRandomValues(buffer);
		return buffer;
	},
	timingSafeEqual: (a: Uint8Array, b: Uint8Array): boolean => {
		if (a.length !== b.length) throw new RangeError('Buffers must be the same length');
		let diff = 0;
		for (let at = 0; at < a.length; at++) diff |= a[at]! ^ b[at]!;
		return diff === 0;
	},
	webcrypto: crypto as unknown,
	subtle: crypto.subtle,
	createHash: callThrowsFn('crypto.createHash'),
	createHmac: callThrowsFn('crypto.createHmac'),
	createCipheriv: callThrowsFn('crypto.createCipheriv'),
	createDecipheriv: callThrowsFn('crypto.createDecipheriv'),
	createSign: callThrowsFn('crypto.createSign'),
	createVerify: callThrowsFn('crypto.createVerify')
};

/* ---------- The modules that exist only to fail at call time ---------- */

/** A function whose every call fails with a clear reason — the require succeeds, the use
 *  does not (a spawn an extension never performs must not kill its activation). */
function callThrowsFn(name: string): () => never {
	return () => {
		throw new Error(`${name} is not supported by the Git Graph Studio extension host (extensions run in a sandboxed frame; a package that needs real processes declares a ggs backend)`);
	};
}

/** An object whose every property is a call-time failure — `require('child_process')`
 *  answers it, and any use of any member says why. Promise/bundler protocol members
 *  (`then`, `default`, `__esModule`) read as absent so an accidental `await` or interop
 *  probe does not trip the failure. */
function unavailableModule(name: string): Record<string, never> {
	return new Proxy({}, {
		get: (_target, member) => {
			if (member === 'then' || member === 'default' || member === '__esModule') return undefined;
			if (member === Symbol.toPrimitive || member === 'toString') return () => `[${name}]`;
			return callThrowsFn(`${name}.${String(member)}`);
		}
	}) as Record<string, never>;
}

/* ---------- os and the process global ---------- */

function makeOs(host: ShimHost) {
	const env = host.nodeEnv;
	return {
		EOL: env.eol,
		arch: () => env.arch,
		platform: () => env.platform,
		homedir: () => env.homedir,
		tmpdir: () => env.tmpdir,
		hostname: () => env.hostname,
		release: () => env.release,
		type: () => 'Windows_NT',
		endianness: () => 'LE',
		freemem: () => 0,
		totalmem: () => 0,
		uptime: () => 0,
		loadavg: () => [0, 0, 0],
		cpus: () => [] as unknown[],
		networkInterfaces: () => ({}) as Record<string, unknown[]>,
		constants: { 
			UV_UDP_REUSEADDR: 1, 
			stdio: { 
				STDIN_FILENO: 0, 
				STDOUT_FILENO: 1, 
				STDERR_FILENO: 2 
			} 
		}
	};
}

/** The `process` global, as extension code reads it: the platform word, a production
 *  `env`, nextTick, and inert stdio streams (a sandboxed frame has no console of its own —
 *  writes go to the frame's console, which the host surfaces). */
function makeProcess(host: ShimHost): Record<string, unknown> {
	const env = host.nodeEnv;
	const listeners = new EventEmitter();
	return {
		platform: env.platform,
		arch: env.arch,
		env: {
			NODE_ENV: 'production',
			HOME: env.homedir,
			USERPROFILE: env.homedir,
			TEMP: env.tmpdir,
			TMP: env.tmpdir,
			COMPUTERNAME: env.hostname,
			HOSTNAME: env.hostname,
			OS: 'Windows_NT',
			APPDATA: env.platform === 'win32' ? env.homedir.replace(/[\\/]+$/, '') + '/AppData/Roaming' : env.homedir,
			VSCODE_PID: '0',
			VSCODE_CWD: host.extensionPath,
			ELECTRON_RUN_AS_NODE: '1'
		},
		argv: ['node', host.extensionPath + '/extension.js'],
		argv0: 'node',
		execPath: 'node',
		execArgv: [] as string[],
		pid: 1,
		ppid: 0,
		title: 'node',
		version: 'v20.11.1',
		versions: { node: '20.11.1', v8: '11.3.414.16-node.15', uv: '1.46.0', zlib: '1.2.13' },
		features: { uv: true, worker: false, inspector: false },
		nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
			queueMicrotask(() => fn(...args));
		},
		cwd: () => host.extensionPath,
		chdir: callThrowsFn('process.chdir'),
		exit: ((code?: number) => {
			console.warn(`extension called process.exit(${code ?? 0}) — ignored by the extension host frame`);
			return undefined as never;
		}) as unknown as (code?: number) => never,
		hrtime: Object.assign(
			(time?: [number, number]): [number, number] => {
				const now = performance.now() * 1e-3;
				if (time === undefined) return [Math.floor(now), Math.floor((now % 1) * 1e9)];
				const previous = time[0]! + time[1]! / 1e9;
				const diff = Math.max(0, now - previous);
				return [Math.floor(diff), Math.floor((diff % 1) * 1e9)];
			},
			{ bigint: () => BigInt(Math.round(performance.now() * 1e6)) }
		),
		uptime: () => performance.now() / 1000,
		memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
		stdout: makeStdio('stdout'),
		stderr: makeStdio('stderr'),
		stdin: { on: () => undefined, read: () => null, pipe: () => undefined },
		on: listeners.on.bind(listeners) as never,
		once: listeners.once.bind(listeners) as never,
		off: listeners.off.bind(listeners) as never,
		removeListener: listeners.off.bind(listeners) as never,
		addListener: listeners.on.bind(listeners) as never,
		emit: listeners.emit.bind(listeners) as never,
		listeners: listeners.listeners.bind(listeners) as never,
		browser: false,
		connected: true,
		type: 'renderer'
	};
}

function makeStdio(name: 'stdout' | 'stderr'): Record<string, unknown> {
	const write = (chunk: unknown): boolean => {
		const text = typeof chunk === 'string' ? chunk : String(chunk);
		(name === 'stdout' ? console.log : console.error).call(console, text.replace(/\n$/, ''));
		return true;
	};
	return {
		write,
		fd: name === 'stdout' ? 1 : 2,
		columns: 120,
		rows: 30,
		isTTY: false,
		on: () => undefined,
		once: () => undefined,
		end: write as never,
		destroy: () => undefined
	};
}

/* ---------- The assembly ---------- */

/** Build every builtin shim for one activation. The `module` shim needs the loader's
 *  `require`, which itself needs these shims — it is filled in by the caller afterwards. */
export function createNodeBuiltins(host: ShimHost): Record<string, unknown> {
	const path = defaultPath(host.nodeEnv.platform);
	const fs = makeFs(host);
	const builtins: Record<string, unknown> = {
		path,
		os: makeOs(host),
		events: Object.assign(EventEmitter, { EventEmitter, defaultMaxListeners: 10 }),
		util: utilShim,
		assert,
		url: urlShim,
		querystring,
		string_decoder: { StringDecoder },
		timers,
		fs,
		'fs/promises': fs.promises,
		crypto: cryptoShim,
		buffer: { Buffer, INSPECT_MAX_BYTES: 512, kMaxLength: 0x7fffffff },
		process: makeProcess(host),
		console,                    // Node re-exports the console; so does the frame
		perf_hooks: { performance },
		'string_decoder/': { StringDecoder },
		zlib: unavailableModule('zlib'),
		child_process: unavailableModule('child_process'),
		net: unavailableModule('net'),
		http: unavailableModule('http'),
		https: unavailableModule('https'),
		tls: unavailableModule('tls'),
		dns: unavailableModule('dns'),
		dgram: unavailableModule('dgram'),
		cluster: unavailableModule('cluster'),
		readline: unavailableModule('readline'),
		repl: unavailableModule('repl'),
		vm: unavailableModule('vm'),
		stream: { PassThrough: class {}, Transform: class {}, Readable: class {}, Writable: class {}, Duplex: class {}, finished: callThrowsFn('stream.finished'), pipeline: callThrowsFn('stream.pipeline') },
		worker_threads: { isMainThread: true, threadId: 0, parentPort: null, workerData: null, Worker: callThrowsFn('worker_threads.Worker') },
		async_hooks: { createHook: () => ({ enable: () => undefined, disable: () => undefined }), executionAsyncId: () => 0, triggerAsyncId: () => 0 },
		v8: { getHeapStatistics: () => ({}), setFlagsFromString: () => undefined },
		inspector: { open: () => undefined, close: () => undefined, url: '' },
		'diagnostics_channel': { channel: () => ({ subscribe: () => undefined, publish: () => undefined }) },
		trace_events: { createTracing: () => ({ enable: () => undefined, disable: () => undefined }) },
		constants: {},
		sys: utilShim,
		module: undefined as unknown  // filled by installNodeGlobals (needs the loader's require)
	};
	return builtins;
}

/** Install the globals extension code assumes exist in a Node process: `process`, `Buffer`,
 *  `setImmediate`/`clearImmediate`, and `global` itself (webpack targets reference it). */
export function installNodeGlobals(host: ShimHost, builtins: Record<string, unknown>, nodeRequire: (request: string) => unknown): void {
	const globals = globalThis as unknown as Record<string, unknown>;
	if (globals.process === undefined) globals.process = builtins.process;
	if (globals.Buffer === undefined) globals.Buffer = Buffer;
	if (globals.setImmediate === undefined) {
		globals.setImmediate = (handler: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => handler(...args), 0);
		globals.clearImmediate = (handle: unknown) => clearTimeout(handle as number);
	}
	if (globals.global === undefined) globals.global = globalThis;
	builtins.module = {
		createRequire: () => nodeRequire,
		builtinModules: Object.keys(builtins),
		Module: class Module {
			constructor(readonly id: string) {}
			static _load: (request: string) => unknown = nodeRequire;
		},
		runMain: callThrowsFn('module.runMain')
	};
}
