// The small builtins bag: `util` (inspect, promisify, formats), `assert`,
// `querystring`, `string_decoder` and `timers` — one file, each a table the
// module map serves.

import { Buffer, isWindows } from './shared';

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

/** The errno names every shim surface that exposes constants answers (`constants`,
 *  `os.constants.errno`): packages probe a name (`EBADF`) far more often than they trust
 *  a number, and the numbers follow the errno convention where a number is read. */

export const utilShim = {
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
	// The legacy prototype chain helper: packages compiled against old TypeScript or
	// relying on `util.inherits` at module-eval time (ms-python's tree sitter layer) call it
	// eagerly, so it must exist, not throw.
	inherits(ctor: { prototype: unknown; super_?: unknown }, superCtor: { prototype: unknown }): void {
		if (ctor === undefined || ctor === null) throw new TypeError('The constructor to `inherits` must not be null or undefined.');
		if (superCtor === undefined || superCtor === null) throw new TypeError('The super constructor to `inherits` must not be null or undefined.');
		Object.setPrototypeOf(ctor.prototype as object, superCtor.prototype as object);
		ctor.super_ = superCtor;
	},
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

export const assert = Object.assign(assertShim, {
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

export const querystring = {
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


export class StringDecoder {
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

export const timers = {
	setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => setTimeout(() => handler(...args), timeout),
	clearTimeout: (handle: unknown) => clearTimeout(handle as number),
	setInterval: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => setInterval(() => handler(...args), timeout),
	clearInterval: (handle: unknown) => clearInterval(handle as number),
	setImmediate: (handler: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => handler(...args), 0),
	clearImmediate: (handle: unknown) => clearTimeout(handle as number)
};

/** Node's legacy url module: parse/format/resolve over WHATWG's URL for the cases that
 *  matter (absolute http(s) URLs and plain paths). */

export const urlShim = {
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
