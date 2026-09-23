// The extension host's main-window half: it lists the extensions the Rust side installed from
// `.vsix` / `.ggx` files, spins up one sandboxed frame per extension (ext-host.html), feeds
// each its entry bundle, and serves the frames' host requests - the workbench command
// registry, notifications, quick inputs, settings persistence, opener and clipboard calls,
// withProgress toasts, status bar items, output channels and webview panels - over
// postMessage. Events flow back as `__studioExtEvent` pushes (configuration changes, webview
// messages, disposals).
//
// The host never interprets a package: every installed package is listed from its manifest,
// its commands dispatch to its own frame (a VSIX) or its own backend process (a `ggx/2`
// package), and its pages mount as sandboxed frames over the `ggx://` protocol.

import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from './commands';
import { applyContributions, applyExtensionSettings, declaredCommand, extensionThemeList, extensionViewContributions, languageIdFor, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from './contributions';
import { syncExtensionThemes, themeById } from './settings';
import { locale, registerZhCnText, t } from './i18n';
import * as state from './state';
import { notify, progressToast, quickInput, type ProgressToast } from './ui';
import type { SerializedTreeItem } from './treeView';

export interface ExtInfo {
	id: string;
	name: string;
	displayName: string | null;
	publisher: string;
	version: string;
	description: string;
	builtin: boolean;
	icon: string | null;
	path: string;
	categories: string[];
	keywords: string[];
	repository: string | null;
	license: string | null;
	enginesVscode: string | null;
	extensionDependencies: string[];
	extensionPack: string[];
	/** README / CHANGELOG file names inside the install, when present (the detail page renders them). */
	readme: string | null;
	changelog: string | null;
	/** `bundled` (a not-yet-installed package the installer ships), `vsix` or `ggx`. */
	format: 'bundled' | 'vsix' | 'ggx';
	/** The `.ggx` header, for packages installed from one. */
	ggx: GgxManifest | null;
}

/** What `ext_process_status` reports for one extension's backend: running (pid > 0) or
 *  remembered-dead (pid 0, `lastError` saying why) — the Extensions view's status lines. */
export interface ExtProcessInfo {
	extensionId: string;
	pid: number;
	commands: string[];
	protocolVersion: string;
	startCount: number;
	lastError: string | null;
}

/** The `manifest.json` of a `.ggx` package. */
export interface GgxManifest {
	format: string;
	id: string;
	version: string;
	frontend?: { page: string; config?: string; compare?: string } | null;
	/** `ggx/2`: every page the package can show, by id (the named page registry). */
	pages?: Record<string, { page: string; title?: string; singleton?: boolean; icon?: string | null }> | null;
	/** `ggx/2`: the process backend declaration — `ext_process.rs` spawns it on demand.
	 *  `protocol` is `ggs-ext/1` (the default, command-style plugins) or `ggx-rpc/1` (the
	 *  graph engine's thread-per-request protocol); `binaries` is the per-platform command
	 *  map, when the package carries more than one platform's binary. */
	backend?: { kind: string; command: string; args?: string[]; protocol?: string; binaries?: Record<string, string> } | null;
	/** `ggx/2`: an activity-bar launcher — an icon (package-relative) whose click runs one of
	 *  the package's declared commands (typically its view page's opener). */
	activitybar?: { command: string; title?: string | null; icon?: string | null } | null;
	permissions?: string[];
}

/** The icon path as `ext_read_file_base64` expects it: relative to the extension's install
 *  root. `ExtInfo.icon` is absolute (`<root>/<manifest path>`), so strip the root — reducing
 *  it to a bare file name loses icons kept in a subfolder (`resources/icon.png`). */
export function extIconRelPath(ext: ExtInfo): string {
	const iconPath = ext.icon!;
	const root = ext.path.replace(/[\\/]+$/, '');
	if (root !== '' && (iconPath.startsWith(root + '/') || iconPath.startsWith(root + '\\'))) return iconPath.slice(root.length + 1);
	return iconPath.split(/[\\/]/).pop()!; // unexpected shape: at least the file name is right
}

/** The extension's display title, like VS Code's extension list (displayName falls back to name). */
export function extTitle(ext: ExtInfo): string {
	return ext.displayName ?? ext.name;
}

/** The data-URL MIME type of an image file inside an extension (icons, README images). */
function imageMime(path: string): string {
	const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png'
		: ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp'
		: ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
}

/** Cached base64 reads of a file inside an installed extension, as a data URL. */
const dataUrlCache = new Map<string, Promise<string | null>>();

/** An extension file as a data URL (icons and README images cross the bridge this way), or null
 *  when the file cannot be read. Cached per extension id + path. */
export function extFileDataUrl(extId: string, relPath: string): Promise<string | null> {
	const key = `${extId}:${relPath}`;
	let pending = dataUrlCache.get(key);
	if (!pending) {
		pending = invoke<string>('ext_read_file_base64', { extId, relPath })
			.then((base64) => `data:${imageMime(relPath)};base64,${base64}`)
			.catch(() => null);
		dataUrlCache.set(key, pending);
	}
	return pending;
}

/** A diff a page asks the workbench to open (the editor input's shape minus the kind):
 *  the two sides carry a revision/path/label and whether that side exists. */
export interface PageDiffRequest {
	id: string;
	title: string;
	repo?: string;
	binaryNotice?: boolean;
	left: { revision: string; path: string; label: string; exists: boolean };
	right: { revision: string; path: string; label: string; exists: boolean };
}

/** The theme of the moment, as a page's 'theme.stylesheet' request answers it and the theme
 *  event pushes carry it: the active theme's vscode-* class and its stylesheet text. */
export interface PageTheme {
	kind: 'vscode-dark' | 'vscode-light';
	label: string;
	css: string;
}

/** One open extension page: a sandboxed iframe in an editor tab, speaking the page RPC the
 *  composed bootstrap (`acquireGgsApi`) defines. The editor tab owns it — its disposer is
 *  the tab's `onClose`. */
interface PageFrameHandle {
	extId: string;
	pageId: string;
	frame: HTMLIFrameElement;
	/** Calls into the page still waiting for their result, settled when it goes away. */
	pendingCalls: Set<(error: Error) => void>;
}

/** The `ggx://` URL base of an installed package's directory (trailing slash included) —
 *  what the pages' iframes and the webview panels' `asWebviewUri` compose paths onto. Falls
 *  back to the plain scheme shape where Tauri's internals are absent (jsdom, probes). */
function ggxAssetBase(ext: ExtInfo | undefined): string {
	const dirName = ext?.path.split(/[\\/]/).pop() ?? '';
	const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } }).__TAURI_INTERNALS__;
	return internals?.convertFileSrc ? internals.convertFileSrc(`${dirName}/`, 'ggx') : `ggx://localhost/${dirName}/`;
}

/** The `ggx://` URL of a file inside an installed package, the way the pages' iframes load
 *  them: `{install dir name}/{relative path}` under the `ggx` protocol the backend serves. */
function ggxAssetUrl(ext: ExtInfo | undefined, rel: string): string {
	return ggxAssetBase(ext) + rel.replace(/\\/g, '/');
}

interface FrameHandle {
	frame: HTMLIFrameElement;
	/** Posts into the frame (set once it loaded its extension). */
	send?: (message: unknown) => void;
	/** Command ids this extension registered; unregistered when it goes away. */
	commandIds: Set<string>;
	/** The calls into the frame still waiting for their result: settled (rejected) when the
	 *  frame goes away, or a command that was running in it would wait forever and its
	 *  result listener never leave the window. */
	pendingCalls: Set<(error: Error) => void>;
}

/** One webview panel a frame extension created (`window.createWebviewPanel`): the tab-side
 *  record. The workbench opens the tab (`onOpenWebview`); the iframe lives in it and this
 *  host half feeds it HTML and relays messages both ways. */
interface WebviewHandle {
	panelId: number;
	extId: string;
	title: string;
	html: string;
	/** Set once the tab mounted it (the first `setHtml` may arrive first — it queues here). */
	frame: HTMLIFrameElement | null;
}

/** One extension-owned status bar item (`window.createStatusBarItem`), as the bar renders it. */
export interface ExtStatusBarItem {
	id: string;
	alignment: number;
	text: string;
	tooltip: string;
	command?: string;
	visible: boolean;
}

/** What wakes an extension, parsed from `activationEvents`: an extension with no events (or
 *  only `onStartupFinished` / `*`) starts eagerly at boot; the others activate when one of
 *  their declared commands / languages / views is first touched, or when a `workspaceContains`
 *  pattern matches the open folder. */
export interface ActivationPolicy {
	eager: boolean;
	commands: Set<string>;
	languages: Set<string>;
	views: Set<string>;
	workspaceContains: string[];
}

/** Parse VS Code's `activationEvents` into the policy the host activates by. Events this
 *  model does not carry (`onFileSystem:`, `onUri`, `onDebugResolve`, …) leave the extension
 *  eager — never un-activatable. */
function parseActivationPolicy(events: string[] | undefined): ActivationPolicy {
	const policy: ActivationPolicy = { eager: true, commands: new Set(), languages: new Set(), views: new Set(), workspaceContains: [] };
	if (!events || events.length === 0) return policy;
	policy.eager = false;
	for (const event of events) {
		if (event.startsWith('onCommand:')) policy.commands.add(event.slice('onCommand:'.length));
		else if (event.startsWith('onLanguage:')) policy.languages.add(event.slice('onLanguage:'.length));
		else if (event.startsWith('onView:')) policy.views.add(event.slice('onView:'.length));
		else if (event.startsWith('workspaceContains:')) policy.workspaceContains.push(event.slice('workspaceContains:'.length));
		else policy.eager = true; // `*`, onStartupFinished, and every event this host cannot observe
	}
	return policy;
}

/** The bootstrap composed into a webview panel's HTML: `acquireVsCodeApi()` — one per page,
 *  VS Code's own rule — whose `postMessage` reaches the owning extension frame, plus the
 *  message listener the host relays through. State stays inside the frame (as much of it as
 *  a sandboxed srcdoc document can keep). */
const WEBVIEW_BOOT = `<script>
(function () {
	var api = null;
	var state = null;
	window.acquireVsCodeApi = function () {
		if (api) throw new Error('An instance of the vscode API has already been acquired');
		api = {
			postMessage: function (message) { parent.postMessage({ __ggsWebview: true, kind: 'message', message: message }, '*'); },
			getState: function () { return state; },
			setState: function (value) { state = value; return value; }
		};
		return api;
	};
	window.addEventListener('message', function (event) {
		var data = event.data;
		if (!data || data.__ggsWebviewHost !== true) return;
		if (data.type === 'message') window.dispatchEvent(new MessageEvent('message', { data: data.message }));
	});
})();
</script>`;

/** Compose the bootstrap into a webview document (the `compose_page` rule: inside `<head>`
 *  when there is one, else after `<html>`, else at the very start). */
function composeWebview(html: string): string {
	for (const marker of ['</head>', '</HEAD>']) {
		const at = html.indexOf(marker);
		if (at !== -1) return `${html.slice(0, at)}${WEBVIEW_BOOT}${html.slice(at)}`;
	}
	const at = html.indexOf('<html');
	if (at !== -1) {
		const end = html.indexOf('>', at);
		const cut = end === -1 ? html.length : end + 1;
		return `${html.slice(0, cut)}${WEBVIEW_BOOT}${html.slice(cut)}`;
	}
	return WEBVIEW_BOOT + html;
}

export class ExtensionHost {
	private readonly frames = new Map<string, FrameHandle>();
	/** The command ids of each extension's manifest contributions (dropped from the workbench
	 *  registry on uninstall; the frame's own registrations are tracked per frame handle). */
	private readonly declaredCommandIds = new Map<string, string[]>();
	private readonly pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
	private nextRpcId = 1;
	private nextCallId = 1;
	activated = false;

	onNativeCommand: ((command: string) => boolean) | null = null;
	/** Called after a registration pass added contributions asynchronously (installed
	 *  extensions): the workbench re-renders the views that had already built their menus. */
	onContributionsApplied: (() => void) | null = null;
	/** Workbench hook: open one of an extension's pages in an editor tab — wired the same
	 *  way `onNativeCommand` is (the workbench owns the editor area, the host owns pages). */
	onOpenPage: ((extId: string, pageId: string, params?: unknown, title?: string) => void) | null = null;
	/** The installed extensions the host has listed; pages and backends resolve through it. */
	private installedExts: ExtInfo[] = [];
	/** The open page frames, by serial (their iframes live in editor tabs). */
	private readonly pageFrames = new Map<number, PageFrameHandle>();
	/** The serial of each singleton page's open frame, by `${extId}/${pageId}` (a second open
	 *  reveals that tab and delivers its params as an event, instead of a duplicate tab). */
	private readonly singletonPages = new Map<string, number>();
	private nextPageSerial = 1;
	/** Workbench hook: reveal a singleton page's tab (wired like `onOpenPage`). */
	onRevealPage: ((extId: string, pageId: string) => void) | null = null;
	/** Workbench hooks behind the page services: the diff/revision editors, the SCM view, the
	 *  terminal, and the repo-changed nudge a page's own writes owe the workbench. */
	onOpenDiff: ((diff: PageDiffRequest) => void) | null = null;
	onOpenFileAtRevision: ((revision: string, path: string, title: string, repo?: string) => void) | null = null;
	onShowView: ((id: string) => void) | null = null;
	onRevealTerminal: (() => void) | null = null;
	onRunInTerminal: ((command: string) => void) | null = null;
	onRepoChanged: (() => void) | null = null;
	onForwardKey: ((key: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) => void) | null = null;
	/** Extensions whose commands dispatch to a `ggx/2` process backend, not a frame. */
	private readonly processBacked = new Set<string>();
	/** The declared commands of the process-backed extensions — runnable with no frame, the
	 *  manifest alone (the backend spawns lazily on first execution). */
	private readonly processCommandIds = new Set<string>();

	/** The webview panels frame extensions created, by panel id (VS Code's numeric ids are
	 *  per-frame, so the frame's `(panelId, extension)` pair is unambiguous here). */
	private readonly webviews = new Map<number, WebviewHandle>();
	private nextWebviewPanelId = 1;
	/** Workbench hook: open a webview panel's tab (wired like `onOpenPage`). */
	onOpenWebview: ((panelId: number, title: string, extId: string) => void) | null = null;
	/** Workbench hook: close a webview panel's tab by its editor id (extension-side dispose). */
	onCloseWebviewTab: ((tabId: string) => void) | null = null;
	/** Workbench hook: focus a webview panel's tab (`panel.reveal()`). */
	onRevealWebviewTab: ((tabId: string) => void) | null = null;

	/** The extension-owned status bar items, by item id (frame-assigned `extId:n`). */
	private readonly statusItems = new Map<string, ExtStatusBarItem>();
	/** Workbench hook: the bar re-renders from these (the workbench owns the status bar). */
	onStatusBarItems: ((items: ExtStatusBarItem[]) => void) | null = null;

	/** The output channels extensions created: ext id -> the channel names in creation order. */
	private readonly outputChannels = new Map<string, string[]>();
	/** Workbench hooks: the Output view's channel list, line appends, clears and reveals. */
	onOutputChannels: ((channels: { extId: string; name: string }[]) => void) | null = null;
	onOutputAppend: ((extId: string, name: string, line: string) => void) | null = null;
	onOutputClearChannel: ((extId: string, name: string) => void) | null = null;
	onOutputReveal: ((extId: string, name: string) => void) | null = null;
	/** Workbench hooks behind the editor-facing vscode API: text-edit application (into an
	 *  open CodeMirror editor), file opening, and the active editor's text. */
	onApplyEdits: ((path: string | null, edits: { startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }[]) => boolean) | null = null;
	onOpenFile: ((path: string) => void) | null = null;
	/** The active file editor's whole text, or null — pushed to frames when the active
	 *  document changed, so `TextDocument.getText()` is synchronous inside the frame. */
	activeText: (() => string | null) | null = null;
	/** The path whose text the last activeEditorChanged push carried (suppresses re-sending
	 *  a big document on selection-only changes). */
	private lastPushedDocument: string | null = null;

	/** The withProgress toasts, by progress id. */
	private readonly progress = new Map<number, ProgressToast>();
	private nextProgressId = 1;

	/** The tree views frame extensions registered (`createTreeView`), view id -> ext id. */
	private readonly treeProviders = new Map<string, string>();
	/** Workbench hooks: one view's data changed (re-fetch it), and the declared view set
	 *  changed (install / uninstall — the workbench rebuilds its sidebar sections). */
	onTreeRefresh: ((viewId: string) => void) | null = null;
	onViewsChanged: (() => void) | null = null;
	/** Activation policy per extension, parsed from its `activationEvents`. */
	private readonly activationPolicies = new Map<string, ActivationPolicy>();
	/** The activation pass of a lazily-woken extension, in flight (idempotency). */
	private readonly pendingActivations = new Map<string, Promise<void>>();
	/** Resolved when a frame reports `__studioExtActivated` (lazy activation waits for it). */
	private readonly activationWaiters = new Map<string, () => void>();

	
	constructor() {
		window.addEventListener('message', (event) => this.onMessage(event));
		// An extension's own settings change (its update(), or the Settings dialog writing the
		// same key) reaches its frame as a configChanged event — `onDidChangeConfiguration`.
		document.addEventListener(state.EXT_SETTINGS_EVENT, (event) => {
			const extId = (event as CustomEvent<string>).detail;
			this.frames.get(extId)?.send?.({ type: '__studioExtEvent', event: 'configChanged', settings: state.extSettings(extId) });
		});
	}

	/** List the installed extensions (the Extensions view renders these). */
	async list(): Promise<ExtInfo[]> {
		const installed = await invoke<ExtInfo[]>('ext_list');
		this.installedExts = installed;
		return installed;
	}

	/** The installed packages' activity-bar launchers (`manifest.json`'s `activitybar`), in
	 *  install-list order — the workbench renders one activity item per entry. */
	activityLaunchers(): { extId: string; command: string; title: string; icon: string | null }[] {
		return this.installedExts
			.filter((ext) => ext.format !== 'bundled' && ext.ggx?.activitybar?.command)
			.map((ext) => ({ extId: ext.id, command: ext.ggx!.activitybar!.command, title: ext.ggx!.activitybar!.title ?? extTitle(ext), icon: ext.ggx!.activitybar!.icon ?? null }));
	}

	/** Read a text file inside an installed extension (README, CHANGELOG, manifest). */
	async readFile(extId: string, relPath: string): Promise<string> {
		return await invoke<string>('ext_read_file', { extId, relPath });
	}

	/** Install a `.ggx` package — Studio's own format (a newer version replaces an installed
	 *  `.vsix` or `.ggx` of the same id, forward-only). */
	async installFromGgx(path: string): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_install_from_ggx', { path });
		await this.reload(info.id);
		return info;
	}

	/** Install a `.vsix` package — the VS Code compatibility path. Same store, same
	 *  forward-only upgrade rules as a `.ggx`; the extension activates in its frame with the
	 *  `vscode` API shim. */
	async installFromVsix(path: string): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_install_from_vsix', { path });
		await this.reload(info.id);
		return info;
	}

	/** Install one of the bundled `.ggx` packages the installer carries — the one-click
	 *  Install on the Extensions view's bundled entries (the Git Graph engine view, and the
	 *  GGX Demo sample). The app installs nothing by default; this is the ask, and it lands
	 *  as a standard (uninstallable) package. */
	async installBundled(extId: string): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_install_bundled', { extId });
		await this.reload(info.id);
		return info;
	}

	/** The process backends this app instance knows — running and remembered-dead — for the
	 *  Extensions view's status lines (pid `0` means not running; `lastError` says why). A
	 *  null answer (a defaulting test mock, or nothing ever started) is no backends. */
	async processStatus(): Promise<ExtProcessInfo[]> {
		return (await invoke<ExtProcessInfo[] | null>('ext_process_status').catch(() => null)) ?? [];
	}

	/** Restart a plugin's process backend: stop, then start (the handshake runs again). */
	async restartProcess(extId: string): Promise<void> {
		await invoke('ext_process_stop', { extId }).catch(() => undefined);
		await invoke('ext_process_start', { extId });
	}

	/** Uninstall an extension (the Rust side refuses built-ins), then drop its frame, its
	 *  backend process, its registry commands and its contributions. */
	async uninstall(extId: string): Promise<void> {
		await invoke('ext_uninstall', { extId });
		// A ggx/2 process backend dies with its extension (nothing of it is running after).
		await invoke('ext_process_stop', { extId }).catch(() => undefined);
		this.processBacked.delete(extId);
		for (const id of this.declaredCommandIds.get(extId) ?? []) this.processCommandIds.delete(id);
		this.installedExts = this.installedExts.filter((ext) => ext.id !== extId);
		this.deactivate(extId);
		// The manifest-declared commands live in the workbench registry too: removeContributions
		// only drops the declaration records, and a surviving (disabled) entry with a keybinding
		// would still swallow its keystroke (commandForBinding/forKeyEvent ignore enablement).
		for (const id of this.declaredCommandIds.get(extId) ?? []) unregisterCommand(id);
		this.declaredCommandIds.delete(extId);
		removeContributions(extId);
		this.activationPolicies.delete(extId);
		for (const [viewId, owner] of [...this.treeProviders]) {
			if (owner === extId) this.treeProviders.delete(viewId);
		}
		this.onViewsChanged?.();
	}

	/** Activate every installed extension that the workbench does not host natively. */
	async activateInstalled(): Promise<void> {
		this.activated = true;
		let installed: ExtInfo[] = [];
		try {
			installed = await this.list();
		} catch {
			return; // the panel surfaces the error; activation just stays silent
		}
		// Every extension's manifest contributions (commands, context menu entries,
		// keybindings) join the workbench, the natively-hosted built-in included: its commands
		// dispatch through onNativeCommand instead of a frame. The built-ins were already
		// registered synchronously from the baked-in build-time data - no need to read their
		// manifests again (the disks copy could even lag the baked one mid-upgrade).
		for (const ext of installed) {
			if (this.declaredCommandIds.has(ext.id)) continue;
			await this.applyContributions(ext);
		}
		// Each extension gets its own frame, so activations are independent — run them in
		// parallel instead of serializing every iframe boot behind the slowest bundle read.
		// Skipped for entries with nothing to boot: a `bundled`-format entry (an offer of a
		// package the installer ships but nothing installed) has no files on disk, and a ggx/2
		// process package's commands
		// dispatch to its backend — its `package.json` is its whole program. Activation
		// follows `activationEvents`: eager extensions boot here, the lazy ones wait for
		// their first command / language / view (a `workspaceContains` match boots them too).
		const toActivate: ExtInfo[] = [];
		for (const ext of installed) {
			if (ext.format === 'bundled' || this.processBacked.has(ext.id) || this.frames.has(ext.id)) continue;
			const policy = this.activationPolicies.get(ext.id);
			if ((policy?.eager ?? true) || (await this.matchesWorkspaceContains(policy?.workspaceContains ?? []))) toActivate.push(ext);
		}
		await Promise.all(toActivate.map((ext) => this.activate(ext)));
		this.onContributionsApplied?.();
		this.onViewsChanged?.();
	}

	/** Parse the extension's package.json (and package.nls.json) and register its declared
	 *  commands, keybindings and context menu entries. */
	private async applyContributions(ext: ExtInfo): Promise<void> {
		let manifest: { contributes?: ManifestContributes; activationEvents?: string[] } | null = null;
		let nls: Record<string, string> = {};
		let nlsZhCn: Record<string, string> = {};
		try {
			manifest = JSON.parse(await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.json' })) as { contributes?: ManifestContributes; activationEvents?: string[] };
			const localization = await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.nls.json' }).catch(() => null);
			if (localization) nls = JSON.parse(localization) as Record<string, string>;
			const zhCn = await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.nls.zh-cn.json' }).catch(() => null);
			if (zhCn) nlsZhCn = JSON.parse(zhCn) as Record<string, string>;
		} catch {
			return; // unreadable manifest: nothing to contribute
		}
		this.activationPolicies.set(ext.id, parseActivationPolicy(manifest?.activationEvents));
		this.registerContributions(ext.id, manifest?.contributes, nls, nlsZhCn);
		// The locale context key a manifest's own code would set on activation (VS Code's
		// setContext): `<ext id>:interfaceZhCn` gates its locale-twin commands and menus (the
		// English entry vs. the `.zhCn` one). A process-backed package never activates code,
		// so the host resolves it — its declared `interfaceLanguage` setting when explicit,
		// the app's display language when "auto". A manifest prefixes its context keys and
		// settings with its package name (`git-graph-rs:interfaceZhCn`,
		// `git-graph-rs.interfaceLanguage`), not the `publisher.name` id — both spellings answer.
		const interfaceZhCn = (): boolean => {
			const stored = state.extSettings(ext.id);
			const language = String(stored[`${ext.name}.interfaceLanguage`] ?? stored[`${ext.id}.interfaceLanguage`] ?? 'auto');
			return language === 'zh-cn' || (language === 'auto' && locale() === 'zh-cn');
		};
		for (const prefix of new Set([ext.id, ext.name])) registerContextProvider(`${prefix}:interfaceZhCn`, interfaceZhCn);
		// The snippet and theme contributions are file contents: read them, then register
		// whole (the settings module turns the themes into picker entries with overlays).
		void this.loadContributionFiles(ext.id, manifest?.contributes);
		// A ggx/2 process package's commands dispatch to its backend rather than a frame:
		// its declared ids become runnable from the manifest alone. The backend itself comes
		// up eagerly (the boot pass and the install both start it); a first command still
		// spawns one that is not up — the lazy path remains the fallback.
		const processBacked = ext.ggx?.backend?.kind === 'process';
		if (processBacked) {
			this.processBacked.add(ext.id);
			for (const declared of manifest?.contributes?.commands ?? []) this.processCommandIds.add(declared.command);
		} else {
			this.processBacked.delete(ext.id);
		}
	}

	/** Read one extension's `contributes.snippets` and `.themes` files and register their
	 *  contents whole. An unreadable file is skipped (VS Code logs it; we have no channel
	 *  for it) — the registries keep whatever else landed. */
	private async loadContributionFiles(extId: string, contributes: ManifestContributes | undefined): Promise<void> {
		const snippetFiles: { language: string; text: string }[] = [];
		for (const declared of contributes?.snippets ?? []) {
			try {
				snippetFiles.push({ language: declared.language, text: await invoke<string>('ext_read_file', { extId, relPath: declared.path }) });
			} catch {
				// Unreadable snippet file: skip it, keep the rest.
			}
		}
		registerExtensionSnippets(extId, snippetFiles);
		const themes: ExtensionThemeDef[] = [];
		for (const declared of contributes?.themes ?? []) {
			try {
				const parsed = JSON.parse(await invoke<string>('ext_read_file', { extId, relPath: declared.path })) as {
					colors?: Record<string, string>;
					tokenColors?: ExtensionThemeDef['tokenColors'];
				};
				themes.push({
					extId,
					label: declared.label,
					kind: declared.uiTheme === 'vs' || declared.uiTheme === 'vs-light' ? 'vscode-light' : 'vscode-dark',
					colors: parsed.colors ?? {},
					tokenColors: Array.isArray(parsed.tokenColors) ? parsed.tokenColors : []
				});
			} catch {
				// Unreadable theme file: skip it, keep the rest.
			}
		}
		registerExtensionThemes(extId, themes);
		syncExtensionThemes(extensionThemeList());
	}

	/** Register one extension's parsed manifest contributions into the workbench. */
	private registerContributions(extId: string, contributes: ManifestContributes | null | undefined, nls: Record<string, string>, nlsZhCn: Record<string, string> = {}): void {
		this.declaredCommandIds.set(extId, (contributes?.commands ?? []).map((declared) => declared.command));
		const dispatch = (command: string, args: unknown[] = []) => {
			if (this.processBacked.has(extId)) return void this.runProcessCommand(extId, command, args);
			// A lazily-activating extension wakes here: runRegistered activates it first, then
			// runs the handler its activation registered.
			void this.runRegistered(command, args);
		};
		const canRun = (command: string) => this.canRunCommand(command);
		applyContributions(extId, contributes ?? undefined, nls, dispatch, canRun);
		// The declared titles register in their default (English) form - the stable registry key -
		// and each shipped translation joins the display-language table, so menus and the palette
		// relabel without re-registering (i18n.ts's registerZhCnText).
		const zhPairs: Record<string, string> = {};
		for (const declared of contributes?.commands ?? []) {
			for (const text of [declared.title, declared.category]) {
				if (!text) continue;
				const zh = localize(text, nlsZhCn);
				if (zh !== text && zh !== localize(text, nls)) zhPairs[localize(text, nls)] = zh;
			}
		}
		registerZhCnText(zhPairs);
	}

	/** A declared command is runnable when the workbench handles it natively, its extension's
	 *  ggx/2 backend will take it, its manifest declares it (a lazily-activating extension
	 *  wakes on the run — VS Code's palette behaviour), or its frame holds a handler. */
	private canRunCommand(command: string): boolean {
		if (this.processCommandIds.has(command)) return true;
		if (declaredCommand(command)) return true;
		return commandsRegistered.has(command);
	}

	/** Re-activate one extension (after an install upgraded it): fresh contributions, fresh frame. */
	private async reload(extId: string): Promise<void> {
			this.deactivate(extId);
		removeContributions(extId);
		// An upgraded process package restarts fresh: the old backend does not survive it.
		await invoke('ext_process_stop', { extId }).catch(() => undefined);
		const ext = (await this.list().catch(() => [] as ExtInfo[])).find((e) => e.id === extId);
		if (ext) {
			await this.applyContributions(ext);
			// A process package activates through its backend, not a frame (see
			// activateInstalled); anything else gets a fresh frame for its new files.
			if (!this.processBacked.has(extId)) await this.activate(ext);
		}
		// Install means run: a package that declares a process backend comes up at once — the
		// same "detect and run" the boot pass does, without waiting for a first command.
		if (this.processBacked.has(extId)) {
			await invoke('ext_process_start', { extId }).catch(() => undefined);
		}
	}

	private async activate(ext: ExtInfo): Promise<void> {
		let code: string;
		let main = 'extension.js';
		try {
			// The manifest's `main` is spelled "./out/extension.js"; Rust reads within the ext dir.
			const manifest = JSON.parse(await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.json' })) as { main?: string };
			main = (manifest.main ?? 'extension.js').replace(/^\.\//, '');
			code = await invoke<string>('ext_read_file', { extId: ext.id, relPath: main });
		} catch (error) {
			notify('warning', `Could not load ${ext.id}: ${String(error)}`);
			return;
		}

		const frame = document.createElement('iframe');
		frame.src = '/ext-host.html';
		frame.title = `Extension host: ${ext.id}`;
		frame.style.display = 'none';
		frame.setAttribute('sandbox', 'allow-scripts');
		const handle: FrameHandle = { frame, commandIds: new Set(), pendingCalls: new Set() };
		this.frames.set(ext.id, handle);
		const send = (message: unknown) => frame.contentWindow?.postMessage(message, '*');
		// The frame announces itself, gets its extension, and reports activation - all routed
		// through the shared message listener below via this per-extension sender.
		handle.send = send;

		frame.addEventListener('load', () => {
			send({
				type: '__studioExtInit',
				context: {
					extensionId: ext.id,
					extensionPath: ext.path,
					workspaceFolders: ExtensionHost.workspaceFolders.map((uri, index) => ({ uri: { scheme: 'file', path: uri, fsPath: uri, toString: () => 'file:' + uri }, name: uri.split(/[\\/]/).pop() ?? uri, index })),
					settings: state.extSettings(ext.id),
					// The extension's view of the display language follows the workbench locale.
					language: locale(),
					// Where the extension's webview panels load package-local files from, and its
					// persisted mementos (both preloaded so the shim is synchronous from here on).
					webviewResourceBase: ggxAssetBase(ext),
					state: { global: state.extMemento(ext.id, 'global'), workspace: state.extMemento(ext.id, 'workspace') }
				},
				code
			});
		});
		document.body.appendChild(frame);
	}

	/** The folders the workbench has open, as file URI paths (set by the Workbench). */
	static workspaceFolders: string[] = [];

	private deactivate(extId: string): void {
		const handle = this.frames.get(extId);
		if (!handle) return;
		this.callFrame(handle, 'deactivate', []).catch(() => undefined);
		// The registry has no remove(): each command is re-registered disabled, so it leaves the
		// palette and its run no longer reaches the (gone) frame.
		for (const id of handle.commandIds) {
			commandsRegistered.delete(id);
			unregisterCommand(id);
		}
		this.frames.delete(extId);
		handle.frame.remove();
		// Whatever was still running in the frame (the deactivate itself included) has no
		// frame left to answer from.
		for (const cancel of [...handle.pendingCalls]) cancel(new Error(`extension ${extId} was deactivated`));
		// The extension's UI goes with it: webview tabs close (their disposers re-enter
		// `webviewClosed`, harmless without a frame), and its status bar items and output
		// channels drop.
		for (const panelId of [...this.webviews.keys()]) {
			if (this.webviews.get(panelId)?.extId === extId) this.closeWebview(panelId);
		}
		for (const id of [...this.statusItems.keys()]) {
			if (id.startsWith(`${extId}:`)) this.statusItems.delete(id);
		}
		this.emitStatusBarItems();
		this.outputChannels.delete(extId);
		this.emitOutputChannels();
	}

	/** The pages of an installed package: the `ggx/2` named registry, with a `ggx/1`
	 *  package's single frontend page synthesized in as the page named "view". */
	pageEntry(extId: string, pageId: string): { page: string; title?: string; singleton?: boolean; icon?: string | null } | null {
		const manifest = this.installedExts.find((ext) => ext.id === extId)?.ggx;
		if (!manifest) return null;
		const pages: Record<string, { page: string; title?: string; singleton?: boolean; icon?: string | null }> = {};
		if (manifest.frontend?.page) pages.view = { page: manifest.frontend.page };
		Object.assign(pages, manifest.pages ?? {});
		const entry = pages[pageId];
		if (!entry) return null;
		// A page without its own tab icon wears the package's activity-bar icon, else the
		// package's own icon (package.json's `icon`, the one the Extensions view shows).
		return { ...entry, icon: entry.icon ?? manifest.activitybar?.icon ?? this.packageIcon(extId) };
	}

	/** An installed extension's own icon, package-relative (for `extFileDataUrl`), or null. */
	packageIcon(extId: string): string | null {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return ext?.icon ? extIconRelPath(ext) : null;
	}

	/** Open one of an extension's pages in an editor tab (the workbench's `onOpenPage` does
	 *  the opening; this validates and hands over, the way a command's result may). */
	openPage(extId: string, pageId: string, params?: unknown, title?: string): void {
		const entry = this.pageEntry(extId, pageId);
		if (!entry) {
			notify('warning', `${t('extensions.pageMissing')}: ${extId} / ${pageId}`);
			return;
		}
		if (entry.singleton) {
			const serial = this.singletonPages.get(`${extId}/${pageId}`);
			const frame = serial !== undefined ? this.pageFrames.get(serial) : undefined;
			if (frame) {
				// A singleton's second open reveals its tab and hands the page the params as an
				// event (a page that cannot use them simply ignores the event).
				this.onRevealPage?.(extId, pageId);
				frame.frame.contentWindow?.postMessage({ __ggxHost: true, type: 'event', event: { kind: 'params', params: params ?? null } }, '*');
				return;
			}
		}
		this.onOpenPage?.(extId, pageId, params, title);
	}

	/** Mount one page into a container (its editor tab's pane) and return the disposer the
	 *  tab runs on close. The iframe loads the package's own document through the `ggx`
	 *  protocol — the backend composes the page bootstrap into it, so the page gets
	 *  `acquireGgsApi()` and needs nothing else from the host to boot. */
	mountPage(extId: string, pageId: string, params: unknown, container: HTMLElement): () => void {
		const entry = this.pageEntry(extId, pageId);
		const serial = this.nextPageSerial++;
		if (entry?.singleton) this.singletonPages.set(`${extId}/${pageId}`, serial);
		const frame = document.createElement('iframe');
		frame.className = 'ext-page-frame';
		frame.title = `${extId}: ${pageId}`;
		frame.setAttribute('sandbox', 'allow-scripts');
		if (entry) frame.src = ggxAssetUrl(this.installedExts.find((ext) => ext.id === extId), entry.page);
		const handle: PageFrameHandle = { extId, pageId, frame, pendingCalls: new Set() };
		this.pageFrames.set(serial, handle);
		frame.addEventListener('load', () => {
			frame.contentWindow?.postMessage({
				__ggxHost: true,
				type: 'init',
				// Everything a self-contained page boots from: its identity and open params, the
				// display language, its extension's settings, its persisted mementos and the
				// workspace folders — the page plays its own extension host from these.
				context: {
					extensionId: extId, pageId, params: params ?? null, language: locale(),
					settings: state.extSettings(extId),
					state: { global: state.extMemento(extId, 'global'), workspace: state.extMemento(extId, 'workspace') },
					folders: ExtensionHost.workspaceFolders
				}
			}, '*');
		});
		container.appendChild(frame);
		return () => {
			this.pageFrames.delete(serial);
			if (this.singletonPages.get(`${extId}/${pageId}`) === serial) this.singletonPages.delete(`${extId}/${pageId}`);
			for (const cancel of [...handle.pendingCalls]) cancel(new Error(`page ${extId}/${pageId} was closed`));
			frame.remove();
		};
	}

	/** The active theme as the pages need it: its vscode-* class and its stylesheet text
	 *  (fetched from the app's own theme asset — a sandboxed page cannot link it). */
	private async pageTheme(): Promise<PageTheme> {
		const theme = themeById();
		const css = await fetch(theme.css).then((response) => response.text(), () => '');
		return { kind: theme.kind, label: theme.label, css };
	}

	/** The manifest permissions of a page's package, for the surface a page may use. */
	private pagePermissions(page: PageFrameHandle): Set<string> {
		return new Set(this.installedExts.find((ext) => ext.id === page.extId)?.ggx?.permissions ?? []);
	}

	/** A page's request of the host: the same surface the extension frames get (commands,
	 *  notifications, quick input, clipboard…), plus the page's own — opening another page of
	 *  its extension, speaking its backend's own protocol, the theme, and the workbench
	 *  surface (editors, views, the terminal, dialogs) a self-contained page acts through. */
	private async servePageRpc(method: string, args: unknown[], page: PageFrameHandle): Promise<unknown> {
		switch (method) {
			case 'pages.open': {
				// `pages.open(pageId, params, { title })`: the optional title names this open's
				// tab (a comparison page titles itself by the commits it shows).
				const options = (args[2] ?? {}) as { title?: unknown };
				this.openPage(page.extId, args[0] as string, args[1], typeof options.title === 'string' ? options.title : undefined);
				return undefined;
			}
			case 'backend.run': {
				const [command, commandArgs] = args as [string, unknown[]?];
				return await invoke('ext_process_run', { extId: page.extId, command, args: commandArgs ?? [] });
			}
			case 'backend.message': {
				// One opaque message of the package's own backend protocol — forwarded, never
				// interpreted (the graph engine's request/response rides this).
				const [message, settings] = args as [Record<string, unknown>, Record<string, unknown>?];
				return await invoke('ext_process_message', { extId: page.extId, message, settings: settings ?? null });
			}
			case 'theme.stylesheet':
				return await this.pageTheme();
			case 'workbench.repoChanged':
				this.onRepoChanged?.();
				return undefined;
			case 'workbench.openDiff':
				this.onOpenDiff?.(args[0] as PageDiffRequest);
				return undefined;
			case 'workbench.openFileAtRevision': {
				const [revision, path, title, repo] = args as [string, string, string, string?];
				this.onOpenFileAtRevision?.(revision, path, title, repo);
				return undefined;
			}
			case 'workbench.showView':
				this.onShowView?.(args[0] as string);
				return undefined;
			case 'workbench.revealTerminal':
				this.onRevealTerminal?.();
				return undefined;
			case 'workbench.runInTerminal': {
				// Typing into the user's shell is gated on the package's declared permission.
				if (!this.pagePermissions(page).has('terminal')) throw new Error('the package does not declare the terminal permission');
				this.onRunInTerminal?.(args[0] as string);
				return undefined;
			}
			case 'workbench.saveFile': {
				const [title, defaultPath, filters] = args as [string, string, { name: string; extensions: string[] }[]];
				return await saveDialog({ title, defaultPath, filters });
			}
			case 'workbench.writeFile': {
				if (!this.pagePermissions(page).has('fs')) throw new Error('the package does not declare the fs permission');
				const [path, contents] = args as [string, string];
				return await invoke('write_file', { path, contents });
			}
			case 'workbench.forwardKey': {
				this.onForwardKey?.(args[0] as { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean });
				return undefined;
			}
			case 'commands.register':
			case 'commands.unregister':
				// Pages render; commands are declared in package.json and live in the frame
				// or the backend process, never in a page.
				throw new Error('an extension page cannot register commands; declare them in package.json');
			default: {
				// The shared host surface, through a stand-in handle that can register
				// nothing (the two cases above already rejected that).
				const standIn: FrameHandle = { frame: page.frame, commandIds: new Set(), pendingCalls: page.pendingCalls };
				return await this.serve(method, args, page.extId, standIn);
			}
		}
	}

	/** Run one command in a `ggx/2` process package's backend — the first execution spawns
	 *  it (lazy activation). A result naming one of the package's pages opens it, and one
	 *  naming a notification shows it: the convention a backend uses to surface UI, the way a
	 *  VS Code command shows a webview or a message. */
	private async runProcessCommand(extId: string, command: string, args: unknown[] = []): Promise<void> {
		try {
			const result = await invoke<unknown>('ext_process_run', { extId, command, args });
			if (result && typeof result === 'object') {
				const { openPage: pageId, params, title, notify: toast } = result as {
					openPage?: string; params?: unknown; title?: unknown; notify?: { kind: 'info' | 'warning' | 'error'; message: string };
				};
				// `title` names this open's tab, like pages.open's `{ title }` option.
				if (typeof pageId === 'string') this.openPage(extId, pageId, params, typeof title === 'string' ? title : undefined);
				if (toast && typeof toast.message === 'string') notify(toast.kind ?? 'info', toast.message);
			}
		} catch (error) {
			notify('error', `${t('extensions.processFailed')}: ${String(error)}`);
		}
	}

	/* ---------- Webview panels (window.createWebviewPanel) ---------- */

	/** The editor-tab id of a webview panel — what the workbench opens and closes by. */
	webviewTabId(panelId: number): string {
		return `webview:${panelId}`;
	}

	/** Mount a webview panel into its tab's pane (the workbench's mount callback; the editor
	 *  tab owns the iframe, the disposer runs on close). The document is a srcdoc composed
	 *  with the acquireVsCodeApi bootstrap — `setHtml` reloads it, as VS Code's webviews do. */
	mountWebview(panelId: number, container: HTMLElement): () => void {
		const view = this.webviews.get(panelId);
		const frame = document.createElement('iframe');
		frame.className = 'ext-page-frame';
		frame.title = view?.title ?? 'webview';
		frame.setAttribute('sandbox', 'allow-scripts');
		if (view) {
			view.frame = frame;
			frame.srcdoc = composeWebview(view.html);
		}
		container.appendChild(frame);
		return () => this.webviewClosed(panelId);
	}

	/** The tab went away (either way): drop the record and tell the extension's frame, whose
	 *  panel proxy fires `onDidDispose`. */
	private webviewClosed(panelId: number): void {
		const view = this.webviews.get(panelId);
		if (!view) return;
		this.webviews.delete(panelId);
		view.frame = null;
		this.frames.get(view.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewDisposed', panelId });
	}

	/** The extension disposed its panel: close its tab (the tab's disposer finishes the job),
	 *  or — if no tab ever mounted — just run the same teardown. */
	private closeWebview(panelId: number): void {
		if (!this.webviews.has(panelId)) return;
		if (this.onCloseWebviewTab) {
			this.onCloseWebviewTab(this.webviewTabId(panelId));
			if (!this.webviews.has(panelId)) return; // the tab's disposer already ran
		}
		this.webviewClosed(panelId);
	}

	/* ---------- Status bar items and output channels ---------- */

	/** Hand the workbench's status bar the current set of extension items. */
	private emitStatusBarItems(): void {
		this.onStatusBarItems?.([...this.statusItems.values()]);
	}

	/** One `output.append`: a new channel name registers (creation order per extension),
	 *  then the line crosses to the Output view. */
	private appendOutput(extId: string, name: string, line: string): void {
		const channels = this.outputChannels.get(extId) ?? [];
		if (!channels.includes(name)) {
			channels.push(name);
			this.outputChannels.set(extId, channels);
			this.emitOutputChannels();
		}
		this.onOutputAppend?.(extId, name, line);
	}

	/** Hand the Output view the current channel list (the workbench wires the callback). */
	private emitOutputChannels(): void {
		const channels: { extId: string; name: string }[] = [];
		for (const [extId, names] of this.outputChannels) for (const name of names) channels.push({ extId, name });
		this.onOutputChannels?.(channels);
	}

	/** A request the frame made of the host; also resolves the frame's command registrations. */
	private serve(method: string, args: unknown[], extId: string, handle: FrameHandle): Promise<unknown> {
		switch (method) {
			case 'commands.register': {
				const id = args[0] as string;
				// Declared commands were registered from the manifest already; a frame handler for
				// them is expected. Only another frame claiming the same id is a conflict.
				if (commandsRegistered.has(id) && commandsRegistered.get(id)!.handle !== handle) throw new Error(`command ${id} is already registered`);
				handle.commandIds.add(id);
				commandsRegistered.set(id, { extId, handle });
				// A declared command keeps its manifest title; runtime-only registrations show the id.
				const declared = declaredCommand(id);
				commands.register({ id, title: declared?.title ?? id, category: declared?.category ?? extId, enabled: () => true, run: () => this.runRegistered(id) });
				return Promise.resolve(undefined);
			}
			case 'commands.unregister': {
				const id = args[0] as string;
				handle.commandIds.delete(id);
				commandsRegistered.delete(id);
				unregisterCommand(id);
				return Promise.resolve(undefined);
			}
			case 'commands.execute':
				return this.executeCommand(args[0] as string, (args[1] as unknown[] | undefined) ?? []);
			case 'commands.list':
				return Promise.resolve(commands.all().map((c) => c.id));
			case 'notify': {
				const [kind, message, items] = args as ['info' | 'warning' | 'error', string, string[]];
				return new Promise((resolve) => {
					notify(kind, message, (items ?? []).map((label) => ({ label, run: () => resolve(label) })), () => resolve(undefined));
				});
			}
			case 'showInputBox':
				// quickInput resolves null on Escape; the API contract is undefined.
				return quickInput({ title: args[0] as string, value: args[1] as string, allowFreeText: true }).then((value) => value ?? undefined);
			case 'showQuickPick': {
				// The shim sends `{label, description?, detail?}` entries (string items included);
				// the picked label goes back and the shim maps it to the original item.
				const entries = (args[0] as { label: string; description?: string; detail?: string }[]) ?? [];
				const items = entries.map((entry) => ({ label: entry.label, description: entry.description, detail: entry.detail, value: entry.label }));
				return quickInput({ items, placeholder: args[1] as string }).then((value) => value ?? undefined);
			}
			case 'settings.update': {
				const [id, key, value] = args as [string, string, unknown];
				state.saveExtSetting(id, key, value);
				return Promise.resolve(undefined);
			}
			case 'state.update': {
				const [scope, key, value] = args as ['global' | 'workspace', string, unknown];
				state.saveExtMemento(extId, scope, key, value);
				return Promise.resolve(undefined);
			}
			case 'openExternal':
				return openUrl(args[0] as string).then(() => true);
			case 'clipboard.writeText':
				return writeText(args[0] as string);
			case 'clipboard.readText':
				return readText();
			case 'log':
				// The frame's createOutputChannel routes through 'output.append' below; this is
				// the bare shim logger (activationContext.outputChannel and diagnostics), which
				// keeps the console.
				console.log(`[${args[0]}] ${args[1]}`);
				return Promise.resolve(undefined);
			case 'progress.begin': {
				const id = this.nextProgressId++;
				this.progress.set(id, progressToast(String(args[0] ?? extId)));
				return Promise.resolve(id);
			}
			case 'progress.report': {
				const [id, percent, message] = args as [number, number | null, string?];
				this.progress.get(id)?.update(percent ?? null, message);
				return Promise.resolve(undefined);
			}
			case 'progress.end': {
				const id = args[0] as number;
				this.progress.get(id)?.done();
				this.progress.delete(id);
				return Promise.resolve(undefined);
			}
			case 'output.append': {
				const [name, line] = args as [string, string];
				this.appendOutput(extId, name, line);
				return Promise.resolve(undefined);
			}
			case 'output.clear': {
				this.onOutputClearChannel?.(extId, args[0] as string);
				return Promise.resolve(undefined);
			}
			case 'output.show': {
				this.onOutputReveal?.(extId, args[0] as string);
				return Promise.resolve(undefined);
			}
			case 'output.dispose': {
				const channels = this.outputChannels.get(extId) ?? [];
				this.outputChannels.set(extId, channels.filter((name) => name !== args[0]));
				this.emitOutputChannels();
				return Promise.resolve(undefined);
			}
			case 'statusbar.create': {
				const [id, alignment] = args as [string, number];
				this.statusItems.set(id, { id, alignment, text: '', tooltip: '', visible: false });
				return Promise.resolve(undefined);
			}
			case 'statusbar.set': {
				const [id, fields] = args as [string, Partial<ExtStatusBarItem>];
				const item = this.statusItems.get(id);
				if (item) Object.assign(item, fields);
				this.emitStatusBarItems();
				return Promise.resolve(undefined);
			}
			case 'statusbar.dispose': {
				this.statusItems.delete(args[0] as string);
				this.emitStatusBarItems();
				return Promise.resolve(undefined);
			}
			case 'fs.op': {
				// vscode.workspace.fs / findFiles: one command, workspace-confined on the Rust
				// side (every path resolves inside the open folders or is refused there).
				const [op, path, to, data] = args as [string, string, string?, string?];
				return invoke('ext_fs', { op, roots: ExtensionHost.workspaceFolders, path, to, data });
			}
			case 'editor.applyEdits': {
				// A null path addresses the active file editor; false (not open) tells the
				// frame's applyEdit to fall back to file-level edits.
				const [path, edits] = args as [string | null, { startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }[]];
				return Promise.resolve(this.onApplyEdits ? this.onApplyEdits(path, edits) : false);
			}
			case 'workspace.openFile': {
				const path = args[0] as string;
				this.onOpenFile?.(path);
				return Promise.resolve(undefined);
			}
			case 'treeView.register': {
				this.treeProviders.set(args[0] as string, extId);
				return Promise.resolve(undefined);
			}
			case 'treeView.changed': {
				this.onTreeRefresh?.(args[0] as string);
				return Promise.resolve(undefined);
			}
			case 'treeView.dispose': {
				this.treeProviders.delete(args[0] as string);
				return Promise.resolve(undefined);
			}
			case 'webview.create': {
				// A webview panel needs its extension's frame alive (events route back into it);
				// an extension page has none and gets the clear error instead.
				if (!this.frames.has(extId)) throw new Error('webview panels need a running extension frame');
				const [framePanelId, , title] = args as [number | null, string, string];
				const panelId = framePanelId ?? this.nextWebviewPanelId++;
				this.webviews.set(panelId, { panelId, extId, title, html: '', frame: null });
				this.onOpenWebview?.(panelId, title, extId);
				return Promise.resolve(panelId);
			}
			case 'webview.setTitle': {
				const [panelId, title] = args as [number, string];
				const view = this.webviews.get(panelId);
				if (view) view.title = title;
				return Promise.resolve(undefined);
			}
			case 'webview.setHtml': {
				const [panelId, html] = args as [number, string];
				const view = this.webviews.get(panelId);
				if (view) {
					// Setting html reloads the document, exactly as VS Code's webviews do.
					view.html = html;
					if (view.frame) view.frame.srcdoc = composeWebview(html);
				}
				return Promise.resolve(undefined);
			}
			case 'webview.postMessage': {
				const [panelId, message] = args as [number, unknown];
				this.webviews.get(panelId)?.frame?.contentWindow?.postMessage({ __ggsWebviewHost: true, type: 'message', message }, '*');
				return Promise.resolve(undefined);
			}
			case 'webview.reveal': {
				const panelId = args[0] as number;
				if (this.webviews.has(panelId)) this.onRevealWebviewTab?.(this.webviewTabId(panelId));
				return Promise.resolve(undefined);
			}
			case 'webview.dispose': {
				this.closeWebview(args[0] as number);
				return Promise.resolve(undefined);
			}
			default:
				return Promise.reject(new Error(`unsupported host request: ${method}`));
		}
	}

	/** `vscode.commands.executeCommand`: an extension-registered command receives its arguments
	 *  in its frame, and the handler's result comes back (CommandRegistry.execute takes no
	 *  arguments, so only the workbench's own commands go through it). Public because the
	 *  workbench routes extension status bar items' clicks through it. A declared command of
	 *  a not-yet-active extension wakes it first (activationEvents' `onCommand`). */
	executeCommand(id: string, args: unknown[] = []): Promise<unknown> {
		const entry = commandsRegistered.get(id);
		if (entry) return this.callFrame(entry.handle, 'runCommand', [id, args]);
		const extId = this.declaringExtension(id);
		if (extId && this.processBacked.has(extId)) {
			// A process command keeps the caller's arguments (VS Code passes the menu's own —
			// a right-clicked file, a repository) into its backend dispatch.
			return this.runProcessCommand(extId, id, args);
		}
		if (extId && !this.processBacked.has(extId)) {
			return this.ensureActive(extId).then(() => {
				const late = commandsRegistered.get(id);
				return late ? this.callFrame(late.handle, 'runCommand', [id, args]) : commands.execute(id);
			});
		}
		return commands.execute(id);
	}

	/** Run a command an extension registered: the handler lives in its frame. A declared
	 *  command whose frame is not up yet belongs to a lazily-activating extension — wake it,
	 *  then run what its activation registered. */
	private async runRegistered(id: string, args: unknown[] = []): Promise<void> {
		const entry = commandsRegistered.get(id);
		if (entry) {
			await this.callFrame(entry.handle, 'runCommand', [id, args]);
			return;
		}
		const extId = this.declaringExtension(id);
		if (extId && !this.processBacked.has(extId)) {
			await this.ensureActive(extId);
			const late = commandsRegistered.get(id);
			if (late) await this.callFrame(late.handle, 'runCommand', [id, args]);
		}
	}

	/** The extension whose manifest declares `command`, if any. */
	private declaringExtension(command: string): string | null {
		for (const [extId, ids] of this.declaredCommandIds) {
			if (ids.includes(command)) return extId;
		}
		return null;
	}

	/** Activate a lazily-woken extension (its first command / language / view): one frame,
	 *  one activation wait, however many triggers land while it is in flight. The promise
	 *  settles when the frame reports activation (`__studioExtActivated`) — a failed
	 *  activation resolves too (the failure was surfaced as a notification). */
	ensureActive(extId: string): Promise<void> {
		if (this.frames.has(extId) && !this.pendingActivations.has(extId)) return Promise.resolve();
		let activation = this.pendingActivations.get(extId);
		if (activation) return activation;
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		if (!ext || ext.format === 'bundled' || this.processBacked.has(extId)) return Promise.resolve();
		activation = new Promise<void>((resolve) => {
			this.activationWaiters.set(extId, resolve);
			void this.activate(ext);
		});
		this.pendingActivations.set(extId, activation);
		void activation.then(() => this.pendingActivations.delete(extId), () => this.pendingActivations.delete(extId));
		return activation;
	}

	/** One tree view level, for the sidebar section: routed into the owning frame, whose
	 *  provider answers serialized items; an item's `iconUrl` (an extension-relative path on
	 *  the wire) is resolved into a data URL before the sidebar renders it. */
	async treeChildren(viewId: string, handle: string | null): Promise<SerializedTreeItem[]> {
		const extId = this.treeProviders.get(viewId);
		const frame = extId ? this.frames.get(extId) : undefined;
		if (!frame) return [];
		const items = (await this.callFrame(frame, 'tree.getChildren', [viewId, handle]).catch(() => [])) as SerializedTreeItem[];
		if (extId) {
			await Promise.all(items.map(async (item) => {
				if (item.iconUrl) item.iconUrl = (await extFileDataUrl(extId, item.iconUrl!)) ?? '';
			}));
		}
		return items;
	}

	/** The workbench reports a declared view's visibility (its container selected or the
	 *  sidebar hidden): the frame's TreeView fires `onDidChangeVisibility`, and an `onView:`
	 *  activation wakes the extension the first time its view is seen. */
	noteViewVisible(viewId: string, visible: boolean): void {
		const declaredBy = extensionViewContributions().find((contribution) => contribution.views.some((view) => view.viewId === viewId))?.extId;
		const owner = this.treeProviders.get(viewId) ?? declaredBy;
		if (visible && owner) void this.ensureActive(owner);
		const frame = owner ? this.frames.get(owner) : undefined;
		if (frame && this.treeProviders.has(viewId)) void this.callFrame(frame, 'treeView.setVisible', [viewId, visible]).catch(() => undefined);
	}

	/** The workbench's active-editor change: every frame learns the active text editor
	 *  (its document text rides along when the document itself changed — a selection-only
	 *  change never re-sends a big document). */
	noteActiveEditor(editor: { kind: string; path?: string; languageName?: string; line: number; column: number; selected?: number } | null): void {
		const info = editor !== null && editor.kind === 'file' && editor.path
			? { path: editor.path, languageId: languageIdFor(editor.path), line: editor.line, column: editor.column, selected: editor.selected }
			: null;
		let push: Record<string, unknown>;
		if (info === null) {
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: null };
		} else if (info.path === this.lastPushedDocument) {
			// Same document: strip the text — the frame already holds it.
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: { ...info, text: undefined } };
		} else {
			this.lastPushedDocument = info.path;
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: { ...info, text: this.activeText?.() ?? undefined } };
		}
		for (const handle of this.frames.values()) handle.send?.(push);
	}

	/** The theme changed: every open page learns it (a page that follows the theme re-reads
	 *  its stylesheet and re-mirrors its tokens). */
	noteThemeChanged(): void {
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggxHost: true, type: 'event', event: { kind: 'theme' } }, '*');
		}
	}

	/** The app's open folders changed: every open page learns it (a page keyed to the
	 *  workspace reloads itself; the backends hear it over their own wire). */
	noteWorkspaceChanged(folders: string[]): void {
		ExtensionHost.workspaceFolders = folders;
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggxHost: true, type: 'event', event: { kind: 'workspace', folders } }, '*');
		}
	}

	/** A document was saved: every frame's `onDidSaveTextDocument` fires. */
	noteDocumentSaved(path: string): void {
		const push = { type: '__studioExtEvent', event: 'documentSaved', path, languageId: languageIdFor(path) };
		for (const handle of this.frames.values()) handle.send?.(push);
	}

	/** A file opened in an editor: every extension declaring `onLanguage:<its language>`
	 *  wakes (the language id follows VS Code's map plus any `contributes.languages` entry —
	 *  module 12's language registry feeds `languageOf`). */
	noteLanguageOpened(fileName: string): void {
		const language = languageIdFor(fileName);
		if (!language) return;
		for (const [extId, policy] of this.activationPolicies) {
			if (policy.languages.has(language)) void this.ensureActive(extId);
		}
	}

	/** Do any `workspaceContains` patterns match the open folders? An exact relative path
	 *  checks existence; a pattern with wildcards walks (`ext_fs`, workspace-confined). */
	private async matchesWorkspaceContains(patterns: string[]): Promise<boolean> {
		const roots = ExtensionHost.workspaceFolders;
		if (patterns.length === 0 || roots.length === 0) return false;
		for (const pattern of patterns) {
			try {
				const found = await invoke<string[]>('ext_fs', { op: /[*?]/.test(pattern) ? 'find' : 'exists', roots, path: pattern });
				if (found.length > 0) return true;
			} catch {
				// The path (or the backend answer) is unavailable: this pattern cannot match.
			}
		}
		return false;
	}

	private callFrame(handle: FrameHandle, method: string, args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextCallId++;
			const send = handle.send;
			if (!send) return reject(new Error('extension frame is not loaded'));
			const finish = (event: MessageEvent) => {
				const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown };
				if (data?.type === '__studioExtCallResult' && data.id === id) {
					window.removeEventListener('message', finish);
					handle.pendingCalls.delete(cancel);
					if (data.ok) resolve(data.result);
					else reject(data.result);
				}
			};
			const cancel = (error: Error) => {
				window.removeEventListener('message', finish);
				handle.pendingCalls.delete(cancel);
				reject(error);
			};
			handle.pendingCalls.add(cancel);
			window.addEventListener('message', finish);
			send({ type: '__studioExtCall', id, method, args });
		});
	}

	private onMessage(event: MessageEvent): void {
		const data = event.data as { type?: string; id?: number; method?: string; args?: unknown[]; ok?: boolean; result?: unknown; extensionId?: string; error?: string };
		if (!data || typeof data !== 'object') return;

		// An extension page's RPC (the composed bootstrap's acquireGgsApi): routed by the
		// frame it came from, the same way the logic frames' __studioExtRpc is.
		if ((data as { __ggxPage?: boolean }).__ggxPage === true) {
			const page = this.pageFor(event.source);
			if (!page) return;
			const message = data as { kind?: string; id?: number; method?: string; args?: unknown[] };
			if (message.kind === 'rpc' && typeof message.method === 'string') {
				// The page source is always a Window (a frame), and jsdom's postMessage takes
				// the targetOrigin string form — not the options object the DOM lib offers.
				const pageWindow = event.source as Window | null;
				this.servePageRpc(message.method, message.args ?? [], page).then(
					(result) => pageWindow?.postMessage({ __ggxHost: true, type: 'rpcResult', id: message.id, ok: true, result }, '*'),
					(error) => pageWindow?.postMessage({ __ggxHost: true, type: 'rpcResult', id: message.id, ok: false, result: String(error) }, '*')
				);
			}
			return;
		}

		// A webview panel's message (the composed acquireVsCodeApi bootstrap): it belongs to
		// the panel whose frame sent it, and crosses to the owning extension's frame.
		if ((data as { __ggsWebview?: boolean }).__ggsWebview === true) {
			const view = this.webviewFor(event.source);
			const message = data as { kind?: string; message?: unknown };
			if (view && message.kind === 'message') {
				this.frames.get(view.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewMessage', panelId: view.panelId, message: message.message });
			}
			return;
		}

		if (data.type === '__studioExtActivated') {
			// Lazy activation waits for exactly this; eager activation never set a waiter.
			this.activationWaiters.get(data.extensionId ?? '')?.();
			this.activationWaiters.delete(data.extensionId ?? '');
			return; // activation succeeded; nothing to surface
		}
		if (data.type === '__studioExtActivateFailed') {
			// The failure surfaces as a notification; a lazy activation waiting on it settles
			// rather than hanging its trigger.
			this.activationWaiters.get(data.extensionId ?? '')?.();
			this.activationWaiters.delete(data.extensionId ?? '');
			notify('warning', `Extension ${data.extensionId} failed to activate: ${data.error ?? 'unknown error'}`);
			return;
		}

		if (data.type === '__studioExtRpc') {
			const handle = this.frameFor(event.source);
			if (!handle) return;
			const extId = this.extIdFor(handle);
			this.serve(data.method!, data.args ?? [], extId, handle).then(
				(result) => event.source?.postMessage({ type: '__studioExtRpcResult', id: data.id, ok: true, result }, { targetOrigin: '*' }),
				(error) => event.source?.postMessage({ type: '__studioExtRpcResult', id: data.id, ok: false, result: String(error) }, { targetOrigin: '*' })
			);
		}
	}

	private frameFor(source: MessageEventSource | null): FrameHandle | null {
		for (const handle of this.frames.values()) {
			if (handle.frame.contentWindow === source) return handle;
		}
		return null;
	}

	private pageFor(source: MessageEventSource | null): PageFrameHandle | null {
		for (const page of this.pageFrames.values()) {
			if (page.frame.contentWindow === source) return page;
		}
		return null;
	}

	private webviewFor(source: MessageEventSource | null): WebviewHandle | null {
		for (const view of this.webviews.values()) {
			if (view.frame?.contentWindow === source) return view;
		}
		return null;
	}

	private extIdFor(handle: FrameHandle): string {
		for (const [id, h] of this.frames) if (h === handle) return id;
		return 'extension';
	}
}

/** Live command registrations: command id -> the frame holding its handler. */
const commandsRegistered = new Map<string, { extId: string; handle: FrameHandle }>();

/** Remove a command from the registry without touching other registrations of the same id. */
function unregisterCommand(id: string): void {
	// The registry has no remove(); re-registering a disabled command stands in until it grows
	// one. Palette entries filter on `enabled`, so the command disappears from the UI.
	commands.register({ id, title: id, enabled: () => false, run: () => undefined });
}
