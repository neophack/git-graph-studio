// Uri: a real class (extensions `instanceof vscode.Uri` on every boundary), VS
// Code's semantics for authority, fsPath spelling and encoded toString, plus the
// rehydration of Uris that crossed a bridge as plain data.

/** Whether `Uri.fsPath` answers Windows spelling (drive letter, backslashes) — VS Code
 *  derives it from the platform its extension host runs on. Each host sets it from the
 *  context it boots with (`HostContext.platform`); the default reads the browser/Node
 *  platform. */
let uriWin32 = (() => {
	try {
		if (typeof process !== 'undefined' && typeof process.platform === 'string') return process.platform === 'win32';
	} catch {
		// no process global
	}
	return typeof navigator !== 'undefined' && /^win/i.test(navigator.platform ?? '');
})();

/** Pin the platform `Uri.fsPath` spells paths for (the hosts call it once at boot). */
export function setUriPlatform(platform: string | undefined): void {
	if (platform) uriWin32 = platform === 'win32';
}

const URI_PATTERN = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

function decodeComponent(text: string): string {
	if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
	try {
		return decodeURIComponent(text);
	} catch {
		return text.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
			try {
				return decodeURIComponent(run);
			} catch {
				return run;
			}
		});
	}
}

/** VS Code's component encoding: unreserved characters stay, `/` stays in a path, every
 *  other character is percent-encoded (UTF-8). `minimal` (toString(true)) only escapes
 *  the delimiters that would change how the string parses back. */
function encodeComponent(text: string, isPath: boolean, minimal: boolean): string {
	if (minimal) return text.replace(/[#?]/g, (char) => (char === '#' ? '%23' : '%3F'));
	let out = '';
	for (const char of text) {
		if (/[A-Za-z0-9\-._~]/.test(char) || (isPath && char === '/')) out += char;
		else out += encodeURIComponent(char).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	}
	return out;
}

/** `Uri`: a real class, because extensions `instanceof vscode.Uri` on every boundary
 *  (ms-python's configuration watcher alone does it a dozen times) — a factory object
 *  answering `is not callable` there kills the whole configuration pipeline. Every field
 *  (fsPath included) is an own data field and the methods live on the prototype, so a
 *  structured clone copies exactly the data: an RPC carrying a Uri crosses as plain data
 *  and `rehydrateUris` rebuilds the methods. The semantics are VS Code's: `authority`,
 *  `Uri.file` normalizing a Windows path to `/C:/…`, `fsPath` in the platform's spelling
 *  and an encoded `toString()` — the form language servers expect. */
export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;
	readonly fsPath: string;
	constructor(scheme: string, authority = '', path = '', query = '', fragment = '') {
		this.scheme = scheme || 'file';
		this.authority = authority;
		// A hierarchical scheme's path is absolute once it has an authority (RFC 3986 §3.3).
		this.path = this.authority !== '' && path !== '' && !path.startsWith('/') ? `/${path}` : path;
		this.query = query;
		this.fragment = fragment;
		this.fsPath = uriToFsPath(this);
	}
	toString(skipEncoding = false): string {
		const minimal = skipEncoding === true;
		let out = `${this.scheme}:`;
		if (this.authority !== '' || this.scheme === 'file') out += `//${encodeAuthority(this.authority, minimal)}`;
		let path = this.path;
		// VS Code lowercases a file path's drive letter and encodes its colon.
		const drive = /^\/([A-Za-z]):/.exec(path);
		if (drive) path = `/${drive[1]!.toLowerCase()}:${path.slice(3)}`;
		out += encodeComponent(path, true, minimal);
		if (this.query !== '') out += `?${encodeComponent(this.query, false, minimal)}`;
		if (this.fragment !== '') out += `#${encodeComponent(this.fragment, false, minimal)}`;
		return out;
	}
	toJSON(): Record<string, string> {
		return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath, external: this.toString() };
	}
	with(change: { scheme?: string; authority?: string | null; path?: string | null; query?: string | null; fragment?: string | null }): Uri {
		return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
	}
	static file(path: string): Uri {
		let normalized = String(path ?? '');
		if (uriWin32 || /^[A-Za-z]:\\/.test(normalized) || normalized.startsWith('\\\\')) normalized = normalized.replace(/\\/g, '/');
		let authority = '';
		if (normalized.startsWith('//')) {
			const slash = normalized.indexOf('/', 2);
			authority = slash === -1 ? normalized.slice(2) : normalized.slice(2, slash);
			normalized = slash === -1 ? '/' : normalized.slice(slash);
		}
		if (/^[A-Za-z]:/.test(normalized)) normalized = `/${normalized}`;
		else if (!normalized.startsWith('/')) normalized = `/${normalized}`;
		return new Uri('file', authority, normalized);
	}
	static parse(value: string, _strict = false): Uri {
		const match = URI_PATTERN.exec(String(value ?? ''));
		if (!match) return new Uri('file', '', '');
		return new Uri(match[2] || 'file', decodeComponent(match[4] ?? ''), decodeComponent(match[5] ?? ''), decodeComponent(match[7] ?? ''), decodeComponent(match[9] ?? ''));
	}
	static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
		return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query ?? '', components.fragment ?? '');
	}
	static joinPath(base: Uri, ...segments: string[]): Uri {
		const parts = base.path.split('/');
		for (const segment of segments.join('/').split('/')) {
			if (segment === '' || segment === '.') continue;
			if (segment === '..') {
				if (parts.length > 1) parts.pop();
			} else {
				parts.push(segment);
			}
		}
		let joined = parts.join('/');
		if (!joined.startsWith('/') && base.path.startsWith('/')) joined = `/${joined}`;
		return base.with({ path: joined.replace(/\/{2,}/g, '/') });
	}
	static isUri(value: unknown): value is Uri {
		return value instanceof Uri || (value !== null && typeof value === 'object' && typeof (value as Uri).scheme === 'string' && typeof (value as Uri).path === 'string' && typeof (value as Uri).with === 'function');
	}
}

/** VS Code's authority formatting: the userinfo's parts and the host encode, the `@` and
 *  the port's `:` stay raw — `http://127.0.0.1:54500/` must not become `127.0.0.1%3A54500`,
 *  a host no browser resolves (every `asWebviewUri` script of a remote page died on it). */
function encodeAuthority(authority: string, minimal: boolean): string {
	let out = '';
	let host = authority;
	const at = host.lastIndexOf('@');
	if (at !== -1) {
		const user = host.slice(0, at);
		const colon = user.indexOf(':');
		out += colon === -1 ? encodeComponent(user, false, minimal) : `${encodeComponent(user.slice(0, colon), false, minimal)}:${encodeComponent(user.slice(colon + 1), false, minimal)}`;
		out += '@';
		host = host.slice(at + 1);
	}
	host = host.toLowerCase();
	const port = host.lastIndexOf(':');
	return port === -1 ? out + encodeComponent(host, false, minimal) : out + encodeComponent(host.slice(0, port), false, minimal) + host.slice(port);
}

/** VS Code's `uriToFsPath`: a UNC authority, a drive letter, the platform's separators. */
function uriToFsPath(uri: { scheme: string; authority: string; path: string }): string {
	let value: string;
	if (uri.authority !== '' && uri.path.length > 1 && uri.scheme === 'file') value = `//${uri.authority}${uri.path}`;
	else if (/^\/[A-Za-z]:/.test(uri.path)) value = uri.path.slice(1);
	else value = uri.path;
	return uriWin32 ? value.replace(/\//g, '\\') : value;
}

/** A path, Uri or Uri-shaped value as the host's path spelling (the fsPath). */
export function pathOf(value: Uri | string | { fsPath?: string; path?: string } | undefined | null): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	return value.fsPath ?? value.path ?? '';
}

/** Reconstitute the Uris an inbound host call's arguments carry. A command argument
 *  crosses postMessage (or the ggs-ext/1 line) as plain data — the Uri methods live on the
 *  prototype precisely so the data survives the structured clone — so the menu context
 *  the workbench dispatches (VS Code hands a menu's command the clicked `Uri`) arrives as
 *  `{ scheme, path, fsPath }` without its methods. Anything shaped like that data half, at
 *  any depth of the argument list, becomes a full Uri again: a file Uri from its fsPath
 *  (the host's own spelling), any other scheme from its components. */
export function rehydrateUris(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(rehydrateUris);
	if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
	const data = value as Record<string, unknown>;
	if (typeof data.scheme === 'string' && typeof data.fsPath === 'string') {
		// An own toString means the methods are already there — a full Uri (or something
		// carrying its own) passes through untouched, never copied method-less.
		if (Object.prototype.hasOwnProperty.call(data, 'toString')) return value;
		const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
		if (data.scheme === 'file' && data.fsPath !== '') {
			const uri = Uri.file(data.fsPath);
			return text('query') !== '' || text('fragment') !== '' ? uri.with({ query: text('query'), fragment: text('fragment') }) : uri;
		}
		return new Uri(data.scheme, text('authority'), text('path') || (data.fsPath as string), text('query'), text('fragment'));
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = rehydrateUris(item);
	return out;
}

/** Whether `Uri.fsPath` answers Windows spelling right now (`env.shell` reads it). */
export function uriWin32Active(): boolean {
	return uriWin32;
}
