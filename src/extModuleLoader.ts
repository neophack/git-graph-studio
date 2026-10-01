// The frame-side CommonJS module loader (module 12's Node compatibility layer). An Open VSX
// extension's compiled entry is not always one self-contained bundle: plenty of packages
// ship plain compiled files, `require('./util')` their siblings and `require('dep')` into a
// packed `node_modules` — VS Code's extension host runs them all, because it is a Node
// process with Node's own resolver. This loader is that resolver over the code map the host
// preloaded at activation (`ext_load_code`): a synchronous, in-memory walk of exactly the
// paths Node's `require` would take, with Node's module semantics (cache, partial exports
// on circular requires, `__dirname`/`__filename`, `.json` parsing, package.json `main`).
//
// `require('vscode')` still answers the API shim; the Node builtins answer the shims of
// nodeShims.ts; a `.node` binary cannot run in a frame (NAPI needs a real Node runtime —
// a package carrying one is hosted by the real-Node extension host instead)
// cross — the package's backend loads the file, and every call on the proxy is one
// request over the frame bridge). Nothing here reads a file lazily — a `postMessage`
// read cannot answer a synchronous `require`, so the whole loadable surface crossed
// once, before boot.

/** The Node environment facts the activation context carried in (see `ext_node_env`). */
export interface NodeEnv {
	platform: string;
	arch: string;
	homedir: string;
	tmpdir: string;
	hostname: string;
	release: string;
	eol: string;
	separator: string;
	delimiter: string;
	/** The host's real environment (`process.env`) — tool discovery reads it. */
	env?: Record<string, string>;
}

/** The Node environment facts when no host carried them in — a bridge older than
 *  `ext_node_env`, or the backend call failing. The platform word is read from whatever
 *  environment is observable (a real `process.platform` when one is in scope, else the
 *  browser's `navigator.platform` — the same read `Uri`'s win32 default takes), and the
 *  fields that word decides follow it. The word was once hardcoded `win32`, which made
 *  every non-Windows host's shims spell Windows paths — CI's Linux runner met it as
 *  `path.join` answering `a\b\c`. */
export function defaultNodeEnv(): NodeEnv {
	const platform = (() => {
		try {
			if (typeof process !== 'undefined' && typeof process.platform === 'string') return process.platform;
		} catch {
			// no process global — the navigator read below stands
		}
		const word = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : '';
		return word.includes('win') ? 'win32' : word.includes('mac') ? 'darwin' : 'linux';
	})();
	const windows = platform === 'win32';
	return {
		platform, arch: 'x64', homedir: '', tmpdir: '', hostname: 'studio', release: '',
		eol: windows ? '\r\n' : '\n', separator: windows ? '\\' : '/', delimiter: windows ? ';' : ':'
	};
}

/** What the loader needs from its host: the preloaded code, the environment, and the two
 *  module worlds outside the package (the `vscode` shim and the Node builtin shims). */
export interface LoaderHost {
	/** Package-relative paths with `/` separators -> file text (`ext_load_code`'s map). */
	files: Record<string, string>;
	/** The preload hit its bounds; requires beyond the map fail naming the reason. */
	truncated: boolean;
	/** The install's absolute path — the root every package-relative key resolves under. */
	extensionPath: string;
	/** `require('vscode')` — the API shim, supplied by the boot half. */
	vscode: unknown;
	/** A Node builtin shim by bare name (`'path'`, `'node:fs'` already stripped), or
	 *  `undefined` when the name is not a builtin. */
	builtin: (id: string) => unknown | undefined;
}

/** Node's `require` surface: a callable plus the loader facts extension code reads. */
export interface NodeRequire {
	(request: string): unknown;
	cache: Record<string, { exports: unknown }>;
	resolve(request: string): string;
	main: NodeModule | null;
}

interface NodeModule {
	exports: unknown;
	id: string;
	filename: string;
	loaded: boolean;
	children: unknown[];
	paths: string[];
}

/** Normalize one path segment sequence ('/'-separated): collapse `.` and `..`, keep the
 *  leading `/`, refuse to climb above the package root (`..` at the top is dropped — the
 *  map has nothing above it to hit anyway). */
function normalizePath(path: string): string {
	const absolute = path.startsWith('/');
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
			continue;
		}
		parts.push(part);
	}
	return (absolute ? '/' : '') + parts.join('/');
}

/** The directory of a `/`-separated package-relative path ('a/b/c.js' -> 'a/b'). */
function dirnameOf(path: string): string {
	const at = path.lastIndexOf('/');
	return at === -1 ? '' : path.slice(0, at);
}

class ModuleLoader {
	private readonly cache = new Map<string, NodeModule>();
	/** Lowercase key index — the install sits on a case-insensitive filesystem on Windows,
	 *  and a `require` spelled with different case must still hit. */
	private readonly byLower = new Map<string, string>();
	readonly require: NodeRequire;
	/** The entry module once it ran (null until then) — `require.main`. */
	main: NodeModule | null = null;

	constructor(private readonly host: LoaderHost) {
		for (const key of Object.keys(host.files)) this.byLower.set(key.toLowerCase(), key);
		const self = this;
		const require = ((request: string): unknown => {
			if (request === 'vscode') return host.vscode;
			const bare = request.startsWith('node:') ? request.slice('node:'.length) : request;
			if (!request.startsWith('.') && !request.startsWith('/')) {
				const builtin = host.builtin(bare);
				if (builtin !== undefined) return builtin;
			}
			const resolved = self.resolve(bare, '');
			if (resolved === undefined) throw self.notFound(request);
			return self.loadModule(resolved).exports;
		}) as NodeRequire;
		require.cache = new Proxy({}, {
			get: (_target, key: string) => this.cache.get(key)?.exports
		}) as Record<string, { exports: unknown }>;
		require.resolve = (request: string): string => {
			if (request === 'vscode') return 'vscode';
			const resolved = this.resolve(request.startsWith('node:') ? request.slice(5) : request, '');
			if (resolved === undefined) throw this.notFound(request);
			return resolved;
		};
		require.main = null;
		this.require = require;
	}

	private notFound(request: string): Error {
		const reason = this.host.truncated
			? ' (the package\'s code map was capped at activation — a very large dependency tree did not all cross)'
			: '';
		const error = new Error(`Cannot find module '${request}'${reason}`);
		(error as { code?: string }).code = 'MODULE_NOT_FOUND';
		return error;
	}

	/** A map hit by exact key, then case-insensitively. */
	private file(rel: string): string | undefined {
		const exact = this.host.files[rel];
		if (exact !== undefined) return exact;
		const folded = this.byLower.get(rel.toLowerCase());
		return folded === undefined ? undefined : this.host.files[folded];
	}

	/** Does any file sit under `dir/`? (A directory the map only implies — the preload
	 *  carries files, so a directory exists exactly when a file lives beneath it.) */
	private isDir(rel: string): boolean {
		const prefix = rel === '' ? '' : rel + '/';
		for (const key of Object.keys(this.host.files)) {
			if (key.startsWith(prefix) && key.length > prefix.length) return true;
		}
		return false;
	}

	/** A require spelled as an absolute path (a drive root, a UNC root, a leading `/`):
	 *  package-relative when it points inside the install, `null` when it does not (and
	 *  `null` for every relative spelling — this is not its branch). */
	private toRelative(request: string): string | null {
		const normalized = request.replace(/\\/g, '/');
		if (!normalized.startsWith('/') && !/^[a-zA-Z]:\//.test(normalized)) return null;
		const root = this.host.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
		const lower = normalized.toLowerCase();
		if (lower === root) return '';
		if (lower.startsWith(root + '/')) return normalized.slice(root.length + 1);
		return null;
	}

	/** Node's `require.resolve` core: a relative or bare request, resolved from `fromDir`. */
	resolve(request: string, fromDir: string): string | undefined {
		const asAbsolute = this.toRelative(request);
		const base = asAbsolute !== null
			? asAbsolute
			: request.startsWith('.') || request.startsWith('/')
				// A root-level module's directory is '' — prefixing '/' there would make
				// normalizePath keep a leading slash ('/sessions.js') that no map key
				// carries, and every `require('./sibling.js')` from the entry would miss.
				? normalizePath(request.startsWith('/') ? request : (fromDir ? fromDir + '/' : '') + request)
				: this.resolveBare(request, fromDir);
		return base === undefined ? undefined : this.resolveAsFileOrDirectory(base);
	}

	/** The `node_modules` walk: every directory from `fromDir` up to the package root may
	 *  carry a `node_modules/<name>` — exactly Node's lookup, bounded by the package. */
	private resolveBare(request: string, fromDir: string): string | undefined {
		const segments = request.split('/');
		// `@scope/pkg` keeps its first two segments; every other name its first one — the
		// rest is a path inside the package (`dep/lib/x`).
		const packageName = segments[0]!.startsWith('@') && segments.length > 1
			? `${segments[0]}/${segments[1]!}`
			: segments[0]!;
		const inner = segments.slice(packageName.split('/').length).join('/');
		let dir = fromDir;
		for (;;) {
			const candidate = `${dir === '' ? '' : dir + '/'}node_modules/${packageName}`;
			if (this.isDir(candidate) || this.file(candidate) !== undefined) {
				return inner === '' ? candidate : normalizePath(`${candidate}/${inner}`);
			}
			if (dir === '') return undefined;
			dir = dirnameOf(dir);
		}
	}

	/** Node's file-or-directory resolution: the exact key, then `.js` / `.cjs` / `.json`
	 *  extensions for an extensionless request; a directory resolves through its
	 *  package.json `main`, else its `index.js` / `index.json`. */
	private resolveAsFileOrDirectory(base: string): string | undefined {
		if (this.file(base) !== undefined) return base;
		for (const suffix of ['.js', '.cjs', '.json']) {
			if (this.file(base + suffix) !== undefined) return base + suffix;
		}
		if (this.isDir(base)) {
			const manifest = this.file(`${base}/package.json`);
			if (manifest !== undefined) {
				try {
					const main = (JSON.parse(manifest) as { main?: string }).main;
					// Node honours `browser` field mappings only in bundlers; extension hosts
					// use `main` — and `.`/`./` means the directory index.
					if (typeof main === 'string' && main !== '.' && main !== './') {
						const resolved = this.resolveAsFileOrDirectory(normalizePath(`${base}/${main}`));
						if (resolved !== undefined) return resolved;
					}
				} catch {
					// An unparseable package.json falls through to the index files.
				}
			}
			for (const index of ['index.js', 'index.cjs', 'index.json']) {
				if (this.file(`${base}/${index}`) !== undefined) return `${base}/${index}`;
			}
		}
		return undefined;
	}

	/** Load and run one resolved module: `.json` parses, code runs inside the CommonJS
	 *  wrapper, the cache holds the module from before its own body runs (a circular
	 *  `require` sees the other side's partial exports, like Node). */
	private loadModule(resolved: string): NodeModule {
		const cached = this.cache.get(resolved);
		if (cached !== undefined) return cached;
		const text = this.file(resolved);
		if (text === undefined) throw this.notFound(resolved);
		if (resolved.endsWith('.json')) {
			const module: NodeModule = { exports: JSON.parse(text), id: resolved, filename: resolved, loaded: true, children: [], paths: this.modulePaths(dirnameOf(resolved)) };
			this.cache.set(resolved, module);
			return module;
		}
		const module: NodeModule = { exports: {}, id: resolved, filename: resolved, loaded: false, children: [], paths: this.modulePaths(dirnameOf(resolved)) };
		this.cache.set(resolved, module);
		// A `require` bound to this module's directory — relative requests inside it
		// resolve from here, bare ones walk its `node_modules` chain upward.
		const localRequire = ((request: string): unknown => {
			if (request === 'vscode') return this.host.vscode;
			const bare = request.startsWith('node:') ? request.slice('node:'.length) : request;
			if (!request.startsWith('.') && !request.startsWith('/')) {
				const builtin = this.host.builtin(bare);
				if (builtin !== undefined) return builtin;
			}
			const from = dirnameOf(resolved);
			const target = this.resolve(bare, from);
			if (target === undefined) throw this.notFound(request);
			return this.loadModule(target).exports;
		}) as NodeRequire;
		localRequire.cache = this.require.cache;
		localRequire.resolve = (request: string): string => {
			const target = this.resolve(request.startsWith('node:') ? request.slice(5) : request, dirnameOf(resolved));
			if (target === undefined) throw this.notFound(request);
			return target;
		};
		localRequire.main = this.main;
		const dirname = dirnameOf(resolved);
		try {
			// The CommonJS wrapper Node itself runs module code through; the absolute
			// `__filename`/`__dirname` spell the install path with OS separators.
			const absolute = this.host.extensionPath.replace(/[\\/]+$/, '') + (dirname === '' ? '' : '/' + dirname);
			// The sourceURL names the module in every stack its code throws — the extension
			// host log then points at `<package>/out/extension.js:line:col` (asynchronous
			// failures too, which the catch below never sees), not an anonymous eval.
			const sourceUrl = `ggs-ext://${this.host.extensionPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'extension'}/${resolved || 'entry.js'}`;
			new Function('require', 'module', 'exports', '__filename', '__dirname', `${text}\n//# sourceURL=${sourceUrl}`)(
				localRequire, module, module.exports,
				this.host.extensionPath.replace(/[\\/]+$/, '') + '/' + resolved,
				absolute
			);
		} catch (error) {
			this.cache.delete(resolved);
			// Name the module: a bundle's eval stack points at `<anonymous>` offsets no file
			// on disk answers, and the one fact that locates a failure is which `require`
			// was being evaluated when it threw.
			if (error instanceof Error && !error.message.startsWith('[')) error.message = `[${resolved || 'entry'}] ${error.message}`;
			throw error;
		}
		module.loaded = true;
		return module;
	}

	/** The `node_modules` directory chain of a module directory (`module.paths`). */
	private modulePaths(dir: string): string[] {
		const paths: string[] = [];
		for (;;) {
			paths.push(`${this.host.extensionPath.replace(/[\\/]+$/, '')}/${dir}/node_modules`);
			if (dir === '') return paths;
			dir = dirnameOf(dir);
		}
	}

	/** Resolve and run the manifest's `main` (the Node `require()` spelling without an
	 *  extension included — `./out/extension` resolves as `out/extension.js`). */
	runEntry(main: string): NodeModule | null {
		const entry = this.resolveAsFileOrDirectory(normalizePath(main.replace(/^\.\//, '')));
		if (entry === undefined) throw this.notFound(main);
		const module = this.loadModule(entry);
		this.main = module;
		this.require.main = module;
		return module;
	}
}

/** Build the loader's `require` for one extension activation. `require.main` is filled by
 *  `runEntry`; `require('vscode')` answers the shim before anything else is consulted. */
export function createNodeRequire(host: LoaderHost): { require: NodeRequire; runEntry: (main: string) => NodeModule | null } {
	const loader = new ModuleLoader(host);
	return { require: loader.require, runEntry: (main) => loader.runEntry(main) };
}

