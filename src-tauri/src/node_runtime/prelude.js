// The pretend Node runtime's JavaScript half: the pieces that are far shorter in JS than in
// Rust — console, EventEmitter, Buffer, timers, util.format, `process`, and the two
// compatibility stubs (`vscode`, the frame host's API) — layered over the `__ggs*` native
// functions `builtins.rs` registers. Everything here runs before the package's own entry,
// in the same global object; nothing here is the package's protocol (that is `ggs`, also
// assembled below over its natives).

/* ---------- console: everything is stderr (stdout is the ggs-ext/1 protocol) ---------- */
(() => {
	const emit = (level, args) => {
		try {
			__ggsEmitLog(level, util.format(...args));
		} catch {
			/* a log must never take the runtime down */
		}
	};
	const make = (level) => (...args) => emit(level, args);
	globalThis.console = {
		log: make('log'),
		info: make('info'),
		warn: make('warn'),
		error: make('error'),
		debug: make('debug'),
		trace: make('debug'),
		assert(cond, ...args) {
			if (!cond) throw new Error(`Assertion failed: ${util.format(...args)}`);
		}
	};
})();

/* ---------- the standard-library gaps Boa leaves: Date's locale methods ---------- */
/* Boa 0.20 answers Date's toLocale* family with a `Function Unimplemented` throw, and
   package code written against Node calls them freely (git-graph-rs formats its commit
   search's pick details with `new Date(...).toLocaleString()`). Each one the native
   implementation cannot serve is replaced by the shape of the non-locale method Boa does
   implement — not a localised rendering, but a string where the throw was. */
(() => {
	const day = (date) => date.toDateString();
	const clock = (date) => date.toTimeString().slice(0, 8);
	const shapes = {
		toLocaleString: (date) => `${day(date)}, ${clock(date)}`,
		toLocaleDateString: day,
		toLocaleTimeString: clock
	};
	for (const [name, shape] of Object.entries(shapes)) {
		try {
			new Date(0)[name]();
		} catch {
			Date.prototype[name] = function () {
				return shape(this);
			};
		}
	}
})();

/* ---------- util: format, inspect, promisify, inherits ---------- */
(() => {
	const formatValue = (value) => {
		if (typeof value === 'string') return value;
		if (value instanceof Error) return value.stack || String(value);
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	};
	const format = (f, ...args) => {
		if (typeof f !== 'string') return [f, ...args].map(formatValue).join(' ');
		let out = '';
		let argIndex = 0;
		for (let i = 0; i < f.length; i += 1) {
			const ch = f[i];
			if (ch !== '%' || i + 1 >= f.length || argIndex >= args.length) {
				out += ch;
				continue;
			}
			const spec = f[i + 1];
			const value = args[argIndex];
			let consumed = true;
			switch (spec) {
				case 's': out += String(value); break;
				case 'd': case 'i': out += String(Math.trunc(Number(value))); break;
				case 'f': out += String(Number(value)); break;
				case 'j': case 'o': case 'O': out += formatValue(value); break;
				case '%': out += '%'; consumed = false; break;
				default: out += ch + spec; consumed = false;
			}
			if (consumed) argIndex += 1;
			i += 1;
		}
		for (; argIndex < args.length; argIndex += 1) out += (out.endsWith(' ') ? '' : ' ') + formatValue(args[argIndex]);
		return out;
	};
	Object.assign(globalThis.util = {}, {
		format,
		inspect: (value) => formatValue(value),
		promisify(fn) {
			const promisified = (...args) =>
				new Promise((resolve, reject) => {
					fn(...args, (error, result) => (error ? reject(error) : resolve(result)));
				});
			promisified.original = fn;
			return promisified;
		},
		inherits(ctor, superCtor) {
			Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
		},
		deprecate(fn, message) {
			return fn;
		},
		callbackify(fn) {
			return (...args) => {
				const cb = args.pop();
				fn(...args).then(
					(result) => cb(null, result),
					(error) => cb(error)
				);
			};
		}
	});
})();

/* ---------- EventEmitter + process ---------- */
(() => {
	/* A plain constructor function, not a class: pre-class libraries subclass it the
	 * Node way — `EventEmitter.call(this)` + `util.inherits(Child, EventEmitter)` — and a
	 * class constructor throws when called without `new`. The listener table is created on
	 * first use too, so a subclass that never calls the constructor still works. */
	function EventEmitter() {
		if (this && typeof this === 'object') this._events = new Map();
	}
	const table = (emitter) => {
		if (!(emitter._events instanceof Map)) emitter._events = new Map();
		return emitter._events;
	};
	Object.assign(EventEmitter.prototype, {
		on(event, fn) {
			this._add(event, fn, false, false);
			return this;
		},
		addListener(event, fn) {
			return this.on(event, fn);
		},
		once(event, fn) {
			this._add(event, fn, true, false);
			return this;
		},
		prependListener(event, fn) {
			this._add(event, fn, false, true);
			return this;
		},
		prependOnceListener(event, fn) {
			this._add(event, fn, true, true);
			return this;
		},
		off(event, fn) {
			return this.removeListener(event, fn);
		},
		removeListener(event, fn) {
			const events = table(this);
			const list = events.get(event);
			if (!list) return this;
			const at = list.findIndex(([wrapped, original]) => wrapped === fn || original === fn);
			if (at >= 0) list.splice(at, 1);
			if (list.length === 0) events.delete(event);
			return this;
		},
		removeAllListeners(event) {
			if (event === undefined) table(this).clear();
			else table(this).delete(event);
			return this;
		},
		emit(event, ...args) {
			const list = table(this).get(event);
			if (!list || list.length === 0) {
				if (event === 'error') throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${String(args[0])})`);
				return false;
			}
			for (const [wrapped] of [...list]) wrapped.apply(this, args);
			return true;
		},
		listenerCount(event) {
			return table(this).get(event)?.length ?? 0;
		},
		listeners(event) {
			return (table(this).get(event) ?? []).map(([, original]) => original);
		},
		rawListeners(event) {
			return (table(this).get(event) ?? []).map(([wrapped]) => wrapped);
		},
		eventNames() {
			return [...table(this).keys()];
		},
		setMaxListeners() {
			return this;
		},
		getMaxListeners() {
			return EventEmitter.defaultMaxListeners;
		},
		_add(event, fn, once, prepend) {
			if (typeof fn !== 'function') throw new TypeError('listener must be a function');
			const events = table(this);
			// Node announces every addition before it lands.
			if (events.has('newListener') && event !== 'newListener') this.emit('newListener', event, fn);
			const emitter = this;
			const wrapped = once
				? function (...args) {
					emitter.removeListener(event, wrapped);
					return fn.apply(this, args);
				}
				: fn;
			const list = events.get(event) ?? [];
			if (prepend) list.unshift([wrapped, fn]);
			else list.push([wrapped, fn]);
			events.set(event, list);
		}
	});
	EventEmitter.EventEmitter = EventEmitter;
	EventEmitter.defaultMaxListeners = 10;
	EventEmitter.errorMonitor = Symbol('events.errorMonitor');
	EventEmitter.captureRejections = false;
	EventEmitter.setMaxListeners = () => {};
	EventEmitter.listenerCount = (emitter, event) => emitter.listenerCount(event);
	/* `events.once(emitter, name)`: the promise of the next emission's arguments. */
	EventEmitter.once = (emitter, event) =>
		new Promise((resolve, reject) => {
			const onEvent = (...args) => {
				if (event !== 'error') emitter.removeListener('error', onError);
				resolve(args);
			};
			const onError = (error) => {
				emitter.removeListener(event, onEvent);
				reject(error);
			};
			emitter.once(event, onEvent);
			if (event !== 'error') emitter.once('error', onError);
		});
	globalThis.EventEmitter = EventEmitter;

	const meta = __ggsProcessMeta();
	const process = new EventEmitter();
	Object.assign(process, {
		argv: meta.argv,
		env: meta.env,
		pid: meta.pid,
		platform: meta.platform,
		arch: meta.arch,
		version: meta.version,
		versions: { node: meta.version, ggs: 'node-runtime' },
		execPath: meta.execPath,
		cwd: __ggsProcessCwd,
		exit(code) {
			throw new __GgsExitError(code ?? 0);
		},
		nextTick(fn, ...args) {
			if (typeof fn !== 'function') throw new TypeError('nextTick needs a function');
			Promise.resolve().then(() => fn(...args));
		},
		umask: () => 0o022,
		chdir: () => {
			throw new Error('process.chdir is not supported by the ggs-node runtime');
		},
		hrtime: {
			bigint: () => BigInt(Math.round(__ggsProcessNow() * 1e6))
		},
		stdout: { write: (chunk) => { console.log(String(chunk)); return true; }, isTTY: false },
		stderr: { write: (chunk) => { console.error(String(chunk)); return true; }, isTTY: false },
		browser: false
	});
	globalThis.process = process;
	globalThis.__GgsExitError = class extends Error {
		constructor(code) {
			super(`process.exit(${code})`);
			this.code = code;
			this.__ggsExit = true;
		}
	};
})();

/* ---------- timers ---------- */
(() => {
	globalThis.setTimeout = (fn, ms, ...args) => __ggsSetTimeout(fn, Number(ms) || 0, false, args);
	globalThis.setInterval = (fn, ms, ...args) => __ggsSetTimeout(fn, Number(ms) || 1, true, args);
	globalThis.clearTimeout = (id) => { if (id !== undefined && id !== null) __ggsClearTimeout(Number(id)); };
	globalThis.clearInterval = globalThis.clearTimeout;
	globalThis.setImmediate = (fn, ...args) => __ggsSetTimeout(fn, 0, false, args);
	globalThis.clearImmediate = globalThis.clearTimeout;
	globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn);
})();

/* ---------- crypto: createHash over the Rust digest (md5 / sha1 / sha256) ---------- */
(() => {
	const partsToBytes = (parts) => {
		let length = 0;
		for (const part of parts) length += part.length;
		const out = new Uint8Array(length);
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	};
	const asBytes = (data) => {
		if (typeof data === 'string') return new Uint8Array(__ggsUtf8Encode(data));
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		return new Uint8Array(0);
	};
	const HEX = '0123456789abcdef';
	const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	globalThis.crypto = {
		createHash(algorithm) {
			const parts = [];
			return {
				update(data) {
					parts.push(asBytes(data));
					return this;
				},
				digest(encoding) {
					const hex = __ggsDigestHex(String(algorithm), partsToBytes(parts));
					if (encoding === 'hex') return hex;
					if (encoding === 'base64') {
						const bytes = new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
						let out = '';
						for (let at = 0; at < bytes.length; at += 3) {
							const b0 = bytes[at], b1 = bytes[at + 1], b2 = bytes[at + 2];
							out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
							out += b1 === undefined ? '' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
							out += b2 === undefined ? '' : B64[b2 & 63];
						}
						return out + '='.repeat((3 - (bytes.length % 3)) % 3);
					}
					if (encoding === 'binary' || encoding === 'latin1') {
						return hex.match(/../g).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
					}
					// 'buffer' and undefined: the digest bytes as a Buffer, Node's default.
					const bytes = new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
					return new globalThis.__ggsBufferClass(bytes);
				}
			};
		},
		// The random surfaces, over the OS generator (`__ggsRandomBytes`): Node's
		// randomBytes (sync, or with a callback), randomUUID (RFC 4122 v4) and the Web
		// Crypto getRandomValues — uuid-class libraries call them at module load.
		randomBytes(size, callback) {
			const bytes = new globalThis.__ggsBufferClass(new Uint8Array(__ggsRandomBytes(Number(size) || 0)));
			if (typeof callback === 'function') {
				Promise.resolve().then(() => callback(null, bytes));
				return undefined;
			}
			return bytes;
		},
		randomFillSync(target) {
			const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
			view.set(new Uint8Array(__ggsRandomBytes(view.length)));
			return target;
		},
		randomInt(min, max) {
			if (max === undefined) {
				max = min;
				min = 0;
			}
			const word = new Uint32Array(new Uint8Array(__ggsRandomBytes(4)).buffer)[0];
			return min + (word % Math.max(1, max - min));
		},
		randomUUID() {
			const b = new Uint8Array(__ggsRandomBytes(16));
			b[6] = (b[6] & 0x0f) | 0x40;
			b[8] = (b[8] & 0x3f) | 0x80;
			let hex = '';
			for (const byte of b) hex += HEX[byte >> 4] + HEX[byte & 15];
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		},
		getRandomValues(target) {
			if (!ArrayBuffer.isView(target)) throw new TypeError('crypto.getRandomValues needs a typed array');
			if (target.byteLength > 65536) throw new RangeError('crypto.getRandomValues: at most 65536 bytes per call');
			return this.randomFillSync(target);
		}
	};
	globalThis.crypto.webcrypto = { getRandomValues: (target) => globalThis.crypto.getRandomValues(target) };
})();

/* ---------- url: the URL class and the classic resolve, parsing-only ---------- */
(() => {
	class URLSearchParams {
		constructor(init) {
			this._pairs = [];
			if (typeof init === 'string' && init.length > 0) {
				for (const pair of init.split('&')) {
					if (!pair) continue;
					const at = pair.indexOf('=');
					const key = at === -1 ? pair : pair.slice(0, at);
					const value = at === -1 ? '' : pair.slice(at + 1);
					const decode = (text) => {
						return text.replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
					};
					this._pairs.push([decode(key), decode(value)]);
				}
			}
		}
		append(key, value) { this._pairs.push([String(key), String(value)]); }
		set(key, value) {
			this._pairs = this._pairs.filter(([k]) => k !== String(key));
			this.append(key, value);
		}
		get(key) { const found = this._pairs.find(([k]) => k === String(key)); return found === undefined ? null : found[1]; }
		has(key) { return this._pairs.some(([k]) => k === String(key)); }
		forEach(visitor) { this._pairs.forEach(([k, v]) => visitor(v, k, this)); }
		toString() {
			const encode = (text) => String(text).replace(/[^a-zA-Z0-9-_.~]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
			return this._pairs.map(([k, v]) => encode(k) + '=' + encode(v)).join('&');
		}
	}
	class URL {
		constructor(input, base) {
			input = String(input);
			if (base !== undefined && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
				input = URL._resolve(String(base), input);
			}
			const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(input) || [];
			this.protocol = match[1] ?? '';
			this.host = match[3] ?? '';
			// `file:///x` keeps its empty authority: the `//` is part of the href.
			Object.defineProperty(this, '__authority', { value: match[2] !== undefined || this.protocol === 'file:', enumerable: false });
			const authority = this.host;
			const at = authority.lastIndexOf('@');
			const hostPart = at === -1 ? authority : authority.slice(at + 1);
			const colon = hostPart.lastIndexOf(':');
			this.hostname = colon === -1 ? hostPart : hostPart.slice(0, colon);
			this.port = colon === -1 ? '' : hostPart.slice(colon + 1);
			this.username = at === -1 ? '' : authority.slice(0, at).split(':')[0] ?? '';
			this.password = at === -1 ? '' : (authority.slice(0, at).split(':')[1] ?? '');
			this.pathname = match[4] ?? '';
			// Hierarchical paths lose their `.` / `..` segments, as WHATWG parsing does
			// (`new URL('../x.mjs', import.meta.url)`).
			if (this.pathname.startsWith('/') && /(^|\/)\.\.?(\/|$)/.test(this.pathname)) {
				const out = [];
				const segments = this.pathname.split('/').slice(1);
				segments.forEach((segment, at) => {
					const last = at === segments.length - 1;
					if (segment === '.') {
						if (last) out.push('');
					} else if (segment === '..') {
						if (out.length > 0) out.pop();
						if (last) out.push('');
					} else out.push(segment);
				});
				this.pathname = '/' + out.join('/');
			}
			this.search = match[6] !== undefined ? '?' + match[6] : '';
			this.hash = match[8] !== undefined ? '#' + match[8] : '';
			this.searchParams = new URLSearchParams(match[6] ?? '');
		}
		get origin() {
			return this.protocol + '//' + this.host;
		}
		get href() {
			return this.toString();
		}
		toString() {
			return this.protocol + (this.host || this.__authority ? '//' + this.host : '') + this.pathname + this.search + this.hash;
		}
		toJSON() {
			return this.toString();
		}
		static _resolve(base, relative) {
			const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?/.exec(base) || [];
			if (relative.startsWith('//')) return (match[1] ?? '') + relative;
			if (relative.startsWith('/')) return (match[1] ?? '') + (match[2] ?? '') + relative;
			const dir = (match[4] ?? '').replace(/[^/]*$/, '');
			return (match[1] ?? '') + (match[2] ?? '') + dir + relative;
		}
	}
	globalThis.url = {
		URL,
		URLSearchParams,
		resolve: (from, to) => URL._resolve(from, to),
		pathToFileURL(path) {
			return new URL('file:///' + String(path).replace(/\\/g, '/').replace(/^\/+/, ''));
		},
		fileURLToPath(urlValue) {
			const href = typeof urlValue === 'string' ? urlValue : String(urlValue);
			return decodeURIComponent(href.replace(/^file:\/\/\//, '').replace(/\//g, '\\'));
		}
	};
})();

/* ---------- http / https: the server surfaces inert, the sockets honest ----------
 * `createServer` must answer an object (the git extension builds its askpass server at
 * DataSource construction — a throw there would kill the activation); it never listens,
 * so nothing ever asks. The request surfaces throw at call time: the packages this
 * runtime hosts handle a synchronous throw of `https.get` exactly like a failed request
 * (their own comments say so), and an honest throw beats a silent hang. */
(() => {
	const inertServer = () => ({
		listen() { },
		on() { return this; },
		close() { },
		address() { return null; }
	});
	const unavailable = (name) => () => {
		throw new Error(`network sockets are not available in the ggs-node runtime (${name})`);
	};
	const module = (scheme) => ({
		createServer: (handler) => inertServer(),
		request: unavailable(`${scheme}.request`),
		get: unavailable(`${scheme}.get`),
		Agent: function Agent() { },
		globalAgent: {}
	});
	globalThis.http = module('http');
	globalThis.https = module('https');
})();

/* ---------- Buffer ---------- */
(() => {
	const HEX = '0123456789abcdef';
	const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	class Buffer extends Uint8Array {
		static isBuffer(value) {
			return value instanceof Buffer;
		}
		static from(value, encodingOrOffset, length) {
			if (typeof value === 'string') return Buffer._fromString(value, encodingOrOffset ?? 'utf8');
			if (ArrayBuffer.isView(value)) {
				const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
				const out = new Buffer(bytes.length);
				out.set(bytes);
				return out;
			}
			// Node's `Buffer.from(arrayBuffer[, byteOffset[, length]])` — the shape the natives
			// hand child-process output in; without it every pipe chunk threw and was lost.
			if (value instanceof ArrayBuffer) {
				const offset = Number(encodingOrOffset) || 0;
				const count = length === undefined ? value.byteLength - offset : Number(length);
				const out = new Buffer(count);
				out.set(new Uint8Array(value, offset, count));
				return out;
			}
			if (Array.isArray(value) || value instanceof Uint8Array) {
				const out = new Buffer(value.length);
				out.set(value);
				return out;
			}
			throw new TypeError('Buffer.from: unsupported source');
		}
		static alloc(size, fill = 0) {
			const out = new Buffer(Number(size) || 0);
			if (typeof fill === 'string') {
				const pattern = Buffer._fromString(fill, 'utf8');
				for (let i = 0; i < out.length; i += 1) out[i] = pattern[i % pattern.length];
			} else {
				out.fill(Number(fill) || 0);
			}
			return out;
		}
		static allocUnsafe(size) {
			return new Buffer(Number(size) || 0);
		}
		static concat(list) {
			const total = list.reduce((sum, item) => sum + item.length, 0);
			const out = new Buffer(total);
			let at = 0;
			for (const item of list) {
				out.set(item, at);
				at += item.length;
			}
			return out;
		}
		static byteLength(value, encoding = 'utf8') {
			if (typeof value === 'string') return Buffer._fromString(value, encoding).length;
			if (value && value.byteLength !== undefined) return value.byteLength;
			return 0;
		}
		static _fromString(text, encoding) {
			switch (encoding) {
				case 'utf8': case 'utf-8': {
					// The Rust side owns multi-byte correctness (Boa strings are UTF-16).
					return new Buffer(new Uint8Array(__ggsUtf8Encode(text)));
				}
				case 'ascii': case 'latin1': case 'binary': {
					const out = new Buffer(text.length);
					for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
					return out;
				}
				case 'hex': {
					const out = new Buffer(text.length / 2);
					for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
					return out;
				}
				case 'base64': case 'base64url': {
					const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
					const out = new Buffer(Math.floor(clean.length * 3 / 4));
					let bits = 0;
					let acc = 0;
					let at = 0;
					for (const ch of clean) {
						acc = (acc << 6) | B64.indexOf(ch);
						bits += 6;
						if (bits >= 8) {
							bits -= 8;
							out[at] = (acc >> bits) & 0xff;
							at += 1;
						}
					}
					return out.subarray(0, at);
				}
				default:
					throw new TypeError(`Unknown encoding: ${encoding}`);
			}
		}
		toString(encoding = 'utf8', start = 0, end = this.length) {
			const bytes = this.subarray(start, end);
			switch (encoding) {
				case 'utf8': case 'utf-8':
					// Lossy decode on the Rust side — exact Node `from_utf8_lossy` parity.
					return __ggsUtf8Decode(bytes);
				case 'ascii': case 'latin1': case 'binary': {
					let out = '';
					for (const b of bytes) out += String.fromCharCode(b);
					return out;
				}
				case 'hex': {
					let out = '';
					for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
					return out;
				}
				case 'base64': case 'base64url': {
					let out = '';
					for (let i = 0; i < bytes.length; i += 3) {
						const b1 = bytes[i];
						const b2 = bytes[i + 1];
						const b3 = bytes[i + 2];
						out += B64[b1 >> 2];
						out += B64[((b1 & 3) << 4) | ((b2 ?? 0) >> 4)];
						out += b2 === undefined ? (encoding === 'base64url' ? '' : '=') : B64[((b2 & 15) << 2) | ((b3 ?? 0) >> 6)];
						out += b3 === undefined ? (encoding === 'base64url' ? '' : '=') : B64[b3 & 63];
					}
					return out;
				}
				default:
					throw new TypeError(`Unknown encoding: ${encoding}`);
			}
		}
		toJSON() {
			return { type: 'Buffer', data: [...this] };
		}
		equals(other) {
			return this.length === other.length && this.every((b, i) => b === other[i]);
		}
		/* Node's `buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]])`: the bytes
		 * copied are the answer; streaming consumers (the extension machinery's chunk
		 * capture) call it on every `data` chunk. */
		copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
			if (!target || target.set === undefined) throw new TypeError('Buffer.copy: target must be a Buffer or Uint8Array');
			let at = Number(targetStart) || 0;
			let from = Number(sourceStart) || 0;
			let to = sourceEnd === undefined || sourceEnd === null ? this.length : Number(sourceEnd);
			if (from < 0) from = 0;
			if (to > this.length) to = this.length;
			if (at < 0 || at >= target.length || from >= to) return 0;
			const count = Math.min(to - from, target.length - at);
			if (count <= 0) return 0;
			target.set(this.subarray(from, from + count), at);
			return count;
		}
	}
	globalThis.Buffer = Buffer;
	globalThis.__ggsBufferClass = Buffer;
})();

/* ---------- fs surface over the Rust module (binary results arrive as ArrayBuffers) ---------- */
(() => {
	const raw = globalThis.__ggsFs;
	const encodingOf = (options, fallback) => {
		if (options === undefined) return fallback;
		if (options === null) return 'buffer';
		if (typeof options === 'string') return options;
		if (typeof options === 'object') {
			if (options.encoding === null) return 'buffer';
			if (typeof options.encoding === 'string') return options.encoding;
		}
		return fallback;
	};
	const asBuffer = (arrayBuffer) => new globalThis.__ggsBufferClass(new Uint8Array(arrayBuffer));
	/* Node's error shape: the natives answer `CODE: path: <OS message>` (the code from the
	 * OS error kind); callers branch on `error.code`, ENOENT above all. */
	const withCode = (error) => {
		if (error && typeof error === 'object' && error.code === undefined) {
			const match = /^(E[A-Z]+): /.exec(String(error.message));
			error.code = match ? match[1] : 'EIO';
		}
		return error;
	};
	const coded = (work) => (...args) => {
		try {
			return work(...args);
		} catch (error) {
			throw withCode(error);
		}
	};
	/* A Stats object: the fields plus the predicate methods Node code calls. */
	const toStats = (raw) => {
		const kind = raw.kind;
		return {
			size: raw.size,
			mtimeMs: raw.mtimeMs,
			ctimeMs: raw.ctimeMs,
			birthtimeMs: raw.birthtimeMs,
			atimeMs: raw.mtimeMs,
			mtime: new Date(raw.mtimeMs),
			ctime: new Date(raw.ctimeMs),
			birthtime: new Date(raw.birthtimeMs),
			atime: new Date(raw.mtimeMs),
			mode: kind === 'dir' ? 0o40755 : 0o100644,
			isFile: () => kind === 'file',
			isDirectory: () => kind === 'dir',
			isSymbolicLink: () => kind === 'symlink',
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false
		};
	};
	const fs = {
		constants: raw.constants,
		readFileSync(path, options) {
			const encoding = encodingOf(options, 'utf8');
			const binary = encoding === 'buffer' || encoding === null;
			const result = binary ? asBuffer(raw.readFileSyncBytes(path)) : raw.readFileSync(path, encoding);
			return result;
		},
		writeFileSync(path, data, options) {
			const encoding = encodingOf(options, 'utf8');
			if (typeof data === 'string') return raw.writeFileSync(path, data, encoding);
			return raw.writeFileSyncBytes(path, ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
		},
		appendFileSync: (path, data, options) => raw.appendFileSync(path, String(data), encodingOf(options, 'utf8')),
		existsSync: (path) => raw.existsSync(path),
		accessSync: (path) => raw.accessSync(path),
		mkdirSync: (path, options) => raw.mkdirSync(path, Boolean(options && options.recursive)),
		readdirSync(path, options) {
			const withTypes = Boolean(options && typeof options === 'object' && options.withFileTypes);
			const entries = withTypes ? raw.readdirDirents(path) : raw.readdir(path);
			return withTypes
				? entries.map((entry) => ({
					name: entry.name,
					isFile: () => entry.kind === 'file',
					isDirectory: () => entry.kind === 'dir',
					isSymbolicLink: () => entry.kind === 'symlink',
					isBlockDevice: () => false,
					isCharacterDevice: () => false,
					isFIFO: () => false,
					isSocket: () => false
				}))
				: entries;
		},
		statSync: (path) => toStats(raw.stat(path)),
		lstatSync: (path) => toStats(raw.stat(path)),
		rmSync: (path, options) => raw.rmSync(path, Boolean(options && options.recursive), Boolean(options && options.force)),
		rmdirSync: (path) => raw.rmSync(path, true, false),
		unlinkSync: (path) => raw.unlinkSync(path),
		renameSync: (from, to) => raw.renameSync(from, to),
		copyFileSync: (from, to) => raw.copyFileSync(from, to),
		realpathSync: (path) => raw.realpathSync(path),
		// Permission bits mean nothing to the platform surfaces this runtime serves; the
		// callback-style no-op keeps the extension's own activation flow (the askpass
		// helper scripts, never executed here) running.
		chmod(path, mode, callback) {
			if (typeof callback === 'function') queueMicrotask(() => callback(null));
		},
		chmodSync() { },
		createWriteStream: () => {
			throw new Error('write streams are not supported by the ggs-node runtime — write with writeFile');
		}
	};
	for (const name of Object.keys(fs)) {
		if (typeof fs[name] === 'function') fs[name] = coded(fs[name]);
	}
	fs.realpathSync.native = fs.realpathSync;

	/* fd-based reads (hex views page through big files): an fd names a path, every read is
	 * a ranged native read, so a file is never loaded whole. */
	const descriptors = new Map();
	let nextDescriptor = 100;
	const pathOf = (fd) => {
		const path = descriptors.get(fd);
		if (path === undefined) throw Object.assign(new Error('bad file descriptor'), { code: 'EBADF' });
		return path;
	};
	fs.openSync = coded((path, flags) => {
		const mode = flags === undefined ? 'r' : String(flags);
		if (!mode.startsWith('r')) throw new Error(`${path}: only read-mode descriptors are supported by the ggs-node runtime`);
		raw.accessSync(path);
		const fd = nextDescriptor++;
		descriptors.set(fd, path);
		return fd;
	});
	fs.closeSync = (fd) => {
		descriptors.delete(fd);
	};
	fs.readSync = coded((fd, buffer, offset, length, position) => {
		const path = pathOf(fd);
		const at = offset ?? 0;
		const count = length ?? (buffer.length - at);
		const bytes = new Uint8Array(raw.readRangeBytes(path, position ?? 0, count));
		buffer.set(bytes, at);
		return bytes.length;
	});
	fs.fstatSync = coded((fd) => fs.statSync(pathOf(fd)));

	/* createReadStream: an EventEmitter paging the file through ranged reads, one chunk per
	 * macrotask, honouring start/end/highWaterMark, pause/resume and destroy. */
	fs.createReadStream = (path, options) => {
		const settings = typeof options === 'string' ? { encoding: options } : { ...(options ?? {}) };
		const stream = new globalThis.EventEmitter();
		const chunk = settings.highWaterMark ?? 64 * 1024;
		let position = settings.start ?? 0;
		const end = settings.end === undefined ? Infinity : settings.end + 1;
		let paused = false;
		let done = false;
		stream.readable = true;
		stream.path = path;
		const pump = () => {
			if (done || paused) return;
			try {
				const want = Math.min(chunk, end - position);
				const bytes = want > 0 ? new Uint8Array(raw.readRangeBytes(path, position, want)) : new Uint8Array(0);
				if (bytes.length === 0) {
					done = true;
					stream.readable = false;
					stream.emit('end');
					stream.emit('close');
					return;
				}
				position += bytes.length;
				const buffer = new globalThis.__ggsBufferClass(bytes);
				stream.emit('data', settings.encoding ? buffer.toString(settings.encoding) : buffer);
				setTimeout(pump, 0);
			} catch (error) {
				done = true;
				stream.emit('error', withCode(error));
				stream.emit('close');
			}
		};
		stream.pause = () => {
			paused = true;
			return stream;
		};
		stream.resume = () => {
			if (paused) {
				paused = false;
				setTimeout(pump, 0);
			}
			return stream;
		};
		stream.destroy = () => {
			if (!done) {
				done = true;
				stream.emit('close');
			}
			return stream;
		};
		stream.close = stream.destroy;
		stream.setEncoding = (encoding) => {
			settings.encoding = encoding;
			return stream;
		};
		stream.pipe = (target) => {
			stream.on('data', (data) => target.write(data));
			stream.on('end', () => {
				if (typeof target.end === 'function') target.end();
			});
			return target;
		};
		setTimeout(pump, 0);
		return stream;
	};

	/* The callback forms: the sync call, answered on a microtask as (error, result), the
	 * way Node's own callback API reports. */
	const callbackForm = (sync) => (...args) => {
		const callback = typeof args[args.length - 1] === 'function' ? args.pop() : () => { };
		let result;
		try {
			result = sync(...args);
		} catch (error) {
			queueMicrotask(() => callback(withCode(error)));
			return;
		}
		queueMicrotask(() => callback(null, result));
	};
	for (const name of ['readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'fstat', 'readdir', 'mkdir',
		'unlink', 'rename', 'copyFile', 'rm', 'rmdir', 'realpath', 'access', 'open', 'close']) {
		fs[name] = callbackForm(fs[`${name}Sync`]);
	}
	fs.realpath.native = fs.realpath;
	fs.read = (fd, buffer, offset, length, position, callback) => {
		try {
			const count = fs.readSync(fd, buffer, offset, length, position);
			queueMicrotask(() => callback(null, count, buffer));
		} catch (error) {
			queueMicrotask(() => callback(error, 0, buffer));
		}
	};
	fs.exists = (path, callback) => {
		const present = raw.existsSync(path);
		queueMicrotask(() => callback(present));
	};
	const promise = {};
	/* Promise forms: a synchronous throw becomes the rejection, never an escape. */
	const promised = (sync) => (...args) => new Promise((resolve) => resolve(sync(...args)));
	for (const name of ['mkdir', 'stat', 'lstat', 'unlink', 'rename', 'realpath']) {
		promise[name] = promised(fs[`${name}Sync`]);
	}
	promise.readFile = promised(fs.readFileSync);
	promise.writeFile = promised(fs.writeFileSync);
	promise.appendFile = promised(fs.appendFileSync);
	promise.readdir = promised(fs.readdirSync);
	promise.rm = promised(fs.rmSync);
	promise.copyFile = promised(fs.copyFileSync);
	promise.access = (path) => new Promise((resolve, reject) => {
		try {
			fs.accessSync(path);
			resolve(undefined);
		} catch (error) {
			reject(error);
		}
	});
	promise.mkdtemp = () => {
		throw new Error('mkdtemp is not supported by the ggs-node runtime');
	};
	fs.promises = promise;
	globalThis.fs = fs;
	delete globalThis.__ggsFs;
})();

/* ---------- child_process over the Rust spawner ---------- */
(() => {
	const CP = {
		spawn: globalThis.__ggsChildProcessSpawn,
		spawnSync: globalThis.__ggsChildProcessSpawnSync
	};
	const shellWords = (command) =>
		process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
	const childProcess = {
		spawn(file, args, options) {
			return CP.spawn(file, Array.isArray(args) ? args : [], options ?? {});
		},
		spawnSync(file, args, options) {
			const done = CP.spawnSync(file, Array.isArray(args) ? args : [], options ?? {});
			done.stdout = Buffer.from(done.stdoutBytes ?? []);
			done.stderr = Buffer.from(done.stderrBytes ?? []);
			delete done.stdoutBytes;
			delete done.stderrBytes;
			return done;
		},
		execFile(file, args, options, callback) {
			if (typeof options === 'function') {
				callback = options;
				options = undefined;
			}
			const done = childProcess.spawnSync(file, args ?? [], options ?? {});
			const error = done.status !== 0
				? new Error(String(done.stderr || `execFile ${file} exited with ${done.status}`))
				: null;
			callback?.(error, done.stdout.toString('utf8'), done.stderr.toString('utf8'));
			return done;
		},
		exec(command, options, callback) {
			if (typeof options === 'function') {
				callback = options;
				options = undefined;
			}
			const words = shellWords(command);
			return childProcess.execFile(words[0], words.slice(1), options, callback);
		},
		execSync(command, options) {
			const words = shellWords(command);
			return childProcess.execFileSync(words[0], words.slice(1), options);
		},
		execFileSync(file, args, options) {
			return childProcess.spawnSync(file, args ?? [], options ?? {}).stdout;
		}
	};
	globalThis.child_process = childProcess;
	delete globalThis.__ggsChildProcess;
})();

/* ---------- `vscode`: the frame host's API, named plainly when touched in-process ---------- */
(() => {
	globalThis.vscode = new Proxy({}, {
		get() {
			throw new Error(
				"require('vscode') is the workbench frame host's API, not this process's — the ggs-node " +
				'runtime runs the package\'s process side; register `ggs.onRequest` for backend commands'
			);
		}
	});
})();

/* ---------- the ggs API: how a package's code speaks the backend protocol ---------- */
(() => {
	globalThis.ggs = {
		onRequest(handler) {
			if (typeof handler !== 'function') throw new TypeError('ggs.onRequest needs a function');
			__ggsOnRequest(handler);
		},
		onWorkspaceChanged(handler) {
			if (typeof handler !== 'function') throw new TypeError('ggs.onWorkspaceChanged needs a function');
			__ggsOnWorkspaceChanged(handler);
		},
		log(...args) {
			console.log(...args);
		},
		env: {}
	};
})();

/* ---------- the web globals Boa 0.20 leaves out ----------
 * Node exposes these on the global object and libraries reach for them unguarded
 * (TextDecoder in every parser that reads bytes, URL in every path↔URL conversion,
 * structuredClone for option copies, AbortController in every cancellable API). Each is
 * installed only where the engine has none of its own. */
(() => {
	const define = (name, value) => {
		if (typeof globalThis[name] === 'undefined') globalThis[name] = value;
	};
	class TextEncoder {
		get encoding() {
			return 'utf-8';
		}
		encode(input = '') {
			return new Uint8Array(__ggsUtf8Encode(String(input)));
		}
		encodeInto(input, target) {
			const bytes = this.encode(input);
			const written = Math.min(bytes.length, target.length);
			target.set(bytes.subarray(0, written));
			return { read: String(input).length, written };
		}
	}
	class TextDecoder {
		constructor(label = 'utf-8', options = {}) {
			const normalized = String(label).toLowerCase();
			if (!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(normalized)) {
				throw new RangeError(`the ggs-node TextDecoder decodes utf-8 only (asked for ${label})`);
			}
			this.encoding = 'utf-8';
			this.fatal = Boolean(options.fatal);
			this.ignoreBOM = Boolean(options.ignoreBOM);
		}
		decode(input) {
			if (input === undefined || input === null) return '';
			const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
			const text = __ggsUtf8Decode(bytes);
			return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
		}
	}
	define('TextEncoder', TextEncoder);
	define('TextDecoder', TextDecoder);

	const clone = (value, seen) => {
		if (value === null || typeof value !== 'object') {
			if (typeof value === 'function' || typeof value === 'symbol') throw new Error(`${String(value)} could not be cloned`);
			return value;
		}
		if (seen.has(value)) return seen.get(value);
		let out;
		if (value instanceof Date) out = new Date(value.getTime());
		else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
		else if (ArrayBuffer.isView(value)) out = new value.constructor(value);
		else if (value instanceof ArrayBuffer) out = value.slice(0);
		else if (value instanceof Map) {
			out = new Map();
			seen.set(value, out);
			for (const [k, v] of value) out.set(clone(k, seen), clone(v, seen));
			return out;
		} else if (value instanceof Set) {
			out = new Set();
			seen.set(value, out);
			for (const v of value) out.add(clone(v, seen));
			return out;
		} else if (value instanceof Error) {
			out = new value.constructor(value.message);
			out.stack = value.stack;
		} else {
			out = Array.isArray(value) ? [] : {};
			seen.set(value, out);
			for (const k of Object.keys(value)) out[k] = clone(value[k], seen);
			return out;
		}
		seen.set(value, out);
		return out;
	};
	define('structuredClone', (value) => clone(value, new Map()));

	class EventTarget {
		constructor() {
			this.__listeners = new Map();
		}
		addEventListener(type, listener, options) {
			if (!listener) return;
			const list = this.__listeners.get(type) ?? [];
			list.push({ listener, once: Boolean(options && options.once) });
			this.__listeners.set(type, list);
		}
		removeEventListener(type, listener) {
			const list = this.__listeners.get(type);
			if (list) this.__listeners.set(type, list.filter((entry) => entry.listener !== listener));
		}
		dispatchEvent(event) {
			const list = [...(this.__listeners.get(event.type) ?? [])];
			try {
				event.target = event.currentTarget = this;
			} catch {
				/* a frozen event keeps its own target */
			}
			for (const entry of list) {
				if (entry.once) this.removeEventListener(event.type, entry.listener);
				if (typeof entry.listener === 'function') entry.listener.call(this, event);
				else entry.listener.handleEvent(event);
			}
			const handler = this['on' + event.type];
			if (typeof handler === 'function') handler.call(this, event);
			return !event.defaultPrevented;
		}
	}
	class Event {
		constructor(type, init = {}) {
			this.type = String(type);
			this.bubbles = Boolean(init.bubbles);
			this.cancelable = Boolean(init.cancelable);
			this.defaultPrevented = false;
			this.timeStamp = Date.now();
		}
		preventDefault() {
			if (this.cancelable) this.defaultPrevented = true;
		}
		stopPropagation() { }
		stopImmediatePropagation() { }
	}
	class AbortSignal extends EventTarget {
		constructor() {
			super();
			this.aborted = false;
			this.reason = undefined;
			this.onabort = null;
		}
		throwIfAborted() {
			if (this.aborted) throw this.reason;
		}
		static abort(reason) {
			const controller = new AbortController();
			controller.abort(reason);
			return controller.signal;
		}
		static timeout(ms) {
			const controller = new AbortController();
			setTimeout(() => controller.abort(abortError('The operation was aborted due to timeout', 'TimeoutError')), ms);
			return controller.signal;
		}
		static any(signals) {
			const controller = new AbortController();
			for (const signal of signals) {
				if (signal.aborted) {
					controller.abort(signal.reason);
					break;
				}
				signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
			}
			return controller.signal;
		}
	}
	const abortError = (message, name = 'AbortError') => {
		const error = new Error(message);
		error.name = name;
		error.code = 'ABORT_ERR';
		return error;
	};
	class AbortController {
		constructor() {
			this.signal = new AbortSignal();
		}
		abort(reason) {
			if (this.signal.aborted) return;
			this.signal.aborted = true;
			this.signal.reason = reason === undefined ? abortError('This operation was aborted') : reason;
			this.signal.dispatchEvent(new Event('abort'));
		}
	}
	define('EventTarget', EventTarget);
	define('Event', Event);
	define('AbortSignal', AbortSignal);
	define('AbortController', AbortController);

	const started = __ggsProcessNow();
	define('performance', {
		now: () => __ggsProcessNow() - started,
		timeOrigin: Date.now() - (__ggsProcessNow() - started),
		mark() { },
		measure() { },
		getEntriesByName: () => [],
		toJSON() {
			return { timeOrigin: this.timeOrigin };
		}
	});

	const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	define('btoa', (input) => {
		const text = String(input);
		let out = '';
		for (let i = 0; i < text.length; i += 3) {
			const a = text.charCodeAt(i);
			const b = text.charCodeAt(i + 1);
			const c = text.charCodeAt(i + 2);
			if (a > 255 || b > 255 || c > 255) throw new Error('btoa: the string contains characters outside of the Latin1 range');
			out += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)];
			out += i + 1 < text.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : '=';
			out += i + 2 < text.length ? B64[c & 63] : '=';
		}
		return out;
	});
	define('atob', (input) => {
		const text = String(input).replace(/[\s=]/g, '');
		let out = '';
		let bits = 0;
		let value = 0;
		for (const ch of text) {
			const index = B64.indexOf(ch);
			if (index < 0) throw new Error('atob: the string is not correctly encoded');
			value = (value << 6) | index;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out += String.fromCharCode((value >> bits) & 255);
			}
		}
		return out;
	});
})();

/* ---------- the smaller core modules ----------
 * Everything `require('<core name>')` answers beyond the natively built set in
 * `builtins/mod.rs`: registered here by name in `__ggsBuiltins`, which the Rust registry
 * consults for any core name it does not build itself — so `import 'node:assert'` and
 * `require('assert')` reach the same object. */
(() => {
	const builtins = (globalThis.__ggsBuiltins = Object.create(null));
	const path = __ggsRequire('', 'path');

	/* os — `platform()` is a function in Node (the native half answers the string; fast-glob
	 * calls `os.platform()` at load), plus the members libraries probe for sizing and
	 * identity. */
	const os = __ggsRequire('', 'os');
	const platformName = typeof os.platform === 'function' ? os.platform() : String(os.platform);
	os.platform = () => platformName;
	Object.assign(os, {
		availableParallelism: () => os.cpus().length || 1,
		totalmem: () => 8 * 1024 * 1024 * 1024,
		freemem: () => 4 * 1024 * 1024 * 1024,
		loadavg: () => [0, 0, 0],
		uptime: () => performance.now() / 1000,
		version: () => os.type(),
		machine: () => (typeof os.arch === 'function' ? os.arch() : String(os.arch)) === 'arm64' ? 'arm64' : 'x86_64',
		networkInterfaces: () => ({}),
		userInfo: () => {
			const homedir = os.homedir();
			return { username: process.env.USERNAME || process.env.USER || '', uid: -1, gid: -1, shell: process.env.SHELL || null, homedir };
		},
		devNull: platformName === 'win32' ? '\\\\.\\nul' : '/dev/null',
		constants: { signals: { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }, errno: {}, priority: {} },
		getPriority: () => 0,
		setPriority() { }
	});

	/* path — `parse` / `format` over the native half, and a real `path.posix` on Windows
	 * (libraries build forward-slash paths with it — globs, ignore files, URLs — and the
	 * native win32 join would hand them backslashes). */
	const parseWith = (p, dirname, basename, extname, root) => {
		const text = String(p);
		const base = basename(text);
		const ext = extname(text);
		const dir = text.includes('/') || text.includes('\\') ? dirname(text) : '';
		return { root: root(text), dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
	};
	const formatWith = (sep) => (parts) => {
		const dir = parts.dir || parts.root || '';
		const base = parts.base || (parts.name || '') + (parts.ext ? (parts.ext.startsWith('.') ? '' : '.') + parts.ext : '');
		if (!dir) return base;
		return dir === parts.root ? dir + base : dir + sep + base;
	};
	const posix = (() => {
		const normalizeParts = (parts, absolute) => {
			const out = [];
			for (const part of parts) {
				if (!part || part === '.') continue;
				if (part === '..') {
					if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
					else if (!absolute) out.push('..');
				} else out.push(part);
			}
			return out;
		};
		const normalize = (p) => {
			const text = String(p);
			if (text === '') return '.';
			const absolute = text.startsWith('/');
			const trailing = text.endsWith('/');
			let body = normalizeParts(text.split('/'), absolute).join('/');
			if (!body && !absolute) body = '.';
			if (body && trailing) body += '/';
			return (absolute ? '/' : '') + body;
		};
		const cwd = () => process.cwd().replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
		const resolve = (...parts) => {
			let resolved = '';
			for (let i = parts.length - 1; i >= 0 && !resolved.startsWith('/'); i -= 1) {
				const part = String(parts[i]);
				if (part) resolved = resolved ? part + '/' + resolved : part;
			}
			if (!resolved.startsWith('/')) resolved = cwd() + '/' + resolved;
			const body = normalizeParts(resolved.split('/'), true).join('/');
			return '/' + body;
		};
		const dirname = (p) => {
			const text = String(p).replace(/\/+$/, '') || (String(p).startsWith('/') ? '/' : '');
			const at = text.lastIndexOf('/');
			if (at < 0) return '.';
			if (at === 0) return '/';
			return text.slice(0, at);
		};
		const basename = (p, ext) => {
			const text = String(p).replace(/\/+$/, '');
			let base = text.slice(text.lastIndexOf('/') + 1);
			if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
			return base;
		};
		const extname = (p) => {
			const base = basename(p);
			const at = base.lastIndexOf('.');
			return at <= 0 ? '' : base.slice(at);
		};
		const relative = (from, to) => {
			const a = resolve(from).split('/').filter(Boolean);
			const b = resolve(to).split('/').filter(Boolean);
			let common = 0;
			while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
			return [...Array(a.length - common).fill('..'), ...b.slice(common)].join('/');
		};
		const module = {
			sep: '/',
			delimiter: ':',
			normalize,
			join: (...parts) => normalize(parts.filter((part) => String(part) !== '').join('/') || '.'),
			resolve,
			dirname,
			basename,
			extname,
			relative,
			isAbsolute: (p) => String(p).startsWith('/'),
			toNamespacedPath: (p) => p,
			parse: (p) => parseWith(p, dirname, basename, extname, (text) => (text.startsWith('/') ? '/' : '')),
			format: formatWith('/')
		};
		module.posix = module;
		return module;
	})();
	path.parse = (p) => parseWith(p, path.dirname, path.basename, path.extname, (text) => (/^[A-Za-z]:[\\/]/.test(text) ? text.slice(0, 3) : /^[\\/]/.test(text) ? text[0] : /^[A-Za-z]:/.test(text) ? text.slice(0, 2) : ''));
	path.format = formatWith(path.sep);
	path.toNamespacedPath = (p) => p;
	path.matchesGlob = undefined;
	if (path.sep === '\\') {
		path.posix = posix;
		posix.win32 = path;
	}

	/* url — a path⇄URL pair that is right on both platforms (percent-encoding, drive
	 * letters, UNC hosts), and the WHATWG classes on the global object as Node has them. */
	const windows = process.platform === 'win32';
	const encodePathChars = (text) => encodeURI(text).replace(/[?#]/g, encodeURIComponent);
	url.pathToFileURL = (input) => {
		let resolved = path.resolve(String(input));
		if (String(input).endsWith('/') || (windows && String(input).endsWith('\\'))) resolved += '/';
		if (windows) {
			resolved = resolved.replace(/\\/g, '/');
			if (resolved.startsWith('//')) {
				// UNC: \\server\share\x → file://server/share/x
				const [host, ...rest] = resolved.slice(2).split('/');
				return new url.URL('file://' + host + encodePathChars('/' + rest.join('/')));
			}
			return new url.URL('file:///' + encodePathChars(resolved));
		}
		return new url.URL('file://' + encodePathChars(resolved));
	};
	url.fileURLToPath = (input) => {
		const parsed = typeof input === 'string' ? new url.URL(input) : input;
		if (parsed.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
		const pathname = decodeURIComponent(parsed.pathname);
		if (windows) {
			const local = pathname.replace(/\//g, '\\');
			if (parsed.hostname) return '\\\\' + parsed.hostname + local;
			return local.replace(/^\\([A-Za-z]:)/, '$1');
		}
		return pathname;
	};
	url.format = (value) => (typeof value === 'string' ? value : String(value.href ?? value));
	url.parse = (text) => {
		const parsed = new url.URL(text, 'x-relative:/');
		const relative = parsed.protocol === 'x-relative:';
		return {
			protocol: relative ? null : parsed.protocol,
			host: parsed.host || null,
			hostname: parsed.hostname || null,
			port: parsed.port || null,
			pathname: parsed.pathname,
			search: parsed.search || null,
			query: parsed.search ? parsed.search.slice(1) : null,
			hash: parsed.hash || null,
			href: String(text),
			path: parsed.pathname + parsed.search
		};
	};
	if (typeof globalThis.URL === 'undefined') globalThis.URL = url.URL;
	if (typeof globalThis.URLSearchParams === 'undefined') globalThis.URLSearchParams = url.URLSearchParams;

	/* module — createRequire is the ESM world's way into CommonJS. */
	const builtinModules = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'console', 'constants', 'crypto', 'diagnostics_channel', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'stream/promises', 'string_decoder', 'timers', 'timers/promises', 'tls', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'worker_threads', 'zlib'];
	const createRequire = (from) => {
		let file = from instanceof url.URL ? url.fileURLToPath(from) : String(from);
		if (file.startsWith('file:')) file = url.fileURLToPath(file);
		const dir = /[\\/]$/.test(file) ? file : path.dirname(file);
		return __ggsMakeRequire(dir);
	};
	function Module(id = '') {
		this.id = id;
		this.exports = {};
	}
	Object.assign(Module, {
		createRequire,
		builtinModules,
		isBuiltin: (name) => builtinModules.includes(String(name).replace(/^node:/, '')),
		register() { },
		syncBuiltinESMExports() { },
		_extensions: { '.js': null, '.json': null, '.node': null },
		_cache: {},
		_resolveFilename: (request, parent) => __ggsResolve(parent && parent.filename ? path.dirname(parent.filename) : process.cwd(), request)
	});
	Module.Module = Module;
	builtins.module = Module;

	/* assert — the strict comparisons the libraries' invariants call. */
	class AssertionError extends Error {
		constructor(options = {}) {
			super(options.message ?? `${String(options.actual)} ${options.operator ?? '=='} ${String(options.expected)}`);
			this.name = 'AssertionError';
			this.code = 'ERR_ASSERTION';
			this.actual = options.actual;
			this.expected = options.expected;
			this.operator = options.operator;
			this.generatedMessage = options.message === undefined;
		}
	}
	const fail = (message, fallback) => {
		if (message instanceof Error) throw message;
		throw new AssertionError({ message: message ?? fallback });
	};
	const deepEqual = (a, b, strict) => {
		if (strict ? Object.is(a, b) : a == b) return true;
		if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
		if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
		if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
		if (a instanceof Map && b instanceof Map) {
			if (a.size !== b.size) return false;
			for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k), strict)) return false;
			return true;
		}
		if (a instanceof Set && b instanceof Set) {
			if (a.size !== b.size) return false;
			for (const v of a) if (!b.has(v)) return false;
			return true;
		}
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		if (keysA.length !== keysB.length) return false;
		return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], strict));
	};
	const matchesError = (error, expected) => {
		if (expected === undefined) return true;
		if (typeof expected === 'function') {
			if (expected.prototype !== undefined && error instanceof expected) return true;
			if (Error.isPrototypeOf(expected) || expected === Error) return false;
			return expected(error) === true;
		}
		if (expected instanceof RegExp) return expected.test(String(error && error.message !== undefined ? error.message : error));
		if (typeof expected === 'object') return Object.keys(expected).every((k) => deepEqual(error[k], expected[k], true) || (expected[k] instanceof RegExp && expected[k].test(error[k])));
		return true;
	};
	const makeAssert = (strict) => {
		const assert = (value, message) => {
			if (!value) fail(message, 'The expression evaluated to a falsy value');
		};
		Object.assign(assert, {
			AssertionError,
			ok: assert,
			fail: (message) => fail(message, 'Failed'),
			equal: (a, b, message) => (strict ? Object.is(a, b) : a == b) || fail(message, `${String(a)} == ${String(b)}`),
			notEqual: (a, b, message) => !(strict ? Object.is(a, b) : a == b) || fail(message, `${String(a)} != ${String(b)}`),
			strictEqual: (a, b, message) => Object.is(a, b) || fail(message, `Expected values to be strictly equal: ${String(a)} !== ${String(b)}`),
			notStrictEqual: (a, b, message) => !Object.is(a, b) || fail(message, `Expected "actual" to be strictly unequal to: ${String(b)}`),
			deepEqual: (a, b, message) => deepEqual(a, b, strict) || fail(message, 'Expected values to be loosely deep-equal'),
			deepStrictEqual: (a, b, message) => deepEqual(a, b, true) || fail(message, 'Expected values to be strictly deep-equal'),
			notDeepEqual: (a, b, message) => !deepEqual(a, b, strict) || fail(message, 'Expected "actual" not to be loosely deep-equal'),
			notDeepStrictEqual: (a, b, message) => !deepEqual(a, b, true) || fail(message, 'Expected "actual" not to be strictly deep-equal'),
			match: (text, pattern, message) => pattern.test(text) || fail(message, `The input did not match the regular expression ${String(pattern)}`),
			doesNotMatch: (text, pattern, message) => !pattern.test(text) || fail(message, `The input was expected to not match ${String(pattern)}`),
			ifError: (value) => {
				if (value !== null && value !== undefined) throw value;
			},
			throws(fn, expected, message) {
				try {
					fn();
				} catch (error) {
					if (!matchesError(error, expected)) throw error;
					return;
				}
				fail(typeof expected === 'string' ? expected : message, 'Missing expected exception.');
			},
			doesNotThrow(fn) {
				fn();
			},
			async rejects(promiseOrFn, expected, message) {
				try {
					await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
				} catch (error) {
					if (!matchesError(error, expected)) throw error;
					return;
				}
				fail(typeof expected === 'string' ? expected : message, 'Missing expected rejection.');
			},
			async doesNotReject(promiseOrFn) {
				await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
			}
		});
		return assert;
	};
	builtins.assert = makeAssert(false);
	builtins.assert.strict = makeAssert(true);
	builtins.assert.strict.strict = builtins.assert.strict;
	builtins['assert/strict'] = builtins.assert.strict;

	/* util — the rest of Node's surface over the prelude's format/inspect. */
	const types = {
		isPromise: (v) => v instanceof Promise,
		isDate: (v) => v instanceof Date,
		isRegExp: (v) => v instanceof RegExp,
		isMap: (v) => v instanceof Map,
		isSet: (v) => v instanceof Set,
		isNativeError: (v) => v instanceof Error,
		isUint8Array: (v) => v instanceof Uint8Array,
		isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
		isArrayBuffer: (v) => v instanceof ArrayBuffer,
		isAnyArrayBuffer: (v) => v instanceof ArrayBuffer,
		isArrayBufferView: (v) => ArrayBuffer.isView(v),
		isAsyncFunction: (v) => typeof v === 'function' && v.constructor && v.constructor.name === 'AsyncFunction',
		isGeneratorFunction: (v) => typeof v === 'function' && v.constructor && /GeneratorFunction$/.test(v.constructor.name),
		isBoxedPrimitive: (v) => v instanceof Number || v instanceof String || v instanceof Boolean,
		isProxy: () => false
	};
	util.types = types;
	util.inspect.custom = Symbol.for('nodejs.util.inspect.custom');
	util.inspect.defaultOptions = {};
	util.isDeepStrictEqual = (a, b) => deepEqual(a, b, true);
	util.TextEncoder = TextEncoder;
	util.TextDecoder = TextDecoder;
	util.debuglog = () => {
		const log = () => { };
		log.enabled = false;
		return log;
	};
	util.debug = util.debuglog;
	util.stripVTControlCharacters = (text) => String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
	util.styleText = (_format, text) => String(text);
	util.toUSVString = (text) => String(text);
	util.isArray = Array.isArray;
	util.promisify.custom = Symbol.for('nodejs.util.promisify.custom');
	const inherits = util.inherits;
	util.inherits = (ctor, superCtor) => {
		inherits(ctor, superCtor);
		Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
	};
	builtins['util/types'] = types;

	/* v8 — the facts libraries probe, never an engine. */
	builtins.v8 = {
		getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 4 * 1024 * 1024 * 1024, total_available_size: 4 * 1024 * 1024 * 1024 }),
		getHeapSpaceStatistics: () => [],
		setFlagsFromString() { },
		serialize: (value) => Buffer.from(JSON.stringify(value)),
		deserialize: (bytes) => JSON.parse(Buffer.from(bytes).toString()),
		cachedDataVersionTag: () => 0,
		startupSnapshot: { isBuildingSnapshot: () => false, addSerializeCallback() { }, addDeserializeCallback() { }, setDeserializeMainFunction() { } }
	};

	/* vm — evaluation in this realm (a sandboxed context is not modelled). */
	builtins.vm = {
		runInThisContext: (code) => (0, eval)(String(code)),
		runInNewContext: (code, sandbox = {}) => new Function(...Object.keys(sandbox), `return eval(${JSON.stringify(String(code))})`)(...Object.values(sandbox)),
		createContext: (sandbox = {}) => sandbox,
		isContext: () => true,
		Script: class Script {
			constructor(code) {
				this.code = String(code);
			}
			runInThisContext() {
				return (0, eval)(this.code);
			}
			runInNewContext(sandbox) {
				return builtins.vm.runInNewContext(this.code, sandbox);
			}
		}
	};

	/* tty / worker_threads / perf_hooks / async_hooks / diagnostics_channel — the
	 * single-threaded, non-terminal answers (stdout is the protocol, never a TTY). */
	builtins.tty = {
		isatty: () => false,
		ReadStream: function ReadStream() { },
		WriteStream: function WriteStream() { }
	};
	builtins.worker_threads = {
		isMainThread: true,
		parentPort: null,
		workerData: null,
		threadId: 0,
		resourceLimits: {},
		Worker: function Worker() {
			throw new Error('worker threads are not available in the ggs-node runtime');
		},
		MessageChannel: function MessageChannel() {
			throw new Error('MessageChannel is not available in the ggs-node runtime');
		}
	};
	builtins.perf_hooks = { performance: globalThis.performance, PerformanceObserver: function PerformanceObserver() { this.observe = () => { }; this.disconnect = () => { }; } };
	class AsyncLocalStorage {
		getStore() {
			return this.__store;
		}
		run(store, fn, ...args) {
			const previous = this.__store;
			this.__store = store;
			try {
				return fn(...args);
			} finally {
				this.__store = previous;
			}
		}
		enterWith(store) {
			this.__store = store;
		}
		exit(fn, ...args) {
			return this.run(undefined, fn, ...args);
		}
		disable() {
			this.__store = undefined;
		}
	}
	builtins.async_hooks = {
		AsyncLocalStorage,
		AsyncResource: class AsyncResource {
			runInAsyncScope(fn, thisArg, ...args) {
				return fn.apply(thisArg, args);
			}
			bind(fn) {
				return fn;
			}
			static bind(fn) {
				return fn;
			}
			emitDestroy() { }
		},
		createHook: () => ({ enable() { return this; }, disable() { return this; } }),
		executionAsyncId: () => 1,
		triggerAsyncId: () => 0
	};
	const channel = (name) => ({ name, hasSubscribers: false, publish() { }, subscribe() { }, unsubscribe() { }, bindStore() { }, runStores: (_d, fn, thisArg, ...args) => fn.apply(thisArg, args) });
	builtins.diagnostics_channel = { channel, hasSubscribers: () => false, subscribe() { }, unsubscribe() { }, tracingChannel: (name) => ({ start: channel(name), end: channel(name), asyncStart: channel(name), asyncEnd: channel(name), error: channel(name), hasSubscribers: false, traceSync: (fn, _c, thisArg, ...args) => fn.apply(thisArg, args), tracePromise: (fn, _c, thisArg, ...args) => fn.apply(thisArg, args) }) };

	/* string_decoder — multi-byte sequences split across chunks are held back. */
	class StringDecoder {
		constructor(encoding = 'utf8') {
			this.encoding = String(encoding).toLowerCase().replace('-', '');
			this.pending = new Uint8Array(0);
		}
		write(chunk) {
			if (typeof chunk === 'string') return chunk;
			const incoming = ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
			if (this.encoding !== 'utf8') return Buffer.from(incoming).toString(this.encoding);
			const bytes = new Uint8Array(this.pending.length + incoming.length);
			bytes.set(this.pending);
			bytes.set(incoming, this.pending.length);
			// Hold back an incomplete trailing sequence (at most 3 bytes).
			let cut = bytes.length;
			for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
				const byte = bytes[bytes.length - back];
				if ((byte & 0xc0) === 0x80) continue;
				const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
				if (need > back) cut = bytes.length - back;
				break;
			}
			this.pending = bytes.slice(cut);
			return __ggsUtf8Decode(bytes.subarray(0, cut));
		}
		end(chunk) {
			const head = chunk === undefined ? '' : this.write(chunk);
			const rest = this.pending.length > 0 ? __ggsUtf8Decode(this.pending) : '';
			this.pending = new Uint8Array(0);
			return head + rest;
		}
	}
	builtins.string_decoder = { StringDecoder };

	/* querystring — the classic form codec. */
	const qsEscape = (text) => encodeURIComponent(text);
	const qsUnescape = (text) => {
		try {
			return decodeURIComponent(text.replace(/\+/g, ' '));
		} catch {
			return text;
		}
	};
	builtins.querystring = {
		escape: qsEscape,
		unescape: qsUnescape,
		parse(text, sep = '&', eq = '=') {
			const out = {};
			for (const pair of String(text ?? '').split(sep)) {
				if (!pair) continue;
				const at = pair.indexOf(eq);
				const k = qsUnescape(at < 0 ? pair : pair.slice(0, at));
				const v = at < 0 ? '' : qsUnescape(pair.slice(at + eq.length));
				if (k in out) out[k] = [].concat(out[k], v);
				else out[k] = v;
			}
			return out;
		},
		stringify(object, sep = '&', eq = '=') {
			return Object.entries(object ?? {})
				.flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((item) => qsEscape(k) + eq + qsEscape(item ?? '')))
				.join(sep);
		}
	};
	builtins.querystring.decode = builtins.querystring.parse;
	builtins.querystring.encode = builtins.querystring.stringify;

	/* timers/promises */
	builtins['timers/promises'] = {
		setTimeout: (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
		setImmediate: (value) => new Promise((resolve) => setImmediate(() => resolve(value))),
		async *setInterval(ms, value) {
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, ms));
				yield value;
			}
		},
		scheduler: { wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), yield: () => new Promise((resolve) => setImmediate(resolve)) }
	};

	/* net / tls / dns — the pure helpers real, the sockets an honest call-time throw
	 * (the same line `http` draws). */
	const noSockets = (name) => () => {
		throw new Error(`network sockets are not available in the ggs-node runtime (${name})`);
	};
	const isIPv4 = (text) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(text));
	const isIPv6 = (text) => /^[0-9a-fA-F:]+$/.test(String(text)) && String(text).includes(':');
	builtins.net = {
		isIP: (text) => (isIPv4(text) ? 4 : isIPv6(text) ? 6 : 0),
		isIPv4,
		isIPv6,
		connect: noSockets('net.connect'),
		createConnection: noSockets('net.createConnection'),
		createServer: noSockets('net.createServer'),
		Socket: function Socket() {
			throw new Error('network sockets are not available in the ggs-node runtime (net.Socket)');
		}
	};
	builtins.tls = { connect: noSockets('tls.connect'), createServer: noSockets('tls.createServer'), rootCertificates: [] };
	builtins.dns = { lookup: noSockets('dns.lookup'), resolve: noSockets('dns.resolve'), promises: { lookup: noSockets('dns.promises.lookup') } };

	/* zlib — the compression transforms need a codec the runtime does not carry; every
	 * entry is an honest call-time throw, the constants real (a bundle that requires
	 * this module only touches it inside its own HTTP paths). */
	const noZlib = (name) => () => {
		throw new Error(`compression is not available in the ggs-node runtime (${name})`);
	};
	builtins.zlib = {
		createGzip: noZlib('zlib.createGzip'),
		createGunzip: noZlib('zlib.createGunzip'),
		createDeflate: noZlib('zlib.createDeflate'),
		createInflate: noZlib('zlib.createInflate'),
		createDeflateRaw: noZlib('zlib.createDeflateRaw'),
		createInflateRaw: noZlib('zlib.createInflateRaw'),
		createUnzip: noZlib('zlib.createUnzip'),
		createBrotliCompress: noZlib('zlib.createBrotliCompress'),
		createBrotliDecompress: noZlib('zlib.createBrotliDecompress'),
		gzip: noZlib('zlib.gzip'),
		gunzip: noZlib('zlib.gunzip'),
		deflate: noZlib('zlib.deflate'),
		inflate: noZlib('zlib.inflate'),
		gzipSync: noZlib('zlib.gzipSync'),
		gunzipSync: noZlib('zlib.gunzipSync'),
		deflateSync: noZlib('zlib.deflateSync'),
		inflateSync: noZlib('zlib.inflateSync'),
		crc32: noZlib('zlib.crc32'),
		constants: { Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_DEFAULT_STRATEGY: 0 }
	};

	/* http2 — the same honest line the sockets draw (session creation on). */
	builtins.http2 = {
		connect: noSockets('http2.connect'),
		createServer: noSockets('http2.createServer'),
		createSecureServer: noSockets('http2.createSecureServer'),
		constants: {},
		getDefaultSettings: () => ({}),
		getPackedSettings: () => Buffer.alloc(0),
		getUnpackedSettings: () => ({})
	};

	/* constants — the historical `require('constants')` bag; the modules that really
	 * use constants (fs, os, crypto, zlib) carry their own. */
	builtins.constants = {};

	/* readline — line splitting over any readable emitter (a child's stdout above all). */
	builtins.readline = {
		createInterface(options) {
			const input = options && options.input !== undefined ? options.input : options;
			const rl = new EventEmitter();
			let buffered = '';
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				if (buffered.length > 0) rl.emit('line', buffered);
				buffered = '';
				rl.emit('close');
			};
			const onData = (chunk) => {
				buffered += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
				let at;
				while ((at = buffered.indexOf('\n')) >= 0) {
					const line = buffered.slice(0, at).replace(/\r$/, '');
					buffered = buffered.slice(at + 1);
					rl.emit('line', line);
				}
			};
			input && input.on && input.on('data', onData);
			input && input.on && input.on('end', close);
			input && input.on && input.on('close', close);
			rl.close = () => {
				input && input.removeListener && input.removeListener('data', onData);
				close();
			};
			rl.setPrompt = () => { };
			rl.prompt = () => { };
			rl.question = (_query, callback) => rl.once('line', callback);
			rl.pause = () => rl;
			rl.resume = () => rl;
			rl.write = () => { };
			rl[Symbol.asyncIterator] = async function* () {
				const lines = [];
				let wake = null;
				let done = false;
				rl.on('line', (line) => {
					lines.push(line);
					wake && wake();
				});
				rl.once('close', () => {
					done = true;
					wake && wake();
				});
				while (true) {
					if (lines.length > 0) {
						yield lines.shift();
						continue;
					}
					if (done) return;
					await new Promise((resolve) => (wake = resolve));
					wake = null;
				}
			};
			return rl;
		},
		clearLine: () => true,
		cursorTo: () => true,
		moveCursor: () => true,
		emitKeypressEvents() { }
	};
	builtins['readline/promises'] = builtins.readline;

	/* stream — Readable / Writable / Duplex / Transform / PassThrough with the behaviour
	 * packages lean on (the frame host's `nodeShims/stream.ts`, the same model): flowing
	 * reads, pipe, the `_write` callback protocol, `_transform`/`_flush`, object mode, async
	 * iteration, `Readable.from`, `finished` and `pipeline`. Backpressure is not modelled —
	 * every write reports it may continue. */
	const tick = (fn) => void Promise.resolve().then(fn);
	const toText = (chunk, encoding) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding));
	class Readable extends EventEmitter {
		constructor(options = {}) {
			super();
			this.readable = true;
			this.readableEnded = false;
			this.destroyed = false;
			this.readableObjectMode = Boolean(options.objectMode ?? options.readableObjectMode);
			this.readableFlowing = null;
			this.__queue = [];
			this.__ended = false;
			this.__encoding = options.encoding;
			this.__reading = false;
			if (options.read) this._read = options.read;
			if (options.destroy) this._destroy = options.destroy;
		}
		_read() { }
		push(chunk, encoding) {
			if (chunk === null) {
				this.__ended = true;
				this.__drain();
				return false;
			}
			if (typeof chunk === 'string' && !this.readableObjectMode && this.__encoding === undefined) chunk = Buffer.from(chunk, encoding);
			this.__queue.push(chunk);
			this.__drain();
			return true;
		}
		unshift(chunk) {
			this.__queue.unshift(chunk);
		}
		setEncoding(encoding) {
			this.__encoding = encoding;
			return this;
		}
		read() {
			if (this.__queue.length === 0) {
				this.__pull();
				return null;
			}
			return this.__decode(this.__queue.shift());
		}
		on(event, listener) {
			super.on(event, listener);
			this.__noteListener(event);
			return this;
		}
		addListener(event, listener) {
			return this.on(event, listener);
		}
		once(event, listener) {
			super.once(event, listener);
			this.__noteListener(event);
			return this;
		}
		__noteListener(event) {
			if (event === 'data' && this.readableFlowing !== false) this.resume();
			if (event === 'readable') tick(() => this.__pull());
		}
		pause() {
			this.readableFlowing = false;
			return this;
		}
		resume() {
			this.readableFlowing = true;
			tick(() => {
				this.__drain();
				this.__pull();
			});
			return this;
		}
		isPaused() {
			return this.readableFlowing === false;
		}
		pipe(destination, options) {
			this.on('data', (chunk) => void destination.write(chunk));
			if (!options || options.end !== false) this.once('end', () => void destination.end());
			destination.emit && destination.emit('pipe', this);
			return destination;
		}
		unpipe() {
			return this;
		}
		destroy(error) {
			if (this.destroyed) return this;
			this.destroyed = true;
			this._destroy(error ?? null, (finalError) => {
				tick(() => {
					if (finalError) this.emit('error', finalError);
					this.emit('close');
				});
			});
			return this;
		}
		_destroy(error, callback) {
			callback(error);
		}
		async *[Symbol.asyncIterator]() {
			const pending = [];
			let done = false;
			let failure = null;
			let wake = null;
			const notify = () => {
				if (wake) wake();
				wake = null;
			};
			this.on('data', (chunk) => {
				pending.push(chunk);
				notify();
			});
			this.once('end', () => {
				done = true;
				notify();
			});
			this.once('error', (error) => {
				failure = error;
				notify();
			});
			while (true) {
				if (pending.length > 0) {
					yield pending.shift();
					continue;
				}
				if (failure !== null) throw failure;
				if (done) return;
				await new Promise((resolve) => (wake = resolve));
			}
		}
		static from(iterable, options = {}) {
			const stream = new Readable({ objectMode: true, ...options });
			tick(async () => {
				try {
					if (typeof iterable === 'string' || ArrayBuffer.isView(iterable)) stream.push(iterable);
					else for await (const item of iterable) stream.push(item);
					stream.push(null);
				} catch (error) {
					stream.destroy(error);
				}
			});
			return stream;
		}
		__decode(chunk) {
			if (this.__encoding !== undefined && !this.readableObjectMode && typeof chunk !== 'string') return toText(chunk, this.__encoding);
			return chunk;
		}
		__drain() {
			if (this.readableFlowing === true) {
				while (this.__queue.length > 0 && this.readableFlowing === true) this.emit('data', this.__decode(this.__queue.shift()));
			} else if (this.__queue.length > 0 && this.listenerCount('readable') > 0) {
				this.emit('readable');
			}
			if (this.__ended && this.__queue.length === 0 && !this.readableEnded) {
				this.readableEnded = true;
				this.readable = false;
				tick(() => this.emit('end'));
			}
		}
		__pull() {
			if (this.__ended || this.__reading || this.destroyed) return;
			this.__reading = true;
			tick(() => {
				this.__reading = false;
				if (!this.__ended) this._read();
			});
		}
	}
	const writableMethods = {
		write(chunk, encoding, callback) {
			const done = typeof encoding === 'function' ? encoding : callback;
			const enc = typeof encoding === 'string' ? encoding : 'utf8';
			if (this.writableEnded) {
				const error = new Error('write after end');
				tick(() => (done ? done(error) : this.emit('error', error)));
				return false;
			}
			this.__pendingWrites += 1;
			this.__writeImpl(chunk, enc, (error) => {
				this.__pendingWrites -= 1;
				if (error) this.emit('error', error);
				if (done) done(error ?? null);
				if (this.__pendingWrites === 0) this.emit('drain');
				if (this.writableEnded && this.__pendingWrites === 0) this.__finishOnce();
			});
			return true;
		},
		end(chunk, encoding, callback) {
			const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
			if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') this.write(chunk, typeof encoding === 'string' ? encoding : undefined);
			if (done) this.once('finish', done);
			this.writableEnded = true;
			if (this.__pendingWrites === 0) this.__finishOnce();
			return this;
		},
		cork() { },
		uncork() { },
		setDefaultEncoding() {
			return this;
		}
	};
	const installWritable = (target, options) => {
		target.writable = true;
		target.writableEnded = false;
		target.writableFinished = false;
		target.writableObjectMode = Boolean(options.objectMode ?? options.writableObjectMode);
		target.__pendingWrites = 0;
		target.__writeImpl = (chunk, encoding, callback) => (options.write ? options.write.call(target, chunk, encoding, callback) : target._write(chunk, encoding, callback));
		const finalImpl = (callback) => (options.final ? options.final.call(target, callback) : target._final(callback));
		let finishing = false;
		target.__finishOnce = () => {
			if (finishing) return;
			finishing = true;
			finalImpl((error) => {
				if (error) {
					target.emit('error', error);
					return;
				}
				target.writableFinished = true;
				tick(() => {
					target.emit('finish');
					target.emit('close');
				});
			});
		};
	};
	class Writable extends EventEmitter {
		constructor(options = {}) {
			super();
			this.destroyed = false;
			installWritable(this, options);
		}
		_write(_chunk, _encoding, callback) {
			callback();
		}
		_final(callback) {
			callback();
		}
		destroy(error) {
			if (this.destroyed) return this;
			this.destroyed = true;
			tick(() => {
				if (error) this.emit('error', error);
				this.emit('close');
			});
			return this;
		}
	}
	Object.assign(Writable.prototype, writableMethods);
	class Duplex extends Readable {
		constructor(options = {}) {
			super(options);
			installWritable(this, options);
		}
		_write(_chunk, _encoding, callback) {
			callback();
		}
		_final(callback) {
			callback();
		}
	}
	Object.assign(Duplex.prototype, writableMethods);
	class Transform extends Duplex {
		constructor(options = {}) {
			super(options);
			if (options.transform) this._transform = options.transform;
			if (options.flush) this._flush = options.flush;
		}
		_transform(chunk, _encoding, callback) {
			callback(null, chunk);
		}
		_flush(callback) {
			callback();
		}
		_write(chunk, encoding, callback) {
			this._transform(chunk, encoding, (error, data) => {
				if (data !== undefined && data !== null) this.push(data);
				callback(error ?? null);
			});
		}
		_final(callback) {
			this._flush((error, data) => {
				if (data !== undefined && data !== null) this.push(data);
				this.push(null);
				callback(error ?? null);
			});
		}
	}
	class PassThrough extends Transform { }
	const finished = (stream, options, callback) => {
		const done = typeof options === 'function' ? options : callback;
		let called = false;
		const once = (error) => {
			if (called) return;
			called = true;
			done(error);
		};
		stream.once('end', () => once());
		stream.once('finish', () => once());
		stream.once('error', (error) => once(error));
		return () => undefined;
	};
	const pipeline = (...streams) => {
		const callback = typeof streams[streams.length - 1] === 'function' ? streams.pop() : undefined;
		const list = Array.isArray(streams[0]) ? streams[0] : streams;
		for (let at = 0; at < list.length - 1; at += 1) list[at].pipe(list[at + 1]);
		const last = list[list.length - 1];
		let failed = false;
		for (const stream of list) {
			stream.once('error', (error) => {
				if (failed) return;
				failed = true;
				if (callback) callback(error);
			});
		}
		finished(last, (error) => {
			if (!failed && callback) callback(error);
		});
		return last;
	};
	const streamPromises = {
		finished: (stream) => new Promise((resolve, reject) => finished(stream, (error) => (error ? reject(error) : resolve()))),
		pipeline: (...streams) => new Promise((resolve, reject) => pipeline(...streams, (error) => (error ? reject(error) : resolve())))
	};
	function Stream(options) {
		EventEmitter.call(this, options);
	}
	Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
	Object.setPrototypeOf(Stream, EventEmitter);
	Object.assign(Stream, { Stream, Readable, Writable, Duplex, Transform, PassThrough, finished, pipeline, promises: streamPromises });
	builtins.stream = Stream;
	builtins['stream/promises'] = streamPromises;

	/* path/posix and path/win32 — the one honest platform implementation. */
	builtins['path/posix'] = path.posix;
	builtins['path/win32'] = path;

	/* process — the members the libraries read beyond the prelude's core. */
	process.features = { inspector: false, ipv6: true, tls: false, typescript: false };
	process.noDeprecation = false;
	process.throwDeprecation = false;
	process.release = { name: 'node' };
	process.config = { variables: {} };
	process.execArgv = [];
	process.exitCode = undefined;
	process.title = 'ggs-node';
	process.emitWarning = (warning, type) => {
		const text = warning instanceof Error ? `${warning.name}: ${warning.message}` : `${type ?? 'Warning'}: ${String(warning)}`;
		console.warn(text);
	};
	process.memoryUsage = Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 });
	process.uptime = () => performance.now() / 1000;
	process.hrtime = Object.assign(
		(previous) => {
			const now = __ggsProcessNow();
			const seconds = Math.floor(now / 1000);
			const nanos = Math.round((now - seconds * 1000) * 1e6);
			if (!previous) return [seconds, nanos];
			let ds = seconds - previous[0];
			let dn = nanos - previous[1];
			if (dn < 0) {
				ds -= 1;
				dn += 1e9;
			}
			return [ds, dn];
		},
		{ bigint: process.hrtime.bigint }
	);
	process.getuid = process.getuid ?? (() => 0);
	process.getgid = process.getgid ?? (() => 0);
	process.stdin = process.stdin ?? Object.assign(new Readable(), { isTTY: false, fd: 0 });
	process.stdout.fd = 1;
	process.stderr.fd = 2;
	process.stdout.on = process.stdout.on ?? (() => process.stdout);
	process.stderr.on = process.stderr.on ?? (() => process.stderr);
	process.binding = (name) => {
		throw new Error(`process.binding('${name}') is not available in the ggs-node runtime`);
	};

	/* The `import.meta` members a module's code reads — installed by the ESM loader
	 * (`esm.rs`) on first access, with the module's own path. */
	globalThis.__ggsInitImportMeta = (meta, filename) => {
		meta.url = url.pathToFileURL(filename).href;
		meta.filename = filename;
		meta.dirname = path.dirname(filename);
		meta.resolve = (specifier) => {
			if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier) && !/^[A-Za-z]:[\\/]/.test(specifier)) return specifier;
			return url.pathToFileURL(__ggsResolve(meta.dirname, specifier)).href;
		};
	};
})();

globalThis.global = globalThis;

/* The module compiler the Rust loader calls: the CommonJS wrapper as a direct eval in
 * THIS function's frame. Direct eval compiles the wrapper against this scope and the
 * wrapper captures that same chain, so every binding locator stays consistent no
 * matter where the load happens. The two alternatives are both Boa 0.20 bugs (see
 * require.rs): the `Function` constructor compiles nested functions with locators
 * that panic when the module's own closures run later, and a Rust-side `eval` during
 * a running frame hands the wrapper the caller's environment chain. */
globalThis.__ggsCompileModule = function (text) {
	// Indirect eval on purpose: the module wrapper compiles in the global scope, the
	// same way node.exe compiles a module - a standalone function over its own
	// parameters, not an extension of the calling scope. A direct eval here would run
	// the caller-scope escape/reorder machinery over the shared helper scopes on every
	// require, and at real-bundle scale (hundreds of modules, deep closure chains) the
	// reordered slots diverge from the frames compiled before the reorder.
	return (0, eval)('(function (exports, require, module, __filename, __dirname) {\n' + text + '\n})');
};

/* The per-module `require` factory the Rust loader calls: the parent directory is bound
 * into a closure, so a function a module exports and runs later still requires from home.
 * `cache` is per-runtime (the Rust side holds the real one) and kept for shape. */
globalThis.__ggsMakeRequire = (parentDir) => {
	const req = (specifier) => __ggsRequire(parentDir, specifier);
	req.resolve = (specifier) => __ggsResolve(parentDir, specifier);
	req.cache = {};
	req.extensions = { '.js': null, '.json': null, '.node': null };
	return req;
};

/* The EventEmitter maker the Rust child-process module uses for a child's own emitter and
 * its stdout/stderr streams. */
globalThis.__ggsNewEmitter = () => new EventEmitter();

globalThis.__ggsBufferClass = globalThis.__ggsBufferClass ?? globalThis.Buffer;
