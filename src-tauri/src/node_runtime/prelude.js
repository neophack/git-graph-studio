// The pretend Node runtime's JavaScript half: the pieces that are far shorter in JS than in
// Rust — console, EventEmitter, Buffer, timers, util.format, `process`, and the two
// compatibility stubs (`vscode`, the frame host's API) — layered over the `__ggs*` native
// functions `builtins.rs` registers. Everything here runs before the package's own entry,
// in the same global object; nothing here is the package's protocol (that is `ggs`, also
// assembled below over its natives).

/* ---------- Symbol.dispose / Symbol.asyncDispose ----------
 * Explicit resource management's well-known symbols, which Boa does not define. Bundlers
 * lower `using` to a helper that looks up `Symbol.dispose || Symbol.for("Symbol.dispose")`
 * while the disposables themselves are written `{ [Symbol.dispose]() {} }`: without the
 * symbol those land under the key "undefined" and every `using` throws "Object not
 * disposable" (claude-code's transcript reads did). The registry symbols are the ones the
 * helpers already fall back to, so both sides agree. */
for (const name of ['dispose', 'asyncDispose']) {
	if (typeof Symbol[name] !== 'symbol') {
		Object.defineProperty(Symbol, name, { value: Symbol.for(`Symbol.${name}`), writable: false, enumerable: false, configurable: false });
	}
}

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
			// A function's own promisified form wins (`exec` resolving `{ stdout, stderr }`).
			const own = fn?.[Symbol.for('nodejs.util.promisify.custom')];
			if (typeof own === 'function') return own;
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
					// 'buffer' and undefined: the digest bytes as a Buffer, Node's default; any
					// other encoding (base64url — PKCE challenges) is the Buffer's own rendering.
					const bytes = new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
					const digest = new globalThis.__ggsBufferClass(bytes);
					return encoding === undefined || encoding === 'buffer' ? digest : digest.toString(encoding);
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
			switch (String(encoding).toLowerCase()) {
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
				case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': {
					const out = new Buffer(text.length * 2);
					for (let i = 0; i < text.length; i += 1) {
						const unit = text.charCodeAt(i);
						out[i * 2] = unit & 0xff;
						out[i * 2 + 1] = unit >> 8;
					}
					return out;
				}
				case 'base64': case 'base64url': {
					// Both alphabets decode, as in Node: base64url's - and _ are + and /.
					const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
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
			encoding = String(encoding ?? 'utf8').toLowerCase();
			switch (encoding) {
				case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': {
					let out = '';
					for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
					return out;
				}
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
					// base64url is its own alphabet (RFC 4648 §5) — PKCE challenges and JWTs.
					return encoding === 'base64url' ? out.replace(/\+/g, '-').replace(/\//g, '_') : out;
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
		/* Node's `slice` is a view (`subarray`), never the TypedArray copy. */
		slice(start, end) {
			return this.subarray(start, end);
		}
		/* `buf.write(string[, offset[, length]][, encoding])` → bytes written. */
		write(string, offset, length, encoding) {
			if (typeof offset === 'string') {
				encoding = offset;
				offset = 0;
				length = undefined;
			} else if (typeof length === 'string') {
				encoding = length;
				length = undefined;
			}
			const at = Number(offset) || 0;
			const bytes = Buffer._fromString(String(string), encoding ?? 'utf8');
			const count = Math.max(0, Math.min(bytes.length, this.length - at, length === undefined ? Infinity : Number(length)));
			this.set(bytes.subarray(0, count), at);
			return count;
		}
		fill(value, offset = 0, end = this.length, encoding) {
			if (typeof offset === 'string') {
				encoding = offset;
				offset = 0;
				end = this.length;
			}
			if (typeof value === 'string') {
				const pattern = value.length === 1 && (encoding === undefined || encoding === 'utf8') && value.charCodeAt(0) < 128 ? null : Buffer._fromString(value, encoding ?? 'utf8');
				if (pattern === null) return Uint8Array.prototype.fill.call(this, value.charCodeAt(0), offset, end);
				if (pattern.length === 0) return Uint8Array.prototype.fill.call(this, 0, offset, end);
				for (let at = offset; at < end; at += 1) this[at] = pattern[(at - offset) % pattern.length];
				return this;
			}
			if (ArrayBuffer.isView(value)) {
				const pattern = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
				for (let at = offset; at < end; at += 1) this[at] = pattern[(at - offset) % pattern.length];
				return this;
			}
			return Uint8Array.prototype.fill.call(this, Number(value) & 255, offset, end);
		}
		/* indexOf / lastIndexOf / includes take a byte, a string or a Buffer, like Node. */
		indexOf(value, byteOffset = 0, encoding) {
			if (typeof value === 'number') return Uint8Array.prototype.indexOf.call(this, value & 255, byteOffset);
			const needle = typeof value === 'string' ? Buffer._fromString(value, encoding ?? 'utf8') : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			let from = Number(byteOffset) || 0;
			if (from < 0) from = Math.max(0, this.length + from);
			if (needle.length === 0) return Math.min(from, this.length);
			outer: for (let at = from; at + needle.length <= this.length; at += 1) {
				for (let k = 0; k < needle.length; k += 1) if (this[at + k] !== needle[k]) continue outer;
				return at;
			}
			return -1;
		}
		lastIndexOf(value, byteOffset = this.length - 1, encoding) {
			if (typeof value === 'number') return Uint8Array.prototype.lastIndexOf.call(this, value & 255, byteOffset);
			const needle = typeof value === 'string' ? Buffer._fromString(value, encoding ?? 'utf8') : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			for (let at = Math.min(Number(byteOffset), this.length - needle.length); at >= 0; at -= 1) {
				let match = true;
				for (let k = 0; k < needle.length && match; k += 1) match = this[at + k] === needle[k];
				if (match) return at;
			}
			return -1;
		}
		includes(value, byteOffset, encoding) {
			return this.indexOf(value, byteOffset, encoding) !== -1;
		}
		compare(target, targetStart = 0, targetEnd = target.length, sourceStart = 0, sourceEnd = this.length) {
			const a = this.subarray(sourceStart, sourceEnd);
			const b = target.subarray(targetStart, targetEnd);
			for (let at = 0; at < Math.min(a.length, b.length); at += 1) if (a[at] !== b[at]) return a[at] < b[at] ? -1 : 1;
			return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
		}
		static compare(a, b) {
			return Buffer.prototype.compare.call(a, b);
		}
		static isEncoding(encoding) {
			return ['utf8', 'utf-8', 'hex', 'base64', 'base64url', 'ascii', 'latin1', 'binary', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].includes(String(encoding).toLowerCase());
		}
		static allocUnsafeSlow(size) {
			return Buffer.alloc(size);
		}
		swap16() {
			for (let at = 0; at + 1 < this.length; at += 2) [this[at], this[at + 1]] = [this[at + 1], this[at]];
			return this;
		}
		swap32() {
			for (let at = 0; at + 3 < this.length; at += 4) this.subarray(at, at + 4).reverse();
			return this;
		}
		swap64() {
			for (let at = 0; at + 7 < this.length; at += 8) this.subarray(at, at + 8).reverse();
			return this;
		}
		__view() {
			return new DataView(this.buffer, this.byteOffset, this.byteLength);
		}
		/* Variable-width integers (1–6 bytes), Node's readUIntBE / writeIntLE family. */
		readUIntBE(offset, byteLength) {
			let value = 0;
			for (let at = 0; at < byteLength; at += 1) value = value * 256 + this.__byte(offset + at);
			return value;
		}
		readUIntLE(offset, byteLength) {
			let value = 0;
			for (let at = byteLength - 1; at >= 0; at -= 1) value = value * 256 + this.__byte(offset + at);
			return value;
		}
		readIntBE(offset, byteLength) {
			const value = this.readUIntBE(offset, byteLength);
			const limit = 2 ** (8 * byteLength - 1);
			return value >= limit ? value - limit * 2 : value;
		}
		readIntLE(offset, byteLength) {
			const value = this.readUIntLE(offset, byteLength);
			const limit = 2 ** (8 * byteLength - 1);
			return value >= limit ? value - limit * 2 : value;
		}
		writeUIntBE(value, offset, byteLength) {
			let rest = Number(value);
			for (let at = byteLength - 1; at >= 0; at -= 1) {
				this.__put(offset + at, rest % 256);
				rest = Math.floor(rest / 256);
			}
			return offset + byteLength;
		}
		writeUIntLE(value, offset, byteLength) {
			let rest = Number(value);
			for (let at = 0; at < byteLength; at += 1) {
				this.__put(offset + at, rest % 256);
				rest = Math.floor(rest / 256);
			}
			return offset + byteLength;
		}
		writeIntBE(value, offset, byteLength) {
			return this.writeUIntBE(value < 0 ? value + 2 ** (8 * byteLength) : value, offset, byteLength);
		}
		writeIntLE(value, offset, byteLength) {
			return this.writeUIntLE(value < 0 ? value + 2 ** (8 * byteLength) : value, offset, byteLength);
		}
		__byte(at) {
			if (at < 0 || at >= this.length) throw Object.assign(new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${this.length - 1}. Received ${at}`), { code: 'ERR_OUT_OF_RANGE' });
			return this[at];
		}
		__put(at, byte) {
			if (at < 0 || at >= this.length) throw Object.assign(new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${this.length - 1}. Received ${at}`), { code: 'ERR_OUT_OF_RANGE' });
			this[at] = byte;
		}
	}
	/* The fixed-width reads and writes, generated over DataView: readUInt8 … readDoubleBE,
	 * the BigInt 64-bit pair, and the lower-case `readUint…` aliases Node also carries. */
	{
		const kinds = [
			['UInt8', 'Uint8', 1], ['Int8', 'Int8', 1],
			['UInt16', 'Uint16', 2], ['Int16', 'Int16', 2],
			['UInt32', 'Uint32', 4], ['Int32', 'Int32', 4],
			['Float', 'Float32', 4], ['Double', 'Float64', 8],
			['BigUInt64', 'BigUint64', 8], ['BigInt64', 'BigInt64', 8]
		];
		const range = (buffer, offset, width) => {
			if (buffer.length < width) {
				throw Object.assign(new RangeError('Attempt to access memory outside buffer bounds'), { code: 'ERR_BUFFER_OUT_OF_BOUNDS' });
			}
			if (!Number.isInteger(offset) || offset < 0 || offset + width > buffer.length) {
				throw Object.assign(new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${buffer.length - width}. Received ${offset}`), { code: 'ERR_OUT_OF_RANGE' });
			}
		};
		for (const [name, view, width] of kinds) {
			const endians = width === 1 ? [['', false]] : [['BE', false], ['LE', true]];
			for (const [suffix, little] of endians) {
				const read = function (offset = 0) {
					range(this, offset, width);
					return this.__view()[`get${view}`](offset, little);
				};
				const write = function (value, offset = 0) {
					range(this, offset, width);
					this.__view()[`set${view}`](offset, view.startsWith('Big') ? BigInt(value) : Number(value), little);
					return offset + width;
				};
				Buffer.prototype[`read${name}${suffix}`] = read;
				Buffer.prototype[`write${name}${suffix}`] = write;
				if (name.startsWith('UInt') || name.startsWith('BigUInt')) {
					const alias = name.replace('UInt', 'Uint');
					Buffer.prototype[`read${alias}${suffix}`] = read;
					Buffer.prototype[`write${alias}${suffix}`] = write;
				}
			}
		}
		Buffer.prototype.readUintBE = Buffer.prototype.readUIntBE;
		Buffer.prototype.readUintLE = Buffer.prototype.readUIntLE;
		Buffer.prototype.writeUintBE = Buffer.prototype.writeUIntBE;
		Buffer.prototype.writeUintLE = Buffer.prototype.writeUIntLE;
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
	/* A Stats object: the fields plus the predicate methods Node code calls. `{ bigint: true }`
	 * answers the numeric fields as BigInts, as Node does; `dev` / `ino` are a constant pair
	 * (std has no stable file identity on Windows), so a path's lstat and its open handle's
	 * stat compare equal - the identity check claude-code's transcript probe makes. */
	const toStats = (raw, options) => {
		const kind = raw.kind;
		const n = options && options.bigint ? (value) => BigInt(Math.trunc(value)) : (value) => value;
		return {
			dev: n(0),
			ino: n(0),
			nlink: n(1),
			uid: n(0),
			gid: n(0),
			size: n(raw.size),
			mtimeMs: n(raw.mtimeMs),
			ctimeMs: n(raw.ctimeMs),
			birthtimeMs: n(raw.birthtimeMs),
			atimeMs: n(raw.mtimeMs),
			mtime: new Date(raw.mtimeMs),
			ctime: new Date(raw.ctimeMs),
			birthtime: new Date(raw.birthtimeMs),
			atime: new Date(raw.mtimeMs),
			mode: n(kind === 'dir' ? 0o40755 : kind === 'symlink' ? 0o120777 : 0o100644),
			isFile: () => kind === 'file',
			isDirectory: () => kind === 'dir',
			isSymbolicLink: () => kind === 'symlink',
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false
		};
	};
	/* Stats reads honour Node's `throwIfNoEntry: false`: a missing path answers undefined. */
	const statOf = (path, options, lstat) => {
		try {
			return toStats(raw.stat(path, lstat), options);
		} catch (error) {
			withCode(error);
			if (options && options.throwIfNoEntry === false && error.code === 'ENOENT') return undefined;
			throw error;
		}
	};
	const fs = {
		/* The open flags carry win32's values (Node's own there); O_NOFOLLOW / O_NONBLOCK are
		 * absent, as on win32, so a caller's `?? 0` leaves them out. */
		constants: {
			...raw.constants,
			O_RDONLY: 0,
			O_WRONLY: 1,
			O_RDWR: 2,
			O_APPEND: 8,
			O_CREAT: 256,
			O_TRUNC: 512,
			O_EXCL: 1024
		},
		/* No encoding answers a Buffer, as Node does - claude-code's transcript parser walks
		 * the bytes (`indexOf(10)`, `toString('utf-8', from, to)`) and read none from a
		 * string. */
		readFileSync(path, options) {
			const encoding = encodingOf(options, 'buffer');
			const binary = encoding === 'buffer' || encoding === null;
			const result = binary ? asBuffer(raw.readFileSyncBytes(path)) : raw.readFileSync(path, encoding);
			return result;
		},
		/* `flag` as Node reads it: 'wx' / 'ax' refuse an existing path (EEXIST - the
		 * exclusive create atomic writers stage their temp files with), 'a' appends. */
		writeFileSync(path, data, options) {
			const encoding = encodingOf(options, 'utf8');
			const flag = options && typeof options === 'object' && typeof options.flag === 'string' ? options.flag : 'w';
			if (flag.includes('x') && raw.existsSync(path)) {
				throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
			}
			if (flag[0] === 'a') {
				if (!raw.existsSync(path)) raw.writeFileSync(path, '', 'utf8');
				const bytes = typeof data === 'string' ? globalThis.__ggsBufferClass.from(data, encoding) : data;
				raw.writeRangeBytes(path, bytes, null);
				return;
			}
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
		statSync: (path, options) => statOf(path, options, false),
		lstatSync: (path, options) => statOf(path, options, true),
		rmSync: (path, options) => raw.rmSync(path, Boolean(options && options.recursive), Boolean(options && options.force)),
		rmdirSync: (path) => raw.rmSync(path, true, false),
		unlinkSync: (path) => raw.unlinkSync(path),
		renameSync: (from, to) => raw.renameSync(from, to),
		copyFileSync: (from, to) => raw.copyFileSync(from, to),
		realpathSync: (path) => raw.realpathSync(path),
		readlinkSync: (path) => raw.readlinkSync(path),
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

	/* fd-based I/O (hex views page through big files, claude-code probes and appends its
	 * transcripts): an fd names a path plus its open mode, every read or write is a ranged
	 * native call, so a file is never loaded whole. A read without a position continues
	 * where the last one ended, as on a real descriptor. */
	const descriptors = new Map();
	let nextDescriptor = 100;
	const descriptorOf = (fd) => {
		const entry = descriptors.get(fd);
		if (entry === undefined) throw Object.assign(new Error('bad file descriptor'), { code: 'EBADF' });
		return entry;
	};
	const pathOf = (fd) => descriptorOf(fd).path;
	/* Node's flags, as a string ('r', 'a+', 'wx', ...) or O_* bits, to what the open means. */
	const openMode = (flags) => {
		const c = fs.constants;
		if (typeof flags === 'number') {
			const access = flags & 3;
			return {
				readable: access !== c.O_WRONLY,
				writable: access !== c.O_RDONLY,
				append: (flags & c.O_APPEND) !== 0,
				create: (flags & c.O_CREAT) !== 0,
				truncate: (flags & c.O_TRUNC) !== 0,
				exclusive: (flags & c.O_EXCL) !== 0
			};
		}
		const mode = flags === undefined || flags === null ? 'r' : String(flags);
		const kind = mode[0];
		if (kind !== 'r' && kind !== 'w' && kind !== 'a') {
			throw Object.assign(new Error(`EINVAL: invalid flags '${mode}'`), { code: 'EINVAL' });
		}
		const plus = mode.includes('+');
		return {
			readable: kind === 'r' || plus,
			writable: kind !== 'r' || plus,
			append: kind === 'a',
			create: kind !== 'r',
			truncate: kind === 'w',
			exclusive: mode.includes('x')
		};
	};
	fs.openSync = coded((path, flags) => {
		const mode = openMode(flags);
		const exists = raw.existsSync(path);
		if (exists && mode.exclusive && mode.create) {
			throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
		}
		if (!exists && !mode.create) raw.accessSync(path);
		if ((!exists && mode.create) || (exists && mode.truncate && mode.writable)) raw.writeFileSync(path, '', 'utf8');
		if (exists && raw.stat(path, false).kind === 'dir' && mode.writable) {
			throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
		}
		const fd = nextDescriptor++;
		descriptors.set(fd, { path, ...mode, position: 0 });
		return fd;
	});
	fs.closeSync = (fd) => {
		descriptors.delete(fd);
	};
	fs.readSync = coded((fd, buffer, offset, length, position) => {
		const entry = descriptorOf(fd);
		if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
		// Node's options-object form: readSync(fd, buffer, { offset, length, position }).
		if (offset !== null && typeof offset === 'object') ({ offset, length, position } = offset);
		const at = offset ?? 0;
		const count = length ?? (buffer.length - at);
		const from = typeof position === 'number' || typeof position === 'bigint' ? Number(position) : entry.position;
		const bytes = new Uint8Array(raw.readRangeBytes(entry.path, from, count));
		buffer.set(bytes, at);
		if (!(typeof position === 'number' || typeof position === 'bigint')) entry.position = from + bytes.length;
		return bytes.length;
	});
	/* writeSync(fd, buffer[, offset[, length[, position]]]) or writeSync(fd, string[, position[, encoding]]). */
	fs.writeSync = coded((fd, data, offset, length, position) => {
		const entry = descriptorOf(fd);
		if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
		let bytes;
		if (typeof data === 'string') {
			position = offset;
			bytes = globalThis.__ggsBufferClass.from(data, typeof length === 'string' ? length : 'utf8');
		} else {
			const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
			const at = offset ?? 0;
			bytes = view.subarray(at, at + (length ?? (view.length - at)));
		}
		// Append mode writes at the end whatever the position, as O_APPEND does.
		const explicit = typeof position === 'number' || typeof position === 'bigint';
		const target = entry.append ? null : explicit ? Number(position) : entry.position;
		const written = raw.writeRangeBytes(entry.path, bytes, target);
		if (!entry.append && !explicit) entry.position += written;
		return written;
	});
	fs.fstatSync = coded((fd, options) => fs.statSync(pathOf(fd), options));

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
		'unlink', 'rename', 'copyFile', 'rm', 'rmdir', 'realpath', 'readlink', 'access', 'open', 'close']) {
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
	fs.write = (fd, data, ...rest) => {
		const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : () => { };
		try {
			const count = fs.writeSync(fd, data, ...rest);
			queueMicrotask(() => callback(null, count, data));
		} catch (error) {
			queueMicrotask(() => callback(error, 0, data));
		}
	};
	fs.exists = (path, callback) => {
		const present = raw.existsSync(path);
		queueMicrotask(() => callback(present));
	};
	const promise = {};
	/* Promise forms: a synchronous throw becomes the rejection, never an escape. */
	const promised = (sync) => (...args) => new Promise((resolve) => resolve(sync(...args)));
	for (const name of ['mkdir', 'stat', 'lstat', 'unlink', 'rename', 'realpath', 'readlink', 'chmod']) {
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
	/* FileHandle — `fs.promises.open`'s answer over the descriptors above: stat, positional
	 * read / write, readFile / writeFile / appendFile, a read stream (readline iterates it)
	 * and close. */
	class FileHandle {
		constructor(fd) {
			this.fd = fd;
		}
		stat(options) {
			return promised(fs.fstatSync)(this.fd, options);
		}
		read(buffer, offset, length, position) {
			return promised(() => {
				if (buffer === undefined || (buffer !== null && typeof buffer === 'object' && !ArrayBuffer.isView(buffer))) {
					const options = buffer ?? {};
					buffer = options.buffer ?? globalThis.__ggsBufferClass.alloc(16384);
					({ offset, length, position } = options);
				}
				const bytesRead = fs.readSync(this.fd, buffer, offset, length, position);
				return { bytesRead, buffer };
			})();
		}
		write(data, ...rest) {
			return promised(() => ({ bytesWritten: fs.writeSync(this.fd, data, ...rest), buffer: data }))();
		}
		readFile(options) {
			return promised(() => fs.readFileSync(pathOf(this.fd), options))();
		}
		writeFile(data, options) {
			return promised(() => fs.writeFileSync(pathOf(this.fd), data, options))();
		}
		appendFile(data, options) {
			return promised(() => {
				const bytes = typeof data === 'string' ? globalThis.__ggsBufferClass.from(data, encodingOf(options, 'utf8')) : data;
				raw.writeRangeBytes(pathOf(this.fd), bytes, null);
			})();
		}
		/* Permission bits, ownership and times mean nothing to the platform surfaces this
		 * runtime serves (the module's chmod is the same no-op); an atomic writer
		 * re-applying a mode must not fail on them. */
		chmod() {
			return Promise.resolve();
		}
		chown() {
			return Promise.resolve();
		}
		utimes() {
			return Promise.resolve();
		}
		truncate(length) {
			return promised(() => {
				if (length) throw new Error('truncate to a non-zero length is not supported by the ggs-node runtime');
				raw.writeFileSync(pathOf(this.fd), '', 'utf8');
			})();
		}
		sync() {
			return Promise.resolve();
		}
		datasync() {
			return Promise.resolve();
		}
		createReadStream(options) {
			return fs.createReadStream(pathOf(this.fd), options);
		}
		close() {
			fs.closeSync(this.fd);
			return Promise.resolve();
		}
	}
	if (Symbol.asyncDispose) FileHandle.prototype[Symbol.asyncDispose] = FileHandle.prototype.close;
	promise.open = (path, flags) => promised(() => new FileHandle(fs.openSync(path, flags ?? 'r')))();
	promise.constants = fs.constants;
	fs.promises = promise;
	globalThis.fs = fs;
	delete globalThis.__ggsFs;
})();

/* ---------- child_process over the Rust spawner ----------
 * Node's shapes over the native spawn: a ChildProcess EventEmitter whose stdin is a real
 * Writable and whose stdout / stderr are real Readables (pipe, readline, async iteration,
 * `stdin.on('error')` — what SDKs driving a CLI over stdio lean on), `spawn` / `exit` /
 * `close` in Node's order (close after both output streams ended), a failed spawn as an
 * async `error` with Node's code (ENOENT) rather than a throw, and exec / execFile
 * asynchronous on top of it — never blocking the runtime's one JS thread. The *Sync
 * forms stay synchronous, and throw on a failed exit as Node's do. */
(() => {
	const native = {
		spawn: globalThis.__ggsChildProcessSpawn,
		spawnSync: globalThis.__ggsChildProcessSpawnSync
	};
	const streams = () => globalThis.__ggsBuiltins.stream;
	const shellWords = (command) =>
		process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command];
	const stdioModes = (options) => {
		const stdio = options?.stdio;
		const list = typeof stdio === 'string' ? [stdio, stdio, stdio] : Array.isArray(stdio) ? stdio : [];
		return [0, 1, 2].map((at) => (list[at] === undefined || list[at] === null ? 'pipe' : list[at]));
	};
	const errorCode = (text) => {
		if (/os error 2\b|not found|cannot find|no such file|系统找不到/i.test(text)) return 'ENOENT';
		if (/os error (5|13)\b|denied|拒绝访问/i.test(text)) return 'EACCES';
		return 'EIO';
	};
	const spawnFailure = (error, file, spawnargs) => {
		const code = errorCode(String(error?.message ?? error));
		return Object.assign(new Error(`spawn ${file} ${code}`), { code, errno: code === 'ENOENT' ? -2 : -13, syscall: `spawn ${file}`, path: file, spawnargs: spawnargs.slice(1) });
	};
	const toBytes = (chunk, encoding) => (typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk);

	class ChildProcess extends EventEmitter {
		constructor() {
			super();
			this.pid = undefined;
			this.stdin = null;
			this.stdout = null;
			this.stderr = null;
			this.stdio = [null, null, null];
			this.exitCode = null;
			this.signalCode = null;
			this.killed = false;
			this.connected = false;
			this.spawnfile = undefined;
			this.spawnargs = [];
			this.__raw = null;
			this.__signal = null;
		}
		kill(signal = 'SIGTERM') {
			if (this.__raw === null || this.exitCode !== null || this.signalCode !== null) return false;
			this.__signal = typeof signal === 'string' ? signal : 'SIGTERM';
			try {
				this.__raw.kill(signal);
			} catch {
				return false;
			}
			this.killed = true;
			return true;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
		disconnect() { }
		send() {
			return false;
		}
	}

	function spawn(file, args, options) {
		if (!Array.isArray(args)) {
			options = args;
			args = [];
		}
		options = options ?? {};
		const { Readable, Writable } = streams();
		const child = new ChildProcess();
		let command = String(file);
		let argv = args.map(String);
		child.spawnfile = command;
		child.spawnargs = [command, ...argv];
		if (options.shell) {
			const line = [command, ...argv].join(' ');
			const words = typeof options.shell === 'string'
				? [options.shell, ...(process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-c']), line]
				: shellWords(line);
			command = words[0];
			argv = words.slice(1);
		}
		const [inMode, outMode, errMode] = stdioModes(options);
		const piped = (mode) => mode === 'pipe' || mode === 'overlapped';
		const stdout = new Readable({ read() { } });
		const stderr = new Readable({ read() { } });
		let raw;
		try {
			raw = native.spawn(command, argv, { ...options, shell: false });
		} catch (error) {
			// Node reports a failed spawn asynchronously, on the child — the streams exist
			// (so `child.stdout.on(...)` right after spawn works) and end at once.
			const failure = spawnFailure(error, String(file), child.spawnargs);
			child.stdout = piped(outMode) ? stdout : null;
			child.stderr = piped(errMode) ? stderr : null;
			child.stdin = piped(inMode) ? new Writable({ write: (_chunk, _encoding, callback) => callback() }) : null;
			child.stdio = [child.stdin, child.stdout, child.stderr];
			queueMicrotask(() => {
				child.emit('error', failure);
				stdout.push(null);
				stderr.push(null);
				child.emit('close', -2, null);
			});
			return child;
		}
		child.__raw = raw;
		child.pid = raw.pid;
		raw.stdout.on('data', (chunk) => stdout.push(chunk));
		raw.stderr.on('data', (chunk) => stderr.push(chunk));
		const ended = [stdout, stderr].map((stream) => new Promise((resolve) => stream.once('end', resolve)));
		const stdin = new Writable({
			write(chunk, encoding, callback) {
				try {
					raw.stdin.write(toBytes(chunk, encoding));
					callback();
				} catch (error) {
					callback(Object.assign(new Error(`write EPIPE: ${error?.message ?? error}`), { code: 'EPIPE', errno: -32, syscall: 'write' }));
				}
			},
			final(callback) {
				try {
					raw.stdin.end();
				} catch { }
				callback();
			}
		});
		child.stdin = piped(inMode) ? stdin : null;
		if (!piped(inMode)) {
			try {
				raw.stdin.end();
			} catch { }
		}
		// Output a caller did not pipe still drains (the pipe must not fill and stall
		// the child); it is just not surfaced.
		child.stdout = piped(outMode) ? stdout : null;
		child.stderr = piped(errMode) ? stderr : null;
		if (!piped(outMode)) stdout.resume();
		if (!piped(errMode)) stderr.resume();
		child.stdio = [child.stdin, child.stdout, child.stderr];
		raw.on('exit', (code) => {
			child.exitCode = code;
			if (code === null) child.signalCode = child.__signal ?? 'SIGTERM';
			stdout.push(null);
			stderr.push(null);
			child.emit('exit', child.exitCode, child.signalCode);
			Promise.all(ended).then(() => child.emit('close', child.exitCode, child.signalCode));
		});
		let timer = null;
		if (Number(options.timeout) > 0) {
			timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGTERM'), Number(options.timeout));
			child.once('exit', () => clearTimeout(timer));
		}
		const signal = options.signal;
		if (signal) {
			const onAbort = () => {
				child.kill(options.killSignal ?? 'SIGTERM');
				child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal.reason }));
			};
			if (signal.aborted) queueMicrotask(onAbort);
			else {
				signal.addEventListener?.('abort', onAbort, { once: true });
				child.once('exit', () => signal.removeEventListener?.('abort', onAbort));
			}
		}
		queueMicrotask(() => child.emit('spawn'));
		return child;
	}

	/** Node's exec / execFile: output collected, `callback(error, stdout, stderr)` on close,
	 *  the ChildProcess returned at once. */
	function execFile(file, args, options, callback) {
		if (typeof args === 'function') {
			callback = args;
			args = [];
			options = undefined;
		} else if (!Array.isArray(args)) {
			callback = typeof options === 'function' ? options : callback;
			options = args;
			args = [];
		} else if (typeof options === 'function') {
			callback = options;
			options = undefined;
		}
		options = options ?? {};
		const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
		const maxBuffer = options.maxBuffer ?? 1024 * 1024;
		const child = spawn(file, args, { ...options, stdio: 'pipe' });
		const out = [];
		const err = [];
		let size = 0;
		let failure = null;
		const collect = (target) => (chunk) => {
			size += chunk.length;
			if (size > maxBuffer && failure === null) {
				failure = Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
				child.kill();
				return;
			}
			target.push(chunk);
		};
		child.stdout.on('data', collect(out));
		child.stderr.on('data', collect(err));
		child.on('error', (error) => {
			if (failure === null) failure = error;
		});
		child.on('close', (code, signal) => {
			const render = (bytes) => (encoding === 'buffer' || encoding === null ? bytes : bytes.toString(encoding));
			const stdout = render(Buffer.concat(out));
			const stderr = render(Buffer.concat(err));
			let error = failure;
			const cmd = [file, ...args].join(' ');
			if (error === null && (code !== 0 || signal !== null)) {
				error = Object.assign(new Error(`Command failed: ${cmd}\n${Buffer.concat(err).toString()}`), { code, killed: child.killed, signal, cmd });
			}
			if (error !== null) {
				error.stdout = stdout;
				error.stderr = stderr;
				error.cmd ??= cmd;
			}
			if (typeof callback === 'function') callback(error, stdout, stderr);
		});
		return child;
	}
	function exec(command, options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = undefined;
		}
		const words = typeof options?.shell === 'string'
			? [options.shell, ...(process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-c']), String(command)]
			: shellWords(String(command));
		const child = execFile(words[0], words.slice(1), { ...(options ?? {}), shell: false }, callback);
		child.spawnargs = [words[0], ...words.slice(1)];
		return child;
	}
	// util.promisify(exec / execFile) resolves `{ stdout, stderr }`, as Node defines it.
	const custom = Symbol.for('nodejs.util.promisify.custom');
	const promisified = (run) => (...args) => {
		let child;
		const promise = new Promise((resolve, reject) => {
			child = run(...args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
		});
		promise.child = child;
		return promise;
	};
	Object.defineProperty(execFile, custom, { value: promisified(execFile) });
	Object.defineProperty(exec, custom, { value: promisified(exec) });

	function spawnSync(file, args, options) {
		if (!Array.isArray(args)) {
			options = args;
			args = [];
		}
		options = options ?? {};
		let command = String(file);
		let argv = args.map(String);
		if (options.shell) {
			const words = shellWords([command, ...argv].join(' '));
			command = words[0];
			argv = words.slice(1);
		}
		const encoding = options.encoding;
		let done;
		try {
			done = native.spawnSync(command, argv, { ...options, shell: false });
		} catch (error) {
			// Node answers a failed spawnSync with `error`, never a throw.
			done = { status: null, signal: null, stdoutBytes: [], stderrBytes: [], error: spawnFailure(error, String(file), [String(file), ...argv]) };
		}
		const render = (bytes) => {
			const buffer = Buffer.from(bytes ?? []);
			return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer;
		};
		done.stdout = render(done.stdoutBytes);
		done.stderr = render(done.stderrBytes);
		done.output = [null, done.stdout, done.stderr];
		done.pid = done.pid ?? 0;
		done.signal = done.signal ?? null;
		delete done.stdoutBytes;
		delete done.stderrBytes;
		if (done.error === null) delete done.error;
		return done;
	}
	function execFileSync(file, args, options) {
		if (!Array.isArray(args)) {
			options = args;
			args = [];
		}
		const done = spawnSync(file, args, options);
		if (done.error) throw done.error;
		if (done.status !== 0) {
			const cmd = [file, ...args].join(' ');
			throw Object.assign(new Error(`Command failed: ${cmd}\n${Buffer.from(done.stderr ?? '').toString()}`), { status: done.status, signal: done.signal, stdout: done.stdout, stderr: done.stderr, output: done.output, pid: done.pid, cmd });
		}
		return done.stdout;
	}
	function execSync(command, options) {
		const words = shellWords(String(command));
		return execFileSync(words[0], words.slice(1), options);
	}
	const childProcess = {
		ChildProcess,
		spawn,
		spawnSync,
		exec,
		execFile,
		execSync,
		execFileSync,
		fork() {
			throw Object.assign(new Error('child_process.fork is not available in the ggs-node runtime'), { code: 'ERR_NOT_SUPPORTED' });
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

	// DOMException (Node has it global; Boa does not): the name, the message, the legacy
	// code table, and `instanceof Error` — AbortError is what cancellable APIs reject with.
	const DOM_CODES = { IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20, URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25 };
	class DOMException extends Error {
		#name;
		constructor(message = '', options = 'Error') {
			super(String(message));
			const named = typeof options === 'object' && options !== null;
			this.#name = named ? String(options.name ?? 'Error') : String(options);
			if (named && 'cause' in options) Object.defineProperty(this, 'cause', { value: options.cause, writable: true, configurable: true });
		}
		get name() {
			return this.#name;
		}
		get code() {
			return DOM_CODES[this.#name] ?? 0;
		}
	}
	define('DOMException', DOMException);

	// FinalizationRegistry (Boa 0.21 has none; claude-code constructs one at load to drop
	// abort listeners of collected signals). The spec lets an implementation never run
	// cleanup callbacks — this one never does, but keeps the observable contract: the
	// argument checks, and `unregister` answering whether a token had registrations.
	const canBeHeldWeakly = (value) =>
		(typeof value === 'object' && value !== null) || typeof value === 'function' || typeof value === 'symbol';
	class FinalizationRegistry {
		#tokens = new WeakMap();
		constructor(cleanup) {
			if (typeof cleanup !== 'function') throw new TypeError('FinalizationRegistry: cleanup must be callable');
		}
		register(target, heldValue, unregisterToken) {
			if (!canBeHeldWeakly(target)) throw new TypeError('FinalizationRegistry.prototype.register: invalid target');
			if (Object.is(target, heldValue)) throw new TypeError('FinalizationRegistry.prototype.register: target and holdings must not be same');
			if (unregisterToken !== undefined) {
				if (!canBeHeldWeakly(unregisterToken) || typeof unregisterToken === 'symbol') throw new TypeError('FinalizationRegistry.prototype.register: invalid unregister token');
				this.#tokens.set(unregisterToken, true);
			}
		}
		unregister(unregisterToken) {
			if (!canBeHeldWeakly(unregisterToken) || typeof unregisterToken === 'symbol') throw new TypeError('FinalizationRegistry.prototype.unregister: invalid unregister token');
			return this.#tokens.delete(unregisterToken);
		}
		get [Symbol.toStringTag]() {
			return 'FinalizationRegistry';
		}
	}
	define('FinalizationRegistry', FinalizationRegistry);

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
			// Node's autoDestroy (the default since v14): a finished Readable destroys itself
			// after 'end', so 'close' follows — consumers wait on it (stdout collectors).
			this.__autoDestroy = options.autoDestroy !== false;
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
			// Boa drops the `tick` a callback nested here closes over (the scheduled close
			// never ran — stdout collectors waiting on 'close' hung): the close is its own
			// method, reached through an explicit receiver.
			const stream = this;
			this._destroy(error ?? null, function (finalError) {
				stream.__emitClose(finalError);
			});
			return this;
		}
		__emitClose(finalError) {
			const stream = this;
			Promise.resolve().then(function () {
				if (finalError) stream.emit('error', finalError);
				stream.emit('close');
			});
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
				tick(() => {
					this.emit('end');
					// A Duplex closes on its own terms (its write side may still be open).
					if (this.__autoDestroy && !this.__isWritable) this.destroy();
				});
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
		target.__isWritable = true;
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

	/* ---------- net / http / https / fetch over real sockets (builtins/net.rs) ----------
	 * Real TCP: a listener's accept thread and each socket's reader and writer threads
	 * report through `__ggsNativeEvent(id, event, data, bytes)`, routed here by id. The
	 * http server is HTTP/1.1 over those sockets — keep-alive, chunked bodies, `upgrade`
	 * handed to the owner with the raw socket (what `ws` builds a WebSocket server on).
	 * The client side (`http(s).request`, `fetch`) rides the native ureq client: TLS and
	 * the system proxy included, the body streamed as it arrives. */
	const nativeRoutes = new Map();
	globalThis.__ggsNativeEvent = (id, event, data, bytes) => {
		const route = nativeRoutes.get(id);
		if (route) route(event, data, bytes);
	};
	const netError = (info) => Object.assign(new Error(info?.message ?? 'socket error'), { code: info?.code ?? 'EIO', syscall: info?.syscall, errno: -1 });
	const nativeThrow = (error) => {
		// `listen` throws "CODE|message" (see net.rs) — back into a Node-shaped error.
		const text = String(error?.message ?? error);
		const bar = text.indexOf('|');
		return bar > 0 ? netError({ code: text.slice(0, bar), message: text.slice(bar + 1) }) : netError({ message: text });
	};
	const toBytes = (chunk, encoding) => {
		if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
		if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
		if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		return Buffer.from(String(chunk));
	};

	class Socket extends Duplex {
		constructor(options = {}) {
			super({});
			this.__id = null;
			this.__closedOnce = false;
			this.__timeoutMs = 0;
			this.__timer = null;
			this.connecting = false;
			this.pending = true;
			this.allowHalfOpen = Boolean(options.allowHalfOpen);
			this.bytesRead = 0;
			this.bytesWritten = 0;
			this.remoteAddress = undefined;
			this.remotePort = undefined;
			this.remoteFamily = undefined;
			this.localAddress = undefined;
			this.localPort = undefined;
			// A socket's finish is its half-close, never its close: close comes from the
			// reader thread once the connection is really gone.
			this.__finishOnce = () => {
				if (this.writableFinished) return;
				this._final(() => {
					this.writableFinished = true;
					tick(() => this.emit('finish'));
				});
			};
		}
		get readyState() {
			if (this.connecting) return 'opening';
			if (this.readable && this.writable && !this.writableEnded) return 'open';
			if (this.readable) return 'readOnly';
			return this.writable && !this.writableEnded ? 'writeOnly' : 'closed';
		}
		__attach(id, info) {
			this.__id = id;
			this.__endpoints(info);
			this.pending = false;
			nativeRoutes.set(id, (event, data, bytes) => this.__onNative(event, data, bytes));
		}
		__endpoints(info) {
			if (!info) return;
			for (const name of ['remoteAddress', 'remotePort', 'remoteFamily', 'localAddress', 'localPort']) {
				if (info[name] !== undefined && info[name] !== null) this[name] = info[name];
			}
		}
		__onNative(event, data, bytes) {
			switch (event) {
				case 'connect':
					this.connecting = false;
					this.pending = false;
					this.__endpoints(data);
					this.__touch();
					this.emit('connect');
					this.emit('ready');
					break;
				case 'data':
					this.bytesRead += bytes.length;
					this.__touch();
					this.push(bytes);
					break;
				case 'end':
					this.push(null);
					if (!this.allowHalfOpen && !this.writableEnded) this.end();
					break;
				case 'error':
					this.destroy(netError(data));
					break;
				case 'close':
					nativeRoutes.delete(this.__id);
					this.__closed(Boolean(data?.hadError));
					break;
			}
		}
		__closed(hadError) {
			if (this.__closedOnce) return;
			this.__closedOnce = true;
			this.destroyed = true;
			this.readable = false;
			this.writable = false;
			this.__clearTimer();
			tick(() => this.emit('close', hadError));
		}
		connect(...args) {
			let options = {};
			let listener;
			if (typeof args[0] === 'object' && args[0] !== null) {
				options = args[0];
				listener = args[1];
			} else {
				options = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
				listener = typeof args[1] === 'function' ? args[1] : args[2];
			}
			if (typeof listener === 'function') this.once('connect', listener);
			if (options.path !== undefined) {
				tick(() => this.destroy(netError({ code: 'ENOTSUP', message: `connect ENOTSUP ${options.path}: IPC sockets are not available in the ggs-node runtime` })));
				return this;
			}
			this.connecting = true;
			if (options.timeout) this.setTimeout(options.timeout);
			const id = __ggsNetConnect(String(options.host ?? 'localhost'), Number(options.port));
			this.__attach(id, null);
			this.pending = true;
			return this;
		}
		_write(chunk, encoding, callback) {
			if (this.destroyed) return callback(netError({ code: 'EPIPE', message: 'This socket has been ended by the other party' }));
			const bytes = toBytes(chunk, encoding);
			this.bytesWritten += bytes.length;
			this.__touch();
			if (this.__id !== null) __ggsNetWrite(this.__id, bytes);
			callback();
		}
		_final(callback) {
			if (this.__id !== null) __ggsNetEnd(this.__id);
			callback();
		}
		destroy(error) {
			if (this.destroyed) return this;
			this.destroyed = true;
			const attached = this.__id !== null;
			if (attached) __ggsNetDestroy(this.__id);
			if (error) tick(() => this.emit('error', error));
			// A connected socket's reader reports the close; one that never got a
			// connection (or is still dialing) closes here.
			if (!attached || this.connecting) {
				if (attached) nativeRoutes.delete(this.__id);
				this.__closed(Boolean(error));
			}
			return this;
		}
		destroySoon() {
			this.end();
		}
		resetAndDestroy() {
			return this.destroy();
		}
		setNoDelay(flag = true) {
			if (this.__id !== null) __ggsNetSetNoDelay(this.__id, Boolean(flag));
			return this;
		}
		setKeepAlive() {
			return this;
		}
		setTimeout(ms, callback) {
			this.__timeoutMs = Number(ms) || 0;
			if (typeof callback === 'function') {
				if (this.__timeoutMs === 0) this.removeListener('timeout', callback);
				else this.once('timeout', callback);
			}
			this.__touch();
			return this;
		}
		__clearTimer() {
			if (this.__timer !== null) clearTimeout(this.__timer);
			this.__timer = null;
		}
		__touch() {
			this.__clearTimer();
			if (this.__timeoutMs > 0 && !this.destroyed) this.__timer = setTimeout(() => this.emit('timeout'), this.__timeoutMs);
		}
		address() {
			return this.localPort === undefined ? {} : { address: this.localAddress, family: this.remoteFamily ?? 'IPv4', port: this.localPort };
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
	}

	class Server extends EventEmitter {
		constructor(options, listener) {
			super();
			if (typeof options === 'function') listener = options;
			if (typeof listener === 'function') this.on('connection', listener);
			this.__id = null;
			this.__address = null;
			this.__sockets = new Set();
			this.maxConnections = undefined;
		}
		get listening() {
			return this.__id !== null;
		}
		listen(...args) {
			let port = 0;
			let host;
			let callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
			if (typeof args[0] === 'object' && args[0] !== null) {
				port = args[0].port ?? 0;
				host = args[0].host;
				if (args[0].path !== undefined) {
					tick(() => this.emit('error', netError({ code: 'ENOTSUP', message: `listen ENOTSUP ${args[0].path}: IPC servers are not available in the ggs-node runtime` })));
					return this;
				}
			} else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) {
				tick(() => this.emit('error', netError({ code: 'ENOTSUP', message: `listen ENOTSUP ${args[0]}: IPC servers are not available in the ggs-node runtime` })));
				return this;
			} else {
				port = args[0] ?? 0;
				if (typeof args[1] === 'string') host = args[1];
			}
			if (callback) this.once('listening', callback);
			let info;
			try {
				info = __ggsNetListen(host === undefined ? '0.0.0.0' : String(host), Number(port) || 0);
			} catch (error) {
				tick(() => this.emit('error', nativeThrow(error)));
				return this;
			}
			this.__id = info.id;
			this.__address = { address: info.address, family: info.family, port: info.port };
			nativeRoutes.set(info.id, (event, data) => {
				if (event !== 'connection') return;
				const socket = new Socket();
				socket.__attach(data.socket, data);
				this.__sockets.add(socket);
				socket.once('close', () => this.__sockets.delete(socket));
				this.emit('connection', socket);
			});
			tick(() => this.emit('listening'));
			return this;
		}
		address() {
			return this.__address;
		}
		close(callback) {
			if (this.__id === null) {
				if (typeof callback === 'function') tick(() => callback(Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })));
				return this;
			}
			nativeRoutes.delete(this.__id);
			__ggsNetCloseServer(this.__id);
			this.__id = null;
			if (typeof callback === 'function') this.once('close', callback);
			tick(() => this.emit('close'));
			return this;
		}
		getConnections(callback) {
			tick(() => callback(null, this.__sockets.size));
			return this;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
	}

	const net = builtins.net;
	const createConnection = (...args) => new Socket(typeof args[0] === 'object' && args[0] !== null ? args[0] : {}).connect(...args);
	Object.assign(net, {
		Socket,
		Stream: Socket,
		Server,
		createServer: (options, listener) => new Server(options, listener),
		connect: createConnection,
		createConnection
	});

	/* http — the server over net.Server; the client over the native request. */
	const STATUS_CODES = {
		100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
		206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
		307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
		404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
		410: 'Gone', 411: 'Length Required', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 426: 'Upgrade Required',
		429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
		503: 'Service Unavailable', 504: 'Gateway Timeout'
	};
	const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'CONNECT', 'TRACE'];
	/** Raw header pairs → Node's `headers` object: lower-cased names, `set-cookie` an
	 *  array, other repeats joined with ", ". */
	const headerObject = (pairs) => {
		const headers = {};
		for (const [rawName, value] of pairs) {
			const name = rawName.toLowerCase();
			if (name === 'set-cookie') (headers[name] ??= []).push(value);
			else if (headers[name] === undefined) headers[name] = value;
			else headers[name] += ', ' + value;
		}
		return headers;
	};

	class IncomingMessage extends Readable {
		constructor(socket) {
			super({});
			this.socket = socket;
			this.connection = socket;
			this.headers = {};
			this.rawHeaders = [];
			this.trailers = {};
			this.rawTrailers = [];
			this.method = undefined;
			this.url = '';
			this.statusCode = undefined;
			this.statusMessage = undefined;
			this.httpVersion = '1.1';
			this.httpVersionMajor = 1;
			this.httpVersionMinor = 1;
			this.complete = false;
			this.aborted = false;
		}
		setTimeout(ms, callback) {
			this.socket?.setTimeout?.(ms, callback);
			return this;
		}
	}

	/** Find `\r\n\r\n` (or `\r\n` when `double` is false) in `bytes` from `from`. */
	const findBreak = (bytes, from, double) => {
		for (let at = from; at + (double ? 3 : 1) < bytes.length; at += 1) {
			if (bytes[at] === 13 && bytes[at + 1] === 10 && (!double || (bytes[at + 2] === 13 && bytes[at + 3] === 10))) return at;
		}
		return -1;
	};
	const joinBytes = (a, b) => {
		if (a.length === 0) return b;
		const out = new Buffer(a.length + b.length);
		out.set(a, 0);
		out.set(b, a.length);
		return out;
	};

	class ServerResponse extends Writable {
		constructor(req, socket, keepAlive) {
			super({});
			this.req = req;
			this.socket = socket;
			this.connection = socket;
			this.statusCode = 200;
			this.statusMessage = undefined;
			this.headersSent = false;
			this.finished = false;
			this.sendDate = true;
			this.__headers = new Map();
			this.__keepAlive = keepAlive;
			this.__chunked = false;
			this.__noBody = false;
		}
		setHeader(name, value) {
			if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
			this.__headers.set(String(name).toLowerCase(), [String(name), value]);
			return this;
		}
		appendHeader(name, value) {
			const current = this.getHeader(name);
			if (current === undefined) return this.setHeader(name, value);
			return this.setHeader(name, [].concat(current, value));
		}
		getHeader(name) {
			return this.__headers.get(String(name).toLowerCase())?.[1];
		}
		getHeaders() {
			const out = {};
			for (const [key, [, value]] of this.__headers) out[key] = value;
			return out;
		}
		getHeaderNames() {
			return [...this.__headers.keys()];
		}
		hasHeader(name) {
			return this.__headers.has(String(name).toLowerCase());
		}
		removeHeader(name) {
			this.__headers.delete(String(name).toLowerCase());
		}
		writeHead(status, message, headers) {
			if (typeof message !== 'string') {
				headers = message;
				message = undefined;
			}
			this.statusCode = Number(status);
			if (message !== undefined) this.statusMessage = message;
			if (Array.isArray(headers)) {
				if (Array.isArray(headers[0])) for (const [name, value] of headers) this.setHeader(name, value);
				else for (let at = 0; at + 1 < headers.length; at += 2) this.setHeader(headers[at], headers[at + 1]);
			} else if (headers) {
				for (const [name, value] of Object.entries(headers)) if (value !== undefined) this.setHeader(name, value);
			}
			this.__sendHead();
			return this;
		}
		flushHeaders() {
			this.__sendHead();
		}
		writeContinue() {
			this.socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
		}
		addTrailers() { }
		setTimeout(ms, callback) {
			this.socket?.setTimeout?.(ms, callback);
			return this;
		}
		__sendHead(bodyLength) {
			if (this.headersSent) return;
			this.headersSent = true;
			const headers = this.__headers;
			const status = this.statusCode;
			const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
			if (this.sendDate && !headers.has('date')) headers.set('date', ['Date', new Date().toUTCString()]);
			const encoding = String(headers.get('transfer-encoding')?.[1] ?? '');
			if (/chunked/i.test(encoding)) this.__chunked = true;
			else if (!noBody && !headers.has('content-length')) {
				if (bodyLength !== undefined) headers.set('content-length', ['Content-Length', String(bodyLength)]);
				else {
					headers.set('transfer-encoding', ['Transfer-Encoding', 'chunked']);
					this.__chunked = true;
				}
			}
			const connection = headers.get('connection')?.[1];
			if (connection === undefined) {
				if (status !== 101) headers.set('connection', ['Connection', this.__keepAlive ? 'keep-alive' : 'close']);
			} else if (/close/i.test(String(connection))) this.__keepAlive = false;
			let head = `HTTP/1.1 ${status} ${this.statusMessage ?? STATUS_CODES[status] ?? 'Unknown'}\r\n`;
			for (const [, [name, value]] of headers) {
				for (const one of Array.isArray(value) ? value : [value]) head += `${name}: ${one}\r\n`;
			}
			this.socket.write(head + '\r\n', 'utf8');
			this.__noBody = noBody || this.req?.method === 'HEAD';
		}
		write(chunk, encoding, callback) {
			const done = typeof encoding === 'function' ? encoding : callback;
			if (this.finished) {
				const error = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
				tick(() => (done ? done(error) : this.emit('error', error)));
				return false;
			}
			this.__sendHead();
			const bytes = toBytes(chunk, typeof encoding === 'string' ? encoding : undefined);
			if (!this.__noBody && bytes.length > 0) {
				if (this.__chunked) {
					this.socket.write(bytes.length.toString(16) + '\r\n', 'latin1');
					this.socket.write(bytes);
					this.socket.write('\r\n', 'latin1');
				} else this.socket.write(bytes);
			}
			if (done) tick(() => done(null));
			return true;
		}
		end(chunk, encoding, callback) {
			if (typeof chunk === 'function') {
				callback = chunk;
				chunk = undefined;
			} else if (typeof encoding === 'function') {
				callback = encoding;
				encoding = undefined;
			}
			if (this.finished) {
				if (typeof callback === 'function') tick(callback);
				return this;
			}
			if (!this.headersSent) {
				const bytes = chunk === undefined || chunk === null ? new Uint8Array(0) : toBytes(chunk, encoding);
				this.__sendHead(bytes.length);
				if (!this.__noBody && bytes.length > 0) {
					if (this.__chunked) this.write(bytes);
					else this.socket.write(bytes);
				}
			} else if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
			if (this.__chunked && !this.__noBody) this.socket.write('0\r\n\r\n', 'latin1');
			this.finished = true;
			this.writableEnded = true;
			tick(() => {
				this.writableFinished = true;
				this.emit('finish');
				if (typeof callback === 'function') callback();
				this.emit('close');
			});
			return this;
		}
	}

	/** One connection's HTTP/1.1 server loop: parse a request head, frame its body
	 *  (Content-Length or chunked), answer in order (the next request waits for the
	 *  current response to finish), and hand an Upgrade over with the raw socket. */
	const serveHttp = (server, socket) => {
		let buffer = new Uint8Array(0);
		let busy = false;
		let body = null; // { req, remaining, chunked, chunkLeft, trailer }
		const onData = (chunk) => {
			buffer = joinBytes(buffer, chunk);
			pump();
		};
		const fail = (status) => {
			try {
				socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, 'latin1');
			} catch { }
			socket.end();
		};
		const pump = () => {
			while (true) {
				if (body !== null) {
					if (!pumpBody()) return;
					continue;
				}
				if (busy) return;
				const end = findBreak(buffer, 0, true);
				if (end < 0) {
					if (buffer.length > 80 * 1024) fail(431);
					return;
				}
				const head = Buffer.from(buffer.subarray(0, end)).toString('latin1');
				buffer = buffer.subarray(end + 4);
				const lines = head.split('\r\n');
				const requestLine = /^([A-Z]+) (\S+) HTTP\/(\d)\.(\d)$/.exec(lines[0]);
				if (!requestLine) return fail(400);
				const req = new IncomingMessage(socket);
				req.method = requestLine[1];
				req.url = requestLine[2];
				req.httpVersionMajor = Number(requestLine[3]);
				req.httpVersionMinor = Number(requestLine[4]);
				req.httpVersion = `${req.httpVersionMajor}.${req.httpVersionMinor}`;
				const pairs = [];
				for (const line of lines.slice(1)) {
					const colon = line.indexOf(':');
					if (colon <= 0) continue;
					const name = line.slice(0, colon).trim();
					const value = line.slice(colon + 1).trim();
					pairs.push([name, value]);
					req.rawHeaders.push(name, value);
				}
				req.headers = headerObject(pairs);
				const connection = String(req.headers.connection ?? '');
				const upgrade = req.headers.upgrade !== undefined && /\bupgrade\b/i.test(connection);
				const event = req.method === 'CONNECT' ? 'connect' : upgrade ? 'upgrade' : null;
				if (event !== null && server.listenerCount(event) > 0) {
					// The socket is the owner's now (a WebSocket server takes it over).
					socket.removeListener('data', onData);
					const rest = Buffer.from(buffer);
					buffer = new Uint8Array(0);
					req.complete = true;
					req.push(null);
					server.emit(event, req, socket, rest);
					return;
				}
				const keepAlive = req.httpVersionMinor >= 1 ? !/\bclose\b/i.test(connection) : /\bkeep-alive\b/i.test(connection);
				const res = new ServerResponse(req, socket, keepAlive);
				busy = true;
				res.once('finish', () => {
					busy = false;
					if (!res.__keepAlive) socket.end();
					else tick(pump);
				});
				const chunked = /\bchunked\b/i.test(String(req.headers['transfer-encoding'] ?? ''));
				const length = Number(req.headers['content-length'] ?? 0) || 0;
				if (chunked || length > 0) body = { req, remaining: length, chunked, chunkLeft: -1, trailer: false };
				else {
					req.complete = true;
					req.push(null);
				}
				if (/100-continue/i.test(String(req.headers.expect ?? '')) && server.listenerCount('checkContinue') > 0) server.emit('checkContinue', req, res);
				else {
					if (/100-continue/i.test(String(req.headers.expect ?? ''))) res.writeContinue();
					server.emit('request', req, res);
				}
			}
		};
		/** Feed the current request's body; true when it completed (the loop continues). */
		const pumpBody = () => {
			const { req } = body;
			if (!body.chunked) {
				if (buffer.length === 0) return false;
				const take = Math.min(body.remaining, buffer.length);
				req.push(Buffer.from(buffer.subarray(0, take)));
				buffer = buffer.subarray(take);
				body.remaining -= take;
				if (body.remaining > 0) return false;
			} else {
				while (true) {
					if (body.trailer) {
						const end = findBreak(buffer, 0, false);
						if (end < 0) return false;
						const line = Buffer.from(buffer.subarray(0, end)).toString('latin1');
						buffer = buffer.subarray(end + 2);
						if (line === '') break;
						continue;
					}
					if (body.chunkLeft < 0) {
						const end = findBreak(buffer, 0, false);
						if (end < 0) return false;
						const size = parseInt(Buffer.from(buffer.subarray(0, end)).toString('latin1'), 16);
						buffer = buffer.subarray(end + 2);
						if (!Number.isFinite(size)) {
							fail(400);
							return false;
						}
						if (size === 0) {
							body.trailer = true;
							continue;
						}
						body.chunkLeft = size;
					}
					if (body.chunkLeft > 0) {
						if (buffer.length === 0) return false;
						const take = Math.min(body.chunkLeft, buffer.length);
						req.push(Buffer.from(buffer.subarray(0, take)));
						buffer = buffer.subarray(take);
						body.chunkLeft -= take;
						if (body.chunkLeft > 0) return false;
					}
					if (buffer.length < 2) return false;
					buffer = buffer.subarray(2); // the chunk's CRLF
					body.chunkLeft = -1;
				}
			}
			req.complete = true;
			req.push(null);
			body = null;
			return true;
		};
		socket.on('data', onData);
		socket.on('error', (error) => server.emit('clientError', error, socket));
	};

	class HttpServer extends Server {
		constructor(options, listener) {
			if (typeof options === 'function') {
				listener = options;
				options = {};
			}
			super();
			this.timeout = 0;
			this.keepAliveTimeout = 5000;
			this.headersTimeout = 60000;
			this.requestTimeout = 300000;
			this.maxHeadersCount = null;
			if (typeof listener === 'function') this.on('request', listener);
			this.on('connection', (socket) => serveHttp(this, socket));
		}
		setTimeout(ms, callback) {
			this.timeout = Number(ms) || 0;
			if (typeof callback === 'function') this.on('timeout', callback);
			return this;
		}
		closeAllConnections() {
			for (const socket of this.__sockets) socket.destroy();
		}
		closeIdleConnections() { }
	}

	/* The client: `http(s).request` / `get` over `__ggsHttpRequest`. The request body
	 * is collected and sent at `end()`; the response streams. */
	class Agent extends EventEmitter {
		constructor(options = {}) {
			super();
			this.options = options;
			this.keepAlive = Boolean(options.keepAlive);
			this.maxSockets = options.maxSockets ?? Infinity;
			this.sockets = {};
			this.requests = {};
			this.freeSockets = {};
		}
		destroy() { }
	}
	const requestSpec = (defaultProtocol, args) => {
		let url;
		let options = {};
		let callback;
		for (const arg of args) {
			if (typeof arg === 'function') callback = arg;
			else if (typeof arg === 'string' || arg instanceof URL) url = String(arg);
			else if (arg && typeof arg === 'object') options = { ...options, ...arg };
		}
		if (url === undefined) {
			const protocol = options.protocol ?? defaultProtocol;
			const host = options.hostname ?? (options.host ? String(options.host).replace(/:\d+$/, '') : 'localhost');
			const port = options.port ? `:${options.port}` : '';
			url = `${protocol}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port}${options.path ?? '/'}`;
		}
		return { url, options, callback };
	};
	class ClientRequest extends Writable {
		constructor(defaultProtocol, args) {
			super({});
			const { url, options, callback } = requestSpec(defaultProtocol, args);
			this.__url = url;
			this.method = String(options.method ?? 'GET').toUpperCase();
			this.path = options.path ?? new URL(url).pathname;
			this.host = options.hostname ?? options.host;
			this.protocol = defaultProtocol;
			this.__headers = new Map();
			this.__chunks = [];
			this.__id = null;
			this.__timeoutMs = options.timeout ?? 0;
			this.__timer = null;
			this.__signal = options.signal;
			this.aborted = false;
			this.destroyed = false;
			this.finished = false;
			this.headersSent = false;
			this.reusedSocket = false;
			const headers = options.headers;
			if (Array.isArray(headers)) for (let at = 0; at + 1 < headers.length; at += 2) this.setHeader(headers[at], headers[at + 1]);
			else if (headers) for (const [name, value] of Object.entries(headers)) if (value !== undefined) this.setHeader(name, value);
			if (options.auth && !this.hasHeader('authorization')) this.setHeader('Authorization', 'Basic ' + Buffer.from(String(options.auth)).toString('base64'));
			if (typeof callback === 'function') this.once('response', callback);
			if (this.__signal) {
				if (this.__signal.aborted) tick(() => this.destroy(this.__abortError()));
				else this.__signal.addEventListener?.('abort', () => this.destroy(this.__abortError()));
			}
			// Libraries wait for 'socket' to arm their own timeouts; the native client
			// has no socket object, so a stand-in carries the calls they make on it.
			this.socket = Object.assign(new EventEmitter(), {
				setTimeout: (ms, cb) => this.setTimeout(ms, cb),
				setNoDelay: () => undefined,
				setKeepAlive: () => undefined,
				destroy: (error) => this.destroy(error),
				ref: () => undefined,
				unref: () => undefined,
				remoteAddress: undefined
			});
			this.connection = this.socket;
			tick(() => this.emit('socket', this.socket));
		}
		__abortError() {
			return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
		}
		setHeader(name, value) {
			this.__headers.set(String(name).toLowerCase(), [String(name), value]);
			return this;
		}
		getHeader(name) {
			return this.__headers.get(String(name).toLowerCase())?.[1];
		}
		getHeaders() {
			const out = {};
			for (const [key, [, value]] of this.__headers) out[key] = value;
			return out;
		}
		getHeaderNames() {
			return [...this.__headers.keys()];
		}
		hasHeader(name) {
			return this.__headers.has(String(name).toLowerCase());
		}
		removeHeader(name) {
			this.__headers.delete(String(name).toLowerCase());
		}
		flushHeaders() { }
		setNoDelay() { }
		setSocketKeepAlive() { }
		setTimeout(ms, callback) {
			this.__timeoutMs = Number(ms) || 0;
			if (typeof callback === 'function') this.once('timeout', callback);
			this.__arm();
			return this;
		}
		__arm() {
			if (this.__timer !== null) clearTimeout(this.__timer);
			this.__timer = null;
			if (this.__timeoutMs > 0 && this.__id !== null && !this.destroyed) this.__timer = setTimeout(() => this.emit('timeout'), this.__timeoutMs);
		}
		write(chunk, encoding, callback) {
			const done = typeof encoding === 'function' ? encoding : callback;
			this.__chunks.push(toBytes(chunk, typeof encoding === 'string' ? encoding : undefined));
			if (done) tick(() => done(null));
			return true;
		}
		end(chunk, encoding, callback) {
			if (typeof chunk === 'function') {
				callback = chunk;
				chunk = undefined;
			} else if (typeof encoding === 'function') {
				callback = encoding;
				encoding = undefined;
			}
			if (this.finished) return this;
			if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
			this.finished = true;
			this.writableEnded = true;
			this.headersSent = true;
			if (typeof callback === 'function') this.once('finish', callback);
			if (this.destroyed) return this;
			let total = 0;
			for (const part of this.__chunks) total += part.length;
			const body = new Buffer(total);
			let at = 0;
			for (const part of this.__chunks) {
				body.set(part, at);
				at += part.length;
			}
			const headers = [];
			for (const [, [name, value]] of this.__headers) for (const one of Array.isArray(value) ? value : [value]) headers.push([name, String(one)]);
			let response = null;
			this.__id = __ggsHttpRequest({ method: this.method, url: this.__url, headers }, total > 0 || !['GET', 'HEAD'].includes(this.method) ? body : undefined);
			this.__arm();
			nativeRoutes.set(this.__id, (event, data, bytes) => {
				this.__arm();
				if (event === 'response') {
					response = new IncomingMessage(this.socket);
					response.statusCode = data.status;
					response.statusMessage = data.statusText || STATUS_CODES[data.status] || '';
					response.headers = headerObject(data.headers);
					response.rawHeaders = data.headers.flat();
					response.req = this;
					this.res = response;
					this.emit('response', response);
				} else if (event === 'data') {
					response?.push(bytes);
				} else if (event === 'end') {
					nativeRoutes.delete(this.__id);
					this.__timeoutMs = 0;
					this.__arm();
					if (response) {
						response.complete = true;
						response.push(null);
					}
					tick(() => this.emit('close'));
				} else if (event === 'error') {
					nativeRoutes.delete(this.__id);
					this.__timeoutMs = 0;
					this.__arm();
					this.destroy(netError(data));
				}
			});
			tick(() => this.emit('finish'));
			return this;
		}
		abort() {
			if (this.aborted) return;
			this.aborted = true;
			this.emit('abort');
			this.destroy();
		}
		destroy(error) {
			if (this.destroyed) return this;
			this.destroyed = true;
			if (this.__id !== null) {
				__ggsHttpAbort(this.__id);
				nativeRoutes.delete(this.__id);
			}
			if (this.__timer !== null) clearTimeout(this.__timer);
			const response = this.res;
			tick(() => {
				if (error) {
					if (response && !response.complete) {
						response.aborted = true;
						response.destroy(error);
					} else this.emit('error', error);
				} else if (response && !response.complete) {
					response.aborted = true;
					response.emit('aborted');
					response.destroy();
				}
				this.emit('close');
			});
			return this;
		}
	}
	const httpModule = (protocol) => {
		const request = (...args) => new ClientRequest(protocol, args);
		const get = (...args) => {
			const req = request(...args);
			req.end();
			return req;
		};
		const globalAgent = new Agent({ keepAlive: true });
		const createServer = protocol === 'https:'
			? () => {
				const server = new HttpServer();
				server.listen = () => {
					tick(() => server.emit('error', Object.assign(new Error('TLS servers are not available in the ggs-node runtime'), { code: 'ERR_NOT_SUPPORTED' })));
					return server;
				};
				return server;
			}
			: (options, listener) => new HttpServer(options, listener);
		return {
			Agent,
			globalAgent,
			ClientRequest,
			IncomingMessage,
			OutgoingMessage: Writable,
			Server: HttpServer,
			ServerResponse,
			STATUS_CODES,
			METHODS,
			maxHeaderSize: 16384,
			createServer,
			request,
			get,
			validateHeaderName: (name) => {
				if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(name))) throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: 'ERR_INVALID_HTTP_TOKEN' });
			},
			validateHeaderValue: (name, value) => {
				if (value === undefined) throw Object.assign(new TypeError(`Invalid value "undefined" for header "${name}"`), { code: 'ERR_HTTP_INVALID_HEADER_VALUE' });
			}
		};
	};
	globalThis.http = httpModule('http:');
	globalThis.https = httpModule('https:');

	/* fetch — WHATWG's shape over the same native client: Headers, Request, Response and a
	 * streaming body (a ReadableStream where the engine has none of its own). */
	if (typeof globalThis.ReadableStream === 'undefined') {
		class ReadableStreamDefaultReader {
			constructor(stream) {
				this.__stream = stream;
				stream.__locked = true;
				this.closed = stream.__closed.promise;
			}
			read() {
				return this.__stream.__read();
			}
			releaseLock() {
				this.__stream.__locked = false;
			}
			cancel(reason) {
				return this.__stream.cancel(reason);
			}
		}
		class ReadableStream {
			constructor(source = {}) {
				this.__queue = [];
				this.__waiters = [];
				this.__done = false;
				this.__error = null;
				this.__locked = false;
				this.__source = source;
				let settle;
				this.__closed = { promise: new Promise((resolve) => (settle = resolve)), settle };
				const controller = {
					enqueue: (chunk) => {
						if (this.__done) return;
						const waiter = this.__waiters.shift();
						if (waiter) waiter.resolve({ value: chunk, done: false });
						else this.__queue.push(chunk);
					},
					close: () => {
						if (this.__done) return;
						this.__done = true;
						for (const waiter of this.__waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
						this.__closed.settle();
					},
					error: (error) => {
						if (this.__done) return;
						this.__done = true;
						this.__error = error;
						for (const waiter of this.__waiters.splice(0)) waiter.reject(error);
						this.__closed.settle();
					},
					get desiredSize() {
						return 1;
					}
				};
				this.__controller = controller;
				try {
					const started = source.start?.(controller);
					if (started && typeof started.then === 'function') started.catch((error) => controller.error(error));
				} catch (error) {
					controller.error(error);
				}
			}
			get locked() {
				return this.__locked;
			}
			__read() {
				if (this.__queue.length > 0) return Promise.resolve({ value: this.__queue.shift(), done: false });
				if (this.__error !== null) return Promise.reject(this.__error);
				if (this.__done) return Promise.resolve({ value: undefined, done: true });
				const pending = new Promise((resolve, reject) => this.__waiters.push({ resolve, reject }));
				if (this.__source.pull) {
					try {
						const pulled = this.__source.pull(this.__controller);
						if (pulled && typeof pulled.then === 'function') pulled.catch((error) => this.__controller.error(error));
					} catch (error) {
						this.__controller.error(error);
					}
				}
				return pending;
			}
			getReader() {
				if (this.__locked) throw new TypeError('ReadableStream is locked');
				return new ReadableStreamDefaultReader(this);
			}
			cancel(reason) {
				this.__queue.length = 0;
				this.__controller.close();
				return Promise.resolve(this.__source.cancel?.(reason));
			}
			async *[Symbol.asyncIterator]() {
				const reader = this.getReader();
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) return;
						yield value;
					}
				} finally {
					reader.releaseLock();
				}
			}
			async pipeTo(destination) {
				const writer = destination.getWriter ? destination.getWriter() : destination;
				for await (const chunk of this) await writer.write(chunk);
				await writer.close?.();
			}
			tee() {
				const chunks = [];
				const reader = this.getReader();
				const branch = () => {
					let at = 0;
					return new ReadableStream({
						pull: async (controller) => {
							while (at >= chunks.length) {
								const { value, done } = await reader.read();
								if (done) return controller.close();
								chunks.push(value);
							}
							controller.enqueue(chunks[at++]);
						}
					});
				};
				return [branch(), branch()];
			}
			static from(iterable) {
				const iterator = (iterable[Symbol.asyncIterator] ?? iterable[Symbol.iterator]).call(iterable);
				return new ReadableStream({
					pull: async (controller) => {
						const { value, done } = await iterator.next();
						if (done) controller.close();
						else controller.enqueue(value);
					}
				});
			}
		}
		globalThis.ReadableStream = ReadableStream;
		globalThis.ReadableStreamDefaultReader = ReadableStreamDefaultReader;
	}
	if (typeof globalThis.Headers === 'undefined') {
		class Headers {
			constructor(init) {
				this.__map = new Map();
				if (init instanceof Headers) init.forEach((value, name) => this.append(name, value));
				else if (Array.isArray(init)) for (const [name, value] of init) this.append(name, value);
				else if (init && typeof init === 'object') {
					if (typeof init[Symbol.iterator] === 'function') for (const [name, value] of init) this.append(name, value);
					else for (const [name, value] of Object.entries(init)) this.append(name, value);
				}
			}
			append(name, value) {
				const key = String(name).toLowerCase();
				const list = this.__map.get(key);
				if (list) list.push(String(value));
				else this.__map.set(key, [String(value)]);
			}
			set(name, value) {
				this.__map.set(String(name).toLowerCase(), [String(value)]);
			}
			get(name) {
				const list = this.__map.get(String(name).toLowerCase());
				if (!list) return null;
				return String(name).toLowerCase() === 'set-cookie' ? list.join(', ') : list.join(', ');
			}
			getSetCookie() {
				return [...(this.__map.get('set-cookie') ?? [])];
			}
			has(name) {
				return this.__map.has(String(name).toLowerCase());
			}
			delete(name) {
				this.__map.delete(String(name).toLowerCase());
			}
			forEach(visitor, self) {
				for (const [name, value] of this.entries()) visitor.call(self, value, name, this);
			}
			*entries() {
				for (const key of [...this.__map.keys()].sort()) yield [key, this.get(key)];
			}
			*keys() {
				for (const [key] of this.entries()) yield key;
			}
			*values() {
				for (const [, value] of this.entries()) yield value;
			}
			[Symbol.iterator]() {
				return this.entries();
			}
		}
		globalThis.Headers = Headers;
	}
	const bodyBytes = async (body) => {
		if (body === undefined || body === null) return undefined;
		if (typeof body === 'string') return Buffer.from(body, 'utf8');
		if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
		if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return toBytes(body);
		if (typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
		if (typeof body.getReader === 'function' || typeof body[Symbol.asyncIterator] === 'function') {
			const parts = [];
			for await (const chunk of body) parts.push(toBytes(chunk));
			return Buffer.concat(parts);
		}
		return Buffer.from(String(body), 'utf8');
	};
	const bodyContentType = (body) => {
		if (typeof body === 'string') return 'text/plain;charset=UTF-8';
		if (body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
		return null;
	};
	class Body {
		__initBody(body) {
			this.__body = body;
			this.bodyUsed = false;
		}
		get body() {
			if (this.__body === null || this.__body === undefined) return null;
			if (this.__body instanceof ReadableStream) return this.__body;
			const bytes = this.__body;
			this.__body = new ReadableStream({
				start: async (controller) => {
					controller.enqueue(await bodyBytes(bytes));
					controller.close();
				}
			});
			return this.__body;
		}
		async arrayBuffer() {
			const bytes = await this.__consume();
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		}
		async bytes() {
			return new Uint8Array(await this.__consume());
		}
		async text() {
			return Buffer.from(await this.__consume()).toString('utf8');
		}
		async json() {
			return JSON.parse(await this.text());
		}
		async blob() {
			const bytes = await this.__consume();
			if (typeof Blob === 'function') return new Blob([bytes], { type: this.headers.get('content-type') ?? '' });
			return { size: bytes.length, type: this.headers.get('content-type') ?? '', arrayBuffer: async () => bytes.buffer, text: async () => Buffer.from(bytes).toString('utf8') };
		}
		async formData() {
			throw new TypeError('Response.formData is not available in the ggs-node runtime');
		}
		async __consume() {
			if (this.bodyUsed) throw new TypeError('Body is unusable: Body has already been read');
			this.bodyUsed = true;
			const body = this.__body;
			if (body === null || body === undefined) return new Uint8Array(0);
			if (!(body instanceof ReadableStream)) return (await bodyBytes(body)) ?? new Uint8Array(0);
			const parts = [];
			const reader = body.getReader();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				parts.push(toBytes(value));
			}
			return Buffer.concat(parts);
		}
	}
	if (typeof globalThis.Request === 'undefined') {
		class Request extends Body {
			constructor(input, init = {}) {
				super();
				const base = input instanceof Request ? input : null;
				this.url = base ? base.url : String(input);
				this.method = String(init.method ?? base?.method ?? 'GET').toUpperCase();
				this.headers = new Headers(init.headers ?? base?.headers);
				this.signal = init.signal ?? base?.signal ?? null;
				this.redirect = init.redirect ?? base?.redirect ?? 'follow';
				this.credentials = init.credentials ?? 'same-origin';
				this.mode = init.mode ?? 'cors';
				this.cache = init.cache ?? 'default';
				this.keepalive = Boolean(init.keepalive);
				this.__initBody(init.body ?? base?.__body ?? null);
				const type = bodyContentType(init.body);
				if (type && !this.headers.has('content-type')) this.headers.set('content-type', type);
			}
			clone() {
				return new Request(this);
			}
		}
		globalThis.Request = Request;
	}
	if (typeof globalThis.Response === 'undefined') {
		class Response extends Body {
			constructor(body = null, init = {}) {
				super();
				this.status = init.status ?? 200;
				this.statusText = init.statusText ?? '';
				this.headers = new Headers(init.headers);
				this.url = init.url ?? '';
				this.redirected = false;
				this.type = 'default';
				this.__initBody(body);
				const type = bodyContentType(body);
				if (type && !this.headers.has('content-type')) this.headers.set('content-type', type);
			}
			get ok() {
				return this.status >= 200 && this.status < 300;
			}
			clone() {
				if (this.bodyUsed) throw new TypeError('Response.clone: Body has already been consumed');
				const body = this.body;
				let copy = null;
				if (body) {
					const [a, b] = body.tee();
					this.__body = a;
					copy = b;
				}
				return new Response(copy, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
			}
			static json(value, init = {}) {
				const headers = new Headers(init.headers);
				if (!headers.has('content-type')) headers.set('content-type', 'application/json');
				return new Response(JSON.stringify(value), { ...init, headers });
			}
			static error() {
				const response = new Response(null, { status: 0 });
				response.type = 'error';
				return response;
			}
			static redirect(url, status = 302) {
				return new Response(null, { status, headers: { location: String(url) } });
			}
		}
		globalThis.Response = Response;
	}
	if (typeof globalThis.fetch === 'undefined') {
		globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
			let request;
			try {
				request = input instanceof Request && Object.keys(init).length === 0 ? input : new Request(input instanceof Request ? input : String(input instanceof URL ? input.href : input), init);
			} catch (error) {
				reject(new TypeError(String(error?.message ?? error)));
				return;
			}
			const signal = request.signal;
			const abortError = () => (signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError'));
			if (signal?.aborted) {
				reject(abortError());
				return;
			}
			bodyBytes(request.__body).then((body) => {
				const headers = [];
				request.headers.forEach((value, name) => headers.push([name, value]));
				if (!request.headers.has('user-agent')) headers.push(['user-agent', 'node']);
				if (!request.headers.has('accept')) headers.push(['accept', '*/*']);
				let controller = null;
				let settled = false;
				const id = __ggsHttpRequest({ method: request.method, url: request.url, headers, redirect: request.redirect }, body);
				const onAbort = () => {
					__ggsHttpAbort(id);
					nativeRoutes.delete(id);
					const error = abortError();
					if (!settled) {
						settled = true;
						reject(error);
					} else controller?.error(error);
				};
				signal?.addEventListener?.('abort', onAbort, { once: true });
				nativeRoutes.set(id, (event, data, bytes) => {
					if (event === 'response') {
						const stream = new ReadableStream({
							start: (c) => {
								controller = c;
							},
							cancel: () => {
								__ggsHttpAbort(id);
								nativeRoutes.delete(id);
							}
						});
						const response = new Response(request.method === 'HEAD' || [101, 204, 205, 304].includes(data.status) ? null : stream, { status: data.status, statusText: data.statusText, headers: data.headers, url: data.url });
						settled = true;
						resolve(response);
					} else if (event === 'data') {
						controller?.enqueue(new Uint8Array(bytes));
					} else if (event === 'end') {
						nativeRoutes.delete(id);
						signal?.removeEventListener?.('abort', onAbort);
						controller?.close();
					} else if (event === 'error') {
						nativeRoutes.delete(id);
						signal?.removeEventListener?.('abort', onAbort);
						const error = new TypeError('fetch failed', { cause: netError(data) });
						if (!settled) {
							settled = true;
							reject(error);
						} else controller?.error(error);
					}
				});
			}, reject);
		});
	}

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
