// The extension host's main-window half: it lists the extensions the Rust side installed from
// `.vsix` / `.ggx` files, spins up one sandboxed frame per extension (ext-host.html), feeds
// each its entry bundle, and serves the frames' host requests - the workbench command
// registry, notifications, quick inputs, settings persistence, opener and clipboard calls,
// withProgress toasts, status bar items, output channels and webview panels - over
// postMessage. Events flow back as `__studioExtEvent` pushes (configuration changes, webview
// messages, disposals).
//
// The git-graph-rs extension is deliberately NOT activated here: it is integrated into the app
// (its engine runs in its backend process, its webview is hosted natively by GraphHost); the
// Rust side lists it from the bundled `.ggx` installed on first launch (falling back to the
// manifest embedded in the binary when the package is absent), and the frame-based host is
// for the additional VSIX / `.ggx` extensions Studio supports.

import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { builtinContributions } from 'virtual:builtin-contributions';

import { commands } from './commands';
import { applyContributions, applyExtensionSettings, declaredCommand, localize, removeContributions, type ManifestContributes } from './contributions';
import { locale, registerZhCnText, t } from './i18n';
import { loadBuiltinSettings } from './lazy';
import * as state from './state';
import { notify, progressToast, quickInput, type ProgressToast } from './ui';

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
	/** `builtin` (the integrated git-graph-rs), `vsix` or `ggx`. */
	format: 'builtin' | 'vsix' | 'ggx';
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
	pages?: Record<string, { page: string; title?: string }> | null;
	/** `ggx/2`: the process backend declaration — `ext_process.rs` spawns it on demand.
	 *  `protocol` is `ggs-ext/1` (the default, command-style plugins) or `ggx-rpc/1` (the
	 *  graph engine's thread-per-request protocol); `binaries` is the per-platform command
	 *  map, when the package carries more than one platform's binary. */
	backend?: { kind: string; command: string; args?: string[]; protocol?: string; binaries?: Record<string, string> } | null;
	permissions?: string[];
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

/** The built-in git-graph-rs extension's id (publisher.name, matching Rust's GRAPH_PACKAGE_ID) -
 *  exported so anything reading its declared settings or context (workbench.ts) uses the same
 *  key `applyContributions` registered its manifest under, instead of a second, driftable copy
 *  of this string. */
export const GIT_GRAPH_RS_EXT_ID = 'neophack.git-graph-rs';

/** Apply the baked-in extensions' settings schemas once their async chunk loads (the second
 *  half of the baked contributions - the first-paint slice carries commands and menus only).
 *  The Settings dialog awaits this, so its extension rows cannot render without the schema
 *  unless the chunk itself failed - which leaves the rows absent, not the dialog broken. */
let builtinSettingsLoaded: Promise<void> | null = null;

export function ensureBuiltinSettings(): Promise<void> {
	return (builtinSettingsLoaded ??= loadBuiltinSettings()
		.then((module) => {
			for (const ext of module.builtinSettings) applyExtensionSettings(ext.extId, ext.configuration, ext.nls);
		})
		.catch(() => undefined));
}

/** The extension whose webview and backend the workbench hosts natively (via GraphHost). */
const NATIVELY_HOSTED = new Set([GIT_GRAPH_RS_EXT_ID]);

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

	/** Commands the workbench executes itself for natively-hosted extensions (the built-in
	 *  git-graph-rs never runs in a frame). `nativeCommands` lists the ids it handles;
	 *  `onNativeCommand` executes one and returns whether it was handled. */
	nativeCommands: ReadonlySet<string> = new Set();
	onNativeCommand: ((command: string) => boolean) | null = null;
	/** Called after a registration pass added contributions asynchronously (installed
	 *  extensions): the workbench re-renders the views that had already built their menus. */
	onContributionsApplied: (() => void) | null = null;
	/** Workbench hook: open one of an extension's pages in an editor tab — wired the same
	 *  way `onNativeCommand` is (the workbench owns the editor area, the host owns pages). */
	onOpenPage: ((extId: string, pageId: string, params?: unknown) => void) | null = null;
	/** The installed extensions the host has listed; pages and backends resolve through it. */
	private installedExts: ExtInfo[] = [];
	/** The open page frames, by serial (their iframes live in editor tabs). */
	private readonly pageFrames = new Map<number, PageFrameHandle>();
	private nextPageSerial = 1;
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

	/** The withProgress toasts, by progress id. */
	private readonly progress = new Map<number, ProgressToast>();
	private nextProgressId = 1;

	/** Synchronously register the baked-in extensions' contributions (menus, commands,
	 *  keybindings). The data comes from the build-time virtual module, so the workbench's
	 *  first render already sees these menus - the async activateInstalled() pass skips them.
	 *  The settings schemas ride their own async chunk (most of the manifest's bytes, needed
	 *  only by the Settings dialog): their pass starts loading right away. */
	applyBuiltinContributions(): void {
		for (const baked of builtinContributions) this.registerContributions(baked.extId, baked.contributes, baked.nls, baked.nlsTranslations['zh-cn'] ?? {});
		void ensureBuiltinSettings();
	}

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

	/** Read a text file inside an installed extension (README, CHANGELOG, manifest). */
	async readFile(extId: string, relPath: string): Promise<string> {
		return await invoke<string>('ext_read_file', { extId, relPath });
	}

	/** Install a `.ggx` package — Studio's own format (a newer version replaces an installed
	 *  `.vsix` or `.ggx` of the same id; the integrated git-graph-rs is refused on the Rust
	 *  side). */
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
	 *  Install on the Extensions view's bundled entries (the integrated git-graph-rs, and the
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
		// Skipped for entries with nothing to boot: a `builtin`-format entry (an
		// embedded-manifest offer — the integrated git-graph-rs without its package, the
		// bundled sample) has no files on disk, and a ggx/2 process package's commands
		// dispatch to its backend — its `package.json` is its whole program.
		const toActivate = installed.filter(
			(ext) =>
				ext.format !== 'builtin' &&
				!this.processBacked.has(ext.id) &&
				!NATIVELY_HOSTED.has(ext.id) &&
				!this.frames.has(ext.id)
		);
		await Promise.all(toActivate.map((ext) => this.activate(ext)));
		this.onContributionsApplied?.();
	}

	/** Parse the extension's package.json (and package.nls.json) and register its declared
	 *  commands, keybindings and context menu entries. */
	private async applyContributions(ext: ExtInfo): Promise<void> {
		let manifest: { contributes?: ManifestContributes } | null = null;
		let nls: Record<string, string> = {};
		let nlsZhCn: Record<string, string> = {};
		try {
			manifest = JSON.parse(await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.json' }));
			const localization = await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.nls.json' }).catch(() => null);
			if (localization) nls = JSON.parse(localization) as Record<string, string>;
			const zhCn = await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.nls.zh-cn.json' }).catch(() => null);
			if (zhCn) nlsZhCn = JSON.parse(zhCn) as Record<string, string>;
		} catch {
			return; // unreadable manifest: nothing to contribute
		}
		this.registerContributions(ext.id, manifest?.contributes, nls, nlsZhCn);
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

	/** Register one extension's parsed manifest contributions into the workbench. */
	private registerContributions(extId: string, contributes: ManifestContributes | null | undefined, nls: Record<string, string>, nlsZhCn: Record<string, string> = {}): void {
		this.declaredCommandIds.set(extId, (contributes?.commands ?? []).map((declared) => declared.command));
		const dispatch = (command: string) => {
			if (this.onNativeCommand?.(command)) return;
			if (this.processBacked.has(extId)) return void this.runProcessCommand(extId, command);
			const declared = declaredCommand(command);
			if (!declared) return;
			void this.runRegistered(command);
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

	/** A declared command is runnable when its extension's frame holds a handler, the
	 *  workbench handles it natively, or its extension's ggx/2 backend will take it. */
	private canRunCommand(command: string): boolean {
		if (this.nativeCommands.has(command)) return true;
		if (this.processCommandIds.has(command)) return true;
		return commandsRegistered.has(command);
	}

	/** Re-activate one extension (after an install upgraded it): fresh contributions, fresh frame. */
	private async reload(extId: string): Promise<void> {
		if (NATIVELY_HOSTED.has(extId)) {
			// A git-graph-rs upgrade is picked up by GraphHost's reload; refresh its contributions.
			removeContributions(extId);
			const ext = (await this.list().catch(() => [] as ExtInfo[])).find((e) => e.id === extId);
			if (ext) await this.applyContributions(ext);
			return;
		}
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
	pageEntry(extId: string, pageId: string): { page: string; title?: string } | null {
		const manifest = this.installedExts.find((ext) => ext.id === extId)?.ggx;
		if (!manifest) return null;
		const pages: Record<string, { page: string; title?: string }> = {};
		if (manifest.frontend?.page) pages.view = { page: manifest.frontend.page };
		Object.assign(pages, manifest.pages ?? {});
		return pages[pageId] ?? null;
	}

	/** Open one of an extension's pages in an editor tab (the workbench's `onOpenPage` does
	 *  the opening; this validates and hands over, the way a command's result may). */
	openPage(extId: string, pageId: string, params?: unknown): void {
		if (!this.pageEntry(extId, pageId)) {
			notify('warning', `${t('extensions.pageMissing')}: ${extId} / ${pageId}`);
			return;
		}
		this.onOpenPage?.(extId, pageId, params);
	}

	/** Mount one page into a container (its editor tab's pane) and return the disposer the
	 *  tab runs on close. The iframe loads the package's own document through the `ggx`
	 *  protocol — the backend composes the page bootstrap into it, so the page gets
	 *  `acquireGgsApi()` and needs nothing else from the host to boot. */
	mountPage(extId: string, pageId: string, params: unknown, container: HTMLElement): () => void {
		const entry = this.pageEntry(extId, pageId);
		const serial = this.nextPageSerial++;
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
				context: { extensionId: extId, pageId, params: params ?? null, language: locale() }
			}, '*');
		});
		container.appendChild(frame);
		return () => {
			this.pageFrames.delete(serial);
			for (const cancel of [...handle.pendingCalls]) cancel(new Error(`page ${extId}/${pageId} was closed`));
			frame.remove();
		};
	}

	/** A page's request of the host: the same surface the extension frames get (commands,
	 *  notifications, quick input, clipboard…), plus the page's own two — opening another
	 *  page of its extension and running a command in its backend process. */
	private async servePageRpc(method: string, args: unknown[], page: PageFrameHandle): Promise<unknown> {
		switch (method) {
			case 'pages.open':
				this.openPage(page.extId, args[0] as string, args[1]);
				return undefined;
			case 'backend.run': {
				const [command, commandArgs] = args as [string, unknown[]?];
				return await invoke('ext_process_run', { extId: page.extId, command, args: commandArgs ?? [] });
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
	 *  it (lazy activation). A result naming one of the package's pages opens it: the
	 *  convention a backend uses to surface UI, the way a VS Code command shows a webview. */
	private async runProcessCommand(extId: string, command: string): Promise<void> {
		try {
			const result = await invoke<unknown>('ext_process_run', { extId, command, args: [] });
			if (result && typeof result === 'object' && typeof (result as { openPage?: unknown }).openPage === 'string') {
				const { openPage: pageId, params } = result as { openPage: string; params?: unknown };
				this.openPage(extId, pageId, params);
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
	 *  workbench routes extension status bar items' clicks through it. */
	executeCommand(id: string, args: unknown[] = []): Promise<unknown> {
		const entry = commandsRegistered.get(id);
		if (entry) return this.callFrame(entry.handle, 'runCommand', [id, args]);
		return commands.execute(id);
	}

	/** Run a command an extension registered: the handler lives in its frame. */
	private async runRegistered(id: string, args: unknown[] = []): Promise<void> {
		const entry = commandsRegistered.get(id);
		if (entry) await this.callFrame(entry.handle, 'runCommand', [id, args]);
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
			return; // activation succeeded; nothing to surface
		}
		if (data.type === '__studioExtActivateFailed') {
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
