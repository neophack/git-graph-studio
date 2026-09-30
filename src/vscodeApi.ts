// The `vscode` module Studio's extension host serves to installed extensions. It implements
// the commonly used subset of the VS Code extension API; a surface this host cannot serve
// degrades instead of throwing - VS Code's own compatibility posture (unknown
// contributions are ignored, an unsupported capability registration is inert), because a
// throw at activation time kills every other feature of the extension with it. Each
// degraded surface notes itself on the console, so a silent no-op is never mysterious.
//
// The shim runs inside the extension host frame, so extension callbacks (command handlers,
// event listeners) stay in the frame; everything that touches the workbench - the command
// registry, notifications, settings persistence, webview panels, status bar items, output
// channels - crosses the `HostBridge` to the main window. Events the host pushes back
// (configuration changes, webview messages, disposals) arrive through `handleHostEvent`.

import type { SerializableDiagnostic } from './editorDiagnostics';

export interface HostBridge {
	/** Call a host service; resolves with its result, rejects with the host's error. */
	request(method: string, args: unknown[]): Promise<unknown>;
	/** Park a command handler in the frame (functions cannot cross the message boundary). */
	registerCommandHandler(id: string, handler: (...args: unknown[]) => unknown): void;
	/** Park a text-document content provider in the frame — the host's `vscode.open` /
	 *  `vscode.diff` call back into it (`docProvider.provide`) for a scheme's text. */
	registerDocProvider?(scheme: string, provider: { provideTextDocumentContent?: (uri: unknown) => unknown }): void;
	/** Forget a parked content provider (its Disposable ran). */
	unregisterDocProvider?(scheme: string): void;
	/** This side's own answer for a provider-scheme document it registered — the text, or
	 *  `null` when the scheme is not registered here (another extension may own it; the
	 *  host's global lookup is that case's fallback). Serving the read locally keeps
	 *  `openTextDocument` off the host round-trip, whose answer would call back into a
	 *  ggs-node process whose one JS thread is blocked waiting for exactly that answer —
	 *  the `vscode.diff` reentry deadlock class, 30 s to nothing. */
	readDocProvider?(uri: Uri): string | PromiseLike<string> | null;
}

/** The bridge-side half of a local provider read: this side's own registration answers
 *  from its parked map — `null` when the scheme is not registered here, so the host's
 *  global lookup stays the fallback (another extension may own the scheme). Every host
 *  bridge (`docProvider.provide`'s own lookup) serves the same shape. */
export function readLocalDocProvider(docProviders: Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>, uri: Uri): string | PromiseLike<string> | null {
	const provider = docProviders.get(uri.scheme);
	if (!provider?.provideTextDocumentContent) return null;
	const text = provider.provideTextDocumentContent(uri);
	return text === undefined || text === null ? '' : (text as string | PromiseLike<string>);
}

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

export interface HostContext {
	extensionId: string;
	extensionPath: string;
	/** The folders the workbench has open (VS Code's workspaceFolders, at activation time). */
	workspaceFolders: { uri: Uri; name: string; index: number }[];
	/** The settings section the extension wrote through `workspace.getConfiguration().update()`. */
	settings: Record<string, unknown>;
	language: string;
	/** The app's own version (`env.appVersion`). Optional: an older bridge (the jsdom
	 *  fixtures) sends none, and `env.appVersion` falls back to '1.0.0'. */
	appVersion?: string;
	/** The active colour theme's `ThemeKind` (1 light, 2 dark). Optional for the same
	 *  reason; the shim defaults to dark. */
	themeKind?: number;
	/** The extension's own parsed `package.json`: `context.extension.packageJSON` and
	 *  `extensions.getExtension(id).packageJSON` report it. Optional — an older bridge
	 *  sends none and the shim answers an empty object. */
	packageJSON?: Record<string, unknown>;
	/** Where a webview panel loads package-local files from (the `ggs://` URL of the install
	 *  directory, trailing slash included) — `asWebviewUri` composes synchronously from it. */
	webviewResourceBase: string;
	/** The persisted memento values (`extHost` loads them from localStorage before the frame
	 *  boots; updates write through the `state.update` bridge). */
	state: { global: Record<string, unknown>; workspace: Record<string, unknown> };
	/** The configuration defaults visible to `getConfiguration` — the extension's own
	 *  `contributes.configuration` defaults and the workbench's core sections (`editor.*`,
	 *  `files.*`, …). `settings` (the stored overrides) wins over these. Optional: an
	 *  older bridge sends none. */
	defaults?: Record<string, unknown>;
	/** `process.platform` of the host the shim runs for (`Uri.fsPath` spelling). */
	platform?: string;
	/** The extension-host log threshold: the shim skips shipping lines below it. */
	logLevel?: ShimLogLevel;
	/** The extension's storage directories under `~/.ggs/` (`globalStorageUri`,
	 *  `storageUri`, `logUri`); absent from an older bridge (the install dir stands in). */
	storage?: { global: string; workspace?: string | null; log: string };
	/** The installed extensions as `extensions.all` / `getExtension` report them. */
	extensions?: { id: string; extensionPath: string; packageJSON: Record<string, unknown>; isActive: boolean }[];
}

/** An event the host pushed into the frame: a configuration change for this extension, a
 *  message from one of its webview panels, a panel going away, the active editor changing
 *  (with its document text when the document changed), a document being saved, a message
 *  from one of its webview views (sidebar), a view's visibility, or a theme change. */
export interface HostEvent {
	event: 'configChanged' | 'webviewMessage' | 'webviewDisposed' | 'activeEditorChanged' | 'documentSaved' | 'webviewViewMessage' | 'webviewViewVisible' | 'themeChanged' | 'fsChanged' | 'documentChanged' | 'documentClosed' | 'workspaceFoldersChanged' | 'webviewViewState';
	/** A document edit (documentChanged): the document's whole new text. */
	text?: string;
	/** The open folders after a change (workspaceFoldersChanged). */
	folders?: string[];
	/** A webview panel's view state (webviewViewState). */
	active?: boolean;
	settings?: Record<string, unknown>;
	panelId?: number;
	message?: unknown;
	/** The active editor as the host tracks it (null when no text editor is active). */
	editor?: { path: string; languageId: string; text?: string; line: number; column: number; selected?: number } | null;
	path?: string;
	languageId?: string;
	/** A webview view's push, by view id. */
	viewId?: string;
	visible?: boolean;
	/** A theme change's `ThemeKind` (1 light, 2 dark). */
	kind?: number;
	/** A watcher batch (fsChanged): the changed working-tree paths under `root`, and
	 *  whether something under `.git/` changed (the ref/index half the batch never lists). */
	fs?: { root: string; paths: string[]; gitChanged: boolean; truncated: boolean };
}

/** One edit as it crosses the bridge: 1-based line / 0-based character positions, the shape
 *  both the open-editor path (CodeMirror) and the closed-file path (text splicing) apply. */
export interface SerializableTextEdit {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	newText: string;
}

/** Apply an edit batch to a text, bottom-up so earlier positions stay valid — the frame's
 *  half of `workspace.applyEdit` for files that are not open in an editor. */
export function applyTextEditsToText(text: string, edits: SerializableTextEdit[]): string {
	const lines = text.split('\n');
	const offsetOf = (line: number, character: number): number => {
		const clamped = Math.max(1, Math.min(line, lines.length));
		let offset = 0;
		for (let at = 0; at < clamped - 1; at++) offset += lines[at]!.length + 1;
		return offset + Math.max(0, character);
	};
	const sorted = [...edits].sort((a, b) => (a.startLine - b.startLine) || (a.startCharacter - b.startCharacter));
	for (let index = sorted.length - 1; index >= 0; index--) {
		const edit = sorted[index]!;
		const from = Math.min(offsetOf(edit.startLine, edit.startCharacter), text.length);
		const to = Math.max(from, Math.min(offsetOf(edit.endLine, edit.endCharacter), text.length));
		text = text.slice(0, from) + edit.newText + text.slice(to);
	}
	return text;
}

/** Base64 helpers over the bridge's byte format (`atob` gives a binary string; the loops
 *  move it into a real byte array without per-byte string ops on large buffers). */
function decodeBase64(data: string): Uint8Array {
	const raw = atob(data);
	const bytes = new Uint8Array(raw.length);
	for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 8192;
	for (let at = 0; at < bytes.length; at += chunk) binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
	return btoa(binary);
}

/* ---------- The shim's log line out ---------- */

export type ShimLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const LOG_RANK: Record<ShimLogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

/** Where the shim reports an anomaly: an unsupported API reached for, a listener or
 *  provider that threw, a host request that failed. `createVscodeApi` points it at the
 *  bridge's `log` request (the host's extension-host log records it); until then — and
 *  if the bridge itself fails — the console keeps the line. */
let shimLogSink: (level: ShimLogLevel, message: string, detail?: string) => void = (level, message, detail) => {
	const line = `[ggs-ext] ${message}${detail ? `\n${detail}` : ''}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
};
let shimLogThreshold: ShimLogLevel = 'info';
const shimLoggedOnce = new Set<string>();

function detailText(detail: unknown): string | undefined {
	if (detail === undefined || detail === null) return undefined;
	if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
	if (typeof detail === 'string') return detail;
	try {
		return JSON.stringify(detail);
	} catch {
		return String(detail);
	}
}

/** Record one shim anomaly (never throws — logging must not add a failure). */
export function shimLog(level: ShimLogLevel, message: string, detail?: unknown): void {
	try {
		if (LOG_RANK[level] < LOG_RANK[shimLogThreshold]) return;
		shimLogSink(level, message, detailText(detail));
	} catch {
		// see the doc comment
	}
}

/** `shimLog` at most once per key (an unsupported API polled in a loop logs one line). */
export function shimLogOnce(key: string, level: ShimLogLevel, message: string, detail?: unknown): void {
	if (shimLoggedOnce.has(key)) return;
	shimLoggedOnce.add(key);
	shimLog(level, message, detail);
}

/** Run an extension callback; a throw is logged (with the stack) and swallowed, the way
 *  VS Code's event dispatch isolates one listener's failure from the others. */
function guarded<T>(what: string, run: () => T): T | undefined {
	try {
		const result = run();
		if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
			(result as unknown as Promise<unknown>).then(undefined, (error: unknown) => shimLog('error', `${what} rejected: ${String(error)}`, error));
		}
		return result;
	} catch (error) {
		shimLog('error', `${what} threw: ${String(error)}`, error);
		return undefined;
	}
}

/* ---------- The small value types VS Code's API is built from ---------- */

function isPositionLike(value: unknown): value is { line: number; character: number } {
	return value !== null && typeof value === 'object' && typeof (value as { line?: unknown }).line === 'number' && typeof (value as { character?: unknown }).character === 'number';
}

export class Position {
	readonly line: number;
	readonly character: number;
	constructor(line: number, character: number) {
		if (!(line >= 0) || !(character >= 0)) throw new Error(`Illegal argument: Position(${line}, ${character}) must be non-negative`);
		this.line = line;
		this.character = character;
	}
	static isPosition(value: unknown): value is Position {
		return value instanceof Position || isPositionLike(value);
	}
	/** A plain `{ line, character }` (a Position that crossed a bridge) as a real one. */
	static of(value: { line: number; character: number }): Position {
		return value instanceof Position ? value : new Position(value.line, value.character);
	}
	compareTo(other: { line: number; character: number }): number {
		return this.line !== other.line ? this.line - other.line : this.character - other.character;
	}
	isBefore(other: { line: number; character: number }): boolean {
		return this.compareTo(other) < 0;
	}
	isBeforeOrEqual(other: { line: number; character: number }): boolean {
		return this.compareTo(other) <= 0;
	}
	isAfter(other: { line: number; character: number }): boolean {
		return this.compareTo(other) > 0;
	}
	isAfterOrEqual(other: { line: number; character: number }): boolean {
		return this.compareTo(other) >= 0;
	}
	isEqual(other: { line: number; character: number }): boolean {
		return this.compareTo(other) === 0;
	}
	translate(lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0, characterDelta = 0): Position {
		if (typeof lineDelta === 'object') return new Position(this.line + (lineDelta.lineDelta ?? 0), this.character + (lineDelta.characterDelta ?? 0));
		return new Position(this.line + lineDelta, this.character + characterDelta);
	}
	with(line: number | { line?: number; character?: number } = this.line, character = this.character): Position {
		if (typeof line === 'object') return new Position(line.line ?? this.line, line.character ?? this.character);
		return new Position(line, character);
	}
}

export class Range {
	readonly start: Position;
	readonly end: Position;
	/** `new Range(start, end)` or `new Range(startLine, startCharacter, endLine, endCharacter)`
	 *  — both of VS Code's spellings; the ends are ordered (start never after end). */
	constructor(startLine: number | { line: number; character: number }, startCharacter: number | { line: number; character: number }, endLine?: number, endCharacter?: number) {
		let start: Position;
		let end: Position;
		if (typeof startLine === 'number' && typeof startCharacter === 'number' && typeof endLine === 'number' && typeof endCharacter === 'number') {
			start = new Position(startLine, startCharacter);
			end = new Position(endLine, endCharacter);
		} else if (isPositionLike(startLine) && isPositionLike(startCharacter)) {
			start = Position.of(startLine);
			end = Position.of(startCharacter);
		} else {
			throw new Error('Illegal argument: Range takes (Position, Position) or (line, character, line, character)');
		}
		if (start.isAfter(end)) [start, end] = [end, start];
		this.start = start;
		this.end = end;
	}
	static isRange(value: unknown): value is Range {
		return value instanceof Range || (value !== null && typeof value === 'object' && isPositionLike((value as Range).start) && isPositionLike((value as Range).end));
	}
	get isEmpty(): boolean {
		return this.start.isEqual(this.end);
	}
	get isSingleLine(): boolean {
		return this.start.line === this.end.line;
	}
	contains(positionOrRange: { line: number; character: number } | { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
		if (isPositionLike(positionOrRange)) return this.start.isBeforeOrEqual(positionOrRange) && this.end.isAfterOrEqual(positionOrRange);
		return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
	}
	isEqual(other: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
		return this.start.isEqual(other.start) && this.end.isEqual(other.end);
	}
	intersection(other: { start: { line: number; character: number }; end: { line: number; character: number } }): Range | undefined {
		const start = this.start.isAfter(other.start) ? this.start : Position.of(other.start);
		const end = this.end.isBefore(other.end) ? this.end : Position.of(other.end);
		return start.isAfter(end) ? undefined : new Range(start, end);
	}
	union(other: { start: { line: number; character: number }; end: { line: number; character: number } }): Range {
		const start = this.start.isBefore(other.start) ? this.start : Position.of(other.start);
		const end = this.end.isAfter(other.end) ? this.end : Position.of(other.end);
		return new Range(start, end);
	}
	with(start: { line: number; character: number } | { start?: { line: number; character: number }; end?: { line: number; character: number } } = this.start, end: { line: number; character: number } = this.end): Range {
		if (!isPositionLike(start)) return new Range((start as { start?: Position }).start ?? this.start, (start as { end?: Position }).end ?? this.end);
		return new Range(start, end);
	}
}

export class Location {
	readonly range: Range;
	constructor(readonly uri: Uri, rangeOrPosition: Range | Position) {
		this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
	}
}

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
		if (this.authority !== '' || this.scheme === 'file') out += `//${encodeComponent(this.authority.toLowerCase(), false, minimal)}`;
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

/** VS Code's `uriToFsPath`: a UNC authority, a drive letter, the platform's separators. */
function uriToFsPath(uri: { scheme: string; authority: string; path: string }): string {
	let value: string;
	if (uri.authority !== '' && uri.path.length > 1 && uri.scheme === 'file') value = `//${uri.authority}${uri.path}`;
	else if (/^\/[A-Za-z]:/.test(uri.path)) value = uri.path.slice(1);
	else value = uri.path;
	return uriWin32 ? value.replace(/\//g, '\\') : value;
}

/** A path, Uri or Uri-shaped value as the host's path spelling (the fsPath). */
function pathOf(value: Uri | string | { fsPath?: string; path?: string } | undefined | null): string {
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

export class Disposable {
	private disposed = false;
	private readonly callOnDispose: () => unknown;
	constructor(callOnDispose: () => unknown) {
		this.callOnDispose = callOnDispose;
	}
	/** Runs the cleanup once; a second dispose is a no-op (VS Code's contract). */
	dispose(): unknown {
		if (this.disposed) return undefined;
		this.disposed = true;
		return guarded('Disposable.dispose', () => this.callOnDispose());
	}
	static from(...disposables: ({ dispose(): unknown } | undefined | null)[]): Disposable {
		return new Disposable(() => {
			for (const disposable of disposables) if (disposable && typeof disposable.dispose === 'function') guarded('Disposable.from member', () => disposable.dispose());
		});
	}
}

/** VS Code's event signature: `event(listener, thisArgs?, disposables?)`. */
export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => Disposable;

export class EventEmitter<T> {
	private readonly listeners = new Set<{ fn: (e: T) => unknown; thisArgs: unknown }>();
	private disposed = false;
	/** Subscribe: `thisArgs` binds the listener (the `onDidX(this.handler, this, …)` idiom)
	 *  and a `disposables` array collects the subscription, as VS Code's Event does. */
	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		const entry = { fn: listener, thisArgs };
		if (!this.disposed) this.listeners.add(entry);
		const subscription = new Disposable(() => this.listeners.delete(entry));
		if (Array.isArray(disposables)) disposables.push(subscription);
		return subscription;
	};
	/** Deliver to every listener; one listener's throw is logged and the rest still run. */
	fire(event: T): void {
		for (const entry of [...this.listeners]) {
			if (!this.listeners.has(entry)) continue;
			guarded('event listener', () => entry.fn.call(entry.thisArgs, event));
		}
	}
	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}
}

/** An event that never fires: the registration survives and disposes, nothing arrives. */
function silentEvent<T = unknown>(): Event<T> {
	return (_listener, _thisArgs, disposables) => {
		const subscription = new Disposable(() => undefined);
		if (Array.isArray(disposables)) disposables.push(subscription);
		return subscription;
	};
}

/** VS Code's cancellation shape: the token reports and notifies, the source cancels. */
export class CancellationTokenSource {
	private readonly emitter = new EventEmitter<void>();
	readonly token: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: this.emitter.event
	};
	cancel(): void {
		if (this.token.isCancellationRequested) return;
		this.token.isCancellationRequested = true;
		this.emitter.fire(undefined);
	}
	dispose(cancel = false): void {
		if (cancel) this.cancel();
		this.emitter.dispose();
	}
}
export interface CancellationToken {
	isCancellationRequested: boolean;
	onCancellationRequested: Event<void>;
}
/** `CancellationToken.None` / `.Cancelled`: the two static tokens packages pass around. */
const CancellationTokenNone: CancellationToken = Object.freeze({ isCancellationRequested: false, onCancellationRequested: silentEvent<void>() });
const CancellationTokenCancelled: CancellationToken = Object.freeze({ isCancellationRequested: true, onCancellationRequested: silentEvent<void>() });

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 } as const;
export type ViewColumn = (typeof ViewColumn)[keyof typeof ViewColumn];
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum UIKind { Desktop = 1, Web = 2 }
export enum TextEditorSelectionChangeKind { Keyboard = 1, Mouse = 2, Command = 3 }
export enum TextDocumentSaveReason { Manual = 1, AfterDelay = 2, FocusOut = 3 }
export enum TextDocumentChangeReason { Undo = 1, Redo = 2 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export enum TreeItemCheckboxState { Unchecked = 0, Checked = 1 }
export enum DocumentHighlightKind { Text = 0, Read = 1, Write = 2 }
export enum FoldingRangeKind { Comment = 1, Imports = 2, Region = 3 }
export enum SignatureHelpTriggerKind { Invoke = 1, TriggerCharacter = 2, ContentChange = 3 }
export enum CompletionTriggerKind { Invoke = 0, TriggerCharacter = 1, TriggerForIncompleteCompletions = 2 }
export enum CodeActionTriggerKind { Invoke = 1, Automatic = 2 }
export enum InlineCompletionTriggerKind { Invoke = 0, Automatic = 1 }
export enum CompletionItemTag { Deprecated = 1 }
export enum SymbolTag { Deprecated = 1 }
export enum TextEditorCursorStyle { Line = 1, Block = 2, Underline = 3, LineThin = 4, BlockOutline = 5, UnderlineThin = 6 }
export enum TextEditorLineNumbersStyle { Off = 0, On = 1, Relative = 2, Interval = 3 }
export enum EnvironmentVariableMutatorType { Replace = 1, Append = 2, Prepend = 3 }
export enum NotebookCellKind { Markup = 1, Code = 2 }
export enum CommentMode { Editing = 0, Preview = 1 }
export enum TerminalLocation { Panel = 1, Editor = 2 }
export enum TerminalExitReason { Unknown = 0, Shutdown = 1, Process = 2, User = 3, Extension = 4 }
export enum InputBoxValidationSeverity { Info = 1, Warning = 2, Error = 3 }
export enum DebugConsoleMode { Separate = 0, MergeWithParent = 1 }
export enum ColorFormat { RGB = 0, HEX = 1, HSL = 2 }
/** The enums and value classes extension code constructs at load time (a destructure off
 *  `require('vscode')` followed by `new`), each with VS Code's own shape — absent exports
 *  would be `undefined` and the `new` would kill the activation. */
export enum ExtensionMode { Development = 1, Test = 2, Production = 3 }
export enum ExtensionKind { UI = 1, Workspace = 2 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum EndOfLine { LF = 1, CRLF = 2 }
export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
/** `DecorationRangeBehavior`: how a decoration's ranges grow as the document is edited
 *  (cspell's spell-issue decorations construct with `ClosedClosed`). */
export enum DecorationRangeBehavior { OpenOpen = 0, ClosedClosed = 1, OpenClosed = 2, ClosedOpen = 3 }
/** `LanguageStatusSeverity`: the `LanguageStatusItem.severity` values. */
export enum LanguageStatusSeverity { Information = 0, Warning = 1, Error = 2 }
export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3, InCenterIfOutsideViewportPreserveScroll = 4 }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export enum CompletionItemKind { Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4, Variable = 5, Class = 6, Interface = 7, Module = 8, Property = 9, Unit = 10, Value = 11, Enum = 12, Keyword = 13, Snippet = 14, Color = 15, File = 16, Reference = 17, Folder = 18, EnumMember = 19, Constant = 20, Struct = 21, Event = 22, Operator = 23, TypeParameter = 24, User = 25, Issue = 26 }
export enum SymbolKind { File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4, Method = 5, Property = 6, Field = 7, Constructor = 8, Enum = 9, Interface = 10, Function = 11, Variable = 12, Constant = 13, String = 14, Number = 15, Boolean = 16, Array = 17, Object = 18, Key = 19, Null = 20, EnumMember = 21, Struct = 22, Event = 23, Operator = 24, TypeParameter = 25 }
export enum CommentThreadCollapsibleState { Collapsed = 0, Expanded = 1 }
/** `CodeActionKind` is a string holder with a static hierarchy (`CodeActionKind.Refactor.Append('Inline')`). */
export class CodeActionKind {
	constructor(readonly value: string) {}
	static readonly QuickFix = new CodeActionKind('quickfix');
	static readonly Refactor = new CodeActionKind('refactor');
	static readonly RefactorExtract = new CodeActionKind('refactor.extract');
	static readonly RefactorInline = new CodeActionKind('refactor.inline');
	static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
	static readonly Source = new CodeActionKind('source');
	static readonly SourceOrganizeImports = new CodeActionKind('source.organizeImports');
	static readonly SourceFixAll = new CodeActionKind('source.fixAll');
	static readonly Notebook = new CodeActionKind('notebook');
	append(parts: string): CodeActionKind {
		return new CodeActionKind(`${this.value}.${parts}`);
	}
	intersects(other: CodeActionKind): boolean {
		return this.value.startsWith(other.value) || other.value.startsWith(this.value);
	}
	contains(other: CodeActionKind): boolean {
		return other.value.startsWith(this.value + '.') || other.value === this.value;
	}
}
/** `MarkdownString`: appendable markdown with the trust/theme flags VS Code's renderers read. */
export class MarkdownString {
	isTrusted: boolean | { enabledCommands: string[] } | undefined;
	supportThemeIcons: boolean | undefined;
	supportHtml: boolean | undefined;
	baseUri: Uri | undefined;
	constructor(public value = '') {}
	appendText(text: string): MarkdownString {
		this.value += text;
		return this;
	}
	appendMarkdown(md: string): MarkdownString {
		this.value += md;
		return this;
	}
	appendCodeblock(code: string, language = ''): MarkdownString {
		this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
		return this;
	}
}
/** `ThemeIcon` / `ThemeColor`: references into the theme's icon set and colour table. */
export class ThemeIcon {
	static readonly File = new ThemeIcon('file');
	static readonly Folder = new ThemeIcon('folder');
	constructor(readonly id: string, readonly color?: ThemeColor) {}
}
export class ThemeColor {
	constructor(readonly id: string) {}
}
/** `TreeItem`: what a tree view provider's `getTreeItem` returns — `new TreeItem(label,
 *  state)` or `new TreeItem(resourceUri, state)`, VS Code's two constructors (the
 *  serializer, `TreeViewRegistration.children`, reads every field below). */
export class TreeItem {
	label?: string | { label: string; highlights?: [number, number][] };
	resourceUri?: Uri;
	id?: string;
	description?: string | boolean;
	tooltip?: string | MarkdownString | undefined;
	iconPath?: string | Uri | { light: string | Uri; dark: string | Uri } | ThemeIcon;
	contextValue?: string;
	command?: { command: string; title: string; arguments?: unknown[] };
	checkboxState?: TreeItemCheckboxState | { state: TreeItemCheckboxState; tooltip?: string };
	accessibilityInformation?: { label: string; role?: string };
	collapsibleState?: TreeItemCollapsibleState;
	constructor(labelOrUri?: string | { label: string; highlights?: [number, number][] } | Uri, collapsibleState?: TreeItemCollapsibleState) {
		if (labelOrUri instanceof Uri) this.resourceUri = labelOrUri;
		else if (typeof labelOrUri === 'number') this.collapsibleState = labelOrUri; // the old one-argument misuse
		else if (labelOrUri !== undefined) this.label = labelOrUri;
		if (collapsibleState !== undefined) this.collapsibleState = collapsibleState;
	}
}
/** `SnippetString`: the snippet builder's value object. */
export class SnippetString {
	constructor(public value = '') {}
	appendText(text: string): SnippetString {
		this.value += text;
		return this;
	}
	appendTabstop(number = 1): SnippetString {
		this.value += `$${number}`;
		return this;
	}
	appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number = 1): SnippetString {
		if (typeof value === 'string') this.value += `\${${number}:${value}}`;
		else {
			const inner = new SnippetString();
			value(inner);
			this.value += `\${${number}:${inner.value}}`;
		}
		return this;
	}
	appendChoice(values: string[], number = 1): SnippetString {
		this.value += `\${${number}|${values.join(',')}|}`;
		return this;
	}
	appendVariable(name: string, defaultValue?: string): SnippetString {
		this.value += defaultValue === undefined ? `\${${name}}` : `\${${name}:${defaultValue}}`;
		return this;
	}
}
/** `TextEdit`: the single-document edit (a range and its replacement text). */
export class TextEdit {
	range: Range;
	constructor(range: Range, public newText: string) {
		this.range = range;
	}
	static replace(range: Range, newText: string): TextEdit {
		return new TextEdit(range, newText);
	}
	static insert(position: Position, newText: string): TextEdit {
		return new TextEdit(new Range(position, position), newText);
	}
	static delete(range: Range): TextEdit {
		return new TextEdit(range, '');
	}
	static setEndOfLine(eol: EndOfLine): TextEdit {
		const edit = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
		edit.newEol = eol;
		return edit;
	}
	newEol?: EndOfLine;
	replace(range: Range, newText: string): TextEdit {
		this.range = range;
		this.newText = newText;
		return this;
	}
}
/** `SnippetTextEdit`: an edit whose text is a snippet — applied here as its plain text
 *  (placeholders keep their default text, tab stops vanish; no snippet session). */
export class SnippetTextEdit {
	constructor(public range: Range, public snippet: SnippetString) {}
	static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
		return new SnippetTextEdit(range, snippet);
	}
	static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
		return new SnippetTextEdit(new Range(position, position), snippet);
	}
}
/** A snippet's plain text: `${1:default}` keeps `default`, `$1` / `${1}` vanish. */
export function snippetPlainText(snippet: string): string {
	return snippet
		.replace(/\$\{\d+:([^}]*)\}/g, '$1')
		.replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1')
		.replace(/\$\{?\d+\}?/g, '')
		.replace(/\\([$}\\])/g, '$1');
}
/** `RelativePattern`: a base (folder path, Uri or WorkspaceFolder) and a glob. */
export class RelativePattern {
	base: string;
	baseUri: Uri;
	constructor(base: string | Uri | { uri: Uri }, public pattern: string) {
		this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri || Uri.isUri(base) ? (base as Uri) : (base as { uri: Uri }).uri;
		this.base = this.baseUri.fsPath;
	}
}
/** One operation of a WorkspaceEdit, in the order the package recorded it. */
export type WorkspaceEditOperation =
	| { kind: 'text'; uri: Uri; edit: TextEdit | SnippetTextEdit }
	| { kind: 'create'; uri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } }
	| { kind: 'delete'; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
	| { kind: 'rename'; uri: Uri; newUri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean } };

/** `WorkspaceEdit`: text edits and file operations across documents, applied in the order
 *  they were recorded by `workspace.applyEdit` (or carried by a CodeAction). */
export class WorkspaceEdit {
	readonly _operations: WorkspaceEditOperation[] = [];
	replace(uri: Uri, range: Range, newText: string, _metadata?: unknown): void {
		this._operations.push({ kind: 'text', uri, edit: new TextEdit(range, newText) });
	}
	insert(uri: Uri, position: Position, newText: string, _metadata?: unknown): void {
		this.replace(uri, new Range(position, position), newText);
	}
	delete(uri: Uri, range: Range, _metadata?: unknown): void {
		this.replace(uri, range, '');
	}
	has(uri: Uri): boolean {
		return this._operations.some((operation) => operation.kind === 'text' && operation.uri.toString() === uri.toString());
	}
	/** Replace every text edit of one document (`null` / `[]` clears them). The entries may
	 *  be edits or `[edit, metadata]` pairs, both VS Code spellings. */
	set(uri: Uri, edits: readonly (TextEdit | SnippetTextEdit | [TextEdit | SnippetTextEdit, unknown])[] | null | undefined): void {
		const key = uri.toString();
		for (let at = this._operations.length - 1; at >= 0; at--) {
			const operation = this._operations[at]!;
			if (operation.kind === 'text' && operation.uri.toString() === key) this._operations.splice(at, 1);
		}
		for (const entry of edits ?? []) this._operations.push({ kind: 'text', uri, edit: Array.isArray(entry) ? entry[0] : entry });
	}
	get(uri: Uri): TextEdit[] {
		const key = uri.toString();
		return this._operations.flatMap((operation) => (operation.kind === 'text' && operation.uri.toString() === key && operation.edit instanceof TextEdit ? [operation.edit] : []));
	}
	createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }): void {
		this._operations.push({ kind: 'create', uri, options });
	}
	deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
		this._operations.push({ kind: 'delete', uri, options });
	}
	renameFile(oldUri: Uri, newUri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
		this._operations.push({ kind: 'rename', uri: oldUri, newUri, options });
	}
	/** How many resources the edit touches. */
	get size(): number {
		return new Set(this._operations.map((operation) => operation.uri.toString())).size;
	}
	entries(): [Uri, TextEdit[]][] {
		const byUri = new Map<string, [Uri, TextEdit[]]>();
		for (const operation of this._operations) {
			if (operation.kind !== 'text' || !(operation.edit instanceof TextEdit)) continue;
			const key = operation.uri.toString();
			if (!byUri.has(key)) byUri.set(key, [operation.uri, []]);
			byUri.get(key)![1].push(operation.edit);
		}
		return [...byUri.values()];
	}
}
/** `Diagnostic`: a squiggle — the shape `languages.createDiagnosticCollection` entries
 *  carry and editorDiagnostics renders. */
export enum DiagnosticTag { Unnecessary = 1, Deprecated = 2 }
export class DiagnosticRelatedInformation {
	constructor(public location: Location, public message: string) {}
}
export class Diagnostic {
	severity!: DiagnosticSeverity;
	source?: string;
	code?: string | number;
	relatedInformation?: DiagnosticRelatedInformation[];
	tags?: DiagnosticTag[];
	constructor(public range: Range, public message: string, severity?: DiagnosticSeverity) {
		this.severity = severity ?? DiagnosticSeverity.Error;
	}
}
/** `CompletionItem` and the rest of the language-feature value types: packages extend
 *  these at module-eval time (vscode-languageclient's converters do `class extends
 *  CompletionItem`), so each must be a real class, not a factory. */
export class CompletionItem {
	label: string | { label: string; detail?: string; description?: string };
	kind?: CompletionItemKind;
	tags?: readonly unknown[];
	detail?: string;
	documentation?: string | MarkdownString;
	deprecated?: boolean;
	preselect?: boolean;
	sortText?: string;
	filterText?: string;
	insertText?: string | SnippetString;
	range?: Range | { inserting: Range; replacing: Range };
	command?: unknown;
	textEdit?: TextEdit;
	additionalTextEdits?: TextEdit[];
	commitCharacters?: string[];
	keepWhitespace?: boolean;
	constructor(label: string | { label: string; detail?: string; description?: string }, kind?: CompletionItemKind) {
		this.label = label;
		this.kind = kind;
	}
}
export class CodeLens {
	command?: unknown;
	data?: unknown;
	constructor(public range: Range, command?: unknown) {
		this.command = command;
	}
}
export class DocumentLink {
	tooltip?: string;
	constructor(public range: Range, public target?: Uri) {}
}
export class CodeAction {
	edit?: WorkspaceEdit;
	diagnostics?: Diagnostic[];
	command?: unknown;
	isPreferred?: boolean;
	disabled?: { reason: string };
	constructor(public title: string, public kind?: CodeActionKind) {}
}
export class SymbolInformation {
	tags?: readonly unknown[];
	containerName?: string;
	/** `(name, kind, containerName, location)` or `(name, kind, range, uri?, containerName?)`. */
	constructor(public name: string, public kind: SymbolKind, rangeOrContainer?: Range | string, locationOrUri?: Location | Uri, containerName?: string) {
		if (rangeOrContainer instanceof Range) {
			this.location = new Location(locationOrUri instanceof Uri ? locationOrUri : Uri.parse('untitled:'), rangeOrContainer);
			this.containerName = containerName;
		} else if (typeof rangeOrContainer === 'string' && locationOrUri instanceof Location) {
			this.containerName = rangeOrContainer;
			this.location = locationOrUri;
		}
	}
	location!: Location;
}
export class CallHierarchyItem {
	tags?: readonly unknown[];
	constructor(public kind: SymbolKind, public name: string, public detail: string, public uri: Uri, public range: Range, public selectionRange: Range) {}
}
export class TypeHierarchyItem {
	tags?: readonly unknown[];
	constructor(public kind: SymbolKind, public name: string, public detail: string, public uri: Uri, public range: Range, public selectionRange: Range) {}
}
export enum InlayHintKind { Type = 1, Parameter = 2 }
export class InlayHint {
	kind?: InlayHintKind;
	tooltip?: string | MarkdownString;
	paddingLeft?: boolean;
	paddingRight?: boolean;
	textEdits?: TextEdit[];
	constructor(public position: Position, public label: string | InlayHintLabelPart[], kind?: InlayHintKind) {
		this.kind = kind;
	}
}
export class InlayHintLabelPart {
	tooltip?: string | MarkdownString;
	location?: Location;
	command?: unknown;
	constructor(public value: string) {}
	get label(): string {
		return this.value;
	}
}
/** `CancellationError`: the token's `throwIfCancellationRequested` answer. */
export class CancellationError extends Error {
	constructor() {
		super('Canceled');
		this.name = 'Canceled';
	}
}
/** `Selection`: a Range whose ends are also anchor/active. */
export class Selection extends Range {
	readonly anchor: Position;
	readonly active: Position;
	/** `(anchor, active)` or `(anchorLine, anchorCharacter, activeLine, activeCharacter)`. */
	constructor(anchorLine: number | { line: number; character: number }, anchorCharacter: number | { line: number; character: number }, activeLine?: number, activeCharacter?: number) {
		const anchor = typeof anchorLine === 'number' ? new Position(anchorLine, anchorCharacter as number) : Position.of(anchorLine);
		const active = typeof anchorLine === 'number' ? new Position(activeLine ?? 0, activeCharacter ?? 0) : Position.of(anchorCharacter as { line: number; character: number });
		super(anchor, active);
		this.anchor = anchor;
		this.active = active;
	}
	get isReversed(): boolean {
		return this.anchor.compareTo(this.active) > 0;
	}
}
/** `FileSystemError`: the error family `workspace.fs` rejects with, by code. */
export class FileSystemError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
	}
	static FileNotFound(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileNotFound');
	}
	static FileExists(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileExists');
	}
	static FileNotADirectory(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileNotADirectory');
	}
	static FileIsADirectory(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'FileIsADirectory');
	}
	static NoPermissions(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'NoPermissions');
	}
	static Unavailable(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'Unavailable');
	}
}

/* ---------- Language-feature value classes ----------
 * Providers construct these (and language clients `extends` them at module load), so each
 * is a real class with VS Code's constructor shape — the provider hosts that would consume
 * them are not in this host, which logs the registration as unsupported. */

export class Hover {
	contents: (MarkdownString | string | { language: string; value: string })[];
	constructor(contents: MarkdownString | string | { language: string; value: string } | (MarkdownString | string | { language: string; value: string })[], public range?: Range) {
		this.contents = Array.isArray(contents) ? contents : [contents];
	}
}
export class ParameterInformation {
	constructor(public label: string | [number, number], public documentation?: string | MarkdownString) {}
}
export class SignatureInformation {
	parameters: ParameterInformation[] = [];
	activeParameter?: number;
	constructor(public label: string, public documentation?: string | MarkdownString) {}
}
export class SignatureHelp {
	signatures: SignatureInformation[] = [];
	activeSignature = 0;
	activeParameter = 0;
}
export class FoldingRange {
	constructor(public start: number, public end: number, public kind?: FoldingRangeKind) {}
}
export class DocumentSymbol {
	children: DocumentSymbol[] = [];
	tags?: readonly SymbolTag[];
	constructor(public name: string, public detail: string, public kind: SymbolKind, public range: Range, public selectionRange: Range) {}
}
export class DocumentHighlight {
	constructor(public range: Range, public kind: DocumentHighlightKind = DocumentHighlightKind.Text) {}
}
export class SelectionRange {
	constructor(public range: Range, public parent?: SelectionRange) {}
}
export class CompletionList {
	constructor(public items: CompletionItem[] = [], public isIncomplete = false) {}
}
export class CallHierarchyIncomingCall {
	constructor(public from: CallHierarchyItem, public fromRanges: Range[]) {}
}
export class CallHierarchyOutgoingCall {
	constructor(public to: CallHierarchyItem, public fromRanges: Range[]) {}
}
export class LinkedEditingRanges {
	constructor(public ranges: Range[], public wordPattern?: RegExp) {}
}
export class EvaluatableExpression {
	constructor(public range: Range, public expression?: string) {}
}
export class InlineValueText {
	constructor(public range: Range, public text: string) {}
}
export class InlineValueVariableLookup {
	constructor(public range: Range, public variableName?: string, public caseSensitiveLookup = true) {}
}
export class InlineValueEvaluatableExpression {
	constructor(public range: Range, public expression?: string) {}
}
export class InlineCompletionItem {
	constructor(public insertText: string | SnippetString, public range?: Range, public command?: unknown) {}
}
export class InlineCompletionList {
	constructor(public items: InlineCompletionItem[]) {}
}
export class Color {
	constructor(readonly red: number, readonly green: number, readonly blue: number, readonly alpha: number) {}
}
export class ColorInformation {
	constructor(public range: Range, public color: Color) {}
}
export class ColorPresentation {
	textEdit?: TextEdit;
	additionalTextEdits?: TextEdit[];
	constructor(public label: string) {}
}
export class SemanticTokensLegend {
	constructor(readonly tokenTypes: string[], readonly tokenModifiers: string[] = []) {}
}
export class SemanticTokens {
	constructor(readonly data: Uint32Array, readonly resultId?: string) {}
}
export class SemanticTokensEdit {
	constructor(readonly start: number, readonly deleteCount: number, readonly data?: Uint32Array) {}
}
export class SemanticTokensEdits {
	constructor(readonly edits: SemanticTokensEdit[], readonly resultId?: string) {}
}
/** `SemanticTokensBuilder`: the relative-encoding builder VS Code ships (tokens pushed in
 *  document order become the delta-encoded `Uint32Array`). */
export class SemanticTokensBuilder {
	private readonly data: number[] = [];
	private previousLine = 0;
	private previousCharacter = 0;
	constructor(private readonly legend?: SemanticTokensLegend) {}
	push(lineOrRange: number | Range, characterOrType: number | string, lengthOrModifiers?: number | string[], tokenType?: number, tokenModifiers = 0): void {
		let line: number;
		let character: number;
		let length: number;
		let type: number;
		let modifiers: number;
		if (typeof lineOrRange === 'number') {
			line = lineOrRange;
			character = characterOrType as number;
			length = lengthOrModifiers as number;
			type = tokenType ?? 0;
			modifiers = tokenModifiers;
		} else {
			line = lineOrRange.start.line;
			character = lineOrRange.start.character;
			length = lineOrRange.end.character - lineOrRange.start.character;
			type = Math.max(0, this.legend?.tokenTypes.indexOf(String(characterOrType)) ?? 0);
			modifiers = 0;
			for (const modifier of (lengthOrModifiers as string[] | undefined) ?? []) {
				const bit = this.legend?.tokenModifiers.indexOf(modifier) ?? -1;
				if (bit >= 0) modifiers |= 1 << bit;
			}
		}
		const deltaLine = line - this.previousLine;
		const deltaCharacter = deltaLine === 0 ? character - this.previousCharacter : character;
		this.data.push(deltaLine, deltaCharacter, length, type, modifiers);
		this.previousLine = line;
		this.previousCharacter = character;
	}
	build(resultId?: string): SemanticTokens {
		return new SemanticTokens(new Uint32Array(this.data), resultId);
	}
}
export class DocumentDropEdit {
	constructor(public insertText: string | SnippetString) {}
}
export class FileDecoration {
	constructor(public badge?: string, public tooltip?: string, public color?: ThemeColor) {}
	propagate?: boolean;
}
export class TerminalLink {
	constructor(public startIndex: number, public length: number, public tooltip?: string) {}
}
export class TerminalProfile {
	constructor(public options: unknown) {}
}
export class DataTransferItem {
	constructor(readonly value: unknown) {}
	async asString(): Promise<string> {
		return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
	}
	asFile(): undefined {
		return undefined;
	}
}
export class DataTransfer {
	private readonly items = new Map<string, DataTransferItem>();
	get(mimeType: string): DataTransferItem | undefined {
		return this.items.get(mimeType.toLowerCase());
	}
	set(mimeType: string, value: DataTransferItem): void {
		this.items.set(mimeType.toLowerCase(), value);
	}
	forEach(callback: (item: DataTransferItem, mimeType: string, transfer: DataTransfer) => void): void {
		for (const [mime, item] of this.items) callback(item, mime, this);
	}
	*[Symbol.iterator](): IterableIterator<[string, DataTransferItem]> {
		yield* this.items;
	}
}
/** The Tabs API's input shapes (`tab.input instanceof TabInputText`). */
export class TabInputText {
	constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
	constructor(readonly original: Uri, readonly modified: Uri) {}
}
export class TabInputWebview {
	constructor(readonly viewType: string) {}
}
export class TabInputCustom {
	constructor(readonly uri: Uri, readonly viewType: string) {}
}
export class TabInputTerminal {}
export class NotebookCellData {
	outputs?: unknown[];
	metadata?: Record<string, unknown>;
	constructor(public kind: NotebookCellKind, public value: string, public languageId: string) {}
}
export class NotebookData {
	metadata?: Record<string, unknown>;
	constructor(public cells: NotebookCellData[]) {}
}
/** An output item of a notebook cell. Value types are inert here — the notebooks the
 *  host does not render natively still let packages construct and pass them. */
export class NotebookCellOutputItem {
	constructor(public data: Uint8Array, public mime: string) {}
	static bytes(data: Uint8Array, mime: string): NotebookCellOutputItem {
		return new NotebookCellOutputItem(data, mime);
	}
	static stdout(text: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(new TextEncoder().encode(text), 'application/vnd.code.notebook.stdout');
	}
	static stderr(text: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(new TextEncoder().encode(text), 'application/vnd.code.notebook.stderr');
	}
	static error(err: Error): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(
			new TextEncoder().encode(JSON.stringify({ name: err.name, message: err.message, stack: err.stack ?? '' })),
			'application/vnd.code.notebook.error',
		);
	}
	static json(value: unknown, mime2?: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(
			Buffer.from(JSON.stringify(value, undefined, '\t')),
			mime2 ?? 'text/x-json',
		);
	}
	static text(text: string, mime2: string): NotebookCellOutputItem {
		return NotebookCellOutputItem.bytes(new TextEncoder().encode(text), mime2);
	}
}
export class NotebookEdit {
	constructor(public index: number, public cells: NotebookCellData[]) {}
	static replaceCells(index: number, cells: NotebookCellData[]): NotebookEdit {
		return new NotebookEdit(index, cells);
	}
	static insertCells(index: number, cells: NotebookCellData[]): NotebookEdit {
		return new NotebookEdit(index, cells);
	}
	static deleteCells(index: number, count: number): NotebookEdit {
		void count;
		return new NotebookEdit(index, []);
	}
	static updateCellMetadata(index: number, newCellMetadata: Record<string, unknown>): NotebookEdit {
		const edit = new NotebookEdit(index, []);
		edit.newCellMetadata = newCellMetadata;
		return edit;
	}
	newCellMetadata?: Record<string, unknown>;
}
export class NotebookRange {
	constructor(readonly start: number, readonly end: number) {}
	get isEmpty(): boolean {
		return this.start === this.end;
	}
}
export class Breakpoint {
	readonly id = `bp-${Math.random().toString(36).slice(2)}`;
	constructor(readonly enabled = true, readonly condition?: string, readonly hitCondition?: string, readonly logMessage?: string) {}
}
export class SourceBreakpoint extends Breakpoint {
	constructor(readonly location: Location, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) {
		super(enabled, condition, hitCondition, logMessage);
	}
}
export class FunctionBreakpoint extends Breakpoint {
	constructor(readonly functionName: string, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) {
		super(enabled, condition, hitCondition, logMessage);
	}
}
export class DebugAdapterExecutable {
	constructor(readonly command: string, readonly args: string[] = [], readonly options?: unknown) {}
}
export class DebugAdapterServer {
	constructor(readonly port: number, readonly host?: string) {}
}
export class DebugAdapterNamedPipeServer {
	constructor(readonly path: string) {}
}
export class DebugAdapterInlineImplementation {
	constructor(readonly implementation: unknown) {}
}
export class CommentThreadState {}
export class LanguageModelError extends Error {}

/* ---------- The tasks value classes (the `tasks` namespace serves them inertly) ---------- */

export class ShellExecution {
	constructor(readonly commandLine: string | { command: string; args: string[] }, readonly options?: unknown) {}
}
export class ProcessExecution {
	constructor(readonly process: string, readonly args?: string[], readonly options?: unknown) {}
}
export class CustomExecution {
	constructor(readonly callback: unknown) {}
}
export class TaskGroup {
	static readonly Clean = new TaskGroup('clean');
	static readonly Build = new TaskGroup('build');
	static readonly Rebuild = new TaskGroup('rebuild');
	static readonly Test = new TaskGroup('test');
	static readonly None = new TaskGroup('none');
	constructor(readonly id: string) {}
	isDefault = false;
}
export const TaskScope = { Global: 1, Workspace: 2 } as const;
export type TaskScope = (typeof TaskScope)[keyof typeof TaskScope];
export const TaskRevealKind = { Always: 0, Silent: 1, Never: 2 } as const;
export const TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 } as const;
export class Task {
	constructor(readonly definition: { type: string; [key: string]: unknown }, readonly scope: TaskScope | unknown, readonly name: string, readonly source: string, readonly execution?: unknown, readonly problemMatchers?: string[]) {}
	isBackground = false;
	detail: string | undefined;
	group: TaskGroup | undefined;
}

/* ---------- Shared shapes the API below is typed against ---------- */

/** VS Code's MessageItem: an object-shaped message button (`{ title, isCloseAffordance }`). */
export interface MessageItem {
	title: string;
	isCloseAffordance?: boolean;
}

/** The object shape of a quick pick entry (`label` plus optional `description` / `detail`). */
export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;
	alwaysShow?: boolean;
}

/* ---------- Configuration ---------- */


/** `vscode.ConfigurationChangeEvent`: which settings a change touched. */
export interface ConfigurationChangeEvent {
	affectsConfiguration(section: string, scope?: unknown): boolean;
}

/** The keys whose values differ between two settings maps (added, removed or changed). */
export function changedSettingKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** VS Code's section semantics: a change to `a.b.c` affects `a`, `a.b` and `a.b.c`, and a
 *  change to a whole section (`a.b`) affects every key under it. */
export function configurationChangeEvent(changed: string[]): ConfigurationChangeEvent {
	return {
		affectsConfiguration: (section: string) =>
			changed.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`))
	};
}

/** VS Code's `WorkspaceConfiguration`: a section's view over the defaults (the declared
 *  `contributes.configuration` values and the workbench's core sections) and the stored
 *  overrides. A key that names a whole sub-section (`get('format')` when `x.format.a`
 *  and `x.format.b` are defined) answers the object assembled from its leaves, as VS Code
 *  does; the section's own keys also read as properties (`config.enable`). */
class WorkspaceConfiguration {
	[key: string]: unknown;
	constructor(private readonly ctx: HostContext, private readonly bridge: HostBridge, private readonly section: string, private readonly onChanged?: (keys: string[]) => void) {
		// VS Code's configuration object carries the section's values as properties too.
		for (const leaf of this.leafKeys(this.section)) {
			const rest = this.section === '' ? leaf : leaf.slice(this.section.length + 1);
			const head = rest.split('.')[0]!;
			if (head === '' || head in this || ['get', 'has', 'update', 'inspect'].includes(head)) continue;
			Object.defineProperty(this, head, { enumerable: true, configurable: true, get: () => this.get(head) });
		}
	}

	private key(setting: string): string {
		return this.section === '' ? setting : setting === '' ? this.section : `${this.section}.${setting}`;
	}

	/** Every defined key under a prefix (defaults and overrides alike). */
	private leafKeys(prefix: string): string[] {
		const keys = new Set([...Object.keys(this.ctx.defaults ?? {}), ...Object.keys(this.ctx.settings)]);
		return [...keys].filter((key) => prefix === '' || key === prefix || key.startsWith(`${prefix}.`));
	}

	private valueOf(full: string): unknown {
		if (full in this.ctx.settings) return this.ctx.settings[full];
		if (this.ctx.defaults && full in this.ctx.defaults) return this.ctx.defaults[full];
		// A sub-section: assemble it from its leaves (deep copies — VS Code's are frozen).
		const leaves = this.leafKeys(full).filter((key) => key !== full);
		if (leaves.length === 0) return undefined;
		const out: Record<string, unknown> = {};
		for (const leaf of leaves) {
			const path = leaf.slice(full.length + 1).split('.');
			let node = out;
			for (const part of path.slice(0, -1)) node = (node[part] = typeof node[part] === 'object' && node[part] !== null ? node[part] : {}) as Record<string, unknown>;
			node[path[path.length - 1]!] = structuredCopy(this.valueOf(leaf));
		}
		return out;
	}

	get<T = unknown>(setting: string, defaultValue?: T): T {
		const value = this.valueOf(this.key(setting));
		return (value === undefined ? defaultValue : structuredCopy(value)) as T;
	}

	has(setting: string): boolean {
		return this.valueOf(this.key(setting)) !== undefined;
	}

	async update(setting: string, value: unknown, _target?: ConfigurationTarget | boolean | null, _overrideInLanguage?: boolean): Promise<void> {
		const key = this.key(setting);
		const changed = JSON.stringify(this.ctx.settings[key]) !== JSON.stringify(value);
		if (value === undefined) delete this.ctx.settings[key];
		else this.ctx.settings[key] = value;
		await this.bridge.request('settings.update', [this.ctx.extensionId, key, value]);
		// VS Code fires `onDidChangeConfiguration` for the extension's own update too. The
		// host's `configChanged` push that follows diffs against the value written above and
		// finds nothing, so the event fires here or never (git-graph-rs's `enableLog`
		// toggle never reached its logger before).
		if (changed) this.onChanged?.([key]);
	}

	/** Where a value comes from: its default and the (single, global-scope) override. */
	inspect<T = unknown>(setting: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T; defaultLanguageValue?: T; globalLanguageValue?: T; workspaceLanguageValue?: T; workspaceFolderLanguageValue?: T; languageIds?: string[] } | undefined {
		// Always an object: a package reads `inspect(key).globalValue` for keys it declared
		// (ms-python migrates settings that way), and a key this host has no default for yet
		// must read as "unset", not crash the activation.
		const key = this.key(setting);
		const defaultValue = this.ctx.defaults?.[key] as T | undefined;
		const globalValue = this.ctx.settings[key] as T | undefined;
		return { key, defaultValue: structuredCopy(defaultValue), globalValue: structuredCopy(globalValue), workspaceValue: undefined, workspaceFolderValue: undefined };
	}
}

/** A deep copy of a JSON-shaped value (a configuration object an extension may mutate). */
function structuredCopy<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

/** VS Code's Memento: key/value storage that survives restarts. `globalState` is shared by
 *  every window of the machine (as much as Studio's per-app localStorage is), `workspaceState`
 *  is per-workspace in VS Code and per-install here — both persisted through the host. */
class Memento {
	constructor(private readonly ctx: HostContext, private readonly bridge: HostBridge, private readonly scope: 'global' | 'workspace') {}

	get<T = unknown>(key: string, defaultValue?: T): T | undefined {
		const value = this.ctx.state[this.scope][key];
		return (value as T | undefined) ?? defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) delete this.ctx.state[this.scope][key];
		else this.ctx.state[this.scope][key] = value;
		await this.bridge.request('state.update', [this.scope, key, value]);
	}

	keys(): string[] {
		return Object.keys(this.ctx.state[this.scope]);
	}

	/** Settings Sync's key list (VS Code 1.52): there is no sync service, so the list is
	 *  accepted and has no further effect. */
	setKeysForSync(_keys: readonly string[]): void {}
}

/** `ExtensionContext.secrets`: values kept by the host per extension (the workbench's
 *  storage — not an OS keychain; noted in the log the first time a secret is stored). */
class SecretStorage {
	private readonly changed = new EventEmitter<{ key: string }>();
	readonly onDidChange = this.changed.event;
	constructor(private readonly bridge: HostBridge) {}
	async get(key: string): Promise<string | undefined> {
		const value = await this.bridge.request('secrets.get', [key]);
		return typeof value === 'string' ? value : undefined;
	}
	async store(key: string, value: string): Promise<void> {
		await this.bridge.request('secrets.store', [key, String(value)]);
		this.changed.fire({ key });
	}
	async delete(key: string): Promise<void> {
		await this.bridge.request('secrets.delete', [key]);
		this.changed.fire({ key });
	}
	async keys(): Promise<string[]> {
		const keys = await this.bridge.request('secrets.keys', []);
		return Array.isArray(keys) ? (keys as string[]) : [];
	}
}

/** `ExtensionContext.environmentVariableCollection`: the mutations an extension wants in
 *  the terminals it did not create. The integrated terminal has no per-extension env
 *  layer, so the collection keeps its state (reads back what was written) and the first
 *  mutation is logged as not applied. */
class EnvironmentVariableCollection {
	private readonly mutators = new Map<string, { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> }>();
	persistent = true;
	description: string | MarkdownString | undefined;
	constructor(private readonly extensionId: string) {}
	private note(): void {
		shimLogOnce(`envcollection:${this.extensionId}`, 'warn', 'environmentVariableCollection mutations are kept but not applied to terminals in this host');
	}
	replace(variable: string, value: string, options: Record<string, unknown> = {}): void {
		this.note();
		this.mutators.set(variable, { value, type: EnvironmentVariableMutatorType.Replace, options });
	}
	append(variable: string, value: string, options: Record<string, unknown> = {}): void {
		this.note();
		this.mutators.set(variable, { value, type: EnvironmentVariableMutatorType.Append, options });
	}
	prepend(variable: string, value: string, options: Record<string, unknown> = {}): void {
		this.note();
		this.mutators.set(variable, { value, type: EnvironmentVariableMutatorType.Prepend, options });
	}
	get(variable: string): { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> } | undefined {
		return this.mutators.get(variable);
	}
	forEach(callback: (variable: string, mutator: { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> }, collection: EnvironmentVariableCollection) => unknown): void {
		for (const [variable, mutator] of this.mutators) callback(variable, mutator, this);
	}
	delete(variable: string): void {
		this.mutators.delete(variable);
	}
	clear(): void {
		this.mutators.clear();
	}
	getScoped(_scope: unknown): EnvironmentVariableCollection {
		return this;
	}
	*[Symbol.iterator](): IterableIterator<[string, { value: string; type: EnvironmentVariableMutatorType; options: Record<string, unknown> }]> {
		yield* this.mutators;
	}
}

/** A live webview panel the extension created; the host owns the tab and the iframe, the
 *  frame-side half only proxies. Disposal arrives as a `webviewDisposed` host event. */
class WebviewPanel {
	private titleValue: string;
	private htmlValue = '';
	private readonly disposed = new EventEmitter<void>();
	private readonly messages = new EventEmitter<unknown>();
	private readonly viewState = new EventEmitter<{ webviewPanel: unknown }>();
	gone = false;
	/** Built in the constructor body: it closes over the constructor's parameters, which
	 *  field initializers cannot (parameter properties initialize after them). */
	readonly webview: {
		options: Record<string, unknown>;
		html: string;
		postMessage(message: unknown): Promise<boolean>;
		onDidReceiveMessage(listener: (e: unknown) => unknown): Disposable;
		asWebviewUri(local: Uri | string): Uri;
		cspSource: string;
	};

	constructor(private readonly bridge: HostBridge, private readonly ctx: HostContext, readonly viewType: string, title: string, readonly options: Record<string, unknown>, readonly panelId: number) {
		this.titleValue = title;
		const self = this;
		this.webview = {
			options,
			get html(): string {
				return self.htmlValue;
			},
			set html(value: string) {
				self.htmlValue = value;
				void self.bridge.request('webview.setHtml', [self.panelId, value]);
			},
			postMessage: (message: unknown) => bridge.request('webview.postMessage', [panelId, message]).then(() => true) as Promise<boolean>,
			onDidReceiveMessage: this.messages.event,
			asWebviewUri: (local: Uri | string): Uri => {
				const path = typeof local === 'string' ? local : local.fsPath;
				// The extension path crosses with the host platform's separators (backslashes
				// on Windows) while the incoming path is forward-slash normalized — normalize
				// both or the root-prefix test fails and the whole absolute path is appended
				// to the resource base, a URL nothing serves.
				const root = this.ctx.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
				const rel = path.replace(/\\/g, '/').startsWith(root + '/')
					? path.replace(/\\/g, '/').slice(root.length + 1)
					: path.replace(/\\/g, '/').replace(/^\.\//, '');
				return Uri.parse(this.ctx.webviewResourceBase + rel);
			},
			// `${cspSource}` composes the page's own CSP directives, so `data:` rides along: a
			// page inlining its icon font as a data: URL (claude-code's codicons) dies under
			// its own `font-src ${cspSource}` without it. (Both webview kinds carry it.)
			cspSource: this.ctx.webviewResourceBase + ' data:'
		};
	}

	get title(): string {
		return this.titleValue;
	}

	set title(value: string) {
		this.titleValue = value;
		void this.bridge.request('webview.setTitle', [this.panelId, value]);
	}

	private activeValue = true;

	get visible(): boolean {
		return !this.gone;
	}

	get active(): boolean {
		return !this.gone && this.activeValue;
	}

	/** The panel's tab became (in)active — VS Code's `onDidChangeViewState`. */
	setActive(active: boolean): void {
		if (this.gone || this.activeValue === active) return;
		this.activeValue = active;
		this.viewState.fire({ webviewPanel: this });
	}

	/** The tab icon an extension assigns (accepted; tabs show the package icon). */
	iconPath: Uri | { light: Uri; dark: Uri } | undefined;
	viewColumn: number | undefined = ViewColumn.One;

	readonly onDidDispose = this.disposed.event;
	readonly onDidChangeViewState = this.viewState.event;

	reveal(): void {
		if (!this.gone) void this.bridge.request('webview.reveal', [this.panelId]);
	}

	dispose(): void {
		if (this.gone) return;
		void this.bridge.request('webview.dispose', [this.panelId]);
		this.close();
	}

	/** The host confirmed the panel is gone (tab closed either way) — fire, exactly once. */
	close(): void {
		if (this.gone) return;
		this.gone = true;
		this.disposed.fire(undefined);
		this.disposed.dispose();
		this.messages.dispose();
		this.viewState.dispose();
	}

	receive(message: unknown): void {
		if (!this.gone) this.messages.fire(message);
	}
}

/** A sidebar webview view (`contributes.views` with `type: "webview"`, resolved through
 *  `registerWebviewViewProvider`): the host owns the section's iframe; this frame-side half
 *  proxies html, title and messages the way WebviewPanel does, plus the visibility events
 *  the sidebar's view switching produces. */
class WebviewView {
	private titleValue = '';
	private descriptionValue = '';
	private htmlValue = '';
	private readonly messages = new EventEmitter<unknown>();
	private readonly visibilityChanged = new EventEmitter<{ visible: boolean }>();
	private readonly disposed = new EventEmitter<void>();
	private visibleValue = false;
	/** Set once the provider resolved it (a resolve is deferred to the first show). */
	resolved = false;
	gone = false;
	readonly webview: {
		options: Record<string, unknown>;
		html: string;
		postMessage(message: unknown): Promise<boolean>;
		onDidReceiveMessage(listener: (e: unknown) => unknown): Disposable;
		asWebviewUri(local: Uri | string): Uri;
		cspSource: string;
	};

	constructor(private readonly bridge: HostBridge, private readonly ctx: HostContext, readonly viewType: string, options: Record<string, unknown>) {
		const self = this;
		this.webview = {
			options,
			get html(): string {
				return self.htmlValue;
			},
			set html(value: string) {
				self.htmlValue = value;
				void self.bridge.request('webviewView.setHtml', [self.viewType, value]);
			},
			postMessage: (message: unknown) => bridge.request('webviewView.postMessage', [viewType, message]).then(() => true) as Promise<boolean>,
			onDidReceiveMessage: this.messages.event,
			asWebviewUri: (local: Uri | string): Uri => {
				const path = typeof local === 'string' ? local : local.fsPath;
				// The extension path crosses with the host platform's separators (backslashes
				// on Windows) while the incoming path is forward-slash normalized — normalize
				// both or the root-prefix test fails and the whole absolute path is appended
				// to the resource base, a URL nothing serves.
				const root = this.ctx.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
				const rel = path.replace(/\\/g, '/').startsWith(root + '/')
					? path.replace(/\\/g, '/').slice(root.length + 1)
					: path.replace(/\\/g, '/').replace(/^\.\//, '');
				return Uri.parse(this.ctx.webviewResourceBase + rel);
			},
			// `${cspSource}` composes the page's own CSP directives, so `data:` rides along: a
			// page inlining its icon font as a data: URL (claude-code's codicons) dies under
			// its own `font-src ${cspSource}` without it. (Both webview kinds carry it.)
			cspSource: this.ctx.webviewResourceBase + ' data:'
		};
	}

	get title(): string {
		return this.titleValue;
	}

	set title(value: string) {
		this.titleValue = value;
		void this.bridge.request('webviewView.setTitle', [this.viewType, value]);
	}

	get description(): string | undefined {
		return this.descriptionValue;
	}

	set description(value: string | undefined) {
		this.descriptionValue = value ?? '';
		void this.bridge.request('webviewView.setDescription', [this.viewType, this.descriptionValue]);
	}

	get visible(): boolean {
		return this.visibleValue;
	}

	/** The badge is an inert setter-accepting field: the sidebar sections do not render one. */
	badge: { text: string; tooltip?: string; command?: string } | undefined;

	readonly onDidChangeVisibility = this.visibilityChanged.event;

	/** VS Code's WebviewView carries it like a panel does; a provider that wires its cleanup
	 *  here (Claude Code's sessions list) threw "not a callable function" without it. */
	readonly onDidDispose = this.disposed.event;

	show(): void {
		// The section lives in the sidebar already; VS Code's show reveals it there.
		void this.bridge.request('webviewView.show', [this.viewType]);
	}

	dispose(): void {
		if (this.gone) return;
		this.gone = true;
		void this.bridge.request('webviewView.dispose', [this.viewType]);
		this.disposed.fire();
		this.messages.dispose();
		this.visibilityChanged.dispose();
		this.disposed.dispose();
	}

	/** The host pushed the view's visibility (its sidebar section selected or not). */
	setVisible(visible: boolean): void {
		if (this.visibleValue === visible) return;
		this.visibleValue = visible;
		this.visibilityChanged.fire({ visible });
	}

	receive(message: unknown): void {
		if (!this.gone) this.messages.fire(message);
	}
}

/** A status bar item the extension owns: field writes post to the host, which renders. */
class StatusBarItem {
	private textValue = '';
	private tooltipValue: string | { value?: string } | undefined;
	private commandValue: string | { command: string; title?: string; arguments?: unknown[] } | undefined;
	private visible = false;
	private nameValue: string | undefined;
	private colorValue: string | ThemeColor | undefined;
	private backgroundValue: ThemeColor | undefined;
	accessibilityInformation: { label: string; role?: string } | undefined;

	constructor(private readonly bridge: HostBridge, readonly id: string, readonly alignment: StatusBarAlignment, readonly priority?: number) {}

	get color(): string | ThemeColor | undefined {
		return this.colorValue;
	}

	set color(value: string | ThemeColor | undefined) {
		this.colorValue = value;
		this.push();
	}

	get backgroundColor(): ThemeColor | undefined {
		return this.backgroundValue;
	}

	set backgroundColor(value: ThemeColor | undefined) {
		this.backgroundValue = value;
		this.push();
	}

	get text(): string {
		return this.textValue;
	}

	set text(value: string) {
		this.textValue = value;
		this.push();
	}

	get tooltip(): string | { value?: string } | undefined {
		return this.tooltipValue;
	}

	set tooltip(value: string | { value?: string } | undefined) {
		this.tooltipValue = value;
		this.push();
	}

	/** A command id or VS Code's `Command` object (`{ command, arguments }`). */
	get command(): string | { command: string; title?: string; arguments?: unknown[] } | undefined {
		return this.commandValue;
	}

	set command(value: string | { command: string; title?: string; arguments?: unknown[] } | undefined) {
		this.commandValue = value;
		this.push();
	}

	get name(): string | undefined {
		return this.nameValue;
	}

	set name(value: string | undefined) {
		this.nameValue = value;
		this.push();
	}

	show(): void {
		this.visible = true;
		this.push();
	}

	hide(): void {
		this.visible = false;
		this.push();
	}

	dispose(): void {
		void this.bridge.request('statusbar.dispose', [this.id]);
	}

	private push(): void {
		const tooltip = typeof this.tooltipValue === 'string' ? this.tooltipValue : this.tooltipValue?.value ?? '';
		const command = typeof this.commandValue === 'string' ? this.commandValue : this.commandValue?.command;
		const commandArgs = typeof this.commandValue === 'object' ? (this.commandValue.arguments ?? []) : undefined;
		const color = typeof this.colorValue === 'string' ? this.colorValue : this.colorValue?.id;
		void this.bridge.request('statusbar.set', [this.id, { alignment: this.alignment, priority: this.priority, text: this.textValue, tooltip, command, commandArgs, color, backgroundColor: this.backgroundValue?.id, visible: this.visible }]);
	}
}

/** A tree data provider as VS Code spells it: children on demand, an item per element, a
 *  change event that re-reads whatever is on screen. */
export interface TreeDataProvider<T> {
	getChildren(element?: T): T[] | PromiseLike<T[]>;
	getTreeItem(element: T): { label: string | { label: string; highlights?: [number, number][] }; description?: string; tooltip?: string | undefined; iconPath?: string | { light?: string; dark?: string }; collapsibleState?: number; command?: { command: string; title?: string; arguments?: unknown[] } } | PromiseLike<Record<string, unknown>>;
	onDidChangeTreeData?: (listener: (element: T | undefined | null) => void) => Disposable;
	getParent?(element: T): T | undefined;
}

/** An icon path (string, Uri, light/dark pair) as the path the host resolves: an
 *  extension-relative or absolute file path. */
function iconPathText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (value instanceof Uri) return value.fsPath;
	if (value !== null && typeof value === 'object') {
		const pair = value as { light?: unknown; dark?: unknown; fsPath?: unknown };
		if (typeof pair.fsPath === 'string') return pair.fsPath;
		return iconPathText(pair.dark) ?? iconPathText(pair.light);
	}
	return undefined;
}

/** One `TreeItem` as plain data for the sidebar: the label (or the resource's file name),
 *  a codicon for a ThemeIcon or a file path for an image, the contextValue the
 *  `view/item/context` menus match on, the checkbox and the command with its arguments. */
function serializeTreeItem(handle: string, raw: Record<string, unknown>): Record<string, unknown> {
	const resourceUri = raw.resourceUri as Uri | undefined;
	const rawLabel = raw.label as string | { label?: string } | undefined;
	const label = typeof rawLabel === 'string' ? rawLabel : rawLabel?.label ?? (resourceUri ? resourceUri.path.split('/').pop() ?? '' : '');
	const icon = raw.iconPath;
	const themeIcon = icon instanceof ThemeIcon || (icon !== null && typeof icon === 'object' && typeof (icon as { id?: unknown }).id === 'string' && !('light' in (icon as object))) ? (icon as ThemeIcon).id : undefined;
	const tooltip = raw.tooltip as string | { value?: string } | undefined;
	const checkbox = raw.checkboxState as number | { state?: number } | undefined;
	const description = raw.description === true && resourceUri ? resourceUri.fsPath : typeof raw.description === 'string' ? raw.description : undefined;
	return {
		handle,
		id: typeof raw.id === 'string' ? raw.id : undefined,
		label,
		description,
		tooltip: typeof tooltip === 'string' ? tooltip : tooltip?.value,
		// The extension-relative path crosses the wire; the host resolves it into a data
		// URL before the sidebar renders (the field stays `iconUrl` end to end).
		iconUrl: themeIcon === undefined ? iconPathText(icon) : undefined,
		codicon: themeIcon,
		contextValue: typeof raw.contextValue === 'string' ? raw.contextValue : undefined,
		resourcePath: resourceUri?.fsPath,
		checkbox: checkbox === undefined ? undefined : typeof checkbox === 'number' ? checkbox : checkbox.state,
		collapsibleState: typeof raw.collapsibleState === 'number' ? raw.collapsibleState : 0,
		command: raw.command as { command: string; title?: string; arguments?: unknown[] } | undefined
	};
}

/** One registered tree view: the provider, its element handles (host calls walk by handle),
 *  and the visibility events the host pushes. */
class TreeViewRegistration {
	visible = false;
	/** Handle -> element, and back: an element keeps its handle across refreshes (keyed by
	 *  its TreeItem id when it has one), so the host's expansion state survives a refresh
	 *  and the maps do not grow with every re-fetch. */
	readonly handles = new Map<string, unknown>();
	private readonly handleOf = new Map<unknown, string>();
	private nextHandle = 1;
	selection: unknown[] = [];
	readonly visibilityChanged = new EventEmitter<{ visible: boolean }>();
	readonly selectionChanged = new EventEmitter<{ selection: unknown[] }>();
	readonly expanded = new EventEmitter<{ element: unknown }>();
	readonly collapsed = new EventEmitter<{ element: unknown }>();
	readonly checkboxChanged = new EventEmitter<{ items: [unknown, number][] }>();

	constructor(readonly viewId: string, private readonly provider: TreeDataProvider<unknown>, private readonly bridge: HostBridge) {
		void Promise.resolve(bridge.request('treeView.register', [viewId])).catch((error) => shimLog('warn', `tree view ${viewId}: register failed: ${String(error)}`));
		provider.onDidChangeTreeData?.(() => void Promise.resolve(bridge.request('treeView.changed', [viewId])).catch(() => undefined));
	}

	/** The host asks for one level's children: elements become handles, `getTreeItem`
	 *  serializes each, and the list crosses as plain JSON. */
	async children(parent: string | null): Promise<unknown[]> {
		const element = parent === null ? undefined : this.handles.get(parent);
		const children = await Promise.resolve(this.provider.getChildren(element));
		const items: unknown[] = [];
		for (const child of children ?? []) {
			const raw = await Promise.resolve(this.provider.getTreeItem(child) as Promise<Record<string, unknown>>);
			const key = typeof raw?.id === 'string' ? `id:${raw.id}` : child;
			let handle = this.handleOf.get(key);
			if (handle === undefined) {
				handle = String(this.nextHandle++);
				this.handleOf.set(key, handle);
			}
			this.handles.set(handle, child);
			items.push(serializeTreeItem(handle, raw ?? {}));
		}
		return items;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.visibilityChanged.fire({ visible });
	}

	/** The user selected rows (the host pushes their handles). */
	select(handles: string[]): void {
		this.selection = handles.map((handle) => this.handles.get(handle)).filter((element) => element !== undefined);
		this.selectionChanged.fire({ selection: this.selection });
	}

	/** A row was expanded or collapsed in the sidebar. */
	expand(handle: string, expanded: boolean): void {
		const element = this.handles.get(handle);
		if (element === undefined) return;
		(expanded ? this.expanded : this.collapsed).fire({ element });
	}

	/** A row's checkbox was toggled. */
	check(handle: string, state: number): void {
		const element = this.handles.get(handle);
		if (element !== undefined) this.checkboxChanged.fire({ items: [[element, state]] });
	}
}

/* ---------- The API ---------- */

/** A registration this host accepts but cannot serve: noted once on the console, inert from
 *  there — VS Code ignores what it does not know, and an activation that reaches for a
 *  surface this host lacks must survive to run everything else it registered. */
function inert(name: string): Disposable {
	shimLogOnce(`inert:${name}`, 'warn', `unsupported API ${name}: the registration is accepted but this host does not serve it`);
	return new Disposable(() => undefined);
}

/** The Test API's item and collection shapes: a package's tree stores real items (VS Code's
 *  TestItem is a plain mutable value), the collection iterates like Node's maps. */
export class TestTag {
	constructor(public id: string) {}
}
export class TestMessage {
	output?: string;
	expectedOutput?: string;
	actualOutput?: string;
	location?: Location;
	static output(value: string): TestMessage {
		const message = new TestMessage(value);
		message.output = value;
		return message;
	}
	constructor(public message?: string | unknown) {}
}
export class TestRunRequest {
	constructor(public include?: unknown[] | undefined, public exclude?: unknown[] | undefined, public profile?: unknown, public continuous?: boolean) {}
}
function makeTestItem(id: string, label: string, uri?: Uri, parent?: unknown): Record<string, unknown> {
	const children = new Map<string, unknown>();
	const item: Record<string, unknown> = {
		id,
		label,
		uri,
		parent,
		tags: [] as unknown[],
		sortText: undefined,
		description: undefined,
		detail: undefined,
		error: undefined,
		busy: false,
		range: undefined,
		canResolveChildren: false,
		invalidateResults: () => undefined
	};
	item.children = makeTestItemCollection(children);
	return item;
}
function makeTestItemCollection(items: Map<string, unknown>): Record<string, unknown> {
	const collection: Record<string, unknown> = {
		add: (item: { id: string }) => {
			items.set(item.id, item);
			return item;
		},
		delete: (id: string) => {
			items.delete(id);
		},
		get: (id: string) => items.get(id),
		replace: (descriptions: unknown[]) => {
			items.clear();
			for (const description of descriptions) {
				const item = description as { id: string };
				items.set(item.id, item);
			}
		},
		forEach: (callback: (item: unknown, collection: unknown) => void) => {
			for (const item of [...items.values()]) callback(item, collection);
		},
		get size() {
			return items.size;
		},
		toJSON: () => [...items.values()]
	};
	(collection as unknown as { [Symbol.iterator]: () => IterableIterator<unknown> })[Symbol.iterator] = function* () {
		yield* items.values();
	};
	return collection;
}

/** A document the shim knows the text of: the active editor's (pushed by the host),
 *  one `openTextDocument` read, or an in-memory `{ content }` document. */
interface DocumentState {
	path: string;
	uri: Uri;
	text: string;
	languageId: string;
	version: number;
}

/** The key the shim's document table uses: slashes unified, the drive letter lowercased
 *  (Windows paths are case-insensitive there, and the host's and the extension's
 *  spellings of one file must meet). */
function documentKey(path: string): string {
	return path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_all, drive: string) => `${drive.toLowerCase()}:`);
}

/** Is `path` the folder itself or inside it (a separator boundary, not a name prefix)? */
function isInsideFolder(path: string, folder: string): boolean {
	const child = documentKey(path).toLowerCase().replace(/\/+$/, '');
	const parent = documentKey(folder).toLowerCase().replace(/\/+$/, '');
	return child === parent || child.startsWith(`${parent}/`);
}

/** A `vscode.TextDocument` over a text snapshot — line / offset / word arithmetic on the
 *  held text, VS Code's zero-based lines and characters, `\r\n` counted as one break. */
function documentView(state: DocumentState, save: () => Promise<boolean>): Record<string, unknown> {
	const text = state.text;
	const lines = text.split('\n');
	const lineText = (index: number) => lines[index]!.replace(/\r$/, '');
	const clampPosition = (position?: { line: number; character: number }): Position => {
		const line = Math.max(0, Math.min(Number(position?.line) || 0, lines.length - 1));
		const character = Math.max(0, Math.min(Number(position?.character) || 0, lineText(line).length));
		return new Position(line, character);
	};
	const offsetAt = (position: { line: number; character: number }): number => {
		const clamped = clampPosition(position);
		let offset = 0;
		for (let index = 0; index < clamped.line; index += 1) offset += lines[index]!.length + 1;
		return offset + clamped.character;
	};
	const positionAt = (offset: number): Position => {
		let remaining = Math.max(0, Math.min(Number(offset) || 0, text.length));
		for (let index = 0; index < lines.length; index += 1) {
			const length = lines[index]!.length;
			if (remaining <= length) return new Position(index, Math.min(remaining, lineText(index).length));
			remaining -= length + 1;
		}
		return new Position(lines.length - 1, lineText(lines.length - 1).length);
	};
	const lineAt = (lineOrPosition: number | { line: number }) => {
		const requested = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
		const index = Math.max(0, Math.min(Number(requested) || 0, lines.length - 1));
		const content = lineText(index);
		return {
			lineNumber: index,
			text: content,
			range: new Range(index, 0, index, content.length),
			rangeIncludingLineBreak: index < lines.length - 1 ? new Range(index, 0, index + 1, 0) : new Range(index, 0, index, content.length),
			firstNonWhitespaceCharacterIndex: content.search(/\S|$/),
			isEmptyOrWhitespace: content.trim().length === 0
		};
	};
	return {
		uri: state.uri,
		fileName: state.uri.scheme === 'file' ? state.uri.fsPath : state.path,
		languageId: state.languageId,
		version: state.version,
		isDirty: false,
		isUntitled: state.uri.scheme === 'untitled',
		isClosed: false,
		eol: text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF,
		encoding: 'utf8',
		lineCount: lines.length,
		getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) =>
			range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
		positionAt,
		offsetAt,
		lineAt,
		validatePosition: clampPosition,
		validateRange: (range?: { start?: { line: number; character: number }; end?: { line: number; character: number } }) =>
			new Range(clampPosition(range?.start), clampPosition(range?.end)),
		getWordRangeAtPosition: (position: { line: number; character: number }, regex?: RegExp) => {
			const at = clampPosition(position);
			const content = lineText(at.line);
			const pattern = new RegExp((regex ?? /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g).source, 'g');
			for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
				if (match[0].length === 0) {
					pattern.lastIndex += 1;
					continue;
				}
				if (match.index <= at.character && match.index + match[0].length >= at.character) return new Range(at.line, match.index, at.line, match.index + match[0].length);
			}
			return undefined;
		},
		save
	};
}

export function createVscodeApi(ctx: HostContext, bridge: HostBridge) {
	// The host's platform spells `Uri.fsPath`; the log threshold filters here, before a
	// line costs a bridge crossing; anomalies go to the host's extension-host log.
	setUriPlatform(ctx.platform);
	if (ctx.logLevel !== undefined && ctx.logLevel in LOG_RANK) shimLogThreshold = ctx.logLevel;
	// One API per extension context: its "logged once" notices start fresh.
	shimLoggedOnce.clear();
	shimLogSink = (level, message, detail) => {
		try {
			void Promise.resolve(bridge.request('log', [level, message, detail ?? null])).catch(() => console.warn(`[ggs-ext] ${message}`));
		} catch {
			console.warn(`[ggs-ext] ${message}`);
		}
	};
	/** A fire-and-forget host request whose failure is logged, never an unhandled rejection. */
	const send = (method: string, args: unknown[]): void => {
		try {
			void Promise.resolve(bridge.request(method, args)).catch((error) => shimLog('warn', `host request ${method} failed: ${String(error)}`, error));
		} catch (error) {
			shimLog('warn', `host request ${method} failed: ${String(error)}`, error);
		}
	};
	/** An unsupported surface was used (not just registered): one warning per name. */
	const unsupported = (name: string, what = 'is not supported by this host'): void => {
		shimLogOnce(`unsupported:${name}`, 'warn', `unsupported API ${name}: ${what}`);
	};
	const isZh = /^zh/i.test(ctx.language);

	/** The webview panels this frame created, by panel id (host events route through them). */
	const webviewPanels = new Map<number, WebviewPanel>();
	/** The webview views this frame registered, by view id (`registerWebviewViewProvider`). */
	const webviewViews = new Map<string, WebviewView>();
	/** The providers behind them, by view id (resolved at the view's first show). */
	const webviewViewProviders = new Map<string, { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }>();
	const globalState = new Memento(ctx, bridge, 'global');
	const workspaceState = new Memento(ctx, bridge, 'workspace');
	let webviewSeq = 0;
	let statusSeq = 0;
	let untitledSeq = 0;
	/** Set below the literal — the literal's `handleHostEvent` forwards into it. */
	let dispatchHostEvent: (event: HostEvent) => void = () => undefined;
	const workspaceFoldersChanged = new EventEmitter<{ added: unknown[]; removed: unknown[] }>();
	const configurationChanged = new EventEmitter<ConfigurationChangeEvent>();
	const documentSaved = new EventEmitter<Record<string, unknown>>();
	const documentChanged = new EventEmitter<{ document: Record<string, unknown>; contentChanges: unknown[]; reason: undefined }>();
	const documentOpened = new EventEmitter<Record<string, unknown>>();
	const documentClosed = new EventEmitter<Record<string, unknown>>();
	/** The host's watcher batches — what `createFileSystemWatcher` serves its events from. */
	const fsChanged = new EventEmitter<{ root: string; paths: string[]; gitChanged: boolean; truncated: boolean }>();
	const activeEditorChangedEmitter = new EventEmitter<unknown>();
	const visibleEditorsChanged = new EventEmitter<unknown[]>();
	const selectionChanged = new EventEmitter<{ textEditor: unknown; selections: unknown[]; kind?: number }>();
	const themeChangedEmitter = new EventEmitter<unknown>();
	/** The diagnostics registry: every `createDiagnosticCollection` stores here, so
	 *  `languages.getDiagnostics` aggregates and `onDidChangeDiagnostics` fires for real. */
	const diagnosticCollections = new Set<Map<string, { uri: Uri; diagnostics: unknown[] }>>();
	const diagnosticsChanged = new EventEmitter<{ uris: Uri[] }>();
	/** The host's view of the active text editor, as the last `activeEditorChanged` push left
	 *  it (text rides along whenever the document itself changed). */
	let activeEditor: HostEvent['editor'] = null;
	/** The documents whose text the shim holds, by `documentKey`. A document "opens" once
	 *  per session — and only with its text in hand: the first active-editor push for a file
	 *  can race the text load, and a didOpen with an empty body makes a language server
	 *  analyse nothing (cspell's squiggles never arrived that way). */
	const documents = new Map<string, DocumentState>();
	/** The live workspace folders (the host pushes changes). */
	let workspaceFolders = ctx.workspaceFolders.map((folder) => ({ ...folder, uri: folder.uri instanceof Uri ? folder.uri : Uri.file(pathOf(folder.uri)) }));
	/** The theme kind as the context carried it in / the last themeChanged push left it. */
	let themeKind = ctx.themeKind ?? 2;
	/** The tree views this frame registered, by view id (host calls and events route through). */
	const treeRegistrations = new Map<string, TreeViewRegistration>();
	/** Document formatting providers this frame registered, by id — the host routes
	 *  `editor.formatDocument` to whichever one matches the document's language. */
	const formattingProviders = new Map<string, {
		selectors: unknown[];
		run: (document: Record<string, unknown>, options: unknown, token: CancellationToken) => unknown;
	}>();
	let formatterSeq = 0;
	/** GGS-patch: the registered completion providers (see registerCompletionItemProvider). */
	const completionProviders = new Map<string, {
		selectors: unknown[];
		triggerCharacters: string[];
		run: (document: unknown, position: unknown, token: unknown, context: unknown) => unknown;
	}>();
	/** GGS-patch: the registered hover and definition providers (see editorHovers.ts). */
	const hoverProviders = new Map<string, {
		selectors: unknown[];
		run: (document: unknown, position: unknown, token: unknown) => unknown;
	}>();
	const definitionProviders = new Map<string, {
		selectors: unknown[];
		run: (document: unknown, position: unknown, token: unknown) => unknown;
	}>();
	/** GGS-patch: the registered file decoration providers (see explorerDecorations.ts). */
	const fileDecorationProviders = new Map<string, {
		label: string;
		run: (uri: unknown, token: unknown) => unknown;
	}>();

	/** The document table entry for a path (created on first sight when `text` is given). */
	function rememberDocument(path: string, text: string, languageId: string, uri?: Uri): { state: DocumentState; opened: boolean; changed: boolean; previous: string } {
		const key = documentKey(path);
		const existing = documents.get(key);
		if (existing) {
			const previous = existing.text;
			const changed = previous !== text;
			if (changed) {
				existing.text = text;
				existing.version += 1;
			}
			if (languageId) existing.languageId = languageId;
			return { state: existing, opened: false, changed, previous };
		}
		const state: DocumentState = { path, uri: uri ?? Uri.file(path), text, languageId: languageId || 'plaintext', version: 1 };
		documents.set(key, state);
		return { state, opened: true, changed: false, previous: text };
	}

	function saveDocument(path: string): Promise<boolean> {
		return Promise.resolve(bridge.request('editor.save', [path])).then((saved) => saved === true, (error) => {
			shimLog('warn', `TextDocument.save(${path}) failed: ${String(error)}`, error);
			return false;
		});
	}

	/** A TextDocument for a path, from the shim's last knowledge of its text. */
	function makeTextDocument(path: string): Record<string, unknown> {
		const state = documents.get(documentKey(path)) ?? {
			path,
			uri: Uri.file(path),
			text: activeEditor?.path === path ? activeEditor.text ?? '' : '',
			languageId: activeEditor?.path === path ? activeEditor.languageId : '',
			version: 1
		};
		return documentView(state, () => saveDocument(state.path));
	}

	/** Translate a tree-item marker (a `view/item/context` menu's argument) back into the
	 *  element the provider returned — the element never crosses the frame boundary. */
	function resolveTreeArgs(args: unknown[]): unknown[] {
		return args.map((arg) => {
			const marker = arg as { $treeViewId?: unknown; $treeItemHandle?: unknown } | null;
			if (marker === null || typeof marker !== 'object' || typeof marker.$treeViewId !== 'string' || typeof marker.$treeItemHandle !== 'string') return arg;
			return treeRegistrations.get(marker.$treeViewId)?.handles.get(marker.$treeItemHandle) ?? arg;
		});
	}

	function registerTree(viewId: string, provider: TreeDataProvider<unknown>): TreeViewRegistration {
		const existing = treeRegistrations.get(viewId);
		if (existing) return existing; // re-registering the same id keeps the first provider
		const registration = new TreeViewRegistration(viewId, provider, bridge);
		treeRegistrations.set(viewId, registration);
		return registration;
	}

	/** `showXMessage(message, ...items)` accepts strings or `{title}` items, with an optional
	 *  leading MessageOptions object; the picked entry comes back in the shape it was given. */
	function showMessage(kind: 'info' | 'warning' | 'error', message: string, ...rest: unknown[]): Promise<string | MessageItem | undefined> {
		const items = rest.filter((item): item is string | MessageItem => item !== undefined && item !== null && (typeof item === 'string' || typeof (item as MessageItem).title === 'string'));
		const options = rest[0] !== null && typeof rest[0] === 'object' && typeof (rest[0] as MessageItem).title !== 'string' ? rest[0] as { modal?: boolean; detail?: string } : undefined;
		const text = options?.detail ? `${message} — ${options.detail}` : message;
		return Promise.resolve(bridge.request('notify', [kind, text, items.map((item) => (typeof item === 'string' ? item : item.title))])).then((picked) => {
			const title = picked as string | undefined;
			if (title === undefined || title === null) return undefined;
			return items.find((candidate) => (typeof candidate === 'string' ? candidate === title : candidate.title === title)) ?? undefined;
		}) as Promise<string | MessageItem | undefined>;
	}

	type PickEntry = { id: string; label: string; description?: string; detail?: string; picked?: boolean; item: unknown };

	/** The picker entries for a quick pick's items (separators dropped: the host list has
	 *  no separator rows), each with a stable id so duplicate labels stay distinct. */
	function pickEntries(items: unknown[]): PickEntry[] {
		return items
			.filter((item) => typeof item === 'string' || (item !== null && typeof item === 'object' && (item as { kind?: number }).kind !== QuickPickItemKind.Separator))
			.map((item, index) => typeof item === 'string'
				? { id: String(index), label: item, item }
				: { id: String(index), label: String((item as QuickPickItem).label ?? ''), description: (item as QuickPickItem).description, detail: (item as QuickPickItem).detail, picked: (item as QuickPickItem).picked, item });
	}

	/** The picked entry of one host pick (by id; an older host answers the label). */
	function entryFor(entries: PickEntry[], answer: unknown): PickEntry | undefined {
		if (answer === undefined || answer === null) return undefined;
		return entries.find((entry) => entry.id === answer) ?? entries.find((entry) => entry.label === answer);
	}

	/** One single-choice pick through the host's quick input. */
	async function pickOne(entries: PickEntry[], placeholder: string): Promise<PickEntry | undefined> {
		const answer = await bridge.request('showQuickPick', [entries.map(({ id, label, description, detail }) => ({ id, label, description, detail })), placeholder]);
		return entryFor(entries, answer);
	}

	/** A multi-select pick: the host's quick input has no checkboxes, so each round toggles
	 *  one item (the list shows ☑/☐) until the user takes the OK row or dismisses. */
	async function pickMany(entries: PickEntry[], placeholder: string): Promise<PickEntry[] | undefined> {
		const chosen = new Set(entries.filter((entry) => entry.picked).map((entry) => entry.id));
		const done = { id: '__ggs_done', label: isZh ? '✔ 确定' : '✔ OK' };
		for (;;) {
			const rows = [done, ...entries.map((entry) => ({ id: entry.id, label: `${chosen.has(entry.id) ? '☑' : '☐'} ${entry.label}`, description: entry.description, detail: entry.detail }))];
			const answer = await bridge.request('showQuickPick', [rows, placeholder]);
			if (answer === undefined || answer === null) return undefined;
			if (answer === done.id || answer === done.label) return entries.filter((entry) => chosen.has(entry.id));
			const row = rows.find((candidate) => candidate.id === answer || candidate.label === answer);
			if (!row) return undefined;
			if (chosen.has(row.id)) chosen.delete(row.id);
			else chosen.add(row.id);
		}
	}

	/** `window.showQuickPick`: string or object items (or a promise of them); single or
	 *  multi-select; `onDidSelectItem` fires for the pick. */
	async function showQuickPick(items: unknown, options?: { placeHolder?: string; title?: string; canPickMany?: boolean; onDidSelectItem?: (item: unknown) => unknown }, _token?: CancellationToken): Promise<unknown> {
		const list = await Promise.resolve(items as unknown[] | PromiseLike<unknown[]>);
		const entries = pickEntries(Array.isArray(list) ? list : [list]);
		const placeholder = options?.placeHolder ?? options?.title ?? '';
		if (options?.canPickMany) {
			const picked = await pickMany(entries, placeholder);
			return picked?.map((entry) => entry.item);
		}
		const picked = await pickOne(entries, placeholder);
		if (picked && options?.onDidSelectItem) guarded('showQuickPick onDidSelectItem', () => options.onDidSelectItem!(picked.item));
		return picked?.item;
	}

	/** `window.showInputBox`: the host prompt, re-asked with the message while
	 *  `validateInput` (sync or async) rejects the value. */
	async function showInputBox(options: { prompt?: string; value?: string; placeHolder?: string; password?: boolean; title?: string; validateInput?: (value: string) => unknown } = {}): Promise<string | undefined> {
		let value = options.value ?? '';
		let prompt = options.prompt ?? options.title ?? '';
		for (;;) {
			const answer = await bridge.request('showInputBox', [prompt, value, { placeHolder: options.placeHolder, password: options.password === true }]);
			if (answer === undefined || answer === null) return undefined;
			const text = String(answer);
			if (!options.validateInput) return text;
			const verdict = await Promise.resolve(guarded('showInputBox validateInput', () => options.validateInput!(text)));
			const message = typeof verdict === 'string' ? verdict : (verdict as { message?: string; severity?: number } | null | undefined)?.message;
			const severity = typeof verdict === 'object' && verdict !== null ? (verdict as { severity?: number }).severity : InputBoxValidationSeverity.Error;
			if (!message || severity === InputBoxValidationSeverity.Info || severity === InputBoxValidationSeverity.Warning) return text;
			value = text;
			prompt = `${options.prompt ?? options.title ?? ''}${options.prompt || options.title ? ' — ' : ''}${message}`;
		}
	}

	/** `window.createQuickPick()`: the object form — items (often filled after `show()`,
	 *  with `busy` set meanwhile), selection and the accept / hide events. The host's
	 *  quick input is modal, so `show()` opens it once the items are in hand. */
	function createQuickPick(): Record<string, unknown> {
		const accept = new EventEmitter<void>();
		const hide = new EventEmitter<void>();
		const selection = new EventEmitter<unknown[]>();
		const active = new EventEmitter<unknown[]>();
		const valueChanged = new EventEmitter<string>();
		let items: unknown[] = [];
		let itemsArrived: (() => void) | null = null;
		let open = false;
		const pick: Record<string, unknown> = {
			title: undefined, step: undefined, totalSteps: undefined, enabled: true, busy: false,
			ignoreFocusOut: false, placeholder: undefined, canSelectMany: false, matchOnDescription: false,
			matchOnDetail: false, keepScrollPosition: false, value: '', buttons: [], selectedItems: [], activeItems: [],
			get items() {
				return items;
			},
			set items(value: unknown[]) {
				items = value ?? [];
				itemsArrived?.();
				itemsArrived = null;
			},
			onDidAccept: accept.event,
			onDidHide: hide.event,
			onDidChangeSelection: selection.event,
			onDidChangeActive: active.event,
			onDidChangeValue: valueChanged.event,
			onDidTriggerButton: silentEvent(),
			onDidTriggerItemButton: silentEvent(),
			show: () => {
				if (open) return;
				open = true;
				setTimeout(async () => {
					// Wait (bounded) for the items a busy pick is still loading.
					if (items.length === 0) await new Promise<void>((resolve) => {
						itemsArrived = resolve;
						setTimeout(resolve, 15000);
					});
					if (!open) return;
					const entries = pickEntries(items);
					const placeholder = String(pick.placeholder ?? pick.title ?? '');
					const picked = pick.canSelectMany ? await pickMany(entries, placeholder) : await pickOne(entries, placeholder).then((entry) => (entry ? [entry] : undefined));
					if (!open) return;
					if (picked === undefined) {
						open = false;
						hide.fire(undefined);
						return;
					}
					pick.selectedItems = picked.map((entry) => entry.item);
					pick.activeItems = pick.selectedItems;
					active.fire(pick.activeItems as unknown[]);
					selection.fire(pick.selectedItems as unknown[]);
					accept.fire(undefined);
				}, 0);
			},
			hide: () => {
				if (!open) return;
				open = false;
				hide.fire(undefined);
			},
			dispose: () => {
				open = false;
				accept.dispose();
				hide.dispose();
				selection.dispose();
				active.dispose();
				valueChanged.dispose();
			}
		};
		return pick;
	}

	/** `window.createInputBox()`: the object form over the same host prompt. */
	function createInputBox(): Record<string, unknown> {
		const accept = new EventEmitter<void>();
		const hide = new EventEmitter<void>();
		const valueChanged = new EventEmitter<string>();
		let open = false;
		const box: Record<string, unknown> = {
			title: undefined, step: undefined, totalSteps: undefined, enabled: true, busy: false, ignoreFocusOut: false,
			value: '', valueSelection: undefined, placeholder: undefined, password: false, prompt: undefined,
			validationMessage: undefined, buttons: [],
			onDidAccept: accept.event,
			onDidHide: hide.event,
			onDidChangeValue: valueChanged.event,
			onDidTriggerButton: silentEvent(),
			show: () => {
				if (open) return;
				open = true;
				setTimeout(async () => {
					const answer = await bridge.request('showInputBox', [String(box.prompt ?? box.title ?? ''), String(box.value ?? ''), { placeHolder: box.placeholder, password: box.password === true }]);
					if (!open) return;
					if (answer === undefined || answer === null) {
						open = false;
						hide.fire(undefined);
						return;
					}
					box.value = String(answer);
					valueChanged.fire(box.value as string);
					accept.fire(undefined);
				}, 0);
			},
			hide: () => {
				if (!open) return;
				open = false;
				hide.fire(undefined);
			},
			dispose: () => {
				open = false;
				accept.dispose();
				hide.dispose();
				valueChanged.dispose();
			}
		};
		return box;
	}

	/** The selection the host pushed for the active editor: an anchor/active pair on one
	 *  line (the host reports the cursor and how many characters are selected). */
	function hostSelection(): Selection {
		const line = Math.max(1, activeEditor?.line ?? 1);
		const column = Math.max(1, activeEditor?.column ?? 1);
		return new Selection(line - 1, column - 1, line - 1, column - 1 + (activeEditor?.selected ?? 0));
	}

	/** Serialize an edit batch for the host applier (1-based lines, 0-based characters). */
	function serializeEdits(edits: readonly unknown[]): SerializableTextEdit[] {
		const out: SerializableTextEdit[] = [];
		for (const raw of edits) {
			if (raw === null || typeof raw !== 'object') continue;
			const edit = raw as { startLine?: number; range?: { start: { line: number; character: number }; end: { line: number; character: number } }; newText?: string; snippet?: SnippetString | { value?: string } };
			if (typeof edit.startLine === 'number') {
				out.push(raw as SerializableTextEdit);
				continue;
			}
			if (!edit.range) continue;
			const newText = edit.snippet !== undefined ? snippetPlainText(String(edit.snippet.value ?? '')) : String(edit.newText ?? '');
			out.push({ startLine: edit.range.start.line + 1, startCharacter: edit.range.start.character, endLine: edit.range.end.line + 1, endCharacter: edit.range.end.character, newText });
		}
		return out;
	}

	/** An edit builder (`TextEditor.edit` / `registerTextEditorCommand`) collecting edits. */
	function editBuilder(edits: SerializableTextEdit[]) {
		const push = (start: { line: number; character: number }, end: { line: number; character: number }, newText: string) => edits.push({ startLine: start.line + 1, startCharacter: start.character, endLine: end.line + 1, endCharacter: end.character, newText });
		return {
			replace: (location: Range | Position, newText: string) => (location instanceof Range || Range.isRange(location) ? push((location as Range).start, (location as Range).end, newText) : push(location as Position, location as Position, newText)),
			insert: (position: Position, newText: string) => push(position, position, newText),
			delete: (range: Range) => push(range.start, range.end, ''),
			setEndOfLine: (_eol: EndOfLine) => unsupported('TextEditorEdit.setEndOfLine', 'the line endings are kept')
		};
	}

	/** A TextEditor for a path: its document from the shim's table, its selection from the
	 *  host's active-editor push (when it is the active one), its edits through the host's
	 *  open-editor applier. */
	function makeTextEditorProxy(path = activeEditor?.path ?? ''): Record<string, unknown> {
		const isActive = () => activeEditor?.path === path;
		const tabSize = Number(ctx.defaults?.['editor.tabSize'] ?? 4) || 4;
		const applyEdits = (edits: SerializableTextEdit[]) =>
			Promise.resolve(bridge.request('editor.applyEdits', [isActive() ? null : path, edits])).then((applied) => applied === true, (error) => {
				shimLog('warn', `TextEditor edit failed: ${String(error)}`, error);
				return false;
			});
		return {
			get document() {
				return makeTextDocument(path);
			},
			get selection() {
				return isActive() ? hostSelection() : new Selection(0, 0, 0, 0);
			},
			set selection(value: Selection) {
				if (value?.active) send('workspace.openFile', [path, value.active.line + 1, value.active.character + 1]);
			},
			get selections() {
				return [isActive() ? hostSelection() : new Selection(0, 0, 0, 0)];
			},
			set selections(value: Selection[]) {
				const first = value?.[0];
				if (first?.active) send('workspace.openFile', [path, first.active.line + 1, first.active.character + 1]);
			},
			get visibleRanges() {
				const line = Math.max(0, (activeEditor?.line ?? 1) - 1);
				return [new Range(line, 0, line, 0)];
			},
			viewColumn: ViewColumn.One,
			options: { tabSize, insertSpaces: ctx.defaults?.['editor.insertSpaces'] !== false, cursorStyle: TextEditorCursorStyle.Line, lineNumbers: TextEditorLineNumbersStyle.On },
			setDecorations: (decorationType: unknown, rangesOrOptions: unknown) => {
				// GGS-patch: REPLACE the type's ranges on this editor's document (VS Code's
				// semantics; an empty array clears). A null path addresses the active file,
				// the same convention `editor.applyEdits` uses.
				const key = (decorationType as { key?: string } | null | undefined)?.key;
				if (!key) return unsupported('TextEditor.setDecorations', 'the decoration type is not from this host');
				const ranges = plainDecorationRanges(rangesOrOptions);
				void bridge.request('editor.setDecorations', [isActive() ? null : path, key, ranges]).catch(() => undefined);
			},
			revealRange: (range: Range) => {
				if (range?.start) send('workspace.openFile', [path, range.start.line + 1, range.start.character + 1]);
			},
			show: () => send('workspace.openFile', [path]),
			hide: () => unsupported('TextEditor.hide'),
			edit: async (callback: (builder: ReturnType<typeof editBuilder>) => void, _options?: unknown) => {
				const edits: SerializableTextEdit[] = [];
				guarded('TextEditor.edit callback', () => callback(editBuilder(edits)));
				return applyEdits(edits);
			},
			/** A snippet inserts as its plain text (no snippet session with tab stops). */
			insertSnippet: async (snippet: SnippetString | string, location?: Position | Range | readonly (Position | Range)[]) => {
				const text = snippetPlainText(typeof snippet === 'string' ? snippet : snippet.value);
				const targets = location === undefined ? [isActive() ? hostSelection() : new Selection(0, 0, 0, 0)] : Array.isArray(location) ? location : [location];
				const edits: SerializableTextEdit[] = [];
				const builder = editBuilder(edits);
				for (const target of targets as (Position | Range)[]) builder.replace(target, text);
				return applyEdits(edits);
			}
		};
	}

	/** Every document text the host path spelling for `fs.op` / `editor.*` requests. */
	const hostPathOf = (uri: Uri | string): string => (typeof uri === 'string' ? uri : uri.scheme === 'file' ? uri.fsPath : uri.toString());

	/** Map a host fs failure onto VS Code's `FileSystemError` codes (extensions test
	 *  `error.code === 'FileNotFound'`). */
	function fsError(error: unknown, uri: Uri | string): FileSystemError {
		const text = String(error);
		const target = typeof uri === 'string' ? uri : uri.toString();
		if (/not found|cannot find|no such file|os error 2\b|os error 3\b/i.test(text)) return FileSystemError.FileNotFound(target);
		if (/already exists|os error 80\b|os error 183\b/i.test(text)) return FileSystemError.FileExists(target);
		if (/is a directory|os error 21\b/i.test(text)) return FileSystemError.FileIsADirectory(target);
		if (/not a directory|os error 20\b|os error 267\b/i.test(text)) return FileSystemError.FileNotADirectory(target);
		if (/denied|permission|outside the workspace|os error 5\b|os error 13\b/i.test(text)) return FileSystemError.NoPermissions(`${target}: ${text}`);
		return FileSystemError.Unavailable(`${target}: ${text}`);
	}

	const fsOp = async (name: string, uri: Uri | string, to?: Uri | string, data?: string): Promise<unknown> => {
		try {
			return await bridge.request('fs.op', [name, hostPathOf(uri), to === undefined ? undefined : hostPathOf(to), data]);
		} catch (error) {
			const mapped = fsError(error, uri);
			// A missing file is an ordinary answer (extensions probe for configs); anything
			// else is an anomaly worth the log.
			if (mapped.code !== 'FileNotFound') shimLog('warn', `workspace.fs.${name}(${hostPathOf(uri)}) failed: ${String(error)}`);
			throw mapped;
		}
	};

	const fileSystem = {
		readFile: async (uri: Uri | string) => decodeBase64(((await fsOp('read', uri)) as { data: string }).data),
		writeFile: async (uri: Uri | string, content: Uint8Array) => {
			await fsOp('write', uri, undefined, encodeBase64(content instanceof Uint8Array ? content : new Uint8Array(content ?? [])));
		},
		// `access`: F_OK semantics — a readable stat answers, a missing path rejects.
		access: async (uri: Uri | string) => {
			await fsOp('stat', uri);
			return undefined;
		},
		readDirectory: async (uri: Uri | string) => (((await fsOp('list', uri)) as { name: string; kind: number }[]).map((entry) => [entry.name, entry.kind])) as [string, number][],
		createDirectory: (uri: Uri | string) => fsOp('mkdir', uri).then(() => undefined),
		delete: (uri: Uri | string, _options?: { recursive?: boolean; useTrash?: boolean }) => fsOp('delete', uri).then(() => undefined),
		rename: (uri: Uri | string, to: Uri | string, _options?: { overwrite?: boolean }) => fsOp('rename', uri, to).then(() => undefined),
		copy: async (uri: Uri | string, to: Uri | string, _options?: { overwrite?: boolean }) => {
			const data = (await fsOp('read', uri)) as { data: string };
			await fsOp('write', to, undefined, data.data);
		},
		isWritableFileSystem: (scheme: string) => scheme === 'file',
		stat: async (uri: Uri | string) => {
			const stat = (await fsOp('stat', uri)) as { type: number; size: number; mtime: number; ctime?: number };
			return { type: stat.type, ctime: stat.ctime ?? stat.mtime, mtime: stat.mtime, size: stat.size, permissions: undefined };
		}
	};

	/** One WorkspaceEdit (the class, or the plain `{ changes }` / LSP `documentChanges`
	 *  shapes a converted edit arrives in) as an ordered operation list. */
	function workspaceEditOperations(edit: unknown): ({ kind: 'text'; path: string; edits: SerializableTextEdit[] } | { kind: 'create' | 'delete'; path: string; options?: Record<string, unknown> } | { kind: 'rename'; path: string; to: string; options?: Record<string, unknown> })[] {
		const out: ReturnType<typeof workspaceEditOperations> = [];
		const pushText = (path: string, edits: SerializableTextEdit[]) => {
			const last = out[out.length - 1];
			if (last?.kind === 'text' && last.path === path) last.edits.push(...edits);
			else if (edits.length > 0) out.push({ kind: 'text', path, edits });
		};
		const uriPath = (value: unknown): string => {
			if (typeof value === 'string') return hostPathOf(Uri.parse(value));
			return hostPathOf(value instanceof Uri ? value : (rehydrateUris(value) as Uri));
		};
		if (edit instanceof WorkspaceEdit) {
			for (const operation of edit._operations) {
				if (operation.kind === 'text') pushText(hostPathOf(operation.uri), serializeEdits([operation.edit]));
				else if (operation.kind === 'rename') out.push({ kind: 'rename', path: hostPathOf(operation.uri), to: hostPathOf(operation.newUri), options: operation.options });
				else out.push({ kind: operation.kind, path: hostPathOf(operation.uri), options: operation.options as Record<string, unknown> | undefined });
			}
			return out;
		}
		const plain = (edit ?? {}) as { changes?: Record<string, unknown[]>; documentChanges?: unknown[] };
		for (const change of plain.documentChanges ?? []) {
			const entry = change as { textDocument?: { uri?: unknown }; edits?: unknown[]; kind?: string; uri?: unknown; oldUri?: unknown; newUri?: unknown; options?: Record<string, unknown> };
			if (entry.textDocument) pushText(uriPath(entry.textDocument.uri), serializeEdits(entry.edits ?? []));
			else if (entry.kind === 'rename') out.push({ kind: 'rename', path: uriPath(entry.oldUri), to: uriPath(entry.newUri), options: entry.options });
			else if (entry.kind === 'create' || entry.kind === 'delete') out.push({ kind: entry.kind, path: uriPath(entry.uri), options: entry.options });
		}
		for (const [uri, edits] of Object.entries(plain.changes ?? {})) pushText(uriPath(uri), serializeEdits(edits ?? []));
		return out;
	}

	/** `workspace.applyEdit`: every operation in order — open editors take their text edits
	 *  through CodeMirror; closed files are read, spliced and written back through
	 *  `workspace.fs`; file operations run through the same confined filesystem. The answer
	 *  is whether every operation applied (a failure is logged with its cause). */
	async function applyWorkspaceEdit(edit: unknown): Promise<boolean> {
		try {
			for (const operation of workspaceEditOperations(edit)) {
				if (operation.kind === 'text') {
					const applied = await bridge.request('editor.applyEdits', [operation.path, operation.edits]);
					if (applied === true) continue;
					const read = (await fsOp('read', operation.path)) as { data: string };
					const after = applyTextEditsToText(new TextDecoder().decode(decodeBase64(read.data)), operation.edits);
					await fsOp('write', operation.path, undefined, encodeBase64(new TextEncoder().encode(after)));
					const known = documents.get(documentKey(operation.path));
					if (known) rememberDocument(operation.path, after, known.languageId);
				} else if (operation.kind === 'create') {
					const exists = await fsOp('stat', operation.path).then(() => true, () => false);
					if (exists && operation.options?.ignoreIfExists) continue;
					if (exists && !operation.options?.overwrite) throw FileSystemError.FileExists(operation.path);
					const contents = operation.options?.contents instanceof Uint8Array ? operation.options.contents : new Uint8Array();
					await fsOp('write', operation.path, undefined, encodeBase64(contents));
				} else if (operation.kind === 'delete') {
					const exists = await fsOp('stat', operation.path).then(() => true, () => false);
					if (!exists && operation.options?.ignoreIfNotExists) continue;
					await fsOp('delete', operation.path);
				} else if ('to' in operation) {
					await fsOp('rename', operation.path, operation.to);
				}
			}
			return true;
		} catch (error) {
			shimLog('error', `workspace.applyEdit failed: ${String(error)}`, error);
			return false;
		}
	}

	/** The folder list as a WorkspaceFolder array (VS Code answers undefined for none). */
	const foldersOrUndefined = () => (workspaceFolders.length > 0 ? workspaceFolders : undefined);
	const folderFor = (uriOrPath?: Uri | string) => {
		const path = uriOrPath === undefined ? undefined : pathOf(uriOrPath as Uri | string);
		if (path === undefined || path === '') return undefined;
		// The deepest containing folder wins (nested folders in a multi-root workspace).
		return [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length).find((folder) => isInsideFolder(path, folder.uri.fsPath));
	};

	/** A tree view's element's handle as the menu argument marker (see `resolveTreeArgs`). */
	const wrapHandler = (name: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) => (...args: unknown[]) => {
		try {
			return handler.apply(thisArg, resolveTreeArgs(args));
		} catch (error) {
			shimLog('error', `command ${name} threw: ${String(error)}`, error);
			throw error;
		}
	};

	/** The commands this extension registered (`registerCommand`), by full id — the ones
	 *  its own `executeCommand` runs locally. */
	const ownCommands = new Map<string, (...args: unknown[]) => unknown>();

	/** Workbench-side command registrations waiting to cross, flushed as ONE host request:
	 *  each registration is otherwise a full pipe round trip (~2-4 ms), and an activation
	 *  registers dozens (claude-code: 31) — minutes of nothing on a slow disk, a visible
	 *  slice of every activation here. The workbench sees every command the moment the
	 *  queue flushes, which the hosts do as soon as the activation settles
	 *  (`__ggsFlushRegistrations`, called by ggs-node's frame-program installer, the frame
	 *  boot and the real-Node host) and before any `executeCommand`. */
	let pendingCommandRegistrations: string[] = [];
	const flushCommandRegistrations = (): void => {
		const batch = pendingCommandRegistrations;
		pendingCommandRegistrations = [];
		if (batch.length > 0) send('commands.registerBatch', [batch]);
	};
	/** Output-channel lines waiting to cross, for the same reason: an activation logs
	 *  dozens of lines (claude-code: ~15 on activate) and each was its own round trip.
	 *  Flushed by the same activation-settled hook, and before any `show`/`clear` of the
	 *  channel (their order semantics must not jump the queued lines). */
	let pendingOutputLines: [string, string][] = [];
	const flushOutputLines = (): void => {
		const batch = pendingOutputLines;
		pendingOutputLines = [];
		if (batch.length > 0) send('output.appendBatch', [batch]);
	};
	(globalThis as { __ggsFlushRegistrations?: () => void }).__ggsFlushRegistrations = () => {
		flushCommandRegistrations();
		flushOutputLines();
	};

	/** A language-feature provider registration this host has no consumer for. */
	const provider = (name: string) => (..._args: unknown[]) => inert(`languages.${name}`);

	const api = {
		// The API surface this shim targets, spelled the way `vscode.version` spells it:
		// packages version-gate on it (vscode-languageclient refuses a host below its
		// `engines.vscode` floor), so a studio-local suffix would wrongly read as an old host.
		// 1.106 is the release whose layout packages now assume: Claude Code below it pins its
		// chat into the primary sidebar (`doesNotSupportSecondarySidebar`); at it, the sidebar
		// keeps the sessions list and every conversation opens as an editor tab.
		version: '1.106.0',

		commands: {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) => {
				const full = id.includes('.') ? id : `${ctx.extensionId}.${id}`;
				const wrapped = wrapHandler(full, handler, thisArg);
				ownCommands.set(full, wrapped);
				bridge.registerCommandHandler(full, wrapped);
				pendingCommandRegistrations.push(full);
				return new Disposable(() => {
					if (ownCommands.get(full) === wrapped) ownCommands.delete(full);
					// Not flushed yet: leave the queue (a registration the workbench never saw
					// needs no unregistering); flushed: tell the workbench it went away.
					const queued = pendingCommandRegistrations.indexOf(full);
					if (queued !== -1) pendingCommandRegistrations.splice(queued, 1);
					else send('commands.unregister', [full]);
				});
			},
			registerTextEditorCommand: (id: string, handler: (editor: unknown, edit: unknown, ...args: unknown[]) => unknown, thisArg?: unknown) => {
				const full = id.includes('.') ? id : `${ctx.extensionId}.${id}`;
				bridge.registerCommandHandler(full, wrapHandler(full, async (...args: unknown[]) => {
					if (!activeEditor) {
						shimLog('info', `text editor command ${full} ran with no active text editor`);
						return undefined;
					}
					const editor = makeTextEditorProxy();
					const edits: SerializableTextEdit[] = [];
					const result = await handler.call(thisArg, editor, editBuilder(edits), ...args);
					if (edits.length > 0) await bridge.request('editor.applyEdits', [null, edits]);
					return result;
				}));
				pendingCommandRegistrations.push(full);
				return new Disposable(() => {
					const queued = pendingCommandRegistrations.indexOf(full);
					if (queued !== -1) pendingCommandRegistrations.splice(queued, 1);
					else send('commands.unregister', [full]);
				});
			},
			// A command this extension registered runs right here, as in VS Code's own host:
			// through the workbench it would re-enter this host — which, under ggs-node, is
			// blocked waiting on that very request (Claude Code's "New session" executes its
			// own `claude-vscode.editor.open` and stalled for the 30-second timeout). Local
			// dispatch also keeps `undefined` arguments, which the wire turns into null.
			executeCommand: (id: string, ...args: unknown[]) => {
				const own = ownCommands.get(id);
				if (own) return Promise.resolve().then(() => own(...args));
				// A foreign command can only exist for the workbench once this activation's
				// queued registrations arrived — keep the ordering.
				flushCommandRegistrations();
				return bridge.request('commands.execute', [id, args]) as Promise<unknown>;
			},
			getCommands: async (_filterInternal?: boolean) => (await bridge.request('commands.list', [])) as string[]
		},

		window: {
			showInformationMessage: (message: string, ...rest: unknown[]) => showMessage('info', message, ...rest),
			showWarningMessage: (message: string, ...rest: unknown[]) => showMessage('warning', message, ...rest),
			showErrorMessage: (message: string, ...rest: unknown[]) => showMessage('error', message, ...rest),
			showInputBox,
			showQuickPick,
			createQuickPick,
			createInputBox,
			showWorkspaceFolderPick: async (options?: { placeHolder?: string }) => {
				const picked = await pickOne(pickEntries(workspaceFolders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder }))), options?.placeHolder ?? '');
				return (picked?.item as { folder?: unknown } | undefined)?.folder;
			},
			withProgress: async <T>(options: { title?: string; location?: unknown; cancellable?: boolean }, task: (progress: { report: (value: { message?: string; increment?: number }) => void }, token: CancellationToken) => T | Promise<T>) => {
				const id = (await bridge.request('progress.begin', [options?.title ?? ctx.extensionId])) as number;
				let fraction = 0;
				// The toast has no cancel button: the token exists (tasks read it) and never
				// cancels.
				const source = new CancellationTokenSource();
				try {
					return await task({
						report: (value) => {
							fraction = Math.min(1, fraction + (value?.increment ?? 0) / 100);
							send('progress.report', [id, Math.round(fraction * 100), value?.message ?? '']);
						}
					}, source.token);
				} catch (error) {
					shimLog('warn', `withProgress task "${options?.title ?? ''}" failed: ${String(error)}`, error);
					throw error;
				} finally {
					source.dispose();
					send('progress.end', [id]);
				}
			},
			/** `window.createTerminal`: the integrated terminal serves the text — the run-in-
			 *  terminal actions extensions open. The panel's own session policy applies (its
			 *  shell, its cwd); a Pseudoterminal (`pty`) has no renderer here. */
			createTerminal: (nameOrOptions?: string | { name?: string; cwd?: string | Uri; env?: Record<string, string | null> | null; shellPath?: string; shellArgs?: string[] | string; pty?: unknown }, _shellPath?: string, _shellArgs?: string[]) => {
				const options = typeof nameOrOptions === 'object' && nameOrOptions !== null ? nameOrOptions : undefined;
				const name = typeof nameOrOptions === 'string' ? nameOrOptions : options?.name ?? '';
				if (options?.pty !== undefined) unsupported('window.createTerminal({ pty })', 'extension pseudoterminals have no renderer; the terminal stays empty');
				if (options?.cwd !== undefined || options?.env || options?.shellPath) shimLogOnce(`terminal-options:${ctx.extensionId}`, 'info', 'createTerminal options (cwd/env/shellPath) are advisory: the integrated terminal uses its own session');
				return {
					name,
					creationOptions: options ?? {},
					processId: Promise.resolve(undefined),
					exitStatus: undefined as { code: number } | undefined,
					state: { isInteractedWith: false },
					shellIntegration: undefined,
					sendText: (text: string, addNewLine = true) => {
						send('terminal.send', [addNewLine === false ? text : text]);
					},
					show: (_preserveFocus?: boolean) => send('terminal.show', []),
					hide: () => undefined,
					dispose: () => undefined
				};
			},
			get terminals(): unknown[] {
				return [];
			},
			activeTerminal: undefined,
			/** The Tabs API (`window.tabGroups`, VS Code 1.68): one group whose tab list the
			 *  frame cannot see — the shape a tab-aware feature reads is complete, and the
			 *  events register and never fire. */
			tabGroups: {
				all: [{ isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] as unknown[] }],
				get activeTabGroup() {
					return this.all[0];
				},
				onDidChangeTabs: silentEvent(),
				onDidChangeTabGroups: silentEvent(),
				close: async (_tabOrGroup: unknown, _preserveFocus?: boolean) => {
					unsupported('window.tabGroups.close');
					return false;
				}
			},
			createOutputChannel: (name: string, options?: string | { log?: boolean }) => {
				// The `{ log: true }` form (LogOutputChannel): the level-named methods a logging
				// extension binds at activation (`channel.info.bind(channel)`, cspell's logger
				// wrapper above all); every level lands in the channel with its prefix.
				const isLog = typeof options === 'object' && options?.log === true;
				const format = (message: unknown, args: unknown[]) => `${message instanceof Error ? (message.stack ?? message.message) : String(message)}${args.length > 0 ? ' ' + args.map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? (arg.stack ?? arg.message) : JSON.stringify(arg))).join(' ') : ''}`;
				const logLine = (level: string, message: unknown, ...args: unknown[]) => pendingOutputLines.push([name, `${isLog ? `${new Date().toISOString()} ` : ''}[${level}] ${format(message, args)}\n`]);
				return {
					name,
					logLevel: 3 as never,
					onDidChangeLogLevel: silentEvent() as never,
					trace: (message: unknown, ...args: unknown[]) => logLine('trace', message, ...args),
					debug: (message: unknown, ...args: unknown[]) => logLine('debug', message, ...args),
					info: (message: unknown, ...args: unknown[]) => logLine('info', message, ...args),
					warn: (message: unknown, ...args: unknown[]) => logLine('warning', message, ...args),
					error: (message: unknown, ...args: unknown[]) => logLine('error', message, ...args),
					append: (value: string) => pendingOutputLines.push([name, String(value)]),
					appendLine: (value: string) => pendingOutputLines.push([name, String(value) + '\n']),
					clear: () => { flushOutputLines(); send('output.clear', [name]); },
					show: (_columnOrPreserveFocus?: unknown, _preserveFocus?: boolean) => { flushOutputLines(); send('output.show', [name]); },
					hide: () => undefined,
					replace: (value: string) => {
						flushOutputLines();
						send('output.clear', [name]);
						pendingOutputLines.push([name, String(value)]);
					},
					dispose: () => send('output.dispose', [name])
				};
			},
			/** `(alignment?, priority?)` or VS Code 1.57's `(id, alignment?, priority?)`. */
			createStatusBarItem: (arg1?: number | string, arg2?: number, arg3?: number) => {
				const alignment = (typeof arg1 === 'number' ? arg1 : arg2) ?? StatusBarAlignment.Left;
				const priority = typeof arg1 === 'number' ? arg2 : arg3;
				const item = new StatusBarItem(bridge, `${ctx.extensionId}:${++statusSeq}`, alignment, priority);
				send('statusbar.create', [item.id, alignment]);
				return item;
			},
			/** A transient message: until the timeout, until the thenable settles, or — with
			 *  neither — until the returned Disposable runs (VS Code's three forms). */
			setStatusBarMessage: (text: string, hideAfter?: number | PromiseLike<unknown>) => {
				const item = new StatusBarItem(bridge, `${ctx.extensionId}:${++statusSeq}:msg`, StatusBarAlignment.Left);
				send('statusbar.create', [item.id, StatusBarAlignment.Left]);
				item.text = text;
				item.show();
				let gone = false;
				const dispose = () => {
					if (gone) return;
					gone = true;
					item.dispose();
				};
				if (typeof hideAfter === 'number') setTimeout(dispose, Math.max(0, hideAfter));
				else if (hideAfter && typeof (hideAfter as PromiseLike<unknown>).then === 'function') (hideAfter as PromiseLike<unknown>).then(dispose, dispose);
				return new Disposable(dispose);
			},
			createWebviewPanel: (viewType: string, title: string, showOptions?: unknown, options?: Record<string, unknown>) => {
				const panelId = ++webviewSeq;
				const panel = new WebviewPanel(bridge, ctx, viewType, title, options ?? {}, panelId);
				webviewPanels.set(panelId, panel);
				// VS Code's showOptions: a bare ViewColumn or `{ viewColumn, preserveFocus }`. Both
				// ride the create — the host turns the column into a placement (Beside is what an
				// extension's chat panel opens in; claude-code locks the group it lands a new
				// column in right after, exactly as in VS Code) and skips focusing it while
				// preserveFocus holds.
				const column = typeof showOptions === 'number' ? showOptions : (showOptions as { viewColumn?: unknown } | null | undefined)?.viewColumn;
				const preserveFocus = typeof showOptions === 'object' && showOptions !== null && (showOptions as { preserveFocus?: unknown }).preserveFocus === true;
				send('webview.create', [panelId, viewType, title, column, preserveFocus]);
				return panel;
			},
			registerWebviewViewProvider: (viewId: string, provider: { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }, _options?: unknown) => {
				webviewViewProviders.set(viewId, provider);
				send('webviewView.register', [viewId]);
				return new Disposable(() => {
					webviewViewProviders.delete(viewId);
					send('webviewView.dispose', [viewId]);
				});
			},
			registerWebviewPanelSerializer: (viewType: string, _serializer: unknown) => inert(`window.registerWebviewPanelSerializer(${viewType})`),
			registerCustomEditorProvider: (viewType: string, _provider: unknown) => inert(`window.registerCustomEditorProvider(${viewType})`),
			registerUriHandler: (_handler: unknown) => inert('window.registerUriHandler'),
			registerFileDecorationProvider: (provider: { provideFileDecoration: (uri: unknown, token: unknown) => unknown }, options?: { label?: string }) => {
				// GGS-patch: real file decorations — the explorer's badges/colours ask the
				// providers (see explorerDecorations.ts, the store half; the extension's
				// decoration crosses as its serializable subset: badge letter + colour name).
				const id = `filedeco-${++formatterSeq}`;
				fileDecorationProviders.set(id, { label: options?.label ?? '', run: provider.provideFileDecoration.bind(provider) });
				send('fileDecorations.register', [{ id, label: options?.label ?? '' }]);
				return new Disposable(() => {
					fileDecorationProviders.delete(id);
					send('fileDecorations.unregister', [{ id }]);
				});
			},
			registerTerminalLinkProvider: (_provider: unknown) => inert('window.registerTerminalLinkProvider'),
			registerTerminalProfileProvider: (_id: string, _provider: unknown) => inert('window.registerTerminalProfileProvider'),
			registerTreeDataProvider: (viewId: string, treeDataProvider: TreeDataProvider<unknown>) => {
				registerTree(viewId, treeDataProvider);
				return new Disposable(() => send('treeView.dispose', [viewId]));
			},
			createTextEditorDecorationType: (options?: Record<string, unknown>) => {
				// GGS-patch: real decoration types. The renderable subset of the options
				// crosses to the workbench at creation (see editorDecorations.ts); the rest
				// of the options object is accepted and ignored, as the API shape promises.
				const key = `${ctx.extensionId}/${++statusSeq}/deco`;
				void bridge.request('decoration.type', [{ key, options: plainDecorationOptions(options) }]).catch(() => undefined);
				return {
					key,
					dispose: () => {
						void bridge.request('decoration.dispose', [{ key }]).catch(() => undefined);
					}
				} as { key: string; dispose(): void };
			},
			showOpenDialog: async (options?: { canSelectMany?: boolean; defaultUri?: Uri; filters?: Record<string, string[]>; title?: string; canSelectFolders?: boolean }) => {
				const picked = await bridge.request('dialog.open', [options ?? {}]) as (string | { fsPath?: string })[] | string | null | undefined;
				const paths = picked === null || picked === undefined ? [] : Array.isArray(picked) ? picked : [picked];
				return paths.length > 0 ? paths.map((entry) => Uri.file(pathOf(entry))) : undefined;
			},
			showSaveDialog: async (options?: { defaultUri?: Uri; filters?: Record<string, string[]>; title?: string }) => {
				const picked = await bridge.request('dialog.save', [options ?? {}]) as string | { fsPath?: string } | null | undefined;
				return picked ? Uri.file(pathOf(picked)) : undefined;
			},
			get activeTextEditor(): Record<string, unknown> | undefined {
				return activeEditor ? makeTextEditorProxy() : undefined;
			},
			get visibleTextEditors(): Record<string, unknown>[] {
				return activeEditor ? [makeTextEditorProxy()] : [];
			},
			onDidChangeActiveTextEditor: activeEditorChangedEmitter.event,
			onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
			onDidChangeTextEditorSelection: selectionChanged.event,
			onDidChangeTextEditorVisibleRanges: silentEvent(),
			onDidChangeTextEditorOptions: silentEvent(),
			onDidChangeTextEditorViewColumn: silentEvent(),
			get activeColorTheme(): { kind: number } {
				return { kind: themeKind };
			},
			onDidChangeActiveColorTheme: themeChangedEmitter.event,
			showTextDocument: async (documentOrUri: Record<string, unknown> | Uri | string, columnOrOptions?: number | { selection?: Range; preview?: boolean; preserveFocus?: boolean; viewColumn?: number }) => {
				const options = typeof columnOrOptions === 'object' && columnOrOptions !== null ? columnOrOptions : {};
				const column = typeof columnOrOptions === 'number' ? columnOrOptions : options.viewColumn;
				// A ViewColumn as a placement the host understands: Beside (-2) and the
				// 1-based columns; Active (-1) and the default stay undefined (the active group).
				const placement = column === ViewColumn.Beside ? 'beside' : typeof column === 'number' && column >= 1 ? column : undefined;
				const target = documentOrUri as { uri?: Uri; fileName?: string };
				const uri = documentOrUri instanceof Uri ? documentOrUri : target.uri instanceof Uri ? target.uri : Uri.isUri(target.uri) ? target.uri : undefined;
				if (uri !== undefined && uri.scheme !== 'file' && uri.scheme !== 'untitled') {
					// A provider-scheme document — a package's virtual text (a chat view
					// opening its tool outputs and code blocks this way): the read-only
					// content tab. The shim holds the provider's text from `openTextDocument`;
					// the tab defaults to beside, so the view the link was clicked in (the
					// chat panel) keeps its half of the editor area.
					const remembered = documents.get(documentKey(uri.toString()));
					let text: string;
					if (remembered !== undefined) {
						text = remembered.text;
					} else {
						// The same local-first read `openTextDocument` takes — the host
						// round-trip's answer would call back into a ggs-node process
						// parked on this very call.
						const own = bridge.readDocProvider?.(uri) ?? null;
						text = own !== null
							? String((await own) ?? '')
							: String(await bridge.request('docProvider.read', [uri]).catch((error) => {
								shimLog('warn', `showTextDocument(${uri.toString()}) provider read failed: ${String(error)}`, error);
								return '';
							}) ?? '');
					}
					const title = uri.path.split(/[\\/]/).filter((part) => part !== '').pop() || uri.toString();
					await bridge.request('workspace.openContentTab', [title, uri.path, text, placement ?? 'beside']);
					return makeTextEditorProxy(uri.toString());
				}
				const path = typeof documentOrUri === 'string' ? documentOrUri : uri !== undefined ? hostPathOf(uri) : String(target.fileName ?? '');
				const selection = options.selection;
				await bridge.request('workspace.openFile', selection ? [path, selection.start.line + 1, selection.start.character + 1, placement] : [path, undefined, undefined, placement]);
				return makeTextEditorProxy(path);
			},
			createTreeView: (viewId: string, options: { treeDataProvider: TreeDataProvider<unknown>; showCollapseAll?: boolean; canSelectMany?: boolean }) => {
				const registration = registerTree(viewId, options.treeDataProvider);
				const meta: { title?: string; description?: string; message?: string; badge?: { value: number; tooltip?: string } } = {};
				const pushMeta = () => send('treeView.meta', [viewId, meta]);
				return {
					get visible(): boolean {
						return registration.visible;
					},
					get selection(): unknown[] {
						return registration.selection;
					},
					get title(): string | undefined {
						return meta.title;
					},
					set title(value: string | undefined) {
						meta.title = value;
						pushMeta();
					},
					get description(): string | undefined {
						return meta.description;
					},
					set description(value: string | undefined) {
						meta.description = value;
						pushMeta();
					},
					get message(): string | undefined {
						return meta.message;
					},
					set message(value: string | undefined) {
						meta.message = value;
						pushMeta();
					},
					get badge(): { value: number; tooltip?: string } | undefined {
						return meta.badge;
					},
					set badge(value: { value: number; tooltip?: string } | undefined) {
						meta.badge = value;
						pushMeta();
					},
					onDidChangeVisibility: registration.visibilityChanged.event,
					onDidChangeSelection: registration.selectionChanged.event,
					onDidExpandElement: registration.expanded.event,
					onDidCollapseElement: registration.collapsed.event,
					onDidChangeCheckboxState: registration.checkboxChanged.event,
					/** The view shows itself (its section is revealed); the element is not
					 *  scrolled to or selected — the tree has no reveal-by-element yet. */
					reveal: async (_element: unknown, _options?: unknown) => {
						send('treeView.reveal', [viewId]);
					},
					dispose: () => {
						send('treeView.dispose', [viewId]);
						treeRegistrations.delete(viewId);
						registration.visibilityChanged.dispose();
						registration.selectionChanged.dispose();
					}
				};
			},
			get state(): { focused: boolean; active: boolean } {
				// The shim also runs in the real-Node extension host (nodeHost.ts), where no
				// `document` exists — the window simply reports focused there.
				const focused = typeof document === 'undefined' ? true : document.hasFocus();
				return { focused, active: focused };
			},
			onDidChangeWindowState: silentEvent() as never,
			/** The notebook events: no notebook UI exists here, so the registrations attach and
			 *  never fire — the honest degradation that lets an activation finish. */
			onDidChangeActiveNotebookEditor: silentEvent() as never,
			onDidChangeNotebookEditorSelection: silentEvent() as never,
			onDidChangeNotebookEditorVisibleRanges: silentEvent() as never,
			onDidChangeVisibleNotebookEditors: silentEvent() as never,
			/** The terminal events: terminals `createTerminal` makes open in the integrated
			 *  panel, but the open/close pushes are not wired back — they never fire. */
			onDidOpenTerminal: silentEvent() as never,
			onDidCloseTerminal: silentEvent() as never,
			onDidChangeActiveTerminal: silentEvent() as never,
			onDidChangeTerminalState: silentEvent() as never,
			onDidStartTerminalShellExecution: silentEvent() as never,
			onDidEndTerminalShellExecution: silentEvent() as never,
			onDidChangeTerminalShellIntegration: silentEvent() as never,
			get activeNotebookEditor(): undefined {
				return undefined;
			},
			get visibleNotebookEditors(): unknown[] {
				return [];
			},
			get notebookEditors(): unknown[] {
				return [];
			},
			showNotebookDocument: async () => {
				unsupported('window.showNotebookDocument', 'there is no notebook editor');
				throw new Error('notebooks are not supported by the Git Graph Studio extension host');
			}
		},

		workspace: {
			get workspaceFolders() {
				return foldersOrUndefined();
			},
			onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
			/** Workspace trust: everything the frame runs is the user's own installed package. */
			isTrusted: true,
			onDidGrantWorkspaceTrust: silentEvent() as never,
			workspaceFile: undefined,
			getWorkspaceFolder: (uriOrPath?: Uri | string) => folderFor(uriOrPath),
			get rootPath(): string | undefined {
				return workspaceFolders[0]?.uri.fsPath;
			},
			get name(): string | undefined {
				return workspaceFolders.length === 0 ? undefined : workspaceFolders.length > 1 ? `${workspaceFolders[0]!.name} (Workspace)` : workspaceFolders[0]!.name;
			},
			updateWorkspaceFolders: (_start: number, _deleteCount: number | undefined | null, ..._folders: unknown[]) => {
				unsupported('workspace.updateWorkspaceFolders', 'open folders from the File menu');
				return false;
			},
			getConfiguration: (section = '', _scope?: unknown) => new WorkspaceConfiguration(ctx, bridge, section ?? '', (keys) => configurationChanged.fire(configurationChangeEvent(keys))),
			onDidChangeConfiguration: configurationChanged.event,
			/** The provider object stays in the frame; the host remembers which frame answers the
			 *  scheme, and its `vscode.open` / `vscode.diff` call back here for the text. */
			registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
				bridge.registerDocProvider?.(scheme, provider as { provideTextDocumentContent?: (uri: unknown) => unknown });
				send('docProvider.register', [scheme]);
				return new Disposable(() => {
					bridge.unregisterDocProvider?.(scheme);
					send('docProvider.unregister', [scheme]);
				});
			},
			registerFileSystemProvider: (scheme: string, _provider: unknown, _options?: unknown) => inert(`workspace.registerFileSystemProvider(${scheme})`),
			registerNotebookSerializer: (notebookType: string, _serializer: unknown) => inert(`workspace.registerNotebookSerializer(${notebookType})`),
			registerTaskProvider: (type: string, _provider: unknown) => inert(`workspace.registerTaskProvider(${type})`),
			onDidSaveTextDocument: documentSaved.event,
			onDidChangeTextDocument: documentChanged.event,
			/** No pre-save interception point exists: the registration is accepted and never
			 *  fires (firing after the save would let a formatter-on-save dirty the file
			 *  again), and the first registration says so in the log. */
			onWillSaveTextDocument: (listener: unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => {
				unsupported('workspace.onWillSaveTextDocument', 'there is no pre-save hook; edits-on-save do not run');
				return silentEvent()(listener as never, thisArgs, disposables);
			},
			onDidOpenTextDocument: documentOpened.event,
			onDidCloseTextDocument: documentClosed.event,
			onDidCreateFiles: silentEvent() as never,
			onDidDeleteFiles: silentEvent() as never,
			onDidRenameFiles: silentEvent() as never,
			onWillCreateFiles: silentEvent() as never,
			onWillDeleteFiles: silentEvent() as never,
			onWillRenameFiles: silentEvent() as never,
			onDidOpenNotebookDocument: silentEvent() as never,
			onDidCloseNotebookDocument: silentEvent() as never,
			onDidSaveNotebookDocument: silentEvent() as never,
			onDidChangeNotebookDocument: silentEvent() as never,
			/** The document for a Uri / path — read without opening an editor (VS Code's
			 *  contract: `showTextDocument` opens one). The in-memory `{ content }` form
			 *  answers an untitled document. */
			openTextDocument: async (uriPathOrOptions?: Uri | string | { content?: string; language?: string }) => {
				if (uriPathOrOptions === undefined || (uriPathOrOptions !== null && typeof uriPathOrOptions === 'object' && !(uriPathOrOptions instanceof Uri) && !Uri.isUri(uriPathOrOptions) && typeof (uriPathOrOptions as { fsPath?: unknown }).fsPath !== 'string')) {
					const options = (uriPathOrOptions ?? {}) as { content?: string; language?: string };
					const name = `Untitled-${++untitledSeq}`;
					const { state } = rememberDocument(name, options.content ?? '', options.language ?? 'plaintext', Uri.from({ scheme: 'untitled', path: name }));
					documentOpened.fire(documentView(state, async () => false));
					return documentView(state, async () => false);
				}
				const uri = typeof uriPathOrOptions === 'string' ? Uri.file(uriPathOrOptions) : (rehydrateUris(uriPathOrOptions) as Uri);
				if (uri.scheme !== 'file') {
					// A provider scheme. This side's own registration answers first — a
					// ggs-node package's blocking bridge must not take the host round-trip,
					// whose answer calls back into this same parked JS thread (the
					// `vscode.diff` reentry deadlock class). Another extension's scheme
					// falls to the host's global provider lookup, as before.
					const own = bridge.readDocProvider?.(uri) ?? null;
					let text: unknown;
					try {
						text = own !== null ? await own : await bridge.request('docProvider.read', [uri]);
					} catch (error) {
						shimLog('warn', `openTextDocument(${uri.toString()}) failed: ${String(error)}`, error);
						throw error;
					}
					const { state } = rememberDocument(uri.toString(), String(text ?? ''), 'plaintext', uri);
					return documentView(state, async () => false);
				}
				const path = hostPathOf(uri);
				const known = documents.get(documentKey(path));
				if (known) return makeTextDocument(path);
				let read: { text?: string; languageId?: string } | null = null;
				try {
					read = (await bridge.request('workspace.readText', [path])) as { text?: string; languageId?: string } | null;
				} catch (error) {
					shimLog('warn', `openTextDocument(${path}) failed: ${String(error)}`, error);
					throw fsError(error, uri);
				}
				const { state, opened } = rememberDocument(path, read?.text ?? '', read?.languageId ?? '');
				if (opened) documentOpened.fire(documentView(state, () => saveDocument(path)));
				return makeTextDocument(path);
			},
			applyEdit: (edit: unknown, _metadata?: unknown) => applyWorkspaceEdit(edit),
			asRelativePath: (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean) => {
				const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
				const folder = folderFor(path);
				if (!folder) return path;
				const relative = documentKey(path).slice(documentKey(folder.uri.fsPath).replace(/\/+$/, '').length).replace(/^\//, '');
				const withFolder = includeWorkspaceFolder ?? workspaceFolders.length > 1;
				return withFolder && workspaceFolders.length > 1 ? `${folder.name}/${relative}` : relative;
			},
			createFileSystemWatcher: (pattern: unknown, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) => {
				// A string pattern watches the first workspace folder (an absolute one carries
				// its own base); a RelativePattern carries its base (a repository, typically).
				const asObject = pattern !== null && typeof pattern === 'object' ? pattern as { baseUri?: Uri; base?: unknown; pattern?: unknown } : null;
				let baseRaw = asObject !== null
					? (asObject.baseUri ? asObject.baseUri.fsPath : typeof asObject.base === 'string' ? asObject.base : pathOf(asObject.base as Uri))
					: (workspaceFolders[0]?.uri.fsPath ?? '');
				let glob = String((asObject !== null ? asObject.pattern : pattern) ?? '**');
				if (asObject === null && /^([A-Za-z]:)?[\\/]/.test(glob)) {
					// An absolute string pattern: split at the first wildcard segment.
					const segments = glob.replace(/\\/g, '/').split('/');
					const firstWild = segments.findIndex((segment) => /[*?{[]/.test(segment));
					const cut = firstWild === -1 ? segments.length - 1 : firstWild;
					baseRaw = segments.slice(0, cut).join('/');
					glob = segments.slice(cut).join('/') || '**';
				}
				const base = documentKey(baseRaw).replace(/\/+$/, '').toLowerCase();
				const changed = new EventEmitter<Uri>();
				const created = new EventEmitter<Uri>();
				const deleted = new EventEmitter<Uri>();
				const fire = (emitter: EventEmitter<Uri>, absolute: string) => emitter.fire(Uri.file(absolute));
				// The frame's own saves count too (VS Code's watcher sees them).
				const saveSub = documentSaved.event((document) => {
					if (ignoreChange) return;
					const fileName = String((document as { fileName?: string }).fileName ?? '');
					const normalized = documentKey(fileName).toLowerCase();
					if (normalized.startsWith(base + '/') && watcherGlobMatches(glob, normalized.slice(base.length + 1))) fire(changed, fileName);
				});
				// The host's watcher batches: every changed working-tree path under the base
				// fires; a `.git/` change fires the pattern-matched HEAD event. A batch cannot
				// tell create or delete from change, so those fire as changes.
				const fsSub = fsChanged.event((batch) => {
					if (ignoreChange) return;
					const root = documentKey(batch.root).replace(/\/+$/, '').toLowerCase();
					if (!base.startsWith(root) && !root.startsWith(base)) return;
					for (const relative of batch.paths) {
						const full = `${root}/${relative}`;
						if (base !== '' && !full.startsWith(base + '/')) continue;
						const rest = full.slice(base === '' ? root.length + 1 : base.length + 1);
						if (watcherGlobMatches(glob, rest)) fire(changed, `${batch.root.replace(/[\\/]+$/, '')}/${relative}`);
					}
					if (batch.gitChanged && watcherGlobMatches(glob, '.git/HEAD')) fire(changed, `${batch.root.replace(/[\\/]+$/, '')}/.git/HEAD`);
				});
				if (!ignoreCreate || !ignoreDelete) shimLogOnce(`watcher-kinds:${ctx.extensionId}`, 'debug', 'file watchers report creations and deletions as changes (the host batches do not tell them apart)');
				return {
					ignoreCreateEvents: ignoreCreate,
					ignoreChangeEvents: ignoreChange,
					ignoreDeleteEvents: ignoreDelete,
					onDidChange: changed.event,
					onDidCreate: created.event,
					onDidDelete: deleted.event,
					dispose: () => {
						saveSub.dispose();
						fsSub.dispose();
						changed.dispose();
						created.dispose();
						deleted.dispose();
					}
				};
			},
			/** `findFiles(include, exclude?, maxResults?)`: a glob or a RelativePattern, over
			 *  every open folder (or the pattern's base), the exclude glob applied here. */
			findFiles: async (include: string | RelativePattern | { baseUri?: Uri; base?: unknown; pattern?: string }, exclude?: string | RelativePattern | null, maxResults?: number, _token?: CancellationToken) => {
				const relative = include !== null && typeof include === 'object';
				const glob = relative ? String((include as { pattern?: string }).pattern ?? '**') : String(include ?? '**');
				const base = relative ? ((include as { baseUri?: Uri }).baseUri?.fsPath ?? pathOf((include as { base?: Uri }).base)) : undefined;
				const found = (await bridge.request('fs.op', ['find', glob, base])) as (string | { root: string; path: string })[];
				const excludeGlob = exclude === null || exclude === undefined ? undefined : typeof exclude === 'string' ? exclude : exclude.pattern;
				const firstRoot = workspaceFolders[0]?.uri.fsPath ?? '';
				const out: Uri[] = [];
				for (const entry of found ?? []) {
					const root = typeof entry === 'string' ? firstRoot : entry.root;
					const rel = typeof entry === 'string' ? entry : entry.path;
					if (excludeGlob && watcherGlobMatches(excludeGlob.replace(/^\*\*\//, '**/'), rel)) continue;
					out.push(Uri.file(root === '' ? rel : `${root.replace(/[\\/]+$/, '')}/${rel}`));
					if (maxResults !== undefined && out.length >= maxResults) break;
				}
				return out;
			},
			save: async (uri: Uri) => ((await saveDocument(hostPathOf(uri))) ? uri : undefined),
			saveAs: async (_uri: Uri) => {
				unsupported('workspace.saveAs');
				return undefined;
			},
			saveAll: async (_includeUntitled?: boolean) => {
				let all = true;
				for (const state of documents.values()) if (state.uri.scheme === 'file') all = (await saveDocument(state.path)) && all;
				return all;
			},
			get textDocuments(): Record<string, unknown>[] {
				return [...documents.values()].map((state) => documentView(state, () => saveDocument(state.path)));
			},
			notebookDocuments: [] as never[],
			decode: async (content: Uint8Array) => new TextDecoder().decode(content),
			encode: async (content: string) => new TextEncoder().encode(content),
			/** The file services over the host's `ext_fs` command (bytes cross as base64;
			 *  every path is confined to the open folders, the extension's own directory and
			 *  its storage there). */
			fs: fileSystem
		},

		languages: {
			getLanguages: async () => ['bat', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'jsonc', 'kotlin', 'lua', 'markdown', 'php', 'plaintext', 'powershell', 'python', 'ruby', 'rust', 'scss', 'shellscript', 'sql', 'swift', 'typescript', 'typescriptreact', 'javascriptreact', 'xml', 'yaml'],
			setTextDocumentLanguage: async (document: { uri?: Uri; fileName?: string }, languageId: string) => {
				const path = document.uri ? hostPathOf(document.uri) : String(document.fileName ?? '');
				const state = documents.get(documentKey(path));
				if (state) state.languageId = languageId;
				return makeTextDocument(path);
			},
			/** `createLanguageStatusItem`: a mutable value; no status surface renders it. */
			createLanguageStatusItem: (id: string, selector: unknown) => {
				unsupported('languages.createLanguageStatusItem', 'language status items are not rendered');
				return {
					id, name: undefined as string | undefined, selector, text: '', detail: undefined as string | undefined,
					kind: 1 as never, command: undefined as unknown, busy: false, severity: 0 as never,
					accessibilityInformation: undefined as unknown, dispose: () => undefined
				};
			},
			onDidChangeDiagnostics: diagnosticsChanged.event,
			/** With a Uri, that document's diagnostics across every collection (empty when
			 *  none); without, every `[Uri, diagnostics]` pair. */
			getDiagnostics: (uri?: Uri | string): unknown => {
				if (uri !== undefined) {
					const key = (typeof uri === 'string' ? Uri.file(uri) : uri).toString();
					return [...diagnosticCollections].flatMap((collection) => collection.get(key)?.diagnostics ?? []);
				}
				const byUri = new Map<string, [Uri, unknown[]]>();
				for (const collection of diagnosticCollections) {
					for (const [key, entry] of collection) {
						if (!byUri.has(key)) byUri.set(key, [entry.uri, []]);
						byUri.get(key)![1].push(...entry.diagnostics);
					}
				}
				return [...byUri.values()];
			},
			match: (selector: unknown, document: { languageId?: string; uri?: Uri; fileName?: string } | undefined) => selectorScore(selector, document),
			/** A diagnostic collection keyed by the document Uri; every change re-renders the
			 *  document's squiggles through the host's `diagnostics.set`. */
			createDiagnosticCollection: (name?: string) => {
				const entries = new Map<string, { uri: Uri; diagnostics: unknown[] }>();
				diagnosticCollections.add(entries);
				const toUri = (value: Uri | string) => (typeof value === 'string' ? Uri.file(value) : value instanceof Uri ? value : (rehydrateUris(value) as Uri));
				const push = (uri: Uri) => {
					const diagnostics = entries.get(uri.toString())?.diagnostics ?? [];
					send('diagnostics.set', [ctx.extensionId, hostPathOf(uri), diagnostics.map(serializeDiagnostic)]);
				};
				const changed = (uris: Uri[]) => diagnosticsChanged.fire({ uris });
				const collection = {
					name: name ?? 'collection',
					set: (uriOrEntries: Uri | string | readonly [Uri, readonly unknown[] | undefined][], diagnostics?: readonly unknown[] | null) => {
						const touched: Uri[] = [];
						if (Array.isArray(uriOrEntries)) {
							for (const [uri, list] of uriOrEntries as [Uri, readonly unknown[] | undefined][]) {
								const target = toUri(uri);
								if (list === undefined) entries.delete(target.toString());
								else entries.set(target.toString(), { uri: target, diagnostics: [...(entries.get(target.toString())?.diagnostics ?? []), ...list] });
								touched.push(target);
							}
						} else {
							const target = toUri(uriOrEntries as Uri | string);
							if (diagnostics === undefined || diagnostics === null) entries.delete(target.toString());
							else entries.set(target.toString(), { uri: target, diagnostics: [...diagnostics] });
							touched.push(target);
						}
						for (const uri of touched) push(uri);
						changed(touched);
					},
					delete: (uri: Uri | string) => {
						const target = toUri(uri);
						entries.delete(target.toString());
						push(target);
						changed([target]);
					},
					clear: () => {
						const uris = [...entries.values()].map((entry) => entry.uri);
						entries.clear();
						for (const uri of uris) push(uri);
						changed(uris);
					},
					/** VS Code's callback order: `(uri, diagnostics, collection)`. */
					forEach: (callback: (uri: Uri, diagnostics: readonly unknown[], collection: unknown) => unknown, thisArg?: unknown) => {
						for (const entry of [...entries.values()]) callback.call(thisArg, entry.uri, entry.diagnostics, collection);
					},
					// VS Code answers an empty list (never undefined) for a document with none.
					get: (uri: Uri | string) => [...(entries.get(toUri(uri).toString())?.diagnostics ?? [])],
					has: (uri: Uri | string) => entries.has(toUri(uri).toString()),
					dispose: () => {
						collection.clear();
						diagnosticCollections.delete(entries);
					},
					[Symbol.iterator]: function* () {
						for (const entry of entries.values()) yield [entry.uri, entry.diagnostics] as [Uri, unknown[]];
					}
				};
				return collection;
			},
			registerDocumentFormattingEditProvider: (selector: unknown, formatter: { provideDocumentFormattingEdits: (document: unknown, options: unknown, token: unknown) => unknown }) =>
				registerFormatter(selector, (document, options, token) => formatter.provideDocumentFormattingEdits(document, options, token)),
			/** A range formatter serves whole-document formatting over the full range (the
			 *  host's Format Document is the only formatting entry point). */
			registerDocumentRangeFormattingEditProvider: (selector: unknown, formatter: { provideDocumentRangeFormattingEdits: (document: unknown, range: Range, options: unknown, token: unknown) => unknown }) =>
				registerFormatter(selector, (document, options, token) => {
					const lineCount = Number(document.lineCount) || 1;
					const last = (document.lineAt as (line: number) => { text: string })(lineCount - 1);
					return formatter.provideDocumentRangeFormattingEdits(document, new Range(0, 0, lineCount - 1, last.text.length), options, token);
				}),
			registerCompletionItemProvider: (selector: unknown, provider: { provideCompletionItems?: (document: unknown, position: unknown, token: unknown, context: unknown) => unknown }, ...triggerCharacters: string[]) => {
				if (typeof provider?.provideCompletionItems !== 'function') {
					return inert('languages.registerCompletionItemProvider');
				}
				// GGS-patch: real completion providers. The workbench's completion UI calls
				// over at every trigger (see editorCompletions.ts); the frame answers with
				// serialized items. Trigger characters register with the declaration, as
				// VS Code's signature carries them.
				const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
				const id = `cmp-${++formatterSeq}`;
				const triggers = triggerCharacters.filter((c) => typeof c === 'string');
				completionProviders.set(id, { selectors, triggerCharacters: triggers, run: provider.provideCompletionItems.bind(provider) });
				send('languages.registerCompletion', [{ id, selectors: selectors.map(plainSelector), triggerCharacters: triggers }]);
				return new Disposable(() => {
					completionProviders.delete(id);
					send('languages.unregisterCompletion', [{ id }]);
				});
			},
			registerInlineCompletionItemProvider: provider('registerInlineCompletionItemProvider'),
			registerHoverProvider: (selector: unknown, provider: { provideHover?: (document: unknown, position: unknown, token: unknown) => unknown }) => {
				// GGS-patch: real hover providers — the editor's hover tooltip calls over
				// (see editorHovers.ts), the frame answers with serialized hover contents.
				// A provider without the method degrades to an inert registration (the
				// Open VSX posture: a foreign extension's shape mistake never throws).
				if (typeof provider?.provideHover !== 'function') {
					return inert('languages.registerHoverProvider');
				}
				const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
				const id = `hov-${++formatterSeq}`;
				hoverProviders.set(id, { selectors, run: provider.provideHover.bind(provider) });
				send('languages.registerHover', [{ id, selectors: selectors.map(plainSelector) }]);
				return new Disposable(() => {
					hoverProviders.delete(id);
					send('languages.unregisterHover', [{ id }]);
				});
			},
			registerDefinitionProvider: (selector: unknown, provider: { provideDefinition?: (document: unknown, position: unknown, token: unknown) => unknown }) => {
				if (typeof provider?.provideDefinition !== 'function') {
					return inert('languages.registerDefinitionProvider');
				}
				// GGS-patch: real definition providers — Go-to-Definition calls over (see
				// editorHovers.ts, which also drives the alt-click navigation), the frame
				// answers with serialized locations the workbench opens.
				const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
				const id = `def-${++formatterSeq}`;
				definitionProviders.set(id, { selectors, run: provider.provideDefinition.bind(provider) });
				send('languages.registerDefinition', [{ id, selectors: selectors.map(plainSelector) }]);
				return new Disposable(() => {
					definitionProviders.delete(id);
					send('languages.unregisterDefinition', [{ id }]);
				});
			},
			registerDeclarationProvider: provider('registerDeclarationProvider'),
			registerTypeDefinitionProvider: provider('registerTypeDefinitionProvider'),
			registerImplementationProvider: provider('registerImplementationProvider'),
			registerReferenceProvider: provider('registerReferenceProvider'),
			registerDocumentSymbolProvider: provider('registerDocumentSymbolProvider'),
			registerWorkspaceSymbolProvider: provider('registerWorkspaceSymbolProvider'),
			registerCodeLensProvider: provider('registerCodeLensProvider'),
			registerCodeActionsProvider: provider('registerCodeActionsProvider'),
			registerOnTypeFormattingEditProvider: provider('registerOnTypeFormattingEditProvider'),
			registerRenameProvider: provider('registerRenameProvider'),
			registerSignatureHelpProvider: provider('registerSignatureHelpProvider'),
			registerDocumentLinkProvider: provider('registerDocumentLinkProvider'),
			registerDocumentHighlightProvider: provider('registerDocumentHighlightProvider'),
			registerMultiDocumentHighlightProvider: provider('registerMultiDocumentHighlightProvider'),
			registerDocumentSemanticTokensProvider: provider('registerDocumentSemanticTokensProvider'),
			registerDocumentRangeSemanticTokensProvider: provider('registerDocumentRangeSemanticTokensProvider'),
			registerFoldingRangeProvider: provider('registerFoldingRangeProvider'),
			registerSelectionRangeProvider: provider('registerSelectionRangeProvider'),
			registerCallHierarchyProvider: provider('registerCallHierarchyProvider'),
			registerTypeHierarchyProvider: provider('registerTypeHierarchyProvider'),
			registerLinkedEditingRangeProvider: provider('registerLinkedEditingRangeProvider'),
			registerInlayHintsProvider: provider('registerInlayHintsProvider'),
			registerColorProvider: provider('registerColorProvider'),
			registerInlineValuesProvider: provider('registerInlineValuesProvider'),
			registerDocumentDropEditProvider: provider('registerDocumentDropEditProvider'),
			registerDocumentPasteEditProvider: provider('registerDocumentPasteEditProvider'),
			registerEvaluatableExpressionProvider: provider('registerEvaluatableExpressionProvider'),
			setLanguageConfiguration: provider('setLanguageConfiguration')
		},

		/** The Language Model + Chat namespaces (VS Code 1.90+): registrations survive; no
		 *  chat surface exists to call them from, so `selectChatModels` answers empty. */
		lm: {
			registerTool: (name: string, _tool: unknown) => inert(`lm.registerTool(${name})`),
			registerChatModelProvider: (id: string, _provider: unknown) => inert(`lm.registerChatModelProvider(${id})`),
			invokeTool: async (name: string) => {
				unsupported(`lm.invokeTool(${name})`, 'there is no language model surface');
				throw new LanguageModelError(`tool ${name} is not available in this host`);
			},
			tools: [] as never[],
			selectChatModels: async () => [] as never[],
			onDidChangeChatModels: silentEvent() as never,
			fileCompression: undefined
		},
		chat: {
			registerChatParticipant: () => inert('chat.registerChatParticipant'),
			registerChatVariableResolver: () => inert('chat.registerChatVariableResolver'),
			registerChatCommand: () => inert('chat.registerChatCommand'),
			createChatParticipant: (id: string, handler?: unknown) => {
				unsupported('chat.createChatParticipant', 'there is no chat surface');
				return {
					id, iconPath: undefined, followupProvider: undefined, participantName: id,
					onDidReceiveFeedback: silentEvent() as never, requestHandler: handler as unknown, dispose: () => undefined
				};
			}
		},

		tasks: {
			registerTaskProvider: (type: string, _provider: unknown) => inert(`tasks.registerTaskProvider(${type})`),
			fetchTasks: async (_filter?: unknown) => [] as never[],
			/** A run the host cannot perform rejects (a fake TaskExecution would leave the
			 *  caller waiting for an end event that never comes). */
			executeTask: async (task: unknown) => {
				const name = String((task as { name?: string })?.name ?? '');
				unsupported('tasks.executeTask', 'tasks do not run in this host');
				shimLog('warn', `tasks.executeTask(${name}) refused: tasks are not supported`);
				throw new Error(`tasks are not supported by the Git Graph Studio extension host (${name})`);
			},
			get taskExecutions(): never[] {
				return [];
			},
			onDidStartTask: silentEvent() as never,
			onDidEndTask: silentEvent() as never,
			onDidStartTaskProcess: silentEvent() as never,
			onDidEndTaskProcess: silentEvent() as never
		},

		/** The Test Controller API (VS Code 1.59): the controller, its items and the run
		 *  handles are real objects over local state; no test UI renders them. */
		tests: {
			createTestController: (id: string, label?: string) => {
				unsupported('tests.createTestController', 'test results are not rendered');
				const items = new Map<string, unknown>();
				const collection = makeTestItemCollection(items);
				const controller: Record<string, unknown> = {
					id,
					label,
					items: collection,
					refreshHandler: undefined,
					resolveHandler: undefined as unknown,
					invalidateTestResults: () => undefined,
					createTestItem: (itemId: string, itemLabel: string, uri?: Uri) => makeTestItem(itemId, itemLabel, uri),
					createRunProfile: (profileLabel: string, kind: unknown, runHandler: unknown, isDefault?: boolean, tag?: unknown) => ({ label: profileLabel, kind, runHandler, isDefault, tag, configureHandler: undefined, onDidChangeDefault: silentEvent(), dispose: () => undefined }),
					createTestRun: (_request: unknown, name?: string, _persist?: boolean) => ({
						name,
						token: CancellationTokenNone,
						isPersisted: false,
						onDidDispose: silentEvent(),
						started: () => undefined,
						passed: () => undefined,
						failed: () => undefined,
						skipped: () => undefined,
						errored: () => undefined,
						enqueued: () => undefined,
						appendOutput: () => undefined,
						addCoverage: () => undefined,
						end: () => undefined
					}),
					dispose: () => undefined
				};
				return controller;
			}
		},

		debug: {
			activeDebugSession: undefined,
			activeStackItem: undefined,
			activeDebugConsole: { append: () => undefined, appendLine: () => undefined },
			breakpoints: [] as never[],
			registerDebugConfigurationProvider: (type: string) => inert(`debug.registerDebugConfigurationProvider(${type})`),
			registerDebugAdapterDescriptorFactory: (type: string) => inert(`debug.registerDebugAdapterDescriptorFactory(${type})`),
			registerDebugAdapterTrackerFactory: (type: string) => inert(`debug.registerDebugAdapterTrackerFactory(${type})`),
			registerDebugVisualizationProvider: (id: string) => inert(`debug.registerDebugVisualizationProvider(${id})`),
			startDebugging: async () => {
				unsupported('debug.startDebugging', 'there is no debugger in this host');
				return false;
			},
			stopDebugging: async () => undefined,
			addBreakpoints: () => unsupported('debug.addBreakpoints'),
			removeBreakpoints: () => unsupported('debug.removeBreakpoints'),
			asDebugSourceUri: (source: { path?: string }) => Uri.file(String(source?.path ?? '')),
			onDidStartDebugSession: silentEvent() as never,
			onDidTerminateDebugSession: silentEvent() as never,
			onDidChangeActiveDebugSession: silentEvent() as never,
			onDidReceiveDebugSessionCustomEvent: silentEvent() as never,
			onDidChangeBreakpoints: silentEvent() as never,
			onDidChangeActiveStackItem: silentEvent() as never
		},

		/** The Source Control API: a provider's objects are real and mutable (extensions
		 *  write their resource states into them); the Source Control view is the app's own
		 *  git view and renders none of them. */
		scm: {
			inputBox: { value: '', placeholder: '', enabled: true, visible: true },
			createSourceControl: (id: string, label: string, rootUri?: Uri) => {
				unsupported('scm.createSourceControl', 'the Source Control view shows the app\'s own git provider only');
				const groups: unknown[] = [];
				return {
					id, label, rootUri,
					inputBox: { value: '', placeholder: '', enabled: true, visible: true, validateInput: undefined },
					count: undefined, quickDiffProvider: undefined, commitTemplate: undefined,
					acceptInputCommand: undefined, statusBarCommands: undefined,
					createResourceGroup: (groupId: string, groupLabel: string) => {
						const group = { id: groupId, label: groupLabel, hideWhenEmpty: false, resourceStates: [] as unknown[], dispose: () => undefined };
						groups.push(group);
						return group;
					},
					dispose: () => undefined
				};
			}
		},

		notebooks: {
			createNotebookController: (id: string, notebookType: string, label: string) => {
				unsupported('notebooks.createNotebookController', 'there is no notebook editor');
				return {
					id, notebookType, label, supportedLanguages: [] as string[], supportsExecutionOrder: false,
					executeHandler: undefined as unknown, interruptHandler: undefined as unknown,
					onDidChangeSelectedNotebooks: silentEvent(),
					createNotebookCellExecution: () => { throw new Error('notebooks are not supported by the Git Graph Studio extension host'); },
					updateNotebookAffinity: () => undefined,
					dispose: () => undefined
				};
			},
			registerNotebookCellStatusBarItemProvider: (notebookType: string) => inert(`notebooks.registerNotebookCellStatusBarItemProvider(${notebookType})`),
			createRendererMessaging: (rendererId: string) => {
				unsupported(`notebooks.createRendererMessaging(${rendererId})`);
				return { onDidReceiveMessage: silentEvent(), postMessage: async () => false };
			}
		},

		authentication: {
			registerAuthenticationProvider: (id: string) => inert(`authentication.registerAuthenticationProvider(${id})`),
			getSession: async (providerId: string, _scopes: readonly string[], options?: { createIfNone?: boolean; forceNewSession?: unknown }) => {
				unsupported(`authentication.getSession(${providerId})`, 'no authentication providers exist; resolved undefined');
				if (options?.createIfNone || options?.forceNewSession) throw new Error(`no authentication provider ${providerId} in this host`);
				return undefined;
			},
			getAccounts: async () => [] as never[],
			onDidChangeSessions: silentEvent() as never
		},

		l10n: {
			/** `t(message, ...args)`, `t(message, { named })` and the `{ message, args }` form. */
			t: (message: string | { message: string; args?: unknown[] | Record<string, unknown>; comment?: string | string[] }, ...args: unknown[]): string => {
				let text = typeof message === 'string' ? message : message.message;
				const values = typeof message === 'string' ? (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args) : message.args ?? [];
				if (Array.isArray(values)) return text.replace(/\{(\d+)\}/g, (all, index: string) => (values[Number(index)] === undefined ? all : String(values[Number(index)])));
				for (const [key, value] of Object.entries(values as Record<string, unknown>)) text = text.split(`{${key}}`).join(String(value));
				return text;
			},
			bundle: undefined,
			uri: undefined
		},

		comments: {
			createCommentController: (id: string, label: string) => {
				unsupported('comments.createCommentController', 'comment threads are not rendered');
				return {
					id, label, commentingRangeProvider: undefined, options: {}, reactionHandler: undefined,
					createCommentThread: (uri: Uri, range: Range, comments: unknown[]) => ({ uri, range, comments, collapsibleState: 0, canReply: false, contextValue: undefined, label: undefined, state: undefined, dispose: () => undefined }),
					dispose: () => undefined
				};
			}
		},

		env: {
			language: ctx.language,
			appName: 'Git Graph Studio',
			appRoot: '',
			appHost: 'desktop',
			appVersion: ctx.appVersion ?? '1.0.0',
			uriScheme: 'ggs',
			uiKind: UIKind.Desktop,
			machineId: 'studio',
			sessionId: `${ctx.extensionId}-${Date.now().toString(36)}`,
			remoteName: undefined,
			isNewAppInstall: false,
			isTelemetryEnabled: false,
			logLevel: 3,
			onDidChangeLogLevel: silentEvent() as never,
			onDidChangeTelemetryEnabled: silentEvent() as never,
			onDidChangeShell: silentEvent() as never,
			get shell(): string {
				return (ctx.platform ?? (uriWin32 ? 'win32' : 'linux')) === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : '/bin/bash';
			},
			getLanguage: () => ctx.language,
			openExternal: (uri: Uri | string) => bridge.request('openExternal', [typeof uri === 'string' ? uri : uri.toString(true)]) as Promise<boolean>,
			/** Nothing is forwarded or tunnelled: a URI is already reachable as-is here. */
			asExternalUri: async (uri: Uri) => uri,
			// VS Code's telemetry entry point — extensions call it during activation (cspell
			// logs its first usage event there). This host collects nothing.
			createTelemetryLogger: (_sender?: unknown, _configuration?: unknown) => ({
				logUsage: () => undefined,
				logError: () => undefined,
				sendEventData: () => undefined,
				sendErrorData: () => undefined,
				isUsageEnabled: false,
				isErrorsEnabled: false,
				onDidChangeEnableStates: silentEvent(),
				dispose: () => undefined
			}),
			clipboard: {
				writeText: (text: string) => bridge.request('clipboard.writeText', [text]) as Promise<void>,
				readText: () => bridge.request('clipboard.readText', []) as Promise<string>
			}
		},

		extensions: {
			/** Every installed extension the host listed; `exports` of another extension do
			 *  not cross hosts (each runs in its own), and reading them is logged. */
			getExtension: (extensionId: string) => {
				if (typeof extensionId !== 'string') return undefined;
				if (extensionId.toLowerCase() === ctx.extensionId.toLowerCase()) return extensionEntry(ctx);
				const other = (ctx.extensions ?? []).find((entry) => entry.id.toLowerCase() === extensionId.toLowerCase());
				if (!other) {
					shimLog('debug', `extensions.getExtension(${extensionId}): not installed`);
					return undefined;
				}
				return foreignExtension(other);
			},
			get all(): unknown[] {
				const others = (ctx.extensions ?? []).filter((entry) => entry.id.toLowerCase() !== ctx.extensionId.toLowerCase()).map(foreignExtension);
				return [extensionEntry(ctx), ...others];
			},
			get allAcrossExtensionHosts(): unknown[] {
				return this.all;
			},
			onDidChange: silentEvent() as never
		},

		/** The log-level enum VS Code 1.74 added with LogOutputChannel. */
		LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
		/** `IndentAction`: the onEnter auto-indent rules (ms-python constructs them at eval). */
		IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
		ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
		TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
		TestResultState: { Queued: 1, Running: 2, Passed: 3, Failed: 4, Skipped: 5, Errored: 6 },
		QuickInputButtons: { Back: { iconPath: new ThemeIcon('arrow-left') } },
		CancellationToken: { None: CancellationTokenNone, Cancelled: CancellationTokenCancelled },
		ExtensionRuntime: { Node: 1, Webworker: 2 },
		LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
		Uri, Position, Range, Selection, Location, Disposable, EventEmitter, CancellationTokenSource,
		ViewColumn, StatusBarAlignment, ConfigurationTarget, TreeItemCollapsibleState, ProgressLocation,
		UIKind, ExtensionMode, ExtensionKind, FileType, EndOfLine, OverviewRulerLane, DecorationRangeBehavior,
		LanguageStatusSeverity, TextEditorRevealType, QuickPickItemKind, DiagnosticSeverity, CompletionItemKind,
		SymbolKind, CommentThreadCollapsibleState, CodeActionKind, MarkdownString, ThemeIcon, ThemeColor,
		TreeItem, SnippetString, TextEdit, SnippetTextEdit, RelativePattern, FileSystemError, WorkspaceEdit,
		Diagnostic, DiagnosticTag, DiagnosticRelatedInformation, CompletionItem, CompletionList, CodeLens,
		DocumentLink, CodeAction, SymbolInformation, DocumentSymbol, CallHierarchyItem, CallHierarchyIncomingCall,
		CallHierarchyOutgoingCall, TypeHierarchyItem, InlayHint, InlayHintKind, InlayHintLabelPart, CancellationError,
		Hover, SignatureHelp, SignatureInformation, ParameterInformation, FoldingRange, FoldingRangeKind,
		DocumentHighlight, DocumentHighlightKind, SelectionRange, LinkedEditingRanges, EvaluatableExpression,
		InlineValueText, InlineValueVariableLookup, InlineValueEvaluatableExpression, InlineCompletionItem,
		InlineCompletionList, InlineCompletionTriggerKind, Color, ColorInformation, ColorPresentation,
		SemanticTokensLegend, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensBuilder,
		DocumentDropEdit, FileDecoration, TerminalLink, TerminalProfile, DataTransfer, DataTransferItem,
		TabInputText, TabInputTextDiff, TabInputWebview, TabInputCustom, TabInputTerminal,
		NotebookCellData, NotebookData, NotebookRange, NotebookCellKind, NotebookCellOutputItem, NotebookEdit, Breakpoint, SourceBreakpoint,
		FunctionBreakpoint, DebugAdapterExecutable, DebugAdapterServer, DebugAdapterNamedPipeServer,
		DebugAdapterInlineImplementation, DebugConsoleMode, TextEditorSelectionChangeKind, TextDocumentSaveReason,
		TextDocumentChangeReason, FileChangeType, TreeItemCheckboxState, SignatureHelpTriggerKind,
		CompletionTriggerKind, CodeActionTriggerKind, CompletionItemTag, SymbolTag, TextEditorCursorStyle,
		TextEditorLineNumbersStyle, EnvironmentVariableMutatorType, CommentMode, TerminalLocation,
		TerminalExitReason, InputBoxValidationSeverity, ColorFormat, LanguageModelError,
		Task, ShellExecution, ProcessExecution, CustomExecution, TaskGroup, TaskScope, TaskRevealKind, TaskPanelKind,
		TestTag, TestMessage, TestRunRequest,

		/** Not part of VS Code's `vscode` module: the mementos and secrets the
		 *  ExtensionContext is built from (extHostBoot / nodeHost wire them in). */
		__mementos: { global: globalState, workspace: workspaceState },
		__secrets: new SecretStorage(bridge),
		__environment: new EnvironmentVariableCollection(ctx.extensionId),

		/** Not part of VS Code's `vscode` module either: the host's tree plumbing — the
		 *  frame's answer to the host calls `tree.getChildren` / `treeView.setVisible` /
		 *  `treeView.select` / `treeView.expand` / `treeView.checkbox`. */
		__serveTree: {
			children: async (viewId: string, handle: string | null): Promise<unknown[]> => {
				const registration = treeRegistrations.get(viewId);
				if (!registration) return [];
				try {
					return await registration.children(handle);
				} catch (error) {
					shimLog('error', `tree view ${viewId}: getChildren/getTreeItem failed: ${String(error)}`, error);
					return [];
				}
			},
			setVisible: (viewId: string, visible: boolean): void => treeRegistrations.get(viewId)?.setVisible(visible),
			select: (viewId: string, handles: string[]): void => treeRegistrations.get(viewId)?.select(handles),
			expand: (viewId: string, handle: string, expanded: boolean): void => treeRegistrations.get(viewId)?.expand(handle, expanded),
			checkbox: (viewId: string, handle: string, state: number): void => treeRegistrations.get(viewId)?.check(handle, state)
		},

		/** Not part of VS Code's `vscode` module either: the host's answer to
		 *  `editor.formatDocument` runs the registered provider over the host's text. */
		__runFormatter: async (id: string, document: { path: string; languageId: string; text: string }, options: { tabSize: number; insertSpaces: boolean }): Promise<unknown[]> => {
			const entry = formattingProviders.get(id);
			if (!entry) throw new Error(`no formatting provider ${id}`);
			const { state } = rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => saveDocument(document.path));
			try {
				const edits = await Promise.resolve(entry.run(view, options, CancellationTokenNone));
				return (Array.isArray(edits) ? edits : []).map((edit) => {
					const value = edit as { range?: Range; newText?: string };
					return { range: value.range ? { start: { line: value.range.start.line, character: value.range.start.character }, end: { line: value.range.end.line, character: value.range.end.character } } : undefined, newText: value.newText ?? '' };
				});
			} catch (error) {
				shimLog('error', `formatting provider ${id} failed on ${document.path}: ${String(error)}`, error);
				throw error;
			}
		},

		/** GGS-patch: not part of VS Code's `vscode` module either — the completion
		 *  answer side (the host's completion UI calls this at every trigger, ranked to
		 *  the best provider for the document). Items cross serialized: the label,
		 *  kind, texts and the (optional) replacement range. */
		__serveCompletions: async (id: string, document: { path: string; languageId: string; text: string }, position: { line: number; character: number }, context: { triggerCharacter?: string }): Promise<unknown[]> => {
			const entry = completionProviders.get(id);
			if (!entry) throw new Error(`no completion provider ${id}`);
			const { state } = rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => saveDocument(document.path));
			try {
				const items = await Promise.resolve(entry.run(view, new Position(position.line, position.character), CancellationTokenNone, { triggerCharacter: context.triggerCharacter, triggerKind: context.triggerCharacter !== undefined ? 1 : 0 }));
				return (Array.isArray(items) ? items : (items as { items?: unknown[] })?.items ?? []).map((item) => {
					const value = item as { label?: unknown; kind?: unknown; detail?: unknown; documentation?: unknown; insertText?: unknown; sortText?: unknown; filterText?: unknown; range?: Range };
					return {
						label: typeof value.label === 'object' && value.label !== null ? (value.label as { label: string }).label : value.label,
						kind: typeof value.kind === 'number' ? value.kind : undefined,
						detail: typeof value.detail === 'string' ? value.detail : undefined,
						documentation: typeof value.documentation === 'string' ? value.documentation : undefined,
						insertText: typeof value.insertText === 'string' ? value.insertText : undefined,
						sortText: typeof value.sortText === 'string' ? value.sortText : undefined,
						filterText: typeof value.filterText === 'string' ? value.filterText : undefined,
						range: value.range ? { start: { line: value.range.start.line, character: value.range.start.character }, end: { line: value.range.end.line, character: value.range.end.character } } : undefined
					};
				});
			} catch (error) {
				shimLog('error', `completion provider ${id} failed on ${document.path}: ${String(error)}`, error);
				return [];
			}
		},

		/** GGS-patch: not part of VS Code's module — the file-decoration ask side: the
		 *  host's explorer batches its paths, this answers the serializable decoration
		 *  per path (badge letter + one of VS Code's decoration colour names). */
		__serveFileDecorationsAsk: async (providerId: string, paths: string[]): Promise<Record<string, { badge: string; color?: string; tooltip?: string } | null>> => {
			const entry = fileDecorationProviders.get(providerId);
			if (!entry) return {};
			const answers: Record<string, { badge: string; color?: string; tooltip?: string } | null> = {};
			for (const path of paths) {
				try {
					const decoration = await Promise.resolve(entry.run(Uri.file(path), CancellationTokenNone));
					if (!decoration) {
						answers[path] = null;
						continue;
					}
					const value = decoration as { badge?: unknown; color?: unknown; tooltip?: unknown };
					const color = value.color;
					answers[path] = {
						badge: typeof value.badge === 'string' && value.badge.length > 0 ? value.badge.slice(0, 2) : '',
						color: typeof color === 'string'
							? color
							: color && typeof color === 'object' && 'id' in (color as Record<string, unknown>)
								? String((color as { id: unknown }).id)
								: undefined,
						tooltip: typeof value.tooltip === 'string' ? value.tooltip : undefined
					};
				} catch (error) {
					shimLog('error', `file decoration provider failed on ${path}: ${String(error)}`, error);
					answers[path] = null;
				}
			}
			return answers;
		},

		/** GGS-patch: the hover answer side (see editorHovers.ts): the serialized hover's
		 *  contents — a plain string or the markdown value's text — plus an optional
		 *  range. Everything exotic degrades to its string form; a null answer is no
		 *  hover. */
		__serveHover: async (id: string, document: { path: string; languageId: string; text: string }, position: { line: number; character: number }): Promise<{ contents: string[]; range?: { start: { line: number; character: number }; end: { line: number; character: number } } } | null> => {
			const entry = hoverProviders.get(id);
			if (!entry) return null;
			const { state } = rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => saveDocument(document.path));
			try {
				const hover = await Promise.resolve(entry.run(view, new Position(position.line, position.character), CancellationTokenNone));
				if (!hover) return null;
				const value = hover as { contents?: unknown[]; range?: Range };
				const contents = (Array.isArray(value.contents) ? value.contents : []).map((entry2) => {
					if (typeof entry2 === 'string') return entry2;
					const markdown = entry2 as { value?: unknown };
					return typeof markdown?.value === 'string' ? markdown.value : String(entry2 ?? '');
				}).filter((text) => text.length > 0);
				if (contents.length === 0) return null;
				return {
					contents,
					range: value.range ? { start: { line: value.range.start.line, character: value.range.start.character }, end: { line: value.range.end.line, character: value.range.end.character } } : undefined
				};
			} catch (error) {
				shimLog('error', `hover provider ${id} failed on ${document.path}: ${String(error)}`, error);
				return null;
			}
		},

		/** GGS-patch: the definition answer side: the symbol's locations as path+range
		 *  pairs — the workbench opens the first one, the rest land in a peek. */
		__serveDefinition: async (id: string, document: { path: string; languageId: string; text: string }, position: { line: number; character: number }): Promise<{ path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]> => {
			const entry = definitionProviders.get(id);
			if (!entry) return [];
			const { state } = rememberDocument(document.path, document.text, document.languageId);
			const view = documentView(state, () => saveDocument(document.path));
			try {
				const locations = await Promise.resolve(entry.run(view, new Position(position.line, position.character), CancellationTokenNone));
				const list = Array.isArray(locations) ? locations : (locations as { uri?: Uri; target?: Uri; range?: Range } | null ? [locations] : []);
				return (list as { uri?: unknown; target?: unknown; range?: Range }[]).map((location) => {
					const uri = (location.target ?? location.uri) as { fsPath?: string; path?: string } | undefined;
					const range = location.range;
					return {
						path: String(uri?.fsPath ?? uri?.path ?? ''),
						startLine: range?.start.line ?? 0,
						startCharacter: range?.start.character ?? 0,
						endLine: range?.end.line ?? 0,
						endCharacter: range?.end.character ?? 0
					};
				}).filter((location) => location.path.length > 0);
			} catch (error) {
				shimLog('error', `definition provider ${id} failed on ${document.path}: ${String(error)}`, error);
				return [];
			}
		},

		/** Not part of VS Code's `vscode` module either: the webview view plumbing — the
		 *  frame's answer to the host calls `webviewView.resolve` (the view's first show)
		 *  and `webviewView.setVisible` (the sidebar's view switching). */
		__serveWebviewView: {
			resolve: async (viewId: string): Promise<void> => {
				const viewProvider = webviewViewProviders.get(viewId);
				if (viewProvider === undefined) {
					shimLog('warn', `webview view ${viewId} was shown but no provider is registered for it`);
					return;
				}
				let view = webviewViews.get(viewId);
				if (view === undefined) {
					view = new WebviewView(bridge, ctx, viewId, {});
					webviewViews.set(viewId, view);
				}
				if (view.resolved) return;
				view.resolved = true;
				try {
					await Promise.resolve(viewProvider.resolveWebviewView(view, { state: undefined }, CancellationTokenNone));
				} catch (error) {
					shimLog('error', `resolveWebviewView(${viewId}) failed: ${String(error)}`, error);
					throw error;
				}
			},
			setVisible: (viewId: string, visible: boolean): void => webviewViews.get(viewId)?.setVisible(visible)
		},

		/** Deliver an event the host pushed in (see `HostEvent`); the frame's single message
		 *  listener routes here — the shim needs no other channel into itself. */
		handleHostEvent: (event: HostEvent) => {
			try {
				dispatchHostEvent(event);
			} catch (error) {
				shimLog('error', `host event ${event?.event} failed: ${String(error)}`, error);
			}
		}
	};

	/** One registered formatter (document or range) behind an id the host routes by. */
	function registerFormatter(selector: unknown, run: (document: Record<string, unknown>, options: unknown, token: CancellationToken) => unknown): Disposable {
		// VS Code selectors arrive as strings (`'python'`) or document filters
		// (`{ language, scheme, pattern }`) — normalized to filter objects for the host match.
		const selectors = (Array.isArray(selector) ? selector : [selector]).map((entry) => (typeof entry === 'string' ? { language: entry } : entry));
		const id = `fmt-${++formatterSeq}`;
		formattingProviders.set(id, { selectors, run });
		send('languages.registerFormatting', [{ id, selectors: selectors.map(plainSelector) }]);
		return new Disposable(() => {
			formattingProviders.delete(id);
			send('languages.unregisterFormatting', [{ id }]);
		});
	}

	dispatchHostEvent = (event: HostEvent): void => {
		if (event.event === 'configChanged' && event.settings) {
			const changed = changedSettingKeys(ctx.settings, event.settings);
			for (const key of Object.keys(ctx.settings)) delete ctx.settings[key];
			Object.assign(ctx.settings, event.settings);
			// VS Code's listeners read the event (`affectsConfiguration(section)`).
			if (changed.length > 0) configurationChanged.fire(configurationChangeEvent(changed));
			return;
		}
		if (event.event === 'webviewMessage' && event.panelId !== undefined) {
			webviewPanels.get(event.panelId)?.receive(event.message);
			return;
		}
		if (event.event === 'webviewDisposed' && event.panelId !== undefined) {
			const panel = webviewPanels.get(event.panelId);
			webviewPanels.delete(event.panelId);
			panel?.close();
			return;
		}
		if (event.event === 'webviewViewState' && event.panelId !== undefined) {
			webviewPanels.get(event.panelId)?.setActive(event.active === true);
			return;
		}
		if (event.event === 'webviewViewMessage' && event.viewId !== undefined) {
			webviewViews.get(event.viewId)?.receive(event.message);
			return;
		}
		if (event.event === 'webviewViewVisible' && event.viewId !== undefined) {
			webviewViews.get(event.viewId)?.setVisible(event.visible ?? false);
			return;
		}
		if (event.event === 'themeChanged' && event.kind !== undefined) {
			themeKind = event.kind;
			themeChangedEmitter.fire({ kind: themeKind });
			return;
		}
		if (event.event === 'workspaceFoldersChanged' && Array.isArray(event.folders)) {
			const before = workspaceFolders;
			workspaceFolders = event.folders.map((path, index) => ({ uri: Uri.file(path), name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, index }));
			const keys = (list: typeof workspaceFolders) => new Set(list.map((folder) => documentKey(folder.uri.fsPath)));
			const beforeKeys = keys(before);
			const afterKeys = keys(workspaceFolders);
			const added = workspaceFolders.filter((folder) => !beforeKeys.has(documentKey(folder.uri.fsPath)));
			const removed = before.filter((folder) => !afterKeys.has(documentKey(folder.uri.fsPath)));
			if (added.length > 0 || removed.length > 0) workspaceFoldersChanged.fire({ added, removed });
			return;
		}
		if (event.event === 'activeEditorChanged') {
			const before = activeEditor?.path;
			const incoming = event.editor ?? null;
			// A selection-only push (same document, no text) keeps the text already held.
			const held = activeEditor ?? null;
			activeEditor = incoming !== null && incoming.text === undefined && held !== null && before === incoming.path
				? { ...incoming, text: held.text }
				: incoming;
			// The document table learns the text; a changed text is an edit VS Code reports.
			let opened = false;
			if (activeEditor !== null && activeEditor.text !== undefined) {
				const remembered = rememberDocument(activeEditor.path, activeEditor.text, activeEditor.languageId);
				opened = remembered.opened;
				if (remembered.changed) fireDocumentChange(remembered.state, remembered.previous);
			}
			if (before !== activeEditor?.path) {
				activeEditorChangedEmitter.fire(activeEditor !== null ? makeTextEditorProxy() : undefined);
				// VS Code's payload for this event is the editors array itself.
				visibleEditorsChanged.fire(activeEditor !== null ? [makeTextEditorProxy()] : []);
			}
			if (activeEditor !== null) {
				const editor = makeTextEditorProxy();
				selectionChanged.fire({ textEditor: editor, selections: editor.selections as unknown[], kind: TextEditorSelectionChangeKind.Keyboard });
			}
			// A document becoming active with its text in hand is VS Code's
			// onDidOpenTextDocument (once per path per session).
			if (opened && activeEditor !== null) {
				shimLog('trace', `onDidOpenTextDocument ${activeEditor.path} (${String(activeEditor.text).length} chars)`);
				documentOpened.fire(makeTextDocument(activeEditor.path));
			}
			return;
		}
		if (event.event === 'documentChanged' && event.path !== undefined && typeof event.text === 'string') {
			const remembered = rememberDocument(event.path, event.text, event.languageId ?? '');
			if (activeEditor?.path === event.path) activeEditor = { ...activeEditor, text: event.text };
			if (remembered.opened) documentOpened.fire(makeTextDocument(event.path));
			else if (remembered.changed) fireDocumentChange(remembered.state, remembered.previous);
			return;
		}
		if (event.event === 'documentClosed' && event.path !== undefined) {
			const key = documentKey(event.path);
			const state = documents.get(key);
			if (state) {
				documents.delete(key);
				documentClosed.fire({ ...documentView(state, async () => false), isClosed: true });
			}
			return;
		}
		if (event.event === 'documentSaved' && event.path !== undefined) {
			documentSaved.fire(makeTextDocument(event.path));
			return;
		}
		if (event.event === 'fsChanged' && event.fs) {
			fsChanged.fire(event.fs);
		}
	};

	/** `onDidChangeTextDocument` for a whole-text replacement (the host sends the new text,
	 *  not the delta — one content change spanning the old document, VS Code's shape). */
	function fireDocumentChange(state: DocumentState, before: string): void {
		const lines = before.split('\n');
		const lastLine = lines.length - 1;
		const range = new Range(0, 0, lastLine, lines[lastLine]!.replace(/\r$/, '').length);
		documentChanged.fire({
			document: documentView(state, () => saveDocument(state.path)),
			contentChanges: [{ range, rangeOffset: 0, rangeLength: before.length, text: state.text }],
			reason: undefined
		});
	}
	return api;
}

/** A document selector's score for a document — VS Code's rules: a string matches the
 *  language (`*` everything); a filter's `language`, `scheme` and `pattern` must all match
 *  where declared; an array takes the best entry. */
export function selectorScore(selector: unknown, document: { languageId?: string; uri?: Uri; fileName?: string } | undefined): number {
	const scoreOne = (entry: unknown): number => {
		if (typeof entry === 'string') return entry === '*' ? 5 : entry === document?.languageId ? 10 : 0;
		if (entry === null || typeof entry !== 'object') return 0;
		const filter = entry as { language?: string; scheme?: string; pattern?: string | { pattern?: string; baseUri?: Uri; base?: string } };
		let score = 0;
		if (filter.language !== undefined) {
			if (filter.language === '*') score = Math.max(score, 5);
			else if (filter.language === document?.languageId) score = 10;
			else return 0;
		}
		if (filter.scheme !== undefined) {
			const scheme = document?.uri?.scheme ?? 'file';
			if (filter.scheme === '*') score = Math.max(score, 5);
			else if (filter.scheme === scheme) score = Math.max(score, 10);
			else return 0;
		}
		if (filter.pattern !== undefined) {
			const path = documentKey(document?.uri?.fsPath ?? document?.fileName ?? '');
			const pattern = typeof filter.pattern === 'string' ? filter.pattern : filter.pattern.pattern ?? '';
			const base = typeof filter.pattern === 'string' ? '' : documentKey(filter.pattern.baseUri?.fsPath ?? filter.pattern.base ?? '');
			const relative = base !== '' && path.toLowerCase().startsWith(base.toLowerCase() + '/') ? path.slice(base.length + 1) : path;
			const matches = watcherGlobMatches(pattern, relative) || watcherGlobMatches(pattern.startsWith('**/') ? pattern : `**/${pattern}`, relative.replace(/^\//, ''));
			if (!matches) return 0;
			score = Math.max(score, 10);
		}
		return score;
	};
	const selectors = Array.isArray(selector) ? selector : [selector];
	return Math.max(0, ...selectors.map(scoreOne));
}

/** A document filter as plain data for the host (a RelativePattern becomes its glob and
 *  base path). */
/** GGS-patch: the renderable subset of a DecorationRenderOptions object (see
 *  editorDecorations.ts); everything else is accepted and ignored. */
function plainDecorationOptions(options: Record<string, unknown> | undefined): Record<string, string | boolean> {
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
function plainDecorationRanges(rangesOrOptions: unknown): { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[] {
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

function plainSelector(entry: unknown): unknown {
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
function serializeDiagnostic(value: unknown): SerializableDiagnostic {
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

export type VscodeApi = ReturnType<typeof createVscodeApi>;

/** The answer `serveHostCall` gives for a method it does not serve. */
export const UNSERVED_HOST_CALL = Symbol('unserved host call');

/** The host → extension call vocabulary every extension host serves the same way (the
 *  sandboxed frame, the real-Node host and ggs-node): tree view walks and pushes, the
 *  formatter run and the webview view resolution. One table, so no host lags the others
 *  (ggs-node answered none of these before, and its tree views stayed empty). */
export function serveHostCall(api: VscodeApi | null, method: string, args: unknown[]): unknown {
	if (api === null) return UNSERVED_HOST_CALL;
	switch (method) {
		case 'tree.getChildren':
			return api.__serveTree.children(args[0] as string, (args[1] as string | null) ?? null);
		case 'treeView.setVisible':
			api.__serveTree.setVisible(args[0] as string, args[1] as boolean);
			return undefined;
		case 'treeView.select':
			api.__serveTree.select(args[0] as string, (args[1] as string[]) ?? []);
			return undefined;
		case 'treeView.expand':
			api.__serveTree.expand(args[0] as string, args[1] as string, args[2] as boolean);
			return undefined;
		case 'treeView.checkbox':
			api.__serveTree.checkbox(args[0] as string, args[1] as string, args[2] as number);
			return undefined;
		case 'formatDocument.run': {
			const [id, doc, options] = args as [string, { path: string; languageId: string; text: string }, { tabSize: number; insertSpaces: boolean }];
			return api.__runFormatter(id, doc, options);
		}
		// GGS-patch: the language-provider run methods the host's ranked callers use
		// (completions/hover/definition/fileDecorations — editorCompletions.ts and
		// editorHovers.ts).
		case 'completion.run': {
			const [id, doc, position, context] = args as [string, { path: string; languageId: string; text: string }, { line: number; character: number }, { triggerCharacter?: string }];
			return api.__serveCompletions(id, doc, position, context);
		}
		case 'hover.run': {
			const [id, doc, position] = args as [string, { path: string; languageId: string; text: string }, { line: number; character: number }];
			return api.__serveHover(id, doc, position);
		}
		case 'definition.run': {
			const [id, doc, position] = args as [string, { path: string; languageId: string; text: string }, { line: number; character: number }];
			return api.__serveDefinition(id, doc, position);
		}
		case 'fileDecorations.ask': {
			const [{ providerId, paths }] = args as [{ providerId: string; paths: string[] }];
			return api.__serveFileDecorationsAsk(providerId, paths);
		}
		case 'webviewView.resolve':
			return api.__serveWebviewView.resolve(args[0] as string);
		case 'webviewView.setVisible':
			api.__serveWebviewView.setVisible(args[0] as string, args[1] as boolean);
			return undefined;
		default:
			return UNSERVED_HOST_CALL;
	}
}

/** The extension's own `Extension<T>` entry — `context.extension` and
 *  `extensions.getExtension(id)` answer the same object, as in VS Code, so a package
 *  reading its own `packageJSON` off either (cspell's activate does) sees one shape. */
export function extensionEntry(context: HostContext): Record<string, unknown> {
	return {
		id: context.extensionId,
		extensionPath: context.extensionPath,
		extensionUri: Uri.file(context.extensionPath),
		extensionKind: ExtensionKind.Workspace,
		isActive: true,
		exports: undefined,
		packageJSON: context.packageJSON ?? {},
		activate: async () => undefined
	};
}

/** Another installed extension as `extensions.getExtension` reports it: its manifest
 *  and path are real; its `exports` live in its own host and cannot be reached from here
 *  (reading them is logged), and `activate()` asks the workbench to wake it. */
function foreignExtension(entry: { id: string; extensionPath: string; packageJSON: Record<string, unknown>; isActive: boolean }): Record<string, unknown> {
	return {
		id: entry.id,
		extensionPath: entry.extensionPath,
		extensionUri: Uri.file(entry.extensionPath),
		extensionKind: ExtensionKind.Workspace,
		packageJSON: entry.packageJSON,
		isActive: entry.isActive,
		get exports(): undefined {
			shimLogOnce(`exports:${entry.id}`, 'warn', `the exports of ${entry.id} are not reachable: every extension runs in its own host here`);
			return undefined;
		},
		activate: async () => {
			shimLogOnce(`activate:${entry.id}`, 'warn', `the exports of ${entry.id} are not reachable: every extension runs in its own host here`);
			return undefined;
		}
	};
}

/** The ExtensionContext VS Code hands to activate(): the mementos are the shim's persisted
 *  ones, the storage directories live under `~/.ggs/` (never inside the install directory
 *  an upgrade replaces), `secrets` and `environmentVariableCollection` are real objects.
 *  Shared by both hosts that run extension code: the sandboxed frame (extHostBoot) and the
 *  real-Node extension host (nodeHost) — one definition, so the two cannot drift. */
export function activationContext(context: HostContext, api: VscodeApi): Record<string, unknown> {
	const globalPath = context.storage?.global ?? context.extensionPath;
	const workspacePath = context.storage ? context.storage.workspace ?? undefined : context.extensionPath;
	const logPath = context.storage?.log ?? context.extensionPath;
	const asAbsolutePath = (relative: string) => `${context.extensionPath.replace(/[\\/]+$/, '')}/${relative.replace(/^\.?[\\/]/, '')}`;
	return {
		subscriptions: [] as Disposable[],
		extensionPath: context.extensionPath,
		extensionUri: Uri.file(context.extensionPath),
		extension: extensionEntry(context),
		extensionMode: ExtensionMode.Production, // neither host has a dev mode
		extensionRuntime: 1,
		globalState: api.__mementos.global,
		workspaceState: api.__mementos.workspace,
		secrets: api.__secrets,
		environmentVariableCollection: api.__environment,
		storagePath: workspacePath,
		storageUri: workspacePath === undefined ? undefined : Uri.file(workspacePath),
		globalStoragePath: globalPath,
		globalStorageUri: Uri.file(globalPath),
		logPath,
		logUri: Uri.file(logPath),
		languageModelAccessInformation: { onDidChange: silentEvent(), canSendRequest: () => undefined },
		asAbsolutePath
	};
}
