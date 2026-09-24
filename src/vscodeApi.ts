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

export interface HostBridge {
	/** Call a host service; resolves with its result, rejects with the host's error. */
	request(method: string, args: unknown[]): Promise<unknown>;
	/** Park a command handler in the frame (functions cannot cross the message boundary). */
	registerCommandHandler(id: string, handler: (...args: unknown[]) => unknown): void;
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
	/** Where a webview panel loads package-local files from (the `ggs://` URL of the install
	 *  directory, trailing slash included) — `asWebviewUri` composes synchronously from it. */
	webviewResourceBase: string;
	/** The persisted memento values (`extHost` loads them from localStorage before the frame
	 *  boots; updates write through the `state.update` bridge). */
	state: { global: Record<string, unknown>; workspace: Record<string, unknown> };
}

/** An event the host pushed into the frame: a configuration change for this extension, a
 *  message from one of its webview panels, a panel going away, the active editor changing
 *  (with its document text when the document changed), a document being saved, a message
 *  from one of its webview views (sidebar), a view's visibility, or a theme change. */
export interface HostEvent {
	event: 'configChanged' | 'webviewMessage' | 'webviewDisposed' | 'activeEditorChanged' | 'documentSaved' | 'webviewViewMessage' | 'webviewViewVisible' | 'themeChanged';
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

/* ---------- The small value types VS Code's API is built from ---------- */

export class Position {
	constructor(readonly line: number, readonly character: number) {}
	compareTo(other: Position): number {
		return this.line !== other.line ? this.line - other.line : this.character - other.character;
	}
}

export class Range {
	constructor(readonly start: Position, readonly end: Position) {}
	with(start = this.start, end = this.end): Range {
		return new Range(start, end);
	}
	get isEmpty(): boolean {
		return this.start.line === this.end.line && this.start.character === this.end.character;
	}
}

export class Location {
	constructor(readonly uri: Uri, readonly range: Range) {}
}

export interface Uri {
	scheme: string;
	path: string;
	fsPath: string;
	query: string;
	fragment: string;
	toString(): string;
	with(change: Partial<Uri>): Uri;
}

function makeUri(scheme: string, path: string, query = '', fragment = ''): Uri {
	const fsPath = path;
	return {
		scheme,
		path,
		fsPath,
		query,
		fragment,
		toString: () => `${scheme}:${path}${query ? '?' + query : ''}${fragment ? '#' + fragment : ''}`,
		with: (change) => makeUri(change.scheme ?? scheme, change.path ?? path, change.query ?? query, change.fragment ?? fragment)
	};
}

export const Uri = {
	file: (path: string) => makeUri('file', path),
	joinPath: (base: Uri, ...segments: string[]) => makeUri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/')),
	parse: (value: string) => {
		const index = value.indexOf(':');
		if (index === -1) return makeUri('untitled', value);
		const scheme = value.slice(0, index);
		// The rest keeps its authority (`//host/path`) inside the path — a scheme-delimited
		// URL like the webview base round-trips through toString() exactly as it came in.
		const rest = value.slice(index + 1);
		const queryAt = rest.indexOf('?');
		const hashAt = rest.indexOf('#');
		const cut = Math.min(...[queryAt, hashAt].filter((at) => at !== -1).concat(rest.length));
		return makeUri(scheme, rest.slice(0, cut), queryAt !== -1 ? rest.slice(queryAt + 1, hashAt === -1 ? undefined : hashAt) : '', hashAt !== -1 ? rest.slice(hashAt + 1) : '');
	}
} as const;

export class Disposable {
	constructor(readonly dispose: () => void) {}
	static from(...disposables: { dispose(): void }[]): Disposable {
		return new Disposable(() => disposables.forEach((d) => d.dispose()));
	}
}

export class EventEmitter<T> {
	private readonly listeners = new Set<(e: T) => any>();
	readonly event = (listener: (e: T) => any) => {
		this.listeners.add(listener);
		return new Disposable(() => this.listeners.delete(listener));
	};
	fire(event: T): void {
		for (const listener of this.listeners) listener(event);
	}
	dispose(): void {
		this.listeners.clear();
	}
}

/** VS Code's cancellation shape: the token reports and notifies, the source cancels. */
export class CancellationTokenSource {
	private readonly emitter = new EventEmitter<void>();
	readonly token = {
		isCancellationRequested: false,
		onCancellationRequested: this.emitter.event
	};
	cancel(): void {
		if (this.token.isCancellationRequested) return;
		this.token.isCancellationRequested = true;
		this.emitter.fire(undefined);
	}
	dispose(): void {
		this.emitter.dispose();
	}
}
export interface CancellationToken {
	isCancellationRequested: boolean;
	onCancellationRequested: (listener: () => unknown) => Disposable;
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 } as const;
export type ViewColumn = (typeof ViewColumn)[keyof typeof ViewColumn];
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum UIKind { Desktop = 1, Web = 2 }
/** The enums and value classes extension code constructs at load time (a destructure off
 *  `require('vscode')` followed by `new`), each with VS Code's own shape — absent exports
 *  would be `undefined` and the `new` would kill the activation. */
export enum ExtensionMode { Development = 1, Test = 2, Production = 3 }
export enum ExtensionKind { UI = 1, Workspace = 2 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum EndOfLine { LF = 1, CRLF = 2 }
export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
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
/** `TreeItem`: what a tree view provider's `getTreeItem` returns — the shape, inert here
 *  (the serializer reads it, `treeView.ts`). */
export class TreeItem {
	label?: string | { label: string; highlights?: [number, number][] };
	description?: string | boolean;
	tooltip?: string | MarkdownString | undefined;
	iconPath?: string | Uri | { light: string | Uri; dark: string | Uri } | ThemeIcon;
	contextValue?: string;
	command?: { command: string; title: string; arguments?: unknown[] };
	accessibilityInformation?: { label: string; role?: string };
	constructor(public collapsibleState?: TreeItemCollapsibleState) {}
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
	replace(range: Range, newText: string): TextEdit {
		this.range = range;
		this.newText = newText;
		return this;
	}
}
/** `RelativePattern`: a base (folder or Uri) and a glob. */
export class RelativePattern {
	constructor(public base: string | Uri, public pattern: string) {}
}
/** `Selection`: a Range whose ends are also anchor/active. */
export class Selection extends Range {
	readonly anchor: Position;
	readonly active: Position;
	constructor(anchor: Position, active: Position) {
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
	static NoPermissions(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'NoPermissions');
	}
	static Unavailable(messageOrUri: string | Uri): FileSystemError {
		return new FileSystemError(String(messageOrUri), 'Unavailable');
	}
}

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

class WorkspaceConfiguration {
	constructor(private readonly ctx: HostContext, private readonly bridge: HostBridge, private readonly section: string) {}

	private key(setting: string): string {
		return this.section === '' ? setting : `${this.section}.${setting}`;
	}

	get<T = unknown>(setting: string, defaultValue?: T): T {
		const value = this.ctx.settings[this.key(setting)];
		return (value as T | undefined) ?? (defaultValue as T);
	}

	has(setting: string): boolean {
		return this.key(setting) in this.ctx.settings;
	}

	async update(setting: string, value: unknown, _target?: ConfigurationTarget): Promise<void> {
		this.ctx.settings[this.key(setting)] = value;
		await this.bridge.request('settings.update', [this.ctx.extensionId, this.key(setting), value]);
	}

	inspect(_setting: string): undefined {
		return undefined;
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
}

/** A live webview panel the extension created; the host owns the tab and the iframe, the
 *  frame-side half only proxies. Disposal arrives as a `webviewDisposed` host event. */
class WebviewPanel {
	private titleValue: string;
	private htmlValue = '';
	private readonly disposed = new EventEmitter<void>();
	private readonly messages = new EventEmitter<unknown>();
	private readonly viewState = new EventEmitter<void>();
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
				const root = this.ctx.extensionPath.replace(/[\\/]+$/, '');
				const rel = path.replace(/\\/g, '/').startsWith(root + '/')
					? path.replace(/\\/g, '/').slice(root.length + 1)
					: path.replace(/\\/g, '/').replace(/^\.\//, '');
				return Uri.parse(this.ctx.webviewResourceBase + rel);
			},
			cspSource: this.ctx.webviewResourceBase
		};
	}

	get title(): string {
		return this.titleValue;
	}

	set title(value: string) {
		this.titleValue = value;
		void this.bridge.request('webview.setTitle', [this.panelId, value]);
	}

	get visible(): boolean {
		return !this.gone;
	}

	get active(): boolean {
		return !this.gone;
	}

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
				const root = this.ctx.extensionPath.replace(/[\\/]+$/, '');
				const rel = path.replace(/\\/g, '/').startsWith(root + '/')
					? path.replace(/\\/g, '/').slice(root.length + 1)
					: path.replace(/\\/g, '/').replace(/^\.\//, '');
				return Uri.parse(this.ctx.webviewResourceBase + rel);
			},
			cspSource: this.ctx.webviewResourceBase
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

	show(): void {
		// The section lives in the sidebar already; VS Code's show reveals it there.
		void this.bridge.request('webviewView.show', [this.viewType]);
	}

	dispose(): void {
		if (this.gone) return;
		this.gone = true;
		void this.bridge.request('webviewView.dispose', [this.viewType]);
		this.messages.dispose();
		this.visibilityChanged.dispose();
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
	private commandValue: string | undefined;
	private visible = false;
	private nameValue: string | undefined;

	constructor(private readonly bridge: HostBridge, readonly id: string, readonly alignment: StatusBarAlignment) {}

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

	get command(): string | undefined {
		return this.commandValue;
	}

	set command(value: string | undefined) {
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
		void this.bridge.request('statusbar.set', [this.id, { alignment: this.alignment, text: this.textValue, tooltip, command: this.commandValue, visible: this.visible }]);
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

/** One registered tree view: the provider, its element handles (host calls walk by handle),
 *  and the visibility events the host pushes. */
class TreeViewRegistration {
	visible = false;
	readonly handles = new Map<string, unknown>();
	private nextHandle = 1;
	readonly visibilityChanged = new EventEmitter<{ visible: boolean }>();
	readonly selectionChanged = new EventEmitter<unknown[]>();

	constructor(readonly viewId: string, private readonly provider: TreeDataProvider<unknown>, private readonly bridge: HostBridge) {
		void bridge.request('treeView.register', [viewId]);
		provider.onDidChangeTreeData?.(() => void bridge.request('treeView.changed', [viewId]));
	}

	/** The host asks for one level's children: elements become handles, `getTreeItem`
	 *  serializes each, and the list crosses as plain JSON. */
	async children(parent: string | null): Promise<unknown[]> {
		const element = parent === null ? undefined : this.handles.get(parent);
		const children = await Promise.resolve(this.provider.getChildren(element));
		const items: unknown[] = [];
		for (const child of children ?? []) {
			const raw = await Promise.resolve(this.provider.getTreeItem(child) as Promise<Record<string, unknown>>);
			const handle = String(this.nextHandle++);
			this.handles.set(handle, child);
			const label = typeof raw.label === 'string' ? raw.label : (raw.label as { label?: string } | undefined)?.label ?? '';
			const iconPath = raw.iconPath as string | { light?: string; dark?: string } | undefined;
			items.push({
				handle,
				label,
				description: typeof raw.description === 'string' ? raw.description : undefined,
				tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : undefined,
				// The extension-relative path crosses the wire; the host resolves it into a
				// data URL before the sidebar renders (the field stays `iconUrl` end to end).
				iconUrl: typeof iconPath === 'string' ? iconPath : iconPath?.light ?? iconPath?.dark,
				collapsibleState: typeof raw.collapsibleState === 'number' ? raw.collapsibleState : 0,
				command: raw.command as { command: string; title?: string; arguments?: unknown[] } | undefined
			});
		}
		return items;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.visibilityChanged.fire({ visible });
	}
}

/* ---------- The API ---------- */

/** A registration this host accepts but cannot serve: noted once on the console, inert from
 *  there — VS Code ignores what it does not know, and an activation that reaches for a
 *  surface this host lacks must survive to run everything else it registered. */
function inert(name: string): Disposable {
	console.info(`[ggs] '${name}' is registered but inert in the Git Graph Studio extension host`);
	return new Disposable(() => undefined);
}

export function createVscodeApi(ctx: HostContext, bridge: HostBridge) {
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
	/** Set below the literal — the literal's `handleHostEvent` forwards into it. */
	let dispatchHostEvent: (event: HostEvent) => void = () => undefined;
	const workspaceFoldersChanged = new EventEmitter<void>();
	const configurationChanged = new EventEmitter<void>();
	const documentSaved = new EventEmitter<{ fileName: string } & Record<string, unknown>>();
	const documentChanged = new EventEmitter<{ fileName: string; languageId: string } & Record<string, unknown>>();
	const documentOpened = new EventEmitter<{ fileName: string } & Record<string, unknown>>();
	const documentClosed = new EventEmitter<{ fileName: string } & Record<string, unknown>>();
	const activeEditorChangedEmitter = new EventEmitter<void>();
	const visibleEditorsChanged = new EventEmitter<void>();
	const selectionChanged = new EventEmitter<void>();
	const editorVisibleRangesChanged = new EventEmitter<void>();
	const editorOptionsChanged = new EventEmitter<void>();
	const themeChangedEmitter = new EventEmitter<unknown>();
	const extensionsChanged = new EventEmitter<void>();
	/** The host's view of the active text editor, as the last `activeEditorChanged` push left
	 *  it (text rides along whenever the document itself changed). */
	let activeEditor: HostEvent['editor'] = null;
	/** The theme kind as the context carried it in / the last themeChanged push left it. */
	let themeKind = ctx.themeKind ?? 2;
	/** The tree views this frame registered, by view id (host calls and events route through). */
	const treeRegistrations = new Map<string, TreeViewRegistration>();

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
		return bridge.request('notify', [kind, message, items.map((item) => (typeof item === 'string' ? item : item.title))]).then((picked) => {
			const title = picked as string | undefined;
			if (title === undefined) return undefined;
			const item = items.find((candidate) => (typeof candidate === 'string' ? candidate === title : candidate.title === title));
			return item ?? undefined;
		}) as Promise<string | MessageItem | undefined>;
	}

	/** Quick picks accept string or object items; the host answers with the picked label and
	 *  the original item comes back. Multi-select degrades to a cancel (the quick input UI
	 *  has no checkboxes) rather than throwing — a picker the host cannot serve reads as
	 *  "the user closed it", the safest lie for compatibility. */
	async function showQuickPick(items: unknown, options?: { placeHolder?: string; canPickMany?: boolean; [key: string]: unknown }): Promise<unknown> {
		const list = await Promise.resolve(items as unknown[]);
		if (options?.canPickMany) {
			console.info('[ggs] showQuickPick with canPickMany is not served by this host; resolving undefined');
			return undefined;
		}
		const entries = (Array.isArray(list) ? list : [list]).map((item) =>
			typeof item === 'string' ? { label: item, item } : { label: String((item as QuickPickItem)?.label ?? item), description: (item as QuickPickItem)?.description, detail: (item as QuickPickItem)?.detail, item }
		);
		return await bridge.request('showQuickPick', [entries.map(({ label, description, detail }) => ({ label, description, detail })), options?.placeHolder ?? '']).then((picked) => {
			const label = picked as string | null | undefined;
			if (label === undefined || label === null) return undefined;
			return entries.find((entry) => entry.label === label)?.item;
		});
	}

	/** A TextDocument for a path, from the host's last knowledge of it (the text is the
	 *  active-editor push's copy when this is the active document, else empty). */
	function makeTextDocument(path: string): Record<string, unknown> {
		const active = activeEditor?.path === path ? activeEditor : null;
		return {
			uri: Uri.file(path),
			fileName: path,
			languageId: active?.languageId ?? '',
			version: 1,
			isDirty: false,
			isUntitled: false,
			isClosed: false,
			getText: () => active?.text ?? '',
			save: async () => true
		};
	}

	/** The active-editor proxy: `activeTextEditor` (undefined with no text editor open). Its
	 *  selection is the host's push (a single range), its `edit` builds a TextEdit batch in
	 *  the frame and hands it to the host's open-editor applier. */
	function makeTextEditorProxy(): Record<string, unknown> {
		const selectionRange = () => {
			const line = Math.max(1, activeEditor?.line ?? 1);
			const column = Math.max(1, activeEditor?.column ?? 1);
			const start = new Position(line - 1, column - 1);
			return new Range(start, new Position(start.line, start.character + (activeEditor?.selected ?? 0)));
		};
		return {
			get document() {
				return activeEditor ? makeTextDocument(activeEditor!.path) : makeTextDocument('');
			},
			get selection() {
				return selectionRange();
			},
			get selections() {
				return [selectionRange()];
			},
			get visibleRanges() {
				const start = new Position(Math.max(0, (activeEditor?.line ?? 1) - 1), 0);
				return [new Range(start, start)];
			},
			viewColumn: ViewColumn.One,
			options: {},
			setDecorations: (_decorationType: unknown, _rangesOrOptions: unknown) => undefined, // decorations are inert in this host
			edit: (callback: (builder: { replace(range: Range, newText: string): void; insert(position: Position, newText: string): void; delete(range: Range): void }) => void) => {
				const edits: SerializableTextEdit[] = [];
				const push = (start: Position, end: Position, newText: string) => edits.push({ startLine: start.line + 1, startCharacter: start.character, endLine: end.line + 1, endCharacter: end.character, newText });
				callback({
					replace: (range: Range, newText: string) => push(range.start, range.end, newText),
					insert: (position: Position, newText: string) => push(position, position, newText),
					delete: (range: Range) => push(range.start, range.end, '')
				});
				// A null path addresses the ACTIVE editor (the host resolves it there).
				return bridge.request('editor.applyEdits', [null, edits]).then((applied) => applied === true) as Promise<boolean>;
			}
		};
	}

	/** The `edit` argument a `registerTextEditorCommand` handler receives: the same builder
	 *  an editor's `edit` takes, applied to the active editor on return. */
	function editorEditBuilder(): { replace(range: Range, newText: string): void; insert(position: Position, newText: string): void; delete(range: Range): void } {
		const edits: SerializableTextEdit[] = [];
		const push = (start: Position, end: Position, newText: string) => edits.push({ startLine: start.line + 1, startCharacter: start.character, endLine: end.line + 1, endCharacter: end.character, newText });
		return {
			replace: (range, newText) => push(range.start, range.end, newText),
			insert: (position, newText) => push(position, position, newText),
			delete: (range) => push(range.start, range.end, '')
		};
	}

	const api = {
		version: '1.61.0-studio',

		commands: {
			registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
				const full = id.includes('.') ? id : `${ctx.extensionId}.${id}`;
				bridge.registerCommandHandler(full, handler);
				void bridge.request('commands.register', [full]);
				return new Disposable(() => void bridge.request('commands.unregister', [full]));
			},
			registerTextEditorCommand: (id: string, handler: (editor: unknown, edit: unknown, ...args: unknown[]) => unknown) => {
				const full = id.includes('.') ? id : `${ctx.extensionId}.${id}`;
				bridge.registerCommandHandler(full, (...args: unknown[]) => {
					const editor = activeEditor ? makeTextEditorProxy() : undefined;
					return editor ? handler(editor, editorEditBuilder(), ...args) : undefined;
				});
				void bridge.request('commands.register', [full]);
				return new Disposable(() => void bridge.request('commands.unregister', [full]));
			},
			executeCommand: (id: string, ...args: unknown[]) => bridge.request('commands.execute', [id, args]) as Promise<unknown>,
			getCommands: async () => (await bridge.request('commands.list', [])) as string[]
		},

		window: {
			showInformationMessage: (message: string, ...rest: unknown[]) => showMessage('info', message, ...rest),
			showWarningMessage: (message: string, ...rest: unknown[]) => showMessage('warning', message, ...rest),
			showErrorMessage: (message: string, ...rest: unknown[]) => showMessage('error', message, ...rest),
			showInputBox: (options?: { prompt?: string; value?: string; placeholder?: string; password?: boolean; ignoreFocusOut?: boolean }) =>
				bridge.request('showInputBox', [options?.prompt ?? '', options?.value ?? '']) as Promise<string | undefined>,
			showQuickPick,
			withProgress: async <T>(options: { title?: string; location?: unknown; cancellable?: boolean }, task: (progress: { report: (value: { message?: string; increment?: number }) => void }) => T | Promise<T>) => {
				const id = (await bridge.request('progress.begin', [options?.title ?? ctx.extensionId])) as number;
				let fraction = 0;
				try {
					return await task({
						report: (value) => {
							fraction = Math.min(1, fraction + (value.increment ?? 0) / 100);
							void bridge.request('progress.report', [id, Math.round(fraction * 100), value.message ?? '']);
						}
					});
				} finally {
					void bridge.request('progress.end', [id]);
				}
			},
			createOutputChannel: (name: string) => ({
				name,
				append: (value: string) => void bridge.request('output.append', [name, value]),
				appendLine: (value: string) => void bridge.request('output.append', [name, value + '\n']),
				clear: () => void bridge.request('output.clear', [name]),
				show: () => void bridge.request('output.show', [name]),
				hide: () => undefined,
				replace: (value: string) => void bridge.request('output.append', [name, value]),
				dispose: () => void bridge.request('output.dispose', [name])
			}),
			createStatusBarItem: (arg1?: number | string, arg2?: number) => {
				const alignment = typeof arg1 === 'number' ? arg1 : arg2 ?? StatusBarAlignment.Left;
				const item = new StatusBarItem(bridge, `${ctx.extensionId}:${++statusSeq}`, alignment);
				void bridge.request('statusbar.create', [item.id, alignment]);
				return item;
			},
			setStatusBarMessage: (text: string, timeout?: number) => {
				const item = new StatusBarItem(bridge, `${ctx.extensionId}:${++statusSeq}:msg`, StatusBarAlignment.Left);
				void bridge.request('statusbar.create', [item.id, StatusBarAlignment.Left]);
				item.text = text;
				item.show();
				if (timeout === undefined) window.setTimeout(() => item.dispose(), 5000);
				else if (timeout > 0) window.setTimeout(() => item.dispose(), timeout);
				return new Disposable(() => item.dispose());
			},
			createWebviewPanel: (viewType: string, title: string, _showOptions?: unknown, options?: Record<string, unknown>) => {
				const panelId = ++webviewSeq;
				const panel = new WebviewPanel(bridge, ctx, viewType, title, options ?? {}, panelId);
				webviewPanels.set(panelId, panel);
				void bridge.request('webview.create', [panelId, viewType, title]);
				return panel;
			},
			registerWebviewViewProvider: (viewId: string, provider: { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }, _options?: unknown) => {
				webviewViewProviders.set(viewId, provider);
				void bridge.request('webviewView.register', [viewId]);
				return new Disposable(() => {
					webviewViewProviders.delete(viewId);
					void bridge.request('webviewView.dispose', [viewId]);
				});
			},
			registerCustomEditorProvider: (_viewType: string, _provider: unknown) => inert('window.registerCustomEditorProvider'),
			registerTreeDataProvider: (viewId: string, treeDataProvider: TreeDataProvider<unknown>) => {
				registerTree(viewId, treeDataProvider);
				return new Disposable(() => void bridge.request('treeView.dispose', [viewId]));
			},
			createTextEditorDecorationType: (_options?: unknown) => {
				const key = `${ctx.extensionId}:${++statusSeq}:deco`;
				console.info(`[ggs] decoration type ${key} registered; decorations are inert in this host`);
				return { key, dispose: () => undefined } as { key: string; dispose(): void };
			},
			showOpenDialog: (options?: { canSelectMany?: boolean; defaultUri?: Uri; filters?: Record<string, string[]>; title?: string }) =>
				bridge.request('dialog.open', [options ?? {}]) as Promise<Uri[] | undefined>,
			showSaveDialog: (options?: { defaultUri?: Uri; filters?: Record<string, string[]>; title?: string }) =>
				bridge.request('dialog.save', [options ?? {}]) as Promise<Uri | undefined>,
			get activeTextEditor(): Record<string, unknown> | undefined {
				return activeEditor ? makeTextEditorProxy() : undefined;
			},
			get visibleTextEditors(): Record<string, unknown>[] {
				return activeEditor ? [makeTextEditorProxy()] : [];
			},
			onDidChangeActiveTextEditor: activeEditorChangedEmitter.event,
			onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
			onDidChangeTextEditorSelection: selectionChanged.event,
			onDidChangeTextEditorVisibleRanges: editorVisibleRangesChanged.event,
			onDidChangeTextEditorOptions: editorOptionsChanged.event,
			get activeColorTheme(): { kind: number } {
				return { kind: themeKind };
			},
			onDidChangeActiveColorTheme: themeChangedEmitter.event,
			showTextDocument: async (documentOrUri: Record<string, unknown> | Uri | string) => {
				const path = typeof documentOrUri === 'string' ? documentOrUri : documentOrUri instanceof Object && 'fsPath' in (documentOrUri as Uri) ? (documentOrUri as Uri).fsPath : String((documentOrUri as { fileName?: string }).fileName ?? '');
				await bridge.request('workspace.openFile', [path]);
				return makeTextEditorProxy();
			},
			createTreeView: (viewId: string, options: { treeDataProvider: TreeDataProvider<unknown> }) => {
				const registration = registerTree(viewId, options.treeDataProvider);
				return {
					get visible(): boolean {
						return registration.visible;
					},
					get title(): string {
						return viewId;
					},
					set title(_value: string) {
						console.info(`[ggs] TreeView.title is inert in this host (${viewId})`);
					},
					set description(_value: string) {
						console.info(`[ggs] TreeView.description is inert in this host (${viewId})`);
					},
					set message(_value: string) {
						console.info(`[ggs] TreeView.message is inert in this host (${viewId})`);
					},
					set badge(_value: { text: string; tooltip?: string } | undefined) {
						console.info(`[ggs] TreeView.badge is inert in this host (${viewId})`);
					},
					onDidChangeVisibility: registration.visibilityChanged.event,
					onDidChangeSelection: registration.selectionChanged.event,
					reveal: () => undefined, // the host has no reveal: the view is already the section
					dispose: () => {
						void bridge.request('treeView.dispose', [viewId]);
						registration.visibilityChanged.dispose();
						registration.selectionChanged.dispose();
					}
				};
			},
			get state(): { focused: boolean } {
				return { focused: document.hasFocus() };
			},
			onDidChangeWindowState: (() => new Disposable(() => undefined)) as never
		},

		workspace: {
			workspaceFolders: ctx.workspaceFolders,
			onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
			getWorkspaceFolder: (uriOrPath?: Uri | string) => {
				const path = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath?.fsPath;
				if (path === undefined) return ctx.workspaceFolders[0] ?? null;
				const normalized = path.replace(/\\/g, '/').toLowerCase();
				const folder = ctx.workspaceFolders.find((candidate) => normalized.startsWith(candidate.uri.fsPath.replace(/\\/g, '/').toLowerCase()));
				return folder ?? null;
			},
			get rootPath(): string | null {
				return ctx.workspaceFolders[0]?.uri.fsPath ?? null;
			},
			get name(): string | null {
				return ctx.workspaceFolders.length > 1 ? ctx.workspaceFolders[ctx.workspaceFolders.length - 1]!.name : ctx.workspaceFolders[0]?.name ?? null;
			},
			getConfiguration: (section = '') => new WorkspaceConfiguration(ctx, bridge, section),
			onDidChangeConfiguration: configurationChanged.event,
			/** A text-document content provider registers (its `activate()` must survive the
			 *  call); this host's diff surface resolves virtual documents through the app's
			 *  own diff editors, so the provider is remembered, never consulted. */
			registerTextDocumentContentProvider: (_scheme: string, _provider: unknown) => new Disposable(() => undefined),
			onDidSaveTextDocument: documentSaved.event,
			onDidChangeTextDocument: documentChanged.event,
			/** The save push arrives after the write; `waitUntil` accepts and ignores (this
			 *  host has no pre-save interception point). */
			onWillSaveTextDocument: (listener: (event: { document: unknown; reason: number; waitUntil(thenable: unknown): void }) => unknown) => {
				return documentSaved.event((document) => {
					listener({ document, reason: 1, waitUntil: () => undefined });
				});
			},
			onDidOpenTextDocument: documentOpened.event,
			onDidCloseTextDocument: documentClosed.event,
			onDidCreateFiles: workspaceFoldersChanged.event as never,
			onDidDeleteFiles: workspaceFoldersChanged.event as never,
			onDidRenameFiles: workspaceFoldersChanged.event as never,
			/** Open a file in the editor area (the host half opens and reveals it); the
			 *  returned document mirrors what the host knows — text arrives with the
			 *  active-editor push an open produces. The content variant
			 *  (`openTextDocument({ content })`) answers an in-memory document, as VS Code does. */
			openTextDocument: async (uriOrPathOrOptions?: Uri | string | { content?: string; language?: string }) => {
				if (uriOrPathOrOptions !== null && typeof uriOrPathOrOptions === 'object' && !(uriOrPathOrOptions as Uri).fsPath) {
					const options = uriOrPathOrOptions as { content?: string; language?: string };
					return {
						uri: Uri.parse('untitled:Untitled-1'),
						fileName: 'Untitled-1',
						languageId: options.language ?? 'plaintext',
						version: 1,
						isDirty: false,
						isUntitled: true,
						isClosed: false,
						getText: () => options.content ?? '',
						save: async () => false
					};
				}
				const path = typeof uriOrPathOrOptions === 'string' ? uriOrPathOrOptions : (uriOrPathOrOptions as Uri | undefined)?.fsPath ?? '';
				await bridge.request('workspace.openFile', [path]);
				return makeTextDocument(path);
			},
			/** A WorkspaceEdit over its `changes`: open editors take their edits through the
			 *  CodeMirror document; closed files are read, spliced and written back through
			 *  `workspace.fs` — the same confinement the fs ops carry. */
			applyEdit: async (edit: { changes?: Record<string, SerializableTextEdit[]>; documentChanges?: unknown[] }) => {
				if (edit.documentChanges) {
					console.info('[ggs] workspace.applyEdit with documentChanges: only its changes entries are served');
				}
				const changes = edit.changes ?? {};
				for (const [uriString, edits] of Object.entries(changes)) {
					const path = uriString.startsWith('file:') ? uriString.slice('file:'.length) : uriString;
					const applied = await bridge.request('editor.applyEdits', [path, edits]);
					if (applied === true) continue;
					const read = (await bridge.request('fs.op', ['read', path])) as { data: string };
					const after = applyTextEditsToText(new TextDecoder().decode(decodeBase64(read.data)), edits);
					await bridge.request('fs.op', ['write', path, undefined, encodeBase64(new TextEncoder().encode(after))]);
				}
				return true;
			},
			asRelativePath: (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean) => {
				const path = (typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath).replace(/\\/g, '/');
				const root = ctx.workspaceFolders[0]?.uri.fsPath.replace(/\\/g, '/').toLowerCase();
				if (root !== undefined && path.toLowerCase().startsWith(root)) return path.slice(root.length).replace(/^\//, '');
				return path;
			},
			createFileSystemWatcher: (_pattern: unknown) => {
				const changed = new EventEmitter<{ type: number; fileName: string } & Record<string, unknown>>();
				// The one file event this frame learns is a save; it feeds the change event,
				// and create/delete stay silent (never a false fire).
				documentSaved.event((document) => changed.fire({ type: 2, fileName: (document as { fileName: string }).fileName, ...document as Record<string, unknown> }));
				return {
					onDidChange: changed.event,
					onDidCreate: (() => new Disposable(() => undefined)) as never,
					onDidDelete: (() => new Disposable(() => undefined)) as never,
					dispose: () => changed.dispose()
				};
			},
			findFiles: async (include: string, _exclude?: string | null, _maxResults?: number) => {
				const root = ctx.workspaceFolders[0]?.uri.fsPath ?? '';
				const found = (await bridge.request('fs.op', ['find', include])) as string[];
				return found.map((relative) => Uri.file(root === '' ? relative : root.replace(/[\\/]+$/, '') + '/' + relative));
			},
			save: async () => false,
			saveAll: async (_includeUntitled?: boolean) => false,
			get textDocuments(): Record<string, unknown>[] {
				return activeEditor ? [makeTextDocument(activeEditor.path)] : [];
			},
			notebookDocuments: [] as never[],
			/** The workspace-confined file services, over the host's `ext_fs` command (bytes
			 *  cross as base64; every path is confined to the open folders there). */
			get fs() {
				const op = (name: string, uri: Uri | string, to?: Uri | string, data?: string) =>
					bridge.request('fs.op', [name, typeof uri === 'string' ? uri : uri.fsPath, to === undefined ? undefined : typeof to === 'string' ? to : to.fsPath, data]);
				return {
					readFile: async (uri: Uri | string) => decodeBase64(((await op('read', uri)) as { data: string }).data),
					readDirectory: async (uri: Uri | string) => (((await op('list', uri)) as { name: string; kind: number }[]).map((entry) => [entry.name, entry.kind])) as [string, number][],
					createDirectory: (uri: Uri | string) => op('mkdir', uri).then(() => undefined),
					delete: (uri: Uri | string) => op('delete', uri).then(() => undefined),
					rename: (uri: Uri | string, to: Uri | string) => op('rename', uri, to).then(() => undefined),
					copy: async (uri: Uri | string, to: Uri | string) => {
						const data = (await op('read', uri)) as { data: string };
						await op('write', to, undefined, data.data);
					},
					isWritableFileSystem: (_scheme: string) => true,
					stat: async (uri: Uri | string) => {
						const stat = (await op('stat', uri)) as { type: number; size: number; mtime: number };
						return { type: stat.type, ctime: 0, mtime: stat.mtime, size: stat.size };
					}
				};
			}
		},

		languages: {
			getLanguages: async () => ['bat', 'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'json', 'kotlin', 'lua', 'markdown', 'plaintext', 'powershell', 'python', 'ruby', 'rust', 'shellscript', 'sql', 'swift', 'typescript', 'xml', 'yaml'],
			match: (selector: unknown, document: { languageId?: string }) => {
				const wanted = typeof selector === 'string' ? [selector] : Array.isArray(selector) ? selector.map((entry) => typeof entry === 'string' ? entry : (entry as { language?: string })?.language) : [(selector as { language?: string })?.language];
				return wanted.includes(document?.languageId) ? 10 : 0;
			},
			/** A diagnostic collection that keeps its entries in memory: set/get/delete/clear
			 *  work as data structures (extensions read their own diagnostics back); no editor
			 *  surface renders them yet. */
			createDiagnosticCollection: (name?: string) => {
				const entries = new Map<string, unknown[]>();
				return {
					name: name ?? 'collection',
					set: (uri: Uri | string, diagnostics: unknown[]) => entries.set(typeof uri === 'string' ? uri : uri.toString(), diagnostics ?? []),
					delete: (uri: Uri | string) => entries.delete(typeof uri === 'string' ? uri : uri.toString()),
					clear: () => entries.clear(),
					forEach: (callback: (diagnostics: unknown[], uri: Uri) => void) => entries.forEach((diagnostics, key) => callback(diagnostics, Uri.parse(key))),
					get: (uri: Uri | string) => entries.get(typeof uri === 'string' ? uri : uri.toString()),
					dispose: () => entries.clear()
				};
			},
			registerCompletionItemProvider: () => inert('languages.registerCompletionItemProvider'),
			registerHoverProvider: () => inert('languages.registerHoverProvider'),
			registerDefinitionProvider: () => inert('languages.registerDefinitionProvider'),
			registerTypeDefinitionProvider: () => inert('languages.registerTypeDefinitionProvider'),
			registerImplementationProvider: () => inert('languages.registerImplementationProvider'),
			registerReferenceProvider: () => inert('languages.registerReferenceProvider'),
			registerDocumentSymbolProvider: () => inert('languages.registerDocumentSymbolProvider'),
			registerWorkspaceSymbolProvider: () => inert('languages.registerWorkspaceSymbolProvider'),
			registerCodeLensProvider: () => inert('languages.registerCodeLensProvider'),
			registerCodeActionsProvider: () => inert('languages.registerCodeActionsProvider'),
			registerDocumentFormattingEditProvider: () => inert('languages.registerDocumentFormattingEditProvider'),
			registerDocumentRangeFormattingEditProvider: () => inert('languages.registerDocumentRangeFormattingEditProvider'),
			registerOnTypeFormattingEditProvider: () => inert('languages.registerOnTypeFormattingEditProvider'),
			registerRenameProvider: () => inert('languages.registerRenameProvider'),
			registerDocumentLinkProvider: () => inert('languages.registerDocumentLinkProvider'),
			registerDocumentHighlightProvider: () => inert('languages.registerDocumentHighlightProvider'),
			registerDocumentSemanticTokensProvider: () => inert('languages.registerDocumentSemanticTokensProvider'),
			registerDocumentRangeSemanticTokensProvider: () => inert('languages.registerDocumentRangeSemanticTokensProvider'),
			registerFoldingRangeProvider: () => inert('languages.registerFoldingRangeProvider'),
			registerSelectionRangeProvider: () => inert('languages.registerSelectionRangeProvider'),
			registerCallHierarchyProvider: () => inert('languages.registerCallHierarchyProvider'),
			registerLinkedEditingRangeProvider: () => inert('languages.registerLinkedEditingRangeProvider'),
			registerInlayHintsProvider: () => inert('languages.registerInlayHintsProvider'),
			registerDocumentDropEditProvider: () => inert('languages.registerDocumentDropEditProvider'),
			registerEvaluatableExpressionProvider: () => inert('languages.registerEvaluatableExpressionProvider'),
			setLanguageConfiguration: () => inert('languages.setLanguageConfiguration')
		},

		tasks: {
			task: (definition: unknown, scope: unknown, name: string, source: string, execution: unknown, problemMatchers?: string[]) => ({ definition, scope, name, source, execution, problemMatchers }),
			registerTaskProvider: () => inert('tasks.registerTaskProvider'),
			fetchTasks: async () => [] as never[],
			executeTask: async (task: unknown) => {
				console.info(`[ggs] tasks.executeTask(${String((task as { name?: string })?.name)}) is inert in this host`);
				return undefined;
			},
			get taskExecutions(): never[] {
				return [];
			},
			onDidStartTask: (() => new Disposable(() => undefined)) as never,
			onDidEndTask: (() => new Disposable(() => undefined)) as never,
			onDidStartTaskProcess: (() => new Disposable(() => undefined)) as never,
			onDidEndTaskProcess: (() => new Disposable(() => undefined)) as never,
			Task, ShellExecution, ProcessExecution, TaskGroup, TaskScope, TaskRevealKind, TaskPanelKind, CustomExecution
		},

		debug: {
			activeDebugSession: undefined,
			activeDebugConsole: { append: () => undefined, appendLine: () => undefined },
			breakpoints: [] as never[],
			registerDebugConfigurationProvider: () => inert('debug.registerDebugConfigurationProvider'),
			registerDebugAdapterDescriptorFactory: () => inert('debug.registerDebugAdapterDescriptorFactory'),
			registerDebugAdapterTrackerFactory: () => inert('debug.registerDebugAdapterTrackerFactory'),
			startDebugging: async () => {
				console.info('[ggs] debug.startDebugging is not served by this host');
				return false;
			},
			addBreakpoints: () => undefined,
			removeBreakpoints: () => undefined,
			onDidStartDebugSession: (() => new Disposable(() => undefined)) as never,
			onDidTerminateDebugSession: (() => new Disposable(() => undefined)) as never,
			onDidChangeActiveDebugSession: (() => new Disposable(() => undefined)) as never,
			onDidReceiveDebugSessionCustomEvent: (() => new Disposable(() => undefined)) as never
		},

		authentication: {
			registerAuthenticationProvider: () => inert('authentication.registerAuthenticationProvider'),
			getSession: async (_providerId: string, _scopes: string[], _options?: unknown) => {
				console.info('[ggs] authentication.getSession resolved undefined (no providers in this host)');
				return undefined;
			},
			getAccounts: async () => [] as never[],
			onDidChangeSessions: (() => new Disposable(() => undefined)) as never
		},

		l10n: {
			t: (message: string, ...args: unknown[]): string => {
				if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') {
					let out = message;
					for (const [key, value] of Object.entries(args[0] as Record<string, unknown>)) out = out.replace(`{${key}}`, String(value));
					return out;
				}
				return message.replace(/\{(\d+)\}/g, (_all, index: string) => String(args[Number(index)] ?? ''));
			},
			bundle: undefined,
			uri: undefined
		},

		comments: {
			createCommentController: (_id: string, _label: string) => {
				console.info('[ggs] comments.createCommentController is inert in this host');
				return {
					commentingRangeProvider: undefined,
					options: {},
					get comments(): never[] {
						return [];
					},
					createCommentThread: () => ({ comments: [], collapsibleState: 0, dispose: () => undefined, canReply: false }),
					dispose: () => undefined
				};
			}
		},

		env: {
			language: ctx.language,
			appName: 'Git Graph Studio',
			appHost: 'desktop',
			appVersion: ctx.appVersion ?? '1.0.0',
			uriScheme: 'ggs',
			uiKind: UIKind.Desktop,
			machineId: 'studio',
			sessionId: ctx.extensionId,
			remoteName: undefined,
			isNewAppInstall: false,
			isTelemetryEnabled: false,
			shell: 'cmd.exe',
			getLanguage: () => ctx.language,
			openExternal: (uri: Uri) => bridge.request('openExternal', [uri.toString()]) as Promise<boolean>,
			clipboard: {
				writeText: (text: string) => bridge.request('clipboard.writeText', [text]) as Promise<void>,
				readText: () => bridge.request('clipboard.readText', []) as Promise<string>
			}
		},

		extensions: {
			/** Only the extension itself is known to the frame — its exports never cross the
			 *  frame boundary, and another extension's API surface is not reachable. */
			getExtension: (extensionId: string) => {
				if (extensionId !== ctx.extensionId) return undefined;
				return {
					id: ctx.extensionId,
					extensionPath: ctx.extensionPath,
					isActive: true,
					exports: undefined,
					packageJSON: {},
					activate: async () => undefined
				};
			},
			onDidChange: extensionsChanged.event as never,
			all: [{ id: ctx.extensionId, extensionPath: ctx.extensionPath, isActive: true, exports: undefined, packageJSON: {}, activate: async () => undefined }] as never[]
		},

		Uri,
		Position,
		Range,
		Selection,
		Location,
		Disposable,
		EventEmitter,
		CancellationTokenSource,
		ViewColumn,
		StatusBarAlignment,
		ConfigurationTarget,
		TreeItemCollapsibleState,
		ProgressLocation,
		UIKind,
		ExtensionMode,
		ExtensionKind,
		FileType,
		EndOfLine,
		OverviewRulerLane,
		TextEditorRevealType,
		QuickPickItemKind,
		DiagnosticSeverity,
		CompletionItemKind,
		SymbolKind,
		CommentThreadCollapsibleState,
		CodeActionKind,
		MarkdownString,
		ThemeIcon,
		ThemeColor,
		TreeItem,
		SnippetString,
		TextEdit,
		RelativePattern,
		FileSystemError,

		/** Not part of VS Code's `vscode` module: the mementos `ExtensionContext.globalState` /
		 *  `workspaceState` are built from (extHostBoot wires them into the context). */
		__mementos: { global: globalState, workspace: workspaceState },

		/** Not part of VS Code's `vscode` module either: the host's tree plumbing — the
		 *  frame's answer to the host calls `tree.getChildren` and `treeView.setVisible`
		 *  (extHostBoot routes them here). */
		__serveTree: {
			children: async (viewId: string, handle: string | null): Promise<unknown[]> => (await treeRegistrations.get(viewId)?.children(handle)) ?? [],
			setVisible: (viewId: string, visible: boolean): void => treeRegistrations.get(viewId)?.setVisible(visible)
		},

		/** Not part of VS Code's `vscode` module either: the webview view plumbing — the
		 *  frame's answer to the host calls `webviewView.resolve` (the view's first show)
		 *  and `webviewView.setVisible` (the sidebar's view switching). */
		__serveWebviewView: {
			resolve: async (viewId: string): Promise<void> => {
				const provider = webviewViewProviders.get(viewId);
				if (provider === undefined) return;
				let view = webviewViews.get(viewId);
				if (view === undefined) {
					view = new WebviewView(bridge, ctx, viewId, {});
					webviewViews.set(viewId, view);
				}
				if (view.resolved) return;
				view.resolved = true;
				await Promise.resolve(provider.resolveWebviewView(view, { extensionId: ctx.extensionId, extensionPath: ctx.extensionPath, globalState, workspaceState }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => undefined) }));
			},
			setVisible: (viewId: string, visible: boolean): void => webviewViews.get(viewId)?.setVisible(visible)
		},

		/** Deliver an event the host pushed in (see `HostEvent`); the frame's single message
		 *  listener routes here — the shim needs no other channel into itself. */
		handleHostEvent: (event: HostEvent) => dispatchHostEvent(event)
	};

	dispatchHostEvent = (event: HostEvent): void => {
		if (event.event === 'configChanged' && event.settings) {
			for (const key of Object.keys(ctx.settings)) delete ctx.settings[key];
			Object.assign(ctx.settings, event.settings);
			configurationChanged.fire(undefined);
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
		if (event.event === 'activeEditorChanged') {
			const before = activeEditor?.path;
			const incoming = event.editor ?? null;
			// A selection-only push (same document, no text) keeps the text already held.
			const held = activeEditor ?? null;
			activeEditor = incoming !== null && incoming.text === undefined && held !== null && before === incoming.path
				? { ...incoming, text: held.text }
				: incoming;
			if (before !== activeEditor?.path) {
				activeEditorChangedEmitter.fire(undefined);
				visibleEditorsChanged.fire(undefined);
			}
			selectionChanged.fire(undefined);
			return;
		}
		if (event.event === 'documentSaved' && event.path !== undefined) {
			// The save refreshed the file on disk; the active-document copy (if it is the
			// saved one) may be stale — the next active-editor push re-sends it.
			documentSaved.fire(makeTextDocument(event.path) as { fileName: string } & Record<string, unknown>);
		}
	};

	return api;
}

export type VscodeApi = ReturnType<typeof createVscodeApi>;
