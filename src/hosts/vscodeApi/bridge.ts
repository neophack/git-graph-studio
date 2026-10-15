// The bridge contract between the `vscode` shim and whichever host runs it: the
// `HostBridge` the frame/main-window boundary takes, the `HostContext` an
// activation boots with, the `HostEvent` pushes the host sends back, and the pure
// helpers both sides share (edit splicing, the local provider read).

import type { Uri } from './types/uri';
import { shimLog } from './shimLog';
import type { ShimLogLevel } from './shimLog';

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
	/** Park a file-system provider in the frame — the host's `vscode.open` / `vscode.diff`
	 *  ask it back (`fsProvider.read`) for a scheme's text, exactly as for the content
	 *  providers above. claude-code stages its change-review diffs' both sides in
	 *  in-memory `workspace.registerFileSystemProvider` schemes. */
	registerFsProvider?(scheme: string, provider: { readFile?: (uri: unknown) => unknown }): void;
	/** Forget a parked file-system provider (its Disposable ran). */
	unregisterFsProvider?(scheme: string): void;
}

/** The bridge-side half of a local provider read: this side's own registration answers
 *  from its parked map — `null` when the scheme is not registered here, so the host's
 *  global lookup stays the fallback (another extension may own the scheme). Every host
 *  bridge (`docProvider.provide`'s own lookup) serves the same shape. An fs-provider
 *  registration answers through its `readFile` when the scheme carries one — claude-code
 *  stages its change-review diffs in `_claude_*_fs_*` file-system schemes — the bytes
 *  decoded as UTF-8, a thenable awaited. */
export function readLocalDocProvider(
	docProviders: Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>,
	uri: Uri,
	fsProviders?: Map<string, { readFile?: (uri: unknown) => unknown }>
): string | PromiseLike<string> | null {
	const provider = docProviders.get(uri.scheme);
	if (provider?.provideTextDocumentContent) {
		const text = provider.provideTextDocumentContent(uri);
		return text === undefined || text === null ? '' : (text as string | PromiseLike<string>);
	}
	const fsProvider = fsProviders?.get(uri.scheme);
	if (!fsProvider?.readFile) return null;
	const readText = (): string | PromiseLike<string> => {
		const bytes = fsProvider.readFile!(uri);
		if (bytes === null || bytes === undefined) return '';
		if (typeof bytes === 'string') return bytes;
		const decode = (view: Uint8Array): string => {
			const decoder = new TextDecoder();
			return decoder.decode(view);
		};
		if (bytes instanceof Uint8Array) return decode(bytes);
		return Promise.resolve(bytes).then((view) => decode(new Uint8Array(view as ArrayBufferView as Uint8Array)));
	};
	try {
		return readText();
	} catch (error) {
		// A FileNotFound-style throw reads as "not this scheme's answer": the host's
		// global lookup (or the diff's own error) takes it from here.
		shimLog('warn', `fs provider readFile(${uri.toString()}) failed: ${String(error)}`);
		return null;
	}
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
	event: 'configChanged' | 'webviewMessage' | 'webviewDisposed' | 'activeEditorChanged' | 'documentSaved' | 'webviewViewMessage' | 'webviewViewVisible' | 'themeChanged' | 'fsChanged' | 'documentChanged' | 'documentClosed' | 'workspaceFoldersChanged' | 'webviewViewState' | 'claudeTap';
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
	/** A conversation-tap batch (claudeTap): the Claude Code chat traffic a subscribed
	 *  extension mirrors (each item: direction, shape, the panel, the session, the
	 *  message itself — or a `gap` marker after the host dropped mirror-side events). */
	tap?: { dir: 'in' | 'out'; kind: 'sdk' | 'permission' | 'rc' | 'gap'; panelId: number; sessionId: string | null; message: unknown }[];
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
