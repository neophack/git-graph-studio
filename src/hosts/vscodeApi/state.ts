// The shim's shared state: every cross-namespace table, counter and event
// emitter one api instance owns, plus the helpers more than one namespace calls
// (the document table, the editor proxies, the registration queues) and the host
// event router. Created once per createVscodeApi; the namespace builders receive
// it and close over it.

import type { HostBridge, HostContext, HostEvent, SerializableTextEdit } from './bridge';
import { Position, Range, Selection } from './types/position';
import { pathOf, Uri } from './types/uri';
import { CancellationToken, Disposable, Event, EventEmitter } from './types/events';
import { EndOfLine, TextEditorCursorStyle, TextEditorLineNumbersStyle, TextEditorSelectionChangeKind, ViewColumn } from './types/enums';
import { snippetPlainText, SnippetString } from './types/values';
import { plainDecorationRanges } from './util';
import { changedSettingKeys, ConfigurationChangeEvent, configurationChangeEvent } from './configuration';
import { DocumentState, documentKey, documentView } from './documents';
import { Memento } from './mementos';
import { WebviewPanel, WebviewView } from './webviews';
import { TreeDataProvider, TreeViewRegistration } from './treeViews';
import { guarded, shimLog } from './shimLog';
import { unsupported } from './inert';

export interface ShimState {
	ctx: HostContext;
	bridge: HostBridge;
	send: (method: string, args: unknown[]) => void;
	isZh: boolean;
	webviewPanels: Map<number, WebviewPanel>;
	webviewViews: Map<string, WebviewView>;
	webviewViewProviders: Map<string, { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }>;
	globalState: Memento;
	workspaceState: Memento;
	webviewSeq: number;
	statusSeq: number;
	untitledSeq: number;
	workspaceFoldersChanged: EventEmitter<{ added: unknown[]; removed: unknown[] }>;
	configurationChanged: EventEmitter<ConfigurationChangeEvent>;
	documentSaved: EventEmitter<Record<string, unknown>>;
	documentChanged: EventEmitter<{ document: Record<string, unknown>; contentChanges: unknown[]; reason: undefined }>;
	documentOpened: EventEmitter<Record<string, unknown>>;
	documentClosed: EventEmitter<Record<string, unknown>>;
	fsChanged: EventEmitter<{ root: string; paths: string[]; gitChanged: boolean; truncated: boolean }>;
	claudeTapEvents: EventEmitter<{ dir: 'in' | 'out'; kind: 'sdk' | 'permission' | 'rc' | 'gap'; panelId: number; sessionId: string | null; message: unknown }>;
	claudeTapEmitterProxy: { event: Event<{ dir: 'in' | 'out'; kind: 'sdk' | 'permission' | 'rc' | 'gap'; panelId: number; sessionId: string | null; message: unknown }> };
	activeEditorChangedEmitter: EventEmitter<unknown>;
	visibleEditorsChanged: EventEmitter<unknown[]>;
	selectionChanged: EventEmitter<{ textEditor: unknown; selections: unknown[]; kind?: number }>;
	themeChangedEmitter: EventEmitter<unknown>;
	diagnosticCollections: Set<Map<string, { uri: Uri; diagnostics: unknown[] }>>;
	diagnosticsChanged: EventEmitter<{ uris: Uri[] }>;
	activeEditor: HostEvent['editor'];
	documents: Map<string, DocumentState>;
	workspaceFolders: { uri: Uri; name: string; index: number }[];
	themeKind: number;
	treeRegistrations: Map<string, TreeViewRegistration>;
	formattingProviders: Map<string, { selectors: unknown[]; run: (document: Record<string, unknown>, options: unknown, token: CancellationToken) => unknown }>;
	formatterSeq: number;
	completionProviders: Map<string, { selectors: unknown[]; triggerCharacters: string[]; run: (document: unknown, position: unknown, token: unknown, context: unknown) => unknown }>;
	hoverProviders: Map<string, { selectors: unknown[]; run: (document: unknown, position: unknown, token: unknown) => unknown }>;
	definitionProviders: Map<string, { selectors: unknown[]; run: (document: unknown, position: unknown, token: unknown) => unknown }>;
	fileDecorationProviders: Map<string, { label: string; run: (uri: unknown, token: unknown) => unknown }>;
	rememberDocument: (path: string, text: string, languageId: string, uri?: Uri) => { state: DocumentState; opened: boolean; changed: boolean; previous: string };
	saveDocument: (path: string) => Promise<boolean>;
	makeTextDocument: (path: string) => Record<string, unknown>;
	resolveTreeArgs: (args: unknown[]) => unknown[];
	registerTree: (viewId: string, provider: TreeDataProvider<unknown>) => TreeViewRegistration;
	hostSelection: () => Selection;
	serializeEdits: (edits: readonly unknown[]) => SerializableTextEdit[];
	editBuilder: (edits: SerializableTextEdit[]) => {
		replace: (location: Range | Position, newText: string) => void;
		insert: (position: Position, newText: string) => void;
		delete: (range: Range) => void;
		setEndOfLine: (eol: EndOfLine) => void;
	};
	makeTextEditorProxy: (path?: string) => Record<string, unknown>;
	hostPathOf: (uri: Uri | string) => string;
	wrapHandler: (name: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) => (...args: unknown[]) => unknown;
	ownCommands: Map<string, (...args: unknown[]) => unknown>;
	pendingCommandRegistrations: string[];
	flushCommandRegistrations: () => void;
	pendingOutputLines: [string, string][];
	outputFlushTimer: ReturnType<typeof setTimeout> | null;
	flushOutputLines: () => void;
	scheduleOutputFlush: () => void;
	dispatchHostEvent: (event: HostEvent) => void;
}

export function createShimState(ctx: HostContext, bridge: HostBridge): ShimState {
	const s = {} as ShimState;
	s.ctx = ctx;
	s.bridge = bridge;
	/** A fire-and-forget host request whose failure is logged, never an unhandled rejection. */
	s.send = (method: string, args: unknown[]): void => {
		try {
			void Promise.resolve(bridge.request(method, args)).catch((error) => shimLog('warn', `host request ${method} failed: ${String(error)}`, error));
		} catch (error) {
			shimLog('warn', `host request ${method} failed: ${String(error)}`, error);
		}
	};

	s.isZh = /^zh/i.test(ctx.language);

	/** The webview panels this frame created, by panel id (host events route through them). */
	s.webviewPanels = new Map<number, WebviewPanel>();
	/** The webview views this frame registered, by view id (`registerWebviewViewProvider`). */
	s.webviewViews = new Map<string, WebviewView>();
	/** The providers behind them, by view id (resolved at the view's first show). */
	s.webviewViewProviders = new Map<string, { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }>();
	s.globalState = new Memento(s.ctx, s.bridge, 'global');
	s.workspaceState = new Memento(s.ctx, s.bridge, 'workspace');
	s.webviewSeq = 0;
	s.statusSeq = 0;
	s.untitledSeq = 0;
	s.workspaceFoldersChanged = new EventEmitter<{ added: unknown[]; removed: unknown[] }>();
	s.configurationChanged = new EventEmitter<ConfigurationChangeEvent>();
	s.documentSaved = new EventEmitter<Record<string, unknown>>();
	s.documentChanged = new EventEmitter<{ document: Record<string, unknown>; contentChanges: unknown[]; reason: undefined }>();
	s.documentOpened = new EventEmitter<Record<string, unknown>>();
	s.documentClosed = new EventEmitter<Record<string, unknown>>();
	/** The host's watcher batches — what `createFileSystemWatcher` serves its events from. */
	s.fsChanged = new EventEmitter<{ root: string; paths: string[]; gitChanged: boolean; truncated: boolean }>();
	/** The conversation tap's batches — what `env.onClaudeConversationTap` serves. */
	s.claudeTapEvents = new EventEmitter<{ dir: 'in' | 'out'; kind: 'sdk' | 'permission' | 'rc' | 'gap'; panelId: number; sessionId: string | null; message: unknown }>();
	/** `env.onClaudeConversationTap` hands this out; set before the api literal closes. */
	s.claudeTapEmitterProxy = { event: s.claudeTapEvents.event.bind(s.claudeTapEvents) };
	s.activeEditorChangedEmitter = new EventEmitter<unknown>();
	s.visibleEditorsChanged = new EventEmitter<unknown[]>();
	s.selectionChanged = new EventEmitter<{ textEditor: unknown; selections: unknown[]; kind?: number }>();
	s.themeChangedEmitter = new EventEmitter<unknown>();
	/** The diagnostics registry: every `createDiagnosticCollection` stores here, so
	 *  `languages.getDiagnostics` aggregates and `onDidChangeDiagnostics` fires for real. */
	s.diagnosticCollections = new Set<Map<string, { uri: Uri; diagnostics: unknown[] }>>();
	s.diagnosticsChanged = new EventEmitter<{ uris: Uri[] }>();
	/** The host's view of the active text editor, as the last `activeEditorChanged` push left
	 *  it (text rides along whenever the document itself changed). */
	s.activeEditor = null;
	/** The s.documents whose text the shim holds, by `documentKey`. A document "opens" once
	 *  per session — and only with its text in hand: the first active-editor push for a file
	 *  can race the text load, and a didOpen with an empty body makes a language server
	 *  analyse nothing (cspell's squiggles never arrived that way). */
	s.documents = new Map<string, DocumentState>();
	/** The live workspace folders (the host pushes changes). */
	s.workspaceFolders = s.ctx.workspaceFolders.map((folder) => ({ ...folder, uri: folder.uri instanceof Uri ? folder.uri : Uri.file(pathOf(folder.uri)) }));
	/** The theme kind as the context carried it in / the last themeChanged push left it. */
	s.themeKind = s.ctx.themeKind ?? 2;
	/** The tree views this frame registered, by view id (host calls and events route through). */
	s.treeRegistrations = new Map<string, TreeViewRegistration>();
	/** Document formatting providers this frame registered, by id — the host routes
	 *  `editor.formatDocument` to whichever one matches the document's language. */
	s.formattingProviders = new Map<string, {
		selectors: unknown[];
		run: (document: Record<string, unknown>, options: unknown, token: CancellationToken) => unknown;
	}>();
	s.formatterSeq = 0;
	/** GGS-patch: the registered completion providers (see registerCompletionItemProvider). */
	s.completionProviders = new Map<string, {
		selectors: unknown[];
		triggerCharacters: string[];
		run: (document: unknown, position: unknown, token: unknown, context: unknown) => unknown;
	}>();
	/** GGS-patch: the registered hover and definition providers (see editorHovers.ts). */
	s.hoverProviders = new Map<string, {
		selectors: unknown[];
		run: (document: unknown, position: unknown, token: unknown) => unknown;
	}>();
	s.definitionProviders = new Map<string, {
		selectors: unknown[];
		run: (document: unknown, position: unknown, token: unknown) => unknown;
	}>();
	/** GGS-patch: the registered file decoration providers (see explorerDecorations.ts). */
	s.fileDecorationProviders = new Map<string, {
		label: string;
		run: (uri: unknown, token: unknown) => unknown;
	}>();

	/** The document table entry for a path (created on first sight when `text` is given). */
	s.rememberDocument = (path: string, text: string, languageId: string, uri?: Uri): { state: DocumentState; opened: boolean; changed: boolean; previous: string } => {
		const key = documentKey(path);
		const existing = s.documents.get(key);
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
		s.documents.set(key, state);
		return { state, opened: true, changed: false, previous: text };
	};

	s.saveDocument = (path: string) => {
		return Promise.resolve(s.bridge.request('editor.save', [path])).then((saved) => saved === true, (error) => {
			shimLog('warn', `TextDocument.save(${path}) failed: ${String(error)}`, error);
			return false;
		});
	};

	/** A TextDocument for a path, from the shim's last knowledge of its text. */
	s.makeTextDocument = (path: string) => {
		const state = s.documents.get(documentKey(path)) ?? {
			path,
			uri: Uri.file(path),
			text: s.activeEditor?.path === path ? s.activeEditor.text ?? '' : '',
			languageId: s.activeEditor?.path === path ? s.activeEditor.languageId : '',
			version: 1
		};
		return documentView(state, () => s.saveDocument(state.path));
	};

	/** Translate a tree-item marker (a `view/item/context` menu's argument) back into the
	 *  element the provider returned — the element never crosses the frame boundary. */
	s.resolveTreeArgs = (args: unknown[]) => {
		return args.map((arg) => {
			const marker = arg as { $treeViewId?: unknown; $treeItemHandle?: unknown } | null;
			if (marker === null || typeof marker !== 'object' || typeof marker.$treeViewId !== 'string' || typeof marker.$treeItemHandle !== 'string') return arg;
			return s.treeRegistrations.get(marker.$treeViewId)?.handles.get(marker.$treeItemHandle) ?? arg;
		});
	};

	s.registerTree = (viewId: string, provider: TreeDataProvider<unknown>) => {
		const existing = s.treeRegistrations.get(viewId);
		if (existing) return existing; // re-registering the same id keeps the first provider
		const registration = new TreeViewRegistration(viewId, provider, s.bridge);
		s.treeRegistrations.set(viewId, registration);
		return registration;
	};

	/** The selection the host pushed for the active editor: an anchor/active pair on one
	 *  line (the host reports the cursor and how many characters are selected). */
	s.hostSelection = () => {
		const line = Math.max(1, s.activeEditor?.line ?? 1);
		const column = Math.max(1, s.activeEditor?.column ?? 1);
		return new Selection(line - 1, column - 1, line - 1, column - 1 + (s.activeEditor?.selected ?? 0));
	};

	/** Serialize an edit batch for the host applier (1-based lines, 0-based characters). */
	s.serializeEdits = (edits: readonly unknown[]) => {
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
	};

	/** An edit builder (`TextEditor.edit` / `registerTextEditorCommand`) collecting edits. */
	s.editBuilder = (edits: SerializableTextEdit[]) => {
		const push = (start: { line: number; character: number }, end: { line: number; character: number }, newText: string) => edits.push({ startLine: start.line + 1, startCharacter: start.character, endLine: end.line + 1, endCharacter: end.character, newText });
		return {
			replace: (location: Range | Position, newText: string) => (location instanceof Range || Range.isRange(location) ? push((location as Range).start, (location as Range).end, newText) : push(location as Position, location as Position, newText)),
			insert: (position: Position, newText: string) => push(position, position, newText),
			delete: (range: Range) => push(range.start, range.end, ''),
			setEndOfLine: (_eol: EndOfLine) => unsupported('TextEditorEdit.setEndOfLine', 'the line endings are kept')
		};
	};

	/** A TextEditor for a path: its document from the shim's table, its selection from the
	 *  host's active-editor push (when it is the active one), its edits through the host's
	 *  open-editor applier. */
	s.makeTextEditorProxy = (path = s.activeEditor?.path ?? '') => {
		const isActive = () => s.activeEditor?.path === path;
		const tabSize = Number(s.ctx.defaults?.['editor.tabSize'] ?? 4) || 4;
		const applyEdits = (edits: SerializableTextEdit[]) =>
			Promise.resolve(s.bridge.request('editor.applyEdits', [isActive() ? null : path, edits])).then((applied) => applied === true, (error) => {
				shimLog('warn', `TextEditor edit failed: ${String(error)}`, error);
				return false;
			});
		return {
			get document() {
				return s.makeTextDocument(path);
			},
			get selection() {
				return isActive() ? s.hostSelection() : new Selection(0, 0, 0, 0);
			},
			set selection(value: Selection) {
				if (value?.active) s.send('workspace.openFile', [path, value.active.line + 1, value.active.character + 1]);
			},
			get selections() {
				return [isActive() ? s.hostSelection() : new Selection(0, 0, 0, 0)];
			},
			set selections(value: Selection[]) {
				const first = value?.[0];
				if (first?.active) s.send('workspace.openFile', [path, first.active.line + 1, first.active.character + 1]);
			},
			get visibleRanges() {
				const line = Math.max(0, (s.activeEditor?.line ?? 1) - 1);
				return [new Range(line, 0, line, 0)];
			},
			viewColumn: ViewColumn.One,
			options: { tabSize, insertSpaces: s.ctx.defaults?.['editor.insertSpaces'] !== false, cursorStyle: TextEditorCursorStyle.Line, lineNumbers: TextEditorLineNumbersStyle.On },
			setDecorations: (decorationType: unknown, rangesOrOptions: unknown) => {
				// GGS-patch: REPLACE the type's ranges on this editor's document (VS Code's
				// semantics; an empty array clears). A null path addresses the active file,
				// the same convention `editor.applyEdits` uses.
				const key = (decorationType as { key?: string } | null | undefined)?.key;
				if (!key) return unsupported('TextEditor.setDecorations', 'the decoration type is not from this host');
				const ranges = plainDecorationRanges(rangesOrOptions);
				void s.bridge.request('editor.setDecorations', [isActive() ? null : path, key, ranges]).catch(() => undefined);
			},
			revealRange: (range: Range) => {
				if (range?.start) s.send('workspace.openFile', [path, range.start.line + 1, range.start.character + 1]);
			},
			show: () => s.send('workspace.openFile', [path]),
			hide: () => unsupported('TextEditor.hide'),
			edit: async (callback: (builder: ReturnType<typeof s.editBuilder>) => void, _options?: unknown) => {
				const edits: SerializableTextEdit[] = [];
				guarded('TextEditor.edit callback', () => callback(s.editBuilder(edits)));
				return applyEdits(edits);
			},
			/** A snippet inserts as its plain text (no snippet session with tab stops). */
			insertSnippet: async (snippet: SnippetString | string, location?: Position | Range | readonly (Position | Range)[]) => {
				const text = snippetPlainText(typeof snippet === 'string' ? snippet : snippet.value);
				const targets = location === undefined ? [isActive() ? s.hostSelection() : new Selection(0, 0, 0, 0)] : Array.isArray(location) ? location : [location];
				const edits: SerializableTextEdit[] = [];
				const builder = s.editBuilder(edits);
				for (const target of targets as (Position | Range)[]) builder.replace(target, text);
				return applyEdits(edits);
			}
		};
	};

	/** Every document text the host path spelling for `fs.op` / `editor.*` requests. */
	s.hostPathOf = (uri: Uri | string): string => (typeof uri === 'string' ? uri : uri.scheme === 'file' ? uri.fsPath : uri.toString());

	/** A tree view's element's handle as the menu argument marker (see `resolveTreeArgs`). */
	s.wrapHandler = (name: string, handler: (...args: unknown[]) => unknown, thisArg?: unknown) => (...args: unknown[]) => {
		try {
			return handler.apply(thisArg, s.resolveTreeArgs(args));
		} catch (error) {
			shimLog('error', `command ${name} threw: ${String(error)}`, error);
			throw error;
		}
	};

	/** The commands this extension registered (`registerCommand`), by full id — the ones
	 *  its own `executeCommand` runs locally. */
	s.ownCommands = new Map<string, (...args: unknown[]) => unknown>();

	/** Workbench-side command registrations waiting to cross, flushed as ONE host request:
	 *  each registration is otherwise a full pipe round trip (~2-4 ms), and an activation
	 *  registers dozens (claude-code: 31) — minutes of nothing on a slow disk, a visible
	 *  slice of every activation here. The workbench sees every command the moment the
	 *  queue flushes, which the hosts do as soon as the activation settles
	 *  (`__ggsFlushRegistrations`, called by ggs-node's frame-program installer, the frame
	 *  boot and the real-Node host) and before any `executeCommand`. */
	s.pendingCommandRegistrations = [];
	s.flushCommandRegistrations = (): void => {
		const batch = s.pendingCommandRegistrations;
		s.pendingCommandRegistrations = [];
		if (batch.length > 0) s.send('commands.registerBatch', [batch]);
	};
	/** Output-channel lines waiting to cross, for the same reason: an activation logs
	 *  dozens of lines (claude-code: ~15 on activate) and each was its own round trip.
	 *  Flushed by the same activation-settled hook, before any `show`/`clear` of the
	 *  channel (their order semantics must not jump the queued lines), and — so lines
	 *  appended after the activation settled (a logger the user enables mid-session) reach
	 *  the Output view at all — on a short timer: the activation flush runs once, and
	 *  without it every later line sat in the queue forever (git-graph-rs's enableLog
	 *  logged into a channel that never received it). */
	s.pendingOutputLines = [];
	s.outputFlushTimer = null;
	s.flushOutputLines = (): void => {
		if (s.outputFlushTimer !== null) {
			clearTimeout(s.outputFlushTimer);
			s.outputFlushTimer = null;
		}
		const batch = s.pendingOutputLines;
		s.pendingOutputLines = [];
		if (batch.length > 0) s.send('output.appendBatch', [batch]);
	};
	/** Lines arriving after the activation's own flush cross within `OUTPUT_FLUSH_DELAY`
	 *  of the first queued one. */
	const OUTPUT_FLUSH_DELAY = 100;
	s.scheduleOutputFlush = (): void => {
		if (s.outputFlushTimer === null) {
			s.outputFlushTimer = setTimeout(s.flushOutputLines, OUTPUT_FLUSH_DELAY);
		}
	};

	s.dispatchHostEvent = (event: HostEvent): void => {
		if (event.event === 'configChanged' && event.settings) {
			const changed = changedSettingKeys(s.ctx.settings, event.settings);
			for (const key of Object.keys(s.ctx.settings)) delete s.ctx.settings[key];
			Object.assign(s.ctx.settings, event.settings);
			// VS Code's listeners read the event (`affectsConfiguration(section)`).
			if (changed.length > 0) s.configurationChanged.fire(configurationChangeEvent(changed));
			return;
		}
		if (event.event === 'webviewMessage' && event.panelId !== undefined) {
			s.webviewPanels.get(event.panelId)?.receive(event.message);
			return;
		}
		if (event.event === 'webviewDisposed' && event.panelId !== undefined) {
			const panel = s.webviewPanels.get(event.panelId);
			s.webviewPanels.delete(event.panelId);
			panel?.close();
			return;
		}
		if (event.event === 'webviewViewState' && event.panelId !== undefined) {
			s.webviewPanels.get(event.panelId)?.setActive(event.active === true);
			return;
		}
		if (event.event === 'webviewViewMessage' && event.viewId !== undefined) {
			s.webviewViews.get(event.viewId)?.receive(event.message);
			return;
		}
		if (event.event === 'webviewViewVisible' && event.viewId !== undefined) {
			s.webviewViews.get(event.viewId)?.setVisible(event.visible ?? false);
			return;
		}
		if (event.event === 'themeChanged' && event.kind !== undefined) {
			s.themeKind = event.kind;
			s.themeChangedEmitter.fire({ kind: s.themeKind });
			return;
		}
		if (event.event === 'workspaceFoldersChanged' && Array.isArray(event.folders)) {
			const before = s.workspaceFolders;
			s.workspaceFolders = event.folders.map((path, index) => ({ uri: Uri.file(path), name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, index }));
			const keys = (list: typeof s.workspaceFolders) => new Set(list.map((folder) => documentKey(folder.uri.fsPath)));
			const beforeKeys = keys(before);
			const afterKeys = keys(s.workspaceFolders);
			const added = s.workspaceFolders.filter((folder) => !beforeKeys.has(documentKey(folder.uri.fsPath)));
			const removed = before.filter((folder) => !afterKeys.has(documentKey(folder.uri.fsPath)));
			if (added.length > 0 || removed.length > 0) s.workspaceFoldersChanged.fire({ added, removed });
			return;
		}
		if (event.event === 'activeEditorChanged') {
			const before = s.activeEditor?.path;
			const incoming = event.editor ?? null;
			// A selection-only push (same document, no text) keeps the text already held.
			const held = s.activeEditor ?? null;
			s.activeEditor = incoming !== null && incoming.text === undefined && held !== null && before === incoming.path
				? { ...incoming, text: held.text }
				: incoming;
			// The document table learns the text; a changed text is an edit VS Code reports.
			let opened = false;
			if (s.activeEditor !== null && s.activeEditor.text !== undefined) {
				const remembered = s.rememberDocument(s.activeEditor.path, s.activeEditor.text, s.activeEditor.languageId);
				opened = remembered.opened;
				if (remembered.changed) fireDocumentChange(remembered.state, remembered.previous);
			}
			if (before !== s.activeEditor?.path) {
				s.activeEditorChangedEmitter.fire(s.activeEditor !== null ? s.makeTextEditorProxy() : undefined);
				// VS Code's payload for this event is the editors array itself.
				s.visibleEditorsChanged.fire(s.activeEditor !== null ? [s.makeTextEditorProxy()] : []);
			}
			if (s.activeEditor !== null) {
				const editor = s.makeTextEditorProxy();
				s.selectionChanged.fire({ textEditor: editor, selections: editor.selections as unknown[], kind: TextEditorSelectionChangeKind.Keyboard });
			}
			// A document becoming active with its text in hand is VS Code's
			// onDidOpenTextDocument (once per path per session).
			if (opened && s.activeEditor !== null) {
				shimLog('trace', `onDidOpenTextDocument ${s.activeEditor.path} (${String(s.activeEditor.text).length} chars)`);
				s.documentOpened.fire(s.makeTextDocument(s.activeEditor.path));
			}
			return;
		}
		if (event.event === 'documentChanged' && event.path !== undefined && typeof event.text === 'string') {
			const remembered = s.rememberDocument(event.path, event.text, event.languageId ?? '');
			if (s.activeEditor?.path === event.path) s.activeEditor = { ...s.activeEditor, text: event.text };
			if (remembered.opened) s.documentOpened.fire(s.makeTextDocument(event.path));
			else if (remembered.changed) fireDocumentChange(remembered.state, remembered.previous);
			return;
		}
		if (event.event === 'documentClosed' && event.path !== undefined) {
			const key = documentKey(event.path);
			const state = s.documents.get(key);
			if (state) {
				s.documents.delete(key);
				s.documentClosed.fire({ ...documentView(state, async () => false), isClosed: true });
			}
			return;
		}
		if (event.event === 'documentSaved' && event.path !== undefined) {
			s.documentSaved.fire(s.makeTextDocument(event.path));
			return;
		}
		if (event.event === 'claudeTap' && event.tap) {
			for (const item of event.tap) s.claudeTapEvents.fire(item);
		}
		if (event.event === 'fsChanged' && event.fs) {
			s.fsChanged.fire(event.fs);
		}
	};

	/** `onDidChangeTextDocument` for a whole-text replacement (the host sends the new text,
	 *  not the delta — one content change spanning the old document, VS Code's shape). */
	function fireDocumentChange(state: DocumentState, before: string): void {
		const lines = before.split('\n');
		const lastLine = lines.length - 1;
		const range = new Range(0, 0, lastLine, lines[lastLine]!.replace(/\r$/, '').length);
		s.documentChanged.fire({
			document: documentView(state, () => s.saveDocument(state.path)),
			contentChanges: [{ range, rangeOffset: 0, rangeLength: before.length, text: state.text }],
			reason: undefined
		});
	}
	return s;
}
