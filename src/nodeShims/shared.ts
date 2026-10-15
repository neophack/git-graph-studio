// Primitives shared by the shim modules: the EventEmitter, the deliberate-failure helpers,
// the next-tick shim, and the Buffer byte container with its factory — the types and the
// value every shim module (and the barrel's own surfaces) consume without importing the
// barrel back (plan §5.4 — the `nodeShims ⇄ processSurfaces` cycle's type edge).

import type { NodeEnv } from '../extModuleLoader';

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

/* ---------- The modules that exist only to fail at call time ---------- */

/** Where a deliberate call-time failure is reported before it throws: the frame boot
 *  wires it to the extension-host log, so a package that catches the error and carries on
 *  silently still leaves a line saying which Node surface it reached for. */
let shimFailureReporter: ((message: string, level?: 'trace' | 'debug' | 'info' | 'warn' | 'error') => void) | null = null;

export function setShimFailureReporter(reporter: ((message: string, level?: 'trace' | 'debug' | 'info' | 'warn' | 'error') => void) | null): void {
	shimFailureReporter = reporter;
}

/** Report one unsupported-surface use (never throws — logging must not add a failure). */
export function reportShimFailure(message: string): void {
	traceShim('warn', message);
}

/** One line into the extension host log at a level (the fork bridge's wire trace, a
 *  server's stderr) — silent when no host wired the reporter. */
export function traceShim(level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string): void {
	try {
		shimFailureReporter?.(message, level);
	} catch {
		// the reporter's own failure is not the extension's problem
	}
}

/** A function whose every call fails with a clear reason — the require succeeds, the use
 *  does not (a spawn an extension never performs must not kill its activation). */
export function callThrowsFn(name: string): () => never {
	return () => {
		const message = `${name} is not supported by the Git Graph Studio extension host (this extension runs in a sandboxed frame; installing the package again — or its next version — derives the fuller runtime its code asks for)`;
		reportShimFailure(message);
		throw new Error(message);
	};
}

/** An object whose every property is a call-time failure — `require('child_process')`
 *  answers it, and any use of any member says why. Promise/bundler protocol members
 *  (`then`, `default`, `__esModule`) read as absent so an accidental `await` or interop
 *  probe does not trip the failure. */
export function unavailableModule(name: string): Record<string, never> {
	return new Proxy({}, {
		get: (_target, member) => {
			if (member === 'then' || member === 'default' || member === '__esModule') return undefined;
			if (member === Symbol.toPrimitive || member === 'toString') return () => `[${name}]`;
			return callThrowsFn(`${name}.${String(member)}`);
		}
	}) as Record<string, never>;
}


export function processNextTick(fn: () => void): void {
	Promise.resolve().then(fn);
}

/** What the shims need: the environment facts, the preloaded code map, and the bridge. */
export interface ShimHost {
	nodeEnv: NodeEnv;
	extensionPath: string;
	/** Package-relative ('/'-separated) path -> text, the activation preload. */
	files: Record<string, string>;
	/** The package's binary native modules (`.node`), as package-relative paths: `fs` sees
	 *  them (exists/stat/list), the module loader serves them as native proxies. */
	binaries: string[];
	/** The host bridge (`fs.op` is the one fs escape, workspace-confined on the Rust side;
	 *  `childProcess.*` is the other — the frame's real spawned tools, streamed back as
	 *  `__studioExtHostEvent` pushes the boot layer fans out to the handlers below). */
	bridge: {
		request(method: string, args: unknown[]): Promise<unknown>;
		onChildEvent?(handler: (message: { handle: number; event: string; data?: string; code?: number | null }) => void): () => void;
	};
	/** Binary files of the package (`.wasm` payloads), base64-encoded, keyed
	 *  package-relative — `readFileSync` serves them synchronously from this preload. */
	blobs?: Record<string, string>;
}

export const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `true` when the host is Windows — the host's own word (`process.platform`), not the
 *  browser's, is what Node-flavoured code branches on. Read lazily through the shim host
 *  where one is in scope; the module-level default answers from the user agent, which is
 *  only the right guess in a real WebView2 (jsdom answers empty). */
export const isWindows = (): boolean => {
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
export interface BufferFactory {
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
		// A typed array from another realm (a Node TextEncoder's Uint8Array reaching code
		// evaluated under jsdom) fails `instanceof` — duck-type the one thing a byte view
		// is: numeric length plus `set`.
		if (input && typeof input === 'object' && typeof (input as { length?: unknown }).length === 'number' && typeof (input as { set?: unknown }).set === 'function') {
			return BufferHelper.make(input as unknown as Uint8Array);
		}
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

/** Encode text by Node's encoding names (the ones that actually appear: utf8, base64,
 *  hex, and latin1/binary for the digest hashes' one-byte-per-char spelling). */
export function encodeString(text: string, encoding = 'utf8'): Uint8Array {
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
	if (encoding === 'latin1' || encoding === 'binary') {
		const bytes = new Uint8Array(text.length);
		for (let at = 0; at < text.length; at++) bytes[at] = text.charCodeAt(at) & 0xff;
		return bytes;
	}
	return encoder.encode(text);
}
