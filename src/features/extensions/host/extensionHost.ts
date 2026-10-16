import { EXT_HOST_LOG_OWNER } from './sharedTypes';
import { WebviewDelivery, WebviewHandle, WebviewViewRecord } from './sharedTypes';
import { ExtStatusBarItem } from './sharedTypes';
import { FormatterSelector } from './sharedTypes';
import { PageDiffRequest, PageFrameHandle, PageTheme } from './sharedTypes';
;
import { FrameHandle } from './sharedTypes';
import { ClaudeChatTicket, ClaudeRcState, ClaudeTapSub } from './sharedTypes';
import { ActivationPolicy } from './sharedTypes';
// The extension host's main-window half: it lists the extensions the Rust side installed from
// `.vsix` files, spins up one sandboxed frame per extension (ext-host.html), feeds
// each its entry bundle, and serves the frames' host requests - the workbench command
// registry, notifications, quick inputs, settings persistence, opener and clipboard calls,
// withProgress toasts, status bar items, output channels and webview panels - over
// postMessage. Events flow back as `__studioExtEvent` pushes (configuration changes, webview
// messages, disposals).
//
// The host never interprets a package: every installed package is listed from its manifest,
// its commands dispatch to its own frame (a VSIX) or its own backend process (a `ggs/2`
// package), and its pages mount as sandboxed frames over the `ggs://` protocol.

import { type ExtInfo, type StudioManifest } from '../../../platform/ipc/ext';
import { type ExtProcessInfo, extProcessHostRespond } from '../../../platform/ipc/extProcess';
import { type GalleryEntry } from '../../../platform/ipc/gallery';
import { listen } from '../../../platform/ipc/core';
import { commands } from '../../../platform/commands';
import { type ManifestContributes } from '../contributions';
import { extLog, flushExtLog, setExtLogOutput } from '../extLog';
import type { EditorPlacement } from '../../editor/types';
import { t } from '../../../platform/i18n';
import * as state from '../../../platform/state';
import { type ProgressToast } from '../../../platform/ui/index';
import { hook } from '../../../platform/hooks';
import type { SerializedTreeItem } from '../treeView';
import { type ChatAnswer } from '../claudeChatInject';

export type { ExtInfo, ExtProcessInfo, GalleryEntry, StudioManifest };

/* ---------- The ExtensionHost class shell ---------- */
/* The fields, constructor and statics live here; the method bodies live in the
 * concern files (frames/store/activation/...), typed against this class through
 * ThisType, and host/index.ts Object.assigns them onto the prototype — so every
 * consumer of ExtensionHost sees one class, unchanged. The methods are declared
 * (not private) so the concern files can call across concerns through `this`. */
export const HOST_REQUEST_EVENT = 'ext-host-request';
/** The Tauri event a backend's state-carrying host request is mirrored on (a command
 *  registration, a `setContext` key, a status bar item, a webview panel's create / title /
 *  reveal / dispose — ext_routing.rs decides which): `{ extId, method, args, served,
 *  caller }`. Every frontend but the one that served the request applies it without
 *  answering, so a remote page and the desktop window show the same entries
 *  (docs/ggs-remote-plan.md §8.6 #1); `caller` is the frontend whose call caused it. */

export const HOST_STATE_EVENT = 'ext-host-state';
/** The Tauri event a provider switch's backend restart announces (cmd_providers emits it
 *  when the fresh process's start attempt settles, success or failure — the old process
 *  is dead either way; payload: the extension id). The host resets that extension's
 *  settled webview views on it — their pages were set by the old process and would keep
 *  showing what it rendered (the login page of the provider it booted under). */

export const BACKEND_RESTARTED_EVENT = 'ext-backend-restarted';

export class ExtensionHost {
	readonly frames = new Map<string, FrameHandle>();

	readonly declaredCommandIds = new Map<string, string[]>();

	readonly formattingProviders = new Map<string, { extId: string; id: string; selectors: FormatterSelector[]; handle: FrameHandle }>();

	readonly completionProviders = new Map<string, { extId: string; id: string; selectors: FormatterSelector[]; handle: FrameHandle; triggerCharacters: string[] }>();

	readonly hoverProviders = new Map<string, { extId: string; id: string; selectors: FormatterSelector[]; handle: FrameHandle }>();

	readonly fileDecorationProviders = new Map<string, { extId: string; id: string; handle: FrameHandle }>();

	extensionDecorations: { key: string; path: string; badge: string; color?: string; tooltip?: string }[] = [];

	onFileDecorationsChanged: (() => void) | null = null;

	readonly definitionProviders = new Map<string, { extId: string; id: string; selectors: FormatterSelector[]; handle: FrameHandle }>();

	readonly dependencyWarned = new Set<string>();

	readonly documentChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

	readonly processOnly = new Set<string>();

	readonly pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

	nextRpcId = 1;

	nextCallId = 1;

	activated = false;

	onNativeCommand: ((command: string) => boolean) | null = null;

	onContributionsApplied: (() => void) | null = null;

	installedExts: ExtInfo[] = [];

	readonly pageFrames = new Map<number, PageFrameHandle>();

	nextPageSerial = 1;

	onOpenDiff: ((diff: PageDiffRequest, placement?: EditorPlacement) => void) | null = null;

	onOpenFileAtRevision: ((revision: string, path: string, title: string, repo?: string) => void) | null = null;

	onShowView: ((id: string) => void) | null = null;

	onRevealTerminal: (() => void) | null = null;

	onRunInTerminal: ((command: string) => void) | null = null;

	onRepoChanged: (() => void) | null = null;

	onForwardKey: ((key: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) => void) | null = null;

	onOpenContent: ((title: string, path: string, text: string, placement?: EditorPlacement) => void) | null = null;

	readonly processBacked = new Set<string>();

	readonly extHasMain = new Map<string, boolean>();

	readonly processCommandIds = new Set<string>();

	readonly docProviders = new Map<string, FrameHandle>();

	readonly fsProviders = new Map<string, FrameHandle>();

	nextExtDocSerial = 1;

	webviewTheme: { kind: 'vscode-dark' | 'vscode-light'; css: string; vars: Record<string, string> } | null = null;

	readonly webviews = new Map<string, WebviewHandle>();

	declare webviewKey: (extId: string, panelId: number) => string ;

	nextWebviewPanelId = 1;

	readonly webviewSessions = new Map<string, string>();

	readonly pendingWebviewOpens = new Map<string, { sessionId: string; at: number }>();

	readonly webviewViews = new Map<string, WebviewViewRecord>();

	readonly resolvedWebviewViews = new Set<string>();

	onOpenWebview: ((panelId: number, title: string, extId: string, placement?: EditorPlacement, focus?: boolean) => void) | null = null;

	onCloseWebviewTab: ((tabId: string) => void) | null = null;

	onRevealWebviewTab: ((tabId: string) => void) | null = null;

	onRenameWebviewTab: ((tabId: string, title: string) => void) | null = null;

	onRevealWebviewView: ((viewId: string) => void) | null = null;

	readonly statusItems = new Map<string, ExtStatusBarItem>();

	onStatusBarItems: ((items: ExtStatusBarItem[]) => void) | null = null;

	readonly outputChannels = new Map<string, string[]>();

	onOutputChannels: ((channels: { extId: string; name: string }[]) => void) | null = null;

	onOutputAppend: ((extId: string, name: string, line: string) => void) | null = null;

	onOutputClearChannel: ((extId: string, name: string) => void) | null = null;

	onOutputReveal: ((extId: string, name: string) => void) | null = null;

	onApplyEdits: ((path: string | null, edits: { startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }[]) => boolean) | null = null;

	onDecorateType: ((key: string, options: Record<string, string | boolean>) => void) | null = null;

	onSetDecorations: ((path: string | null, key: string, ranges: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]) => void) | null = null;

	decorTypesByExt = new Map<string, Set<string>>();

	onOpenFile: ((path: string, line?: number, column?: number, placement?: EditorPlacement) => void) | null = null;

	documentText: ((path: string) => string | null) | null = null;

	onSaveFile: ((path: string) => Promise<boolean>) | null = null;

	onTreeMeta: ((viewId: string, meta: { title?: string; description?: string; message?: string; badge?: { value: number; tooltip?: string } }) => void) | null = null;

	activeText: (() => string | null) | null = null;

	lastPushedDocument: string | null = null;

	readonly progress = new Map<number, { toast: ProgressToast; extId: string }>();

	nextProgressId = 1;

	readonly treeProviders = new Map<string, string>();

	onTreeRefresh: ((viewId: string) => void) | null = null;

	onViewsChanged: (() => void) | null = null;

	onContextChanged: (() => void) | null = null;

	readonly activationPolicies = new Map<string, ActivationPolicy>();

	readonly pendingActivations = new Map<string, Promise<void>>();

	readonly activationWaiters = new Map<string, () => void>();

	nodeHostExe: string | null = null;

	readonly remoteHandles = new Map<string, FrameHandle>();

	declare backendHosted: (extId: string) => boolean ;

	declare remoteHandle: (extId: string) => FrameHandle ;

	declare ensureNodeHost: (extId: string) => Promise<void> ;

	declare replayRegistrations: (extId: string) => Promise<void> ;

	declare applyMirroredState: (extId: string, method: string, args: unknown[]) => void ;

	declare sharesWebviews: (extId: string) => boolean ;

	readonly webviewCopies = new Set<string>();

	declare mountWebviewCopy: (container: HTMLElement, stream: string, extId?: string) => () => void ;

	declare webviewFrameFor: (stream: string) => HTMLIFrameElement | null ;

	declare ensureWebviewShown: (stream: string) => void ;

	constructor() {
		window.addEventListener('message', (event) => this.onMessage(event));
		// The extension host log's Output channel ("Extension Host"), and its two commands.
		setExtLogOutput((line) => this.appendOutput(EXT_HOST_LOG_OWNER, t('extensions.logChannel'), line));
		commands.register({ id: 'extensions.showLog', title: 'Show Extension Host Log', category: 'Extensions', run: () => this.showLog() });
		commands.register({ id: 'extensions.openLogFile', title: 'Open Extension Host Log File', category: 'Extensions', run: () => void this.openLogFile() });
		// A real-Node extension host's `ggs.hostRequest`s arrive as backend events: served
		// through the same `serve` path a frame's RPC takes, answered over the backend's
		// stdin. `ensureNodeHost` registers the remote handle before *its* starts, but the
		// Rust boot pass starts (and activates) node backends with no frontend touch at
		// all — those first asks (the activation's `host.env`, a settings push it missed)
		// arrived to `frames.get` returning nothing and were refused, leaving the backend
		// dead until some view happened to resolve it. The handle is created on the spot:
		// an extId with no process fails the push honestly, and one with a process — the
		// boot-pass shape — now activates.
		void listen<{ extId: string; id: number; method: string; args: unknown[]; frontend?: string }>(HOST_REQUEST_EVENT, (event) => {
			const { extId, id, method, args, frontend } = event.payload;
			// One instance, several frontends (the desktop window, remote sessions): each
			// request is addressed to one of them, and only that one answers it
			// (docs/ggs-remote-plan.md §8.6 #1).
			if (frontend && !hook('session').addressedHere(frontend)) return;
			const handle = this.frames.get(extId) ?? this.remoteHandle(extId);
			this.frames.set(extId, handle);
			const respond = (ok: boolean, result: unknown) => {
				void extProcessHostRespond(extId, id, ok, result)
					.catch((error) => extLog('warn', extId, `host request ${method}: the answer could not be delivered: ${String(error)}`));
			};
			this.serve(method, args ?? [], extId, handle).then(
				(result) => respond(true, result === undefined ? null : result),
				(error) => respond(false, String(error))
			);
		}).catch((error) => extLog('warn', 'host', `the extension-host request channel is unavailable: ${String(error)}`));
		// The same backend's registrations another frontend served: applied here too, never
		// answered (the serving frontend already did) — Claude Code's activity-bar container
		// is gated on a `setContext` key, and a frontend that missed it never shows the entry.
		void listen<{ extId: string; method: string; args: unknown[]; served?: string; caller?: string | null }>(HOST_STATE_EVENT, (event) => {
			const { extId, method, args, served } = event.payload;
			if (served === hook('session').frontendId()) return;
			this.applyMirroredState(extId, method, args ?? []);
		}).catch((error) => extLog('warn', 'host', `the extension-host state channel is unavailable: ${String(error)}`));
		// The desktop window is where every backend extension's webviews live (ext_routing.rs):
		// it tells the replica host which frame a remote page's copy reads (§22.6).
		if (hook('session').frontendClass() === 'main') {
			hook('webviewStreams')?.setWebviewFrameSource({
				frameFor: (stream) => this.webviewFrameFor(stream),
				ensure: (stream) => this.ensureWebviewShown(stream)
			});
		}
		// A provider switch restarted a bridged extension's backend (cmd_providers): the
		// fresh process re-activated, but its sidebar views stay marked resolved with the
		// old process's page — the claude chat would keep showing the login state it
		// rendered before the switch. Reset them and ask the fresh provider to resolve
		// again.
		void listen<string>(BACKEND_RESTARTED_EVENT, (event) => {
			this.resetViewsAfterBackendRestart(event.payload);
		}).catch((error) => extLog('warn', 'host', `the backend-restart channel is unavailable: ${String(error)}`));
		// An extension's own settings change (its update(), or the Settings dialog writing the
		// same key) reaches its frame as a configChanged event — `onDidChangeConfiguration`.
		// A process-hosted extension whose remote handle does not exist yet gets one on the
		// spot: the Rust boot pass starts (and activates) the backend before any view has
		// resolved it, so a push that waited for `frames.get` landed on nothing and the
		// backend kept the settings it was activated with forever. An extId with no process
		// at all fails the push, which the send swallows — the next activation reads the
		// fresh settings through `host.env` anyway.
		document.addEventListener(state.EXT_SETTINGS_EVENT, (event) => {
			const extId = (event as CustomEvent<string>).detail;
			const handle = this.frames.get(extId) ?? this.remoteHandle(extId);
			this.frames.set(extId, handle);
			handle.send?.({ type: '__studioExtEvent', event: 'configChanged', settings: state.extSettings(extId) });
		});
		window.addEventListener('beforeunload', () => void flushExtLog());
		// The backend watcher's batches reach every frame as fsChanged events — the half of
		// `workspace.createFileSystemWatcher` that makes an extension's view refresh on
		// external changes (and on commits made in the app's own Source Control). The event
		// name is main.rs's `FS_CHANGED_EVENT` ('studio://fs-changed'); the constant lives
		// with the workbench, which this module must not import (it imports this one).
		// The same batch rides the page channel (kind: 'fs') — a package's ggs:// page has
		// no frame and no vscode API to watch with, so the batch is the only way its view
		// (the graph's) learns a file changed or a stage/commit landed without polling.
		void listen<{ root: string; paths: string[]; gitChanged: boolean; truncated: boolean }>('studio://fs-changed', (event) => {
			for (const handle of this.frames.values()) {
				handle.send?.({ type: '__studioExtEvent', event: 'fsChanged', fs: event.payload });
			}
			for (const page of this.pageFrames.values()) {
				page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'fs', ...event.payload } }, '*');
			}
		}).catch(() => undefined);
		// The theme cache for webview documents: the first `composeWebview` needs it ready.
		void this.refreshWebviewTheme().catch(() => undefined);
	}

	declare list: () => Promise<ExtInfo[]> ;

	readonly prewarmedExts = new Set<string>();

	declare prewarmPageAssets: (extId: string) => void ;

	declare readFile: (extId: string, relPath: string) => Promise<string> ;

	declare readMainFile: (extId: string, main: string) => Promise<string> ;

	declare installFromVsix: (path: string) => Promise<ExtInfo> ;

	declare featuredGallery: () => Promise<string[]> ;

	declare lookupGallery: (id: string) => Promise<GalleryEntry> ;

	declare galleryIcon: (url: string) => Promise<string | null> ;

	declare installFromGallery: (entry: GalleryEntry) => Promise<ExtInfo> ;

	declare installDependencies: (info: ExtInfo, seen?: Set<string>) => Promise<ExtInfo[]>;

	declare installBundled: (extId: string) => Promise<ExtInfo> ;

	declare processStatus: () => Promise<ExtProcessInfo[]> ;

	declare restartProcess: (extId: string) => Promise<void> ;

	declare uninstall: (extId: string) => Promise<void> ;

	declare activateInstalled: () => Promise<void> ;

	declare applyContributions: (ext: ExtInfo) => Promise<void> ;

	declare loadContributionFiles: (extId: string, contributes: ManifestContributes | undefined) => Promise<void> ;

	declare registerContributions: (extId: string, contributes: ManifestContributes | null | undefined, nls: Record<string, string>, nlsZhCn?: Record<string, string>) => void;

	declare canRunCommand: (command: string) => boolean ;

	declare reload: (extId: string) => Promise<void> ;

	declare activate: (ext: ExtInfo) => Promise<void> ;

	static workspaceFolders: string[] = [];

	declare deactivate: (extId: string) => void ;

	declare pageTheme: () => Promise<PageTheme> ;

	declare packageIcon: (extId: string) => string | null ;

	declare servePageRpc: (method: string, args: unknown[], page: PageFrameHandle) => Promise<unknown> ;

	declare resolveVscodeUri: (uri: unknown) => Promise<{ scheme: string; name: string; fsPath: string; label: string; content?: string; local?: boolean }> ;

	static placementOf(column: unknown): EditorPlacement | undefined {
		const value = typeof column === 'number' ? column : (column as { viewColumn?: unknown } | null | undefined)?.viewColumn;
		if (value === -2) return 'beside'; // ViewColumn.Beside
		if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value);
		return undefined;
	}

	declare openVscodeDiff: (left: unknown, right: unknown, title: unknown, column: unknown) => Promise<void> ;

	declare openVscodeDocument: (uri: unknown, column: unknown) => Promise<void> ;

	declare runProcessCommand: (extId: string, command: string, args?: unknown[]) => Promise<void>;

	declare webviewTabId: (extId: string, panelId: number) => string ;

	declare deliverPendingWebviewMessages: (view: WebviewDelivery, owner: string) => void ;

	declare gateWebviewMessage: (view: WebviewDelivery, message: unknown, owner: string) => void ;

	declare mountWebview: (extId: string, panelId: number, container: HTMLElement) => () => void ;

	declare webviewClosed: (extId: string, panelId: number) => void ;

	declare mountWebviewView: (viewId: string, extId: string, container: HTMLElement) => () => void ;

	declare resetViewsAfterBackendRestart: (extId: string) => void ;

	declare setWebviewViewHtml: (extId: string, viewId: string, html: string) => void ;

	declare armLoadGrace: (view: WebviewDelivery, owner: string) => void ;

	declare flushFirstPaint: (record: WebviewDelivery, owner: string) => boolean ;

	declare webviewViewFor: (source: MessageEventSource | null) => { viewId: string; extId: string } | null ;

	declare releaseWebview: (extId: string, panelId: number) => void ;

	declare closeWebview: (extId: string, panelId: number) => void ;

	declare closeSessionTabs: (sessionId: string) => number ;

	readonly claudeChatTickets = new Map<string, ClaudeChatTicket>();

	claudeChatSerial = 0;

	declare claudeExtId: () => string | null ;

	declare claudePanels: () => WebviewHandle[] ;

	declare panelForSession: (sessionId: string) => WebviewHandle | null ;

	declare pollFor: <T>(probe: () => T | null | undefined | false, ms: number) => Promise<T | null>;

	declare claudeChatStart: (raw: unknown, send: boolean) => { ticket: string } ;

	declare claudeChatRun: (ticket: ClaudeChatTicket, text: string | null, interrupt: boolean, model: string | null) => Promise<void> ;

	declare claudeChatRespond: (raw: unknown) => { ok: boolean } ;

	declare claudeChatState: (raw: unknown) => { phase: string; error: string | null; sessionId: string | null; open: boolean; busy: boolean | null; rc: ClaudeRcState | null } ;

	declare claudeChatStop: (raw: unknown) => { stopped: boolean } ;

	declare claudeChatAnswer: (raw: unknown) => { ticket: string } ;

	declare claudeChatAnswerRun: (ticket: ClaudeChatTicket, answers: ChatAnswer[]) => Promise<void> ;

	declare claudeChatRemoteControl: (raw: unknown) => { ticket: string } ;

	declare claudeChatRemoteControlRun: (ticket: ClaudeChatTicket, enable: boolean) => Promise<void> ;

	declare claudeChatRemoteState: (raw: unknown) => { available: boolean | null; rc: ClaudeRcState | null; sessionId: string | null } ;

	declare claudeChatPermission: (raw: unknown) => { ticket: string } ;

	declare claudeChatMode: (raw: unknown) => { ticket: string } ;

	declare claudeChatCardRun: (ticket: ClaudeChatTicket, drive: (doc: Document | null | undefined) => Promise<boolean>) => Promise<void> ;

	readonly claudeTaps = new Map<string, ClaudeTapSub>();

	claudeTapGrants: Record<string, boolean> = state.load('ext.claudeTapGrants', {} as Record<string, boolean>);

	readonly webviewChannels = new Map<string, string>();

	readonly claudeRcStates = new Map<string, ClaudeRcState>();

	readonly claudeRcAvailable = new Map<string, boolean>();

	readonly claudePermissionPanels = new Map<string, string>();

	readonly claudeRcRequestIds = new Map<string, string>();

	readonly claudeRcWaiters = new Map<string, { channelId: string; resolve: (response: unknown) => void }>();

	declare claudeTapSubscribe: (caller?: FrameHandle) => Promise<{ ok: boolean; reason?: string }> ;

	declare claudeTapUnsubscribe: (caller?: FrameHandle) => { ok: boolean } ;

	declare noteClaudeTap: (extId: string, panelId: number, dir: 'in' | 'out', message: unknown) => void ;

	declare enqueueTapEvent: (sub: ClaudeTapSub, event: { dir: 'in' | 'out'; kind: string; panelId: number; sessionId: string | null; message: unknown }) => void ;

	declare flushClaudeTap: (sub: ClaudeTapSub) => void ;

	declare consumeClaudeRcResponse: (extId: string, panelId: number, message: unknown) => boolean ;

	declare emitStatusBarItems: () => void ;

	declare appendOutput: (extId: string, name: string, line: string) => void ;

	declare emitOutputChannels: () => void ;

	declare serve: (method: string, args: unknown[], extId: string, handle: FrameHandle) => Promise<unknown> ;

	declare webviewAssetBase: (extId: string) => string ;

	declare extensionEnv: (extId: string) => Promise<Record<string, unknown>> ;

	declare fsRoots: (extId: string) => string[] ;

	readonly storageRoots = new Map<string, string[]>();

	declare showLog: () => void ;

	declare openLogFile: () => Promise<void> ;

	declare reportActivationFailure: (extId: string, error: string, stack?: string | null) => void ;

	declare checkDependencies: (ext: ExtInfo) => void ;

	declare serveRequest: (method: string, args: unknown[], extId: string, handle: FrameHandle) => Promise<unknown> ;

	declare executeCommand: (id: string, args?: unknown[], caller?: FrameHandle) => Promise<unknown>;

	declare extensionFileDecorations: (paths: string[]) => Promise<{ key: string; path: string; badge: string; color?: string; tooltip?: string }[]> ;

	declare extensionHover: (path: string, languageId: string, text: string, line: number, character: number) => Promise<{ contents: string[]; range?: { start: { line: number; character: number }; end: { line: number; character: number } } } | null> ;

	declare extensionDefinition: (path: string, languageId: string, text: string, line: number, character: number) => Promise<{ path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]> ;

	declare extensionCompletions: (path: string, languageId: string, text: string, line: number, character: number, triggerCharacter?: string) => Promise<{ label: string; kind?: number; detail?: string; documentation?: string; insertText?: string; sortText?: string; filterText?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }[]> ;

	declare formatDocument: (path: string, languageId: string, text: string, tabSize: number, insertSpaces: boolean) => Promise<boolean> ;

	declare runRegistered: (id: string, args?: unknown[]) => Promise<void>;

	declare runRegisteredUnguarded: (id: string, args?: unknown[]) => Promise<void>;

	declare declaringExtension: (command: string) => string | null ;

	declare ensureActive: (extId: string) => Promise<void> ;

	declare treeChildren: (viewId: string, handle: string | null) => Promise<SerializedTreeItem[]> ;

	declare treeInteraction: (viewId: string, method: 'treeView.select' | 'treeView.expand' | 'treeView.checkbox', args: unknown[]) => void ;

	declare noteViewVisible: (viewId: string, visible: boolean) => void ;

	declare noteActiveEditor: (editor: { kind: string; path?: string; languageName?: string; line: number; column: number; selected?: number } | null) => void ;

	declare noteThemeChanged: () => void ;

	declare refreshWebviewTheme: () => Promise<void> ;

	declare noteWorkspaceChanged: (folders: string[]) => void ;

	declare noteDocumentChanged: (path: string, text: () => string) => void ;

	declare noteDocumentClosed: (path: string) => void ;

	declare noteDocumentSaved: (path: string) => void ;

	declare noteLanguageOpened: (fileName: string) => void ;

	declare matchesWorkspaceContains: (patterns: string[]) => Promise<boolean> ;

	declare callFrame: (handle: FrameHandle, method: string, args: unknown[]) => Promise<unknown> ;

	declare onMessage: (event: MessageEvent) => void ;

	declare frameFor: (source: MessageEventSource | null) => FrameHandle | null ;

	declare pageFor: (source: MessageEventSource | null) => PageFrameHandle | null ;

	declare noteWebviewSessionTraffic: (extId: string, panelId: number | null, message: unknown) => void ;

	declare webviewFor: (source: MessageEventSource | null) => WebviewHandle | null ;

	declare extIdFor: (handle: FrameHandle) => string ;

	declare extIdForHandle: (handle: FrameHandle) => string ;

}
