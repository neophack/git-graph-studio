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
	class EventEmitter {
		constructor() {
			this._events = new Map();
		}
		on(event, fn) {
			this._add(event, fn, false);
			return this;
		}
		once(event, fn) {
			this._add(event, fn, true);
			return this;
		}
		prependListener(event, fn) {
			return this.on(event, fn);
		}
		prependOnceListener(event, fn) {
			return this.once(event, fn);
		}
		off(event, fn) {
			return this.removeListener(event, fn);
		}
		removeListener(event, fn) {
			const list = this._events.get(event);
			if (!list) return this;
			this._events.set(event, list.filter(([wrapped]) => wrapped !== fn && wrapped._ggsOriginal !== fn));
			return this;
		}
		removeAllListeners(event) {
			if (event === undefined) this._events.clear();
			else this._events.delete(event);
			return this;
		}
		emit(event, ...args) {
			const list = this._events.get(event);
			if (!list || list.length === 0) {
				if (event === 'error') throw args[0];
				return false;
			}
			for (const [wrapped] of [...list]) wrapped(...args);
			return true;
		}
		listenerCount(event) {
			return this._events.get(event)?.length ?? 0;
		}
		listeners(event) {
			return (this._events.get(event) ?? []).map(([, original]) => original);
		}
		eventNames() {
			return [...this._events.keys()];
		}
		_add(event, fn, once) {
			if (typeof fn !== 'function') throw new TypeError('listener must be a function');
			const wrapped = once
				? (...args) => {
					this.removeListener(event, wrapped);
					fn(...args);
				}
				: fn;
			wrapped._ggsOriginal = fn;
			const list = this._events.get(event) ?? [];
			list.push([wrapped, fn]);
			this._events.set(event, list);
		}
	}
	globalThis.EventEmitter = EventEmitter;
	EventEmitter.prototype.setMaxListeners = () => {};
	EventEmitter.defaultMaxListeners = 10;

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
		// The random surfaces an offline runtime cannot honestly serve.
		randomBytes(size) {
			throw new Error('crypto.randomBytes is not available in the ggs-node runtime');
		},
		getRandomValues() {
			throw new Error('crypto.getRandomValues is not available in the ggs-node runtime');
		}
	};
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
			const authority = this.host;
			const at = authority.lastIndexOf('@');
			const hostPart = at === -1 ? authority : authority.slice(at + 1);
			const colon = hostPart.lastIndexOf(':');
			this.hostname = colon === -1 ? hostPart : hostPart.slice(0, colon);
			this.port = colon === -1 ? '' : hostPart.slice(colon + 1);
			this.username = at === -1 ? '' : authority.slice(0, at).split(':')[0] ?? '';
			this.password = at === -1 ? '' : (authority.slice(0, at).split(':')[1] ?? '');
			this.pathname = match[4] ?? '';
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
			return this.protocol + (this.host ? '//' + this.host : '') + this.pathname + this.search + this.hash;
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

globalThis.global = globalThis;

/* The module compiler the Rust loader calls: the CommonJS wrapper as a direct eval in
 * THIS function's frame. Direct eval compiles the wrapper against this scope and the
 * wrapper captures that same chain, so every binding locator stays consistent no
 * matter where the load happens. The two alternatives are both Boa 0.20 bugs (see
 * require.rs): the `Function` constructor compiles nested functions with locators
 * that panic when the module's own closures run later, and a Rust-side `eval` during
 * a running frame hands the wrapper the caller's environment chain. */
globalThis.__ggsCompileModule = function (text) {
	return eval('(function (exports, require, module, __filename, __dirname) {\n' + text + '\n})');
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
