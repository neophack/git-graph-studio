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

import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from './commands';
import { applyContributions, applyExtensionSettings, declaredCommand, extensionSettingDefs, extensionThemeList, extensionViewContributions, languageIdFor, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from './contributions';
import { describeDetail, extLog, extLogEnabled, extLogLevel, extLogOnce, flushExtLog, levelForConsole, setExtLogOutput, type ExtLogLevel } from './extLog';
import { defaultNodeEnv, type NodeEnv } from './extModuleLoader';
import type { EditorPlacement } from './editor';
import { setFileDiagnostics, type SerializableDiagnostic } from './editorDiagnostics';
import { settings as appSettings, syncExtensionThemes, themeById } from './settings';
import { locale, registerZhCnText, t, tf } from './i18n';
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
	/** `bundled` (a not-yet-installed package the installer ships) or `vsix`. */
	format: 'bundled' | 'vsix' | 'ggs';
	/** The `ggs` key declaration, for packages installed from one. */
	capabilities: StudioManifest | null;
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

/** One marketplace entry (`ext_gallery_lookup`), as the Extensions view renders it. */
export interface GalleryEntry {
	/** `{namespace}.{name}` — the same shape as an installed extension's id. */
	id: string;
	name: string;
	namespace: string;
	displayName: string | null;
	description: string | null;
	version: string;
	downloadCount: number;
	averageRating: number | null;
	verified: boolean;
	timestamp: string;
	iconUrl: string | null;
	/** The `.vsix` download URL (the gallery's own origin) — what `ext_gallery_install` takes. */
	downloadUrl: string;
}

/** The marketplace the Extensions view installs its featured packages from: Open VSX, the open-source
 *  registry the VS Code ecosystem publishes to (the same service code-server and Theia
 *  point at). The backend confines every gallery request to this origin. */
export const MARKETPLACE_URL = 'https://open-vsx.org';
/** The Tauri event a real-Node extension host's `ggs.hostRequest` arrives on (the Rust
 *  reader forwards it; see ext_process.rs's HOST_REQUEST_EVENT). */
export const HOST_REQUEST_EVENT = 'ext-host-request';

/** The `manifest.json` of an extension package. */
export interface StudioManifest {
	format: string;
	id: string;
	version: string;
	/** The process backend declaration the install derived for this package — `ext_process.rs`
	 *  spawns it on demand. `protocol` names the one wire protocol (`ggs-ext/1` when absent;
	 *  anything else fails the start with an upgrade hint); `binaries` is the per-platform
	 *  command map, when the package carries more than one platform's binary. */
	backend?: { kind: string; command: string; args?: string[]; protocol?: string; binaries?: Record<string, string> } | null;
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

/** Cached marketplace icon reads, as data URLs (the same bridge `dataUrlCache` uses). */
const galleryIconCache = new Map<string, Promise<string | null>>();

/** How long a relayed `open_in_editor`'s session stays the pending signal a following
 *  `webview.create` matches against — the create normally follows within the round trip
 *  to the extension; the TTL only bounds a signal left unused (the extension's map was
 *  healthy and it revealed instead of creating). */
const WEBVIEW_OPEN_PENDING_MS = 15_000;

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
	left: { revision: string; path: string; label: string; exists: boolean; local?: boolean; content?: string };
	right: { revision: string; path: string; label: string; exists: boolean; local?: boolean; content?: string };
}

/** The theme of the moment, as a page's 'theme.stylesheet' request answers it and the theme
 *  event pushes carry it: the active theme's vscode-* class, its stylesheet text, and the
 *  --vscode-* declarations parsed out of it. */
export interface PageTheme {
	kind: 'vscode-dark' | 'vscode-light';
	label: string;
	css: string;
	vars: Record<string, string>;
}

/** Extract a theme stylesheet's `--vscode-*` custom-property declarations (file order; the
 *  last declaration of a name wins). VS Code's webview host writes every theme variable into
 *  the document's *inline* style — `document.documentElement.style` — and package script
 *  reads them back that way (`getPropertyValue` on the element style sees stylesheets
 *  never), so the pages and webviews this host serves mirror the variables inline too:
 *  delivered with the page's init context and on every theme push, applied by the page
 *  bootstrap and by the webview boot script. */
export function themeVars(css: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const match of css.matchAll(/(--vscode-[a-zA-Z0-9-]+)\s*:\s*([^;{}]+)/g)) {
		vars[match[1]] = match[2].trim();
	}
	return vars;
}

/** JSON for embedding into a generated `<script>`: `<` escaped so a `</script>` sequence in
 *  a value (an extension-contributed theme's text) can never close the tag early. */
function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
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

/** The `ggs://` URL base of an installed package's directory (trailing slash included) —
 *  what the pages' iframes and the webview panels' `asWebviewUri` compose paths onto. Falls
 *  back to the plain scheme shape where Tauri's internals are absent (jsdom, probes).
 *
 *  The directory name alone crosses `convertFileSrc` — it encodes its argument as ONE path
 *  segment, so a trailing slash in it became `%2F` and the whole composed URL
 *  (`…1.0.26%2Fweb/view.html`) reached the network stack as a single malformed segment; the
 *  separator is appended after the conversion, never inside it. */
export function extAssetBase(ext: ExtInfo | undefined): string {
	const dirName = ext?.path.split(/[\\/]/).pop() ?? '';
	const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } }).__TAURI_INTERNALS__;
	return internals?.convertFileSrc ? internals.convertFileSrc(dirName, 'ggs') + '/' : `ggs://localhost/${dirName}/`;
}

/** The `ggs://` URL of a file inside an installed package, the way the pages' iframes load
 *  them: `{install dir name}/{relative path}` under the `ggs` protocol the backend serves. */
export function extAssetUrl(ext: ExtInfo | undefined, rel: string): string {
	return extAssetBase(ext) + rel.replace(/\\/g, '/');
}

/** The extension host frame's document URL. The frame is sandboxed without `allow-same-origin`,
 *  so its document sits on an opaque origin and the `type=module` scripts it references load
 *  CORS-checked — the tauri protocol answers those with the app's own origin, never `null`,
 *  and the load dies (no frame extension would ever activate in the packaged app). The `ggs`
 *  protocol answers `*`, so in production the document and its hashed assets are served
 *  through it out of the binary's embedded assets (the reserved names `serve_app_asset`
 *  answers in cmd_ext.rs); under the dev server the plain path stands, the server sending
 *  `*` itself (vite.config's `cors`). */
function extHostFrameUrl(): string {
	if (!import.meta.env.PROD) return '/ext-host.html';
	const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } }).__TAURI_INTERNALS__;
	return internals?.convertFileSrc ? internals.convertFileSrc('ext-host.html', 'ggs') : 'ggs://localhost/ext-host.html';
}

interface FrameHandle {
	/** The host iframe. Absent on a remote handle: an extension whose program runs in a
	 *  real-Node host process (nodeHost.ts) has no frame — its calls and pushes cross the
	 *  ggs-ext/1 stdio channel instead (see `call` / `send`). */
	frame?: HTMLIFrameElement;
	/** True on a remote handle: the extension's program runs in a backend process whose
	 *  single JS thread parks inside every host request until this side's answer crosses
	 *  back over stdio. Anything this answer waits on must never call that process back —
	 *  the caller could not answer it. */
	remote?: boolean;
	/** Posts into the frame (set once it loaded its extension). */
	send?: (message: unknown) => void;
	/** A remote handle's call transport: the host's `__studioExtCall` vocabulary over the
	 *  backend's ggs-ext/1 channel instead of the frame's window messages. */
	call?: (method: string, args: unknown[]) => Promise<unknown>;
	/** Command ids this extension registered; unregistered when it goes away. */
	commandIds: Set<string>;
	/** The calls into the frame still waiting for their result: settled (rejected) when the
	 *  frame goes away, or a command that was running in it would wait forever and its
	 *  result listener never leave the window. */
	pendingCalls: Set<(error: Error) => void>;
}

/** The delivery-gate half every webview surface carries — a tabbed panel's record and a
 *  sidebar view's alike: the frame hosting the page, the messages held until the page can
 *  receive them, and whether the frame's current document finished loading. */
interface WebviewDelivery {
	/** Set once the surface mounted it (the first `setHtml` may arrive first — it queues on
	 *  the surface's own `html`). */
	frame: HTMLIFrameElement | null;
	/** Messages the extension pushed while the page could not receive them — the page's
	 *  initial state rides the first pushes, and losing them is the blank-but-loaded
	 *  page: the mount (behind the tab icon's read on a first open) and the backend's
	 *  first postMessage race, and the loser used to vanish silently. Queued until the
	 *  page's own listeners exist (the frame's load event), then delivered in order. */
	pending: unknown[];
	/** The surface's current document (the latest setHtml, painted or pending). */
	html: string;
	/** Whether the frame's current document finished loading — a message posted before
	 *  that replaces the not-yet-navigated document (or precedes the page's listeners)
	 *  and vanishes; it queues instead. */
	loaded: boolean;
	/** The html last assigned to the frame — the document actually living there once its
	 *  load settles. "Already painted" means this equals `html`; a loaded-but-older
	 *  document (the grace expired between its load and a setHtml's coalescing window)
	 *  must still be replaced, or the page boots the stale shell and sits blank. */
	painted: string | null;
	/** The load event's grace timer: a document that just loaded holds its gate closed for
	 *  a moment, because the extension's next act is often either a push (must wait for the
	 *  gate — delivering into a fresh document early is fine, but a setHtml reload right
	 *  after the push would orphan the state into the replaced document) or the real
	 *  document's setHtml itself (the shell→document pair). */
	loadGrace: number | null;
	/** The first paint's coalescing timer: extensions deliver a shell document and the real
	 *  one in rapid pairs (claude-code: 24k then 27k chars within milliseconds), and painting
	 *  the shell boots the page just to be discarded by the second setHtml's reload — worse,
	 *  the shell's load event opens the message gate, so the page's initial state can be
	 *  delivered into the doomed shell document and the real one boots blank forever (the
	 *  intermittent empty new-session page). Holding the first paint ~80 ms paints one
	 *  document — the latest — and the state queues behind its load, where it belongs. */
	firstPaintTimer: number | null;
}

/** One webview panel a frame extension created (`window.createWebviewPanel`): the tab-side
 *  record. The workbench opens the tab (`onOpenWebview`); the iframe lives in it and this
 *  host half feeds it HTML and relays messages both ways. */
interface WebviewHandle extends WebviewDelivery {
	panelId: number;
	extId: string;
	title: string;
}

/** One sidebar webview view (`window.registerWebviewViewProvider`): the section-side
 *  record — the same delivery gate a panel crosses, on the section's mount instead of a
 *  tab's (the sidebar chat is the same claude-code page a tab hosts, and blanks the same
 *  way when its first pushes cross before the section mounts). */
interface WebviewViewRecord extends WebviewDelivery {
	extId: string;
}

/** One extension-owned status bar item (`window.createStatusBarItem`), as the bar renders it. */
export interface ExtStatusBarItem {
	id: string;
	alignment: number;
	/** VS Code's priority: higher sits further left within its alignment. */
	priority?: number;
	text: string;
	tooltip: string;
	command?: string;
	/** The arguments of a `Command`-object command (`{ command, arguments }`). */
	commandArgs?: unknown[];
	/** A colour or a theme colour id (`statusBarItem.errorForeground`, …). */
	color?: string;
	backgroundColor?: string;
	visible: boolean;
}

/** The output channel the extension host log writes to (`extLog.ts`). */
export const EXT_HOST_LOG_OWNER = 'ggs.extension-host';

/** The core configuration sections VS Code defines and extensions read through
 *  `getConfiguration` (`editor.tabSize`, `files.exclude`, `http.proxy`, …) — mirrored
 *  from the workbench's own settings where one exists. */
function coreConfigurationDefaults(): Record<string, unknown> {
	return {
		'editor.tabSize': appSettings.tabSize,
		'editor.insertSpaces': true,
		'editor.fontSize': appSettings.fontSize,
		'editor.wordWrap': appSettings.wordWrap ? 'on' : 'off',
		'editor.minimap.enabled': appSettings.minimap,
		'editor.formatOnSave': false,
		'editor.detectIndentation': true,
		'files.autoSave': appSettings.autoSave,
		'files.autoSaveDelay': appSettings.autoSaveDelay,
		'files.encoding': 'utf8',
		'files.eol': 'auto',
		'files.exclude': { '**/.git': true, '**/.svn': true, '**/.hg': true, '**/CVS': true, '**/.DS_Store': true, '**/Thumbs.db': true },
		'files.watcherExclude': { '**/.git/objects/**': true, '**/.git/subtree-cache/**': true, '**/node_modules/*/**': true },
		'search.exclude': { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true },
		'http.proxy': '',
		'http.proxyStrictSSL': true,
		'http.proxySupport': 'override',
		'git.enabled': true,
		'git.path': null,
		'workbench.colorTheme': themeById().label ?? appSettings.theme,
		'terminal.integrated.defaultProfile.windows': null,
		'telemetry.telemetryLevel': 'off'
	};
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

/** How long a lazy `ensureActive` waits for the frame's activation to settle before the
 *  waiter is released with a warning — a hung `activate` in a package's own code must not
 *  wedge its commands into an unanswerable wait. */
export const ACTIVATION_TIMEOUT = 30_000;

/** Parse VS Code's `activationEvents` into the policy the host activates by. Events this
 *  model does not carry (`onFileSystem:`, `onUri`, `onDebugResolve`, …) leave the extension
 *  eager — never un-activatable. The implicit activation events VS Code derives from the
 *  manifest's own contributions (since 1.74: every `contributes.languages` id — and every
 *  grammar's language — implies `onLanguage:`) join the declared ones, so a modern package
 *  that lists no `onLanguage:` at all still wakes when its language's file opens. (Commands
 *  and views need no implicit entries here: the wake-on-run and view-visibility paths
 *  already cover them.) */
export function parseActivationPolicy(events: string[] | undefined, contributes?: ManifestContributes): ActivationPolicy {
	const policy: ActivationPolicy = { eager: true, commands: new Set(), languages: new Set(), views: new Set(), workspaceContains: [] };
	if (events && events.length > 0) {
		policy.eager = false;
		for (const event of events) {
			if (event.startsWith('onCommand:')) policy.commands.add(event.slice('onCommand:'.length));
			else if (event.startsWith('onLanguage:')) policy.languages.add(event.slice('onLanguage:'.length));
			else if (event.startsWith('onView:')) policy.views.add(event.slice('onView:'.length));
			else if (event.startsWith('workspaceContains:')) policy.workspaceContains.push(event.slice('workspaceContains:'.length));
			else policy.eager = true; // `*`, onStartupFinished, and every event this host cannot observe
		}
	}
	// The implicit events join whatever was declared — a manifest with no activationEvents
	// at all stays eager (the safe reading of a package that declared none), and its
	// contributed languages still wake it if a later boot pass skips the eager path.
	for (const language of contributes?.languages ?? []) policy.languages.add(language.id);
	for (const grammar of contributes?.grammars ?? []) {
		if (grammar.language) policy.languages.add(grammar.language);
	}
	return policy;
}

/** The bootstrap composed into a webview panel's HTML: `acquireVsCodeApi()` — one per page,
 *  VS Code's own rule — whose `postMessage` reaches the owning extension frame, plus the
 *  message listener the host relays through. State stays inside the frame (as much of it as
 *  a sandboxed srcdoc document can keep). The boot script wears the extension's own CSP
 *  nonce when its html declares one — VS Code's own convention, and the only way the boot
 *  survives a `script-src 'nonce-…'` policy the package shipped. */
function webviewBoot(nonce: string | null): string {
	return `<script${nonce ? ` nonce="${nonce}"` : ''}>
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
		if (data.type === 'theme') {
			// VS Code defines the --vscode-* variables (and the kind class) in every webview
			// document itself; the host pushes its theme here for the same effect. The
			// variables land on the document's inline style too — VS Code writes them there,
			// and package script reads them back through documentElement.style.
			var style = document.getElementById('__ggsTheme');
			if (style && typeof data.css === 'string') style.textContent = data.css;
			if (data.vars) {
				var inline = document.documentElement.style;
				for (var name in data.vars) inline.setProperty(name, data.vars[name]);
			}
			document.documentElement.classList.remove('vscode-dark', 'vscode-light');
			document.documentElement.classList.add(data.kind === 'vscode-light' ? 'vscode-light' : 'vscode-dark');
		}
	});
})();
</script>`;}

/** Compose the theme (the active theme's variable definitions and its kind class) and the
 *  bootstrap into a webview document (the `compose_page` rule: inside `<head>` when there
 *  is one, else after `<html>`, else at the very start). VS Code defines `--vscode-*` in
 *  every webview document itself — without the same injection here, every `var(--vscode-…)`
 *  in a package's own CSS is undefined, and widgets (dropdown menus above all) render with
 *  no background at all. */
function composeWebview(html: string, theme: { kind: 'vscode-dark' | 'vscode-light'; css: string; vars: Record<string, string> } | null): string {
	// The extension's own CSP nonce (VS Code's convention: the html declares one nonce and
	// the injected api script reuses it) — without it a `script-src 'nonce-…'` policy
	// blocks the boot and the webview can never speak.
	const nonce = /nonce="([A-Za-z0-9+/=_-]+)"/.exec(html)?.[1] ?? null;
	const themeHead = theme === null
		? ''
		: `<style id="__ggsTheme">${theme.css}</style><script${nonce ? ` nonce="${nonce}"` : ''}>document.documentElement.classList.add('${theme.kind}');var s=document.documentElement.style,v=${jsonForScript(theme.vars)};for(var k in v)s.setProperty(k,v[k]);</script>`;
	const boot = themeHead + webviewBoot(nonce);
	for (const marker of ['</head>', '</HEAD>']) {
		const at = html.indexOf(marker);
		if (at !== -1) return `${html.slice(0, at)}${boot}${html.slice(at)}`;
	}
	const at = html.indexOf('<html');
	if (at !== -1) {
		const end = html.indexOf('>', at);
		const cut = end === -1 ? html.length : end + 1;
		return `${html.slice(0, cut)}${boot}${html.slice(cut)}`;
	}
	return boot + html;
}

/** Load a webview frame's composed document. Assigning `srcdoc` to a frame whose subtree
 *  is not yet connected to the document (an editor pane still being assembled offscreen)
 *  silently drops the navigation — the panel then sits blank until something reloads it.
 *  The wait for connection is NOT paint-gated: a requestAnimationFrame retry never fires
 *  for a window the platform occludes (observed as the intermittent blank Git Graph and
 *  claude pages on macOS, 2026-09-28), so a MutationObserver attaches the load the
 *  moment the pane joins the document, with a generous timer as the bound. Every step
 *  lands in the extension host log — the intermittent-blank causal chain is read from
 *  there, not guessed. */
function loadFrameDoc(frame: HTMLIFrameElement, html: string, theme: { kind: 'vscode-dark' | 'vscode-light'; css: string; vars: Record<string, string> } | null, owner: string): void {
	const composed = composeWebview(html, theme);
	const started = performance.now();
	let done = false;
	const finish = (path: string) => {
		if (done) return;
		done = true;
		extLog('info', 'host', `webview ${owner}: document ${path} (${Math.round(performance.now() - started)} ms, ${composed.length} chars)`);
	};
	const assign = () => {
		finish(frame.isConnected ? 'assigned' : 'ASSIGNED INTO A DETACHED FRAME (the navigation will drop)');
		frame.srcdoc = composed;
		armLoadWatchdog(frame, composed, owner, started);
	};
	if (frame.isConnected) { assign(); return; }
	extLog('info', 'host', `webview ${owner}: mount frame not connected yet — waiting for the pane to attach`);
	const observer = new MutationObserver(() => {
		if (!frame.isConnected) return;
		observer.disconnect();
		clearTimeout(bound);
		assign();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
	const bound = setTimeout(() => {
		observer.disconnect();
		extLog('warn', 'host', `webview ${owner}: the pane never attached within 30 s — assigning anyway`);
		assign();
	}, 30_000);
}

/** A srcdoc navigation occasionally wedges in WebView2: the document reaches
 *  `interactive` (its head styles load) and the loader never finishes — observed
 *  stalling forever on a multi-megabyte module script that the same load normally pulls
 *  in ~35 ms. The page then sits blank until something restarts the navigation, so the
 *  watchdog does exactly that — but never a load that is still MOVING: a cold first
 *  parse of a multi-megabyte bundle (claude-code's chat) runs past the check interval
 *  while making progress, and restarting it each tick meant it could never finish —
 *  the intermittent blank chat page. A snapshot that changed since the arm (readyState,
 *  element and script counts) re-arms instead of restarting; only an unchanged,
 *  unfinished document — the wedge, or the dropped navigation's empty about:blank —
 *  restarts, up to three tries. Every decision is logged. */
function armLoadWatchdog(frame: HTMLIFrameElement, composed: string, owner: string, startedAt: number, attempt = 1): void {
	if (attempt > 3) {
		extLog('warn', 'host', `webview ${owner}: the navigation never settled after 3 watchdog restarts (${Math.round(performance.now() - startedAt)} ms) — the page may sit blank`);
		return;
	}
	let loaded = false;
	frame.addEventListener('load', () => {
		loaded = true;
		extLog('info', 'host', `webview ${owner}: load event fired (${Math.round(performance.now() - startedAt)} ms)`);
	}, { once: true });
	const snapshot = (): string | null => {
		try {
			const doc = frame.contentDocument;
			if (doc === null) return null;
			return `${doc.readyState}:${doc.documentElement?.childElementCount ?? 0}:${doc.querySelectorAll('script, style, link').length}`;
		} catch { return null; } // cross-origin document: nothing to inspect
	};
	const baseline = snapshot();
	setTimeout(() => {
		if (loaded) return;
		const now = snapshot();
		if (now === null || now !== baseline) {
			// Gone, or a slow load that moved since the arm: keep waiting on the same
			// attempt (the cap below only counts real restarts).
			if (now !== null) {
				extLog('info', 'host', `webview ${owner}: load still moving (${baseline} -> ${now}) — waiting on`);
				armLoadWatchdog(frame, composed, owner, startedAt, attempt);
			}
			return;
		}
		// A completed load of OUR document is done. The document of a dropped navigation
		// — a srcdoc assigned into a detached frame — stays the initial empty about:blank
		// (readyState 'complete', nothing in it), and must re-navigate, not pass as
		// healthy. The composed document always carries the boot script (and its theme
		// style), which an empty about:blank never has.
		let settled = false;
		try {
			const doc = frame.contentDocument;
			settled = doc !== null && doc.readyState === 'complete' && doc.querySelector('script, style, link') !== null;
		} catch {
			extLog('warn', 'host', `webview ${owner}: the loaded document is cross-origin to the host — the watchdog cannot inspect it`);
			return;
		}
		if (settled) {
			extLog('info', 'host', `webview ${owner}: document settled without a load event (${Math.round(performance.now() - startedAt)} ms)`);
			return;
		}
		extLog('warn', 'host', `webview ${owner}: navigation wedged (snapshot ${baseline} unchanged, attempt ${attempt}) — restarting it`);
		frame.srcdoc = '';
		// The re-assign crosses on a timer, not requestAnimationFrame: the retry must
		// not inherit a suspended paint callback from a hidden or occluded pane.
		setTimeout(() => {
			frame.srcdoc = composed;
			armLoadWatchdog(frame, composed, owner, startedAt, attempt + 1);
		}, 0);
	}, 4000 * attempt);
}

/** The frame's document is one of OURS and finished: `complete`, and carrying the composed
 *  boot script an empty about:blank never has. Some navigations settle without ever firing
 *  `load` — the watchdog's settle probe exists for that quirk — and the message queue's
 *  delivery gate asks the same question, or such a page would hold its messages forever. */
function frameDocumentSettled(frame: HTMLIFrameElement): boolean {
	try {
		const doc = frame.contentDocument;
		return doc !== null && doc.readyState === 'complete' && doc.querySelector('script, style, link') !== null;
	} catch {
		return false; // cross-origin to the host: nothing to inspect
	}
}

export class ExtensionHost {
	private readonly frames = new Map<string, FrameHandle>();
	/** The command ids of each extension's manifest contributions (dropped from the workbench
	 *  registry on uninstall; the frame's own registrations are tracked per frame handle). */
	private readonly declaredCommandIds = new Map<string, string[]>();
	/** The document formatting providers frames registered (`languages.registerFormatting`):
	 *  `extId/providerId` -> the owning extension, its document selectors and the frame
	 *  holding the handler. Keyed per provider: an extension registering one formatter per
	 *  language keeps every one of them. */
	private readonly formattingProviders = new Map<string, { extId: string; id: string; selectors: FormatterSelector[]; handle: FrameHandle }>();
	/** The extensions whose missing `extensionDependencies` were already reported. */
	private readonly dependencyWarned = new Set<string>();
	/** Debounced document-change pushes, by path (`noteDocumentChanged`). */
	private readonly documentChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The backend-carrying packages whose commands dispatch to the backend process rather
	 *  than a frame — a package without a `main`, whose `package.json` is its whole program.
	 *  A backend package WITH a `main` runs its code in a frame like any VSIX (VS Code
	 *  semantics) and reaches its backend — a native `.node` above all — through it. */
	private readonly processOnly = new Set<string>();
	private readonly pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
	private nextRpcId = 1;
	private nextCallId = 1;
	activated = false;

	onNativeCommand: ((command: string) => boolean) | null = null;
	/** Called after a registration pass added contributions asynchronously (installed
	 *  extensions): the workbench re-renders the views that had already built their menus. */
	onContributionsApplied: (() => void) | null = null;
	/** The installed extensions the host has listed; backends resolve through it. */
	private installedExts: ExtInfo[] = [];
	/** The open page frames, by serial (their iframes live in editor tabs). */
	private readonly pageFrames = new Map<number, PageFrameHandle>();
	private nextPageSerial = 1;
	/** Workbench hooks behind the page services: the diff/revision editors, the SCM view, the
	 *  terminal, and the repo-changed nudge a page's own writes owe the workbench. */
	onOpenDiff: ((diff: PageDiffRequest, placement?: EditorPlacement) => void) | null = null;
	onOpenFileAtRevision: ((revision: string, path: string, title: string, repo?: string) => void) | null = null;
	onShowView: ((id: string) => void) | null = null;
	onRevealTerminal: (() => void) | null = null;
	onRunInTerminal: ((command: string) => void) | null = null;
	onRepoChanged: (() => void) | null = null;
	onForwardKey: ((key: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) => void) | null = null;
	/** Workbench hook: open an extension-supplied text document (a content provider's
	 *  answer to `vscode.open` of a provider-scheme Uri) in a read-only tab. */
	onOpenContent: ((title: string, path: string, text: string, placement?: EditorPlacement) => void) | null = null;
	/** Extensions whose commands dispatch to a `ggs/2` process backend, not a frame. */
	private readonly processBacked = new Set<string>();
	/** The packages whose manifest carries a `main` (the real-Node host's candidates). */
	private readonly extHasMain = new Map<string, boolean>();
	/** The declared commands of the process-backed extensions — runnable with no frame, the
	 *  manifest alone (the backend spawns lazily on first execution). */
	private readonly processCommandIds = new Set<string>();
	/** The text-document content providers extensions registered
	 *  (`workspace.registerTextDocumentContentProvider`), by scheme: the owning frame answers
	 *  a provider-scheme Uri's text when the host opens one (`vscode.open` / `vscode.diff`).
	 *  The host decodes nothing of any package's private schemes — asking back is the whole
	 *  mechanism. */
	private readonly docProviders = new Map<string, FrameHandle>();
	/** The serial of extension-opened diff/content tabs, for their reuse keys. */
	private nextExtDocSerial = 1;
	/** The theme as webview documents wear it (its variable definitions and kind class):
	 *  cached so `composeWebview` can inline it for a correct first paint, and pushed to
	 *  the live documents when the theme changes. `vars` is the same theme's parsed
	 *  `--vscode-*` map, what pages receive in their init context. */
	private webviewTheme: { kind: 'vscode-dark' | 'vscode-light'; css: string; vars: Record<string, string> } | null = null;

	/** The webview panels extensions created, keyed `${extId}#${panelId}`: the panel
	 *  sequence a backend numbers its panels with is PER PROCESS (every extension's first
	 *  panel is 1), so the bare id collides the moment two extensions have panels live —
	 *  git-graph's view and claude-code's chat are both panel 1 — one overwrote the
	 *  other's record and the loser's html landed nowhere (the intermittent blank and
	 *  unopenable pages, 2026-09-28). The pair is unambiguous. */
	private readonly webviews = new Map<string, WebviewHandle>();

	/** The webviews map's key: one extension's own panel id. */
	private webviewKey(extId: string, panelId: number): string {
		return `${extId}#${panelId}`;
	}

	private nextWebviewPanelId = 1;
	/** The session each webview panel hosts, by panel key — learned from the panel's own
	 *  `update_session_state` reports crossing the relay (a chat panel names the session it
	 *  binds on every state change; farewell flags name the one it left). The session ids
	 *  identify a conversation; the panel titles never do. */
	private readonly webviewSessions = new Map<string, string>();
	/** The session a just-relayed `open_in_editor` asked to open, by extension id: the next
	 *  `webview.create` of that extension is that session's new surface (the one signal
	 *  distinguishing a re-open from a brand-new conversation, whose requests carry no
	 *  session id and clear the pending one instead). */
	private readonly pendingWebviewOpens = new Map<string, { sessionId: string; at: number }>();
	/** The sidebar webview views (`contributes.views` with `type: "webview"`, served by
	 *  `registerWebviewViewProvider`), by view id: the section's iframe lives in the
	 *  sidebar (the workbench mounts it), this host half relays both directions. */
	private readonly webviewViews = new Map<string, WebviewViewRecord>();
	/** View ids whose provider the host already asked the frame to resolve. */
	private readonly resolvedWebviewViews = new Set<string>();
	/** Workbench hook: open a webview panel's tab (wired like `onOpenPage`). */
	onOpenWebview: ((panelId: number, title: string, extId: string) => void) | null = null;
	/** Workbench hook: close a webview panel's tab by its editor id (extension-side dispose). */
	onCloseWebviewTab: ((tabId: string) => void) | null = null;
	/** Workbench hook: focus a webview panel's tab (`panel.reveal()`). */
	onRevealWebviewTab: ((tabId: string) => void) | null = null;
	/** Workbench hook: retitle a webview panel's tab in place (`webview.setTitle` — a chat
	 *  tab wearing its session's summary). */
	onRenameWebviewTab: ((tabId: string, title: string) => void) | null = null;
	/** Workbench hook: reveal a webview view's sidebar container (`webviewView.show()`). */
	onRevealWebviewView: ((viewId: string) => void) | null = null;

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
	/** Open (or reveal) a file, optionally at a 1-based line/column, in the group a
	 *  placement picks (an extension's `ViewColumn`). */
	onOpenFile: ((path: string, line?: number, column?: number, placement?: EditorPlacement) => void) | null = null;
	/** An open editor's current text for a path (unsaved edits included), or null. */
	documentText: ((path: string) => string | null) | null = null;
	/** Save an open editor's document; answers whether it saved. */
	onSaveFile: ((path: string) => Promise<boolean>) | null = null;
	/** A tree view's title / description / message / badge changed. */
	onTreeMeta: ((viewId: string, meta: { title?: string; description?: string; message?: string; badge?: { value: number; tooltip?: string } }) => void) | null = null;
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
	/** Workbench hook: an extension's `setContext` changed a key (a view's `when` may now
	 *  read differently — the workbench rebuilds only if the visible set moved). */
	onContextChanged: (() => void) | null = null;
	/** Activation policy per extension, parsed from its `activationEvents`. */
	private readonly activationPolicies = new Map<string, ActivationPolicy>();
	/** The activation pass of a lazily-woken extension, in flight (idempotency). */
	private readonly pendingActivations = new Map<string, Promise<void>>();
	/** Resolved when a frame reports `__studioExtActivated` (lazy activation waits for it). */
	private readonly activationWaiters = new Map<string, () => void>();
	/** The real Node runtime this machine offers (`ext_node_runtime`), or null — null
	 *  unless `GGS_REAL_NODE` opts the real-Node host in, so a main-only package activates
	 *  in a sandboxed frame exactly as before. A manifest `node` backend is NOT tied to
	 *  this: it hosts in its backend process on ggs-node either way (`backendHosted`). */
	private nodeHostExe: string | null = null;
	/** The remote frame handles created per backend-hosted extension (one, reused across
	 *  the backend's restarts — its registrations re-land on the same handle). */
	private readonly remoteHandles = new Map<string, FrameHandle>();

	/** Whether this package's program runs in its backend process instead of a sandboxed
	 *  frame: a manifest-declared `node` backend always does — the bundled ggs-node (Boa)
	 *  hosts it, the machine's own Node is never consulted — and a main-only package joins
	 *  it only under the opted-in real-Node host (`GGS_REAL_NODE`, when a runtime exists). */
	private backendHosted(extId: string): boolean {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return ext?.capabilities?.backend?.kind === 'node' || (this.nodeHostExe !== null && this.extHasMain.has(extId));
	}

	/** A remote frame handle: the host-call vocabulary crosses `ext_process_run` /
	 *  `ext_process_invoke`, the event pushes cross `ext_process_push_event` — the same
	 *  `serve` path and the same push sites a frame's handle flows through. */
	private remoteHandle(extId: string): FrameHandle {
		const existing = this.remoteHandles.get(extId);
		if (existing) return existing;
		const handle: FrameHandle = { remote: true, commandIds: new Set(), pendingCalls: new Set() };
		handle.send = (message) => {
			const data = message as { type?: string };
			// `__studioExtEvent` pushes translate one-to-one; the frame-only channels (the
			// child-process events of the frame's own spawns) do not apply — a real-Node
			// extension spawns real processes itself.
			if (data?.type !== '__studioExtEvent') return;
			void invoke('ext_process_push_event', { extId, event: message }).catch(() => undefined);
		};
		handle.call = (method, args) => {
			if (method === 'runCommand') {
				const [command, commandArgs] = args as [string, unknown[] | undefined];
				return invoke<unknown>('ext_process_run', { extId, command, args: commandArgs ?? [] });
			}
			return invoke<unknown>('ext_process_invoke', { extId, method, args });
		};
		this.remoteHandles.set(extId, handle);
		return handle;
	}

	/** Boot (or reuse) an extension's host process — ggs-node by default, a real Node under
	 *  `GGS_REAL_NODE`: the remote handle registers before `start` so the activation's
	 *  forwarded registrations (`commands.register`, webviews, providers) find their owner.
	 *  The handshake answers after activation, so a settled `start` is a settled
	 *  activation. */
	private async ensureNodeHost(extId: string): Promise<void> {
		this.frames.set(extId, this.remoteHandle(extId));
		const startedAt = performance.now();
		try {
			await invoke('ext_process_start', { extId });
			// The duration is the whole activation (the handshake answers after it) — the
			// number to read against the backend's handshake deadline.
			extLog('info', extId, `extension host process started (${Math.round(performance.now() - startedAt)} ms)`);
		} catch (error) {
			this.frames.delete(extId);
			this.reportActivationFailure(extId, String(error), describeDetail(error));
			throw error;
		}
	}

	
	constructor() {
		window.addEventListener('message', (event) => this.onMessage(event));
		// The extension host log's Output channel ("Extension Host"), and its two commands.
		setExtLogOutput((line) => this.appendOutput(EXT_HOST_LOG_OWNER, t('extensions.logChannel'), line));
		commands.register({ id: 'extensions.showLog', title: 'Show Extension Host Log', category: 'Extensions', run: () => this.showLog() });
		commands.register({ id: 'extensions.openLogFile', title: 'Open Extension Host Log File', category: 'Extensions', run: () => void this.openLogFile() });
		// A real-Node extension host's `ggs.hostRequest`s arrive as backend events: served
		// through the same `serve` path a frame's RPC takes, answered over the backend's
		// stdin. The remote frame handle must exist already — `ensureNodeHost` registers
		// it before starting the process — so an unknown extension's request fails honestly.
		void listen<{ extId: string; id: number; method: string; args: unknown[] }>(HOST_REQUEST_EVENT, (event) => {
			const { extId, id, method, args } = event.payload;
			const handle = this.frames.get(extId);
			const respond = (ok: boolean, result: unknown) => {
				void invoke('ext_process_host_respond', { extId, id, ok, result })
					.catch((error) => extLog('warn', extId, `host request ${method}: the answer could not be delivered: ${String(error)}`));
			};
			if (!handle) return respond(false, `no extension host frame for ${extId}`);
			this.serve(method, args ?? [], extId, handle).then(
				(result) => respond(true, result === undefined ? null : result),
				(error) => respond(false, String(error))
			);
		}).catch((error) => extLog('warn', 'host', `the extension-host request channel is unavailable: ${String(error)}`));
		// An extension's own settings change (its update(), or the Settings dialog writing the
		// same key) reaches its frame as a configChanged event — `onDidChangeConfiguration`.
		document.addEventListener(state.EXT_SETTINGS_EVENT, (event) => {
			const extId = (event as CustomEvent<string>).detail;
			this.frames.get(extId)?.send?.({ type: '__studioExtEvent', event: 'configChanged', settings: state.extSettings(extId) });
		});
		window.addEventListener('beforeunload', () => void flushExtLog());
		// The backend watcher's batches reach every frame as fsChanged events — the half of
		// `workspace.createFileSystemWatcher` that makes an extension's view refresh on
		// external changes (and on commits made in the app's own Source Control). The event
		// name is main.rs's `FS_CHANGED_EVENT` ('studio://fs-changed'); the constant lives
		// with the workbench, which this module must not import (it imports this one).
		void listen<{ root: string; paths: string[]; gitChanged: boolean; truncated: boolean }>('studio://fs-changed', (event) => {
			for (const handle of this.frames.values()) {
				handle.send?.({ type: '__studioExtEvent', event: 'fsChanged', fs: event.payload });
			}
		}).catch(() => undefined);
		// The theme cache for webview documents: the first `composeWebview` needs it ready.
		void this.refreshWebviewTheme().catch(() => undefined);
	}

	/** List the installed extensions (the Extensions view renders these). */
	async list(): Promise<ExtInfo[]> {
		const installed = await invoke<ExtInfo[]>('ext_list');
		this.installedExts = installed;
		return installed;
	}

	/** Page-bundle prewarms already fired (one per extension per host lifetime). */
	private readonly prewarmedExts = new Set<string>();

	/** Warm the packer's page bundle (`webview/index.js` — claude-code's is 5.4 MB) into the
	 *  WebView's HTTP cache the moment an activation settles: a page's first open then pays
	 *  only the parse, not fetch + parse, and the dialog shows that much earlier. The
	 *  packer's convention names the file for every VSIX-packed page; a 404 just means this
	 *  package ships none — silent, so the app log stays a diagnostic, not a warning wall. */
	private prewarmPageAssets(extId: string): void {
		if (this.prewarmedExts.has(extId)) return;
		this.prewarmedExts.add(extId);
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		const url = `${ext ? extAssetBase(ext) : `ggs://localhost/${extId}/`}webview/index.js`;
		const started = performance.now();
		void fetch(url)
			.then((response) => (response.ok ? response.arrayBuffer() : null))
			.then((bytes) => {
				if (bytes) extLog('info', extId, `page bundle prewarmed (${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - started)} ms)`);
			})
			.catch(() => undefined);
	}


	/** Read a text file inside an installed extension (README, CHANGELOG, manifest). */
	async readFile(extId: string, relPath: string): Promise<string> {
		return await invoke<string>('ext_read_file', { extId, relPath });
	}

	/** Read an extension's `main` entry point the way Node's `require()` would resolve it: the
	 *  literal path first, then with a `.js` suffix for a manifest that omits it. */
	private async readMainFile(extId: string, main: string): Promise<string> {
		try {
			return await invoke<string>('ext_read_file', { extId, relPath: main });
		} catch (error) {
			if (/\.[a-zA-Z0-9]+$/.test(main)) throw error;
			return await invoke<string>('ext_read_file', { extId, relPath: `${main}.js` });
		}
	}

	/** Install a `.vsix` package — the store's own format, the one package format this app
	 *  reads (a newer version replaces an installed package of the same id, forward-only).
	 *  A VSIX whose package.json declares the `ggs` capabilities installs with a generated
	 *  manifest and runs as a full ggs/2 package (warm backend, `ggs://` pages); one
	 *  without activates in its frame with the `vscode` API shim, or installs for its
	 *  contributions alone (themes, snippets, grammars). */
	async installFromVsix(path: string): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_install_from_vsix', { path });
		await this.reload(info.id);
		return info;
	}

	/** The packages the Extensions view offers, in display order (the backend names them;
	 *  no network — the rows lay out at once and fill in as their lookups land). */
	async featuredGallery(): Promise<string[]> {
		return await invoke<string[]>('ext_gallery_featured');
	}

	/** One exact id's marketplace entry, the build for this machine's platform (the
	 *  universal build when the registry has no platform one). */
	async lookupGallery(id: string): Promise<GalleryEntry> {
		return await invoke<GalleryEntry>('ext_gallery_lookup', { gallery: MARKETPLACE_URL, id });
	}

	/** One marketplace icon as a data URL (null when it cannot be read), cached per URL. */
	async galleryIcon(url: string): Promise<string | null> {
		let pending = galleryIconCache.get(url);
		if (!pending) {
			pending = invoke<string>('ext_gallery_asset', { gallery: MARKETPLACE_URL, url })
				.then((base64) => `data:${imageMime(url)};base64,${base64}`)
				.catch(() => null);
			galleryIconCache.set(url, pending);
		}
		return pending;
	}

	/** Download and install a marketplace package — the search result's `.vsix` through the
	 *  ordinary install path (forward-only upgrade, the unhostable-`.node` door). */
	async installFromGallery(entry: GalleryEntry): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_gallery_install', { gallery: MARKETPLACE_URL, downloadUrl: entry.downloadUrl });
		await this.reload(info.id);
		return info;
	}

	/** Install what an installed package declares it needs — its `extensionDependencies`
	 *  and the members of an `extensionPack` — from the marketplace, recursively (VS Code
	 *  does the same at install). `vscode.*` built-ins have no package; a dependency the
	 *  marketplace does not carry is reported (log + notification), the rest still install. */
	async installDependencies(info: ExtInfo, seen = new Set<string>()): Promise<ExtInfo[]> {
		seen.add(info.id.toLowerCase());
		const installed: ExtInfo[] = [];
		const wanted = [...(info.extensionDependencies ?? []), ...(info.extensionPack ?? [])];
		for (const dependency of wanted) {
			const key = dependency.toLowerCase();
			if (seen.has(key) || key.startsWith('vscode.')) continue;
			seen.add(key);
			if (this.installedExts.some((ext) => ext.id.toLowerCase() === key && ext.format !== 'bundled')) continue;
			try {
				const added = await this.installFromGallery(await this.lookupGallery(dependency));
				extLog('info', info.id, `installed dependency ${added.id} ${added.version}`);
				notify('info', tf('extensions.dependencyInstalled', added.id, info.id));
				installed.push(added, ...(await this.installDependencies(added, seen)));
			} catch (error) {
				extLog('warn', info.id, `dependency ${dependency} could not be installed: ${String(error)}`);
				notify('warning', tf('extensions.dependencyInstallFailed', dependency, info.id, String(error)));
			}
		}
		return installed;
	}

	/** Install one of the bundled packages the installer carries — the one-click Install on
	 *  the Extensions view's bundled entries (the Git Graph engine view). The app installs
	 *  nothing by default; this is the ask, and it lands as a standard (uninstallable)
	 *  package. */
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
		await invoke('ext_child_stop_for', { extId }).catch(() => undefined);
		// A backend-hosted package re-activates in the new process: its remote handle must be
		// registered first, or the activation's first `host.env` request finds no owner (a
		// restart after a failed start - whose handle was dropped - failed exactly that way).
		if (this.backendHosted(extId)) return this.ensureNodeHost(extId);
		await invoke('ext_process_start', { extId });
	}

	/** Uninstall an extension (the Rust side refuses built-ins), then drop its frame, its
	 *  backend process, its registry commands and its contributions. */
	async uninstall(extId: string): Promise<void> {
		await invoke('ext_uninstall', { extId });
		// A ggs/2 process backend dies with its extension (nothing of it is running after).
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
		// The real-Node runtime fact, asked once per boot: with one, every program-carrying
		// package activates in its own Node host process (`.node` NAPI addons, ESM, workers
		// and `node_modules` native); without one, the sandboxed frames serve as always.
		this.nodeHostExe = await invoke<string | null>('ext_node_runtime').catch(() => null);
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
		// package the installer ships but nothing installed) and a `process`-backend package
		// without a `main` (the boot pass already started it; its commands dispatch to the
		// backend). A `node`-backend package hosts its program in the backend process —
		// `backendHosted` decides frame or process below.
		// Activation follows `activationEvents`: eager extensions boot here, the lazy ones
		// wait for their first command / language / view (a `workspaceContains` match boots
		// them too).
		const toActivate: ExtInfo[] = [];
		for (const ext of installed) {
			if (ext.format === 'bundled' || (ext.capabilities?.backend?.kind !== 'node' && this.processOnly.has(ext.id)) || this.frames.has(ext.id)) continue;
			const policy = this.activationPolicies.get(ext.id);
			if ((policy?.eager ?? true) || (await this.matchesWorkspaceContains(policy?.workspaceContains ?? []))) toActivate.push(ext);
		}
		await Promise.all(toActivate.map((ext) => (this.backendHosted(ext.id) ? this.ensureActive(ext.id) : this.activate(ext))));
		this.onContributionsApplied?.();
		this.onViewsChanged?.();
	}

	/** Parse the extension's package.json (and package.nls.json) and register its declared
	 *  commands, keybindings and context menu entries. */
	private async applyContributions(ext: ExtInfo): Promise<void> {
		let manifest: { contributes?: ManifestContributes; activationEvents?: string[]; main?: string } | null = null;
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
		this.activationPolicies.set(ext.id, parseActivationPolicy(manifest?.activationEvents, manifest?.contributes));
		this.extHasMain.set(ext.id, typeof manifest?.main === 'string');
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
		// A backend-carrying package WITHOUT a `main` dispatches its commands to the backend
		// rather than a frame — its package.json is its whole program, and its declared ids
		// become runnable from the manifest alone. The backend itself comes up eagerly (the
		// boot pass and the install both start it); a first command still spawns one that is
		// not up — the lazy path remains the fallback. Both kinds count: the package's own
		// binary (`process`) and an engine `.node` served by an app-bundled host (`node`).
		// A backend package WITH a `main` is a program first: its frame activates and owns
		// its declared commands (VS Code semantics), and its code reaches the backend — the
		// native `.node` a `require` answers through the host — from inside the frame.
		const processBacked = ext.capabilities?.backend?.kind === 'process' || ext.capabilities?.backend?.kind === 'node';
		if (processBacked) {
			this.processBacked.add(ext.id);
			if (typeof manifest?.main === 'string') {
				this.processOnly.delete(ext.id);
			} else {
				this.processOnly.add(ext.id);
				for (const declared of manifest?.contributes?.commands ?? []) this.processCommandIds.add(declared.command);
			}
		} else {
			this.processBacked.delete(ext.id);
			this.processOnly.delete(ext.id);
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
			if (this.nodeHostExe === null && this.processOnly.has(extId)) return void this.runProcessCommand(extId, command, args);
			// A lazily-activating extension wakes here: runRegistered activates it first, then
			// runs the handler its activation registered.
			void this.runRegistered(command, args).catch(() => undefined); // logged and surfaced there
		};
		const canRun = (command: string) => this.canRunCommand(command);
		applyContributions(extId, contributes ?? undefined, nls, dispatch, canRun);
		// The declared titles register in their default (English) form - the stable registry key -
		// and each shipped translation joins the display-language table, so menus and the palette
		// relabel without re-registering (i18n.ts's registerZhCnText).
		const zhPairs: Record<string, string> = {};
		for (const declared of contributes?.commands ?? []) {
			for (const raw of [declared.title, declared.category]) {
				const text = typeof raw === 'string' ? raw : raw?.value ?? raw?.original;
				if (!text) continue;
				const zh = localize(text, nlsZhCn);
				if (zh !== text && zh !== localize(text, nls)) zhPairs[localize(text, nls)] = zh;
			}
		}
		registerZhCnText(zhPairs);
	}

	/** A declared command is runnable when the workbench handles it natively, its extension's
	 *  ggs/2 backend will take it, its manifest declares it (a lazily-activating extension
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
			// A main-less process package activates through its backend, not a frame (see
			// activateInstalled); anything else gets a fresh frame for its new files. A
			// backend-hosted package (`node` backend, or main-only under the opted-in
			// real-Node host) re-hosts in its process instead, `main` or not.
			if (this.backendHosted(extId)) await this.ensureActive(extId).catch(() => undefined);
			else if (!this.processOnly.has(extId)) await this.activate(ext);
		}
		// Install means run: a package that declares a backend comes up at once — the same
		// "detect and run" the boot pass does, without waiting for a first command. A start
		// failure is surfaced here rather than swallowed: an engine `.node` without the C
		// ABI exports a host loads (a plain native binary declared as an engine) says so
		// now, on screen, instead of dying quietly into the Extensions view's status row.
		if (this.processBacked.has(extId)) {
			await invoke('ext_process_start', { extId }).catch((error) => {
				extLog('error', extId, `backend failed to start: ${String(error)}`, error);
				notify('error', tf('extensions.backendStartFailed', extId, String(error)), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
			});
		}
		// The install (or upgrade) may have changed what the workbench shows of it — the
		// activity-bar launcher above all, which the boot pass renders once and a mid-session
		// install would otherwise never surface.
		this.onViewsChanged?.();
	}

	private async activate(ext: ExtInfo): Promise<void> {
		this.checkDependencies(ext);
		// The whole loadable surface of the package crosses at activation (`ext_load_code`):
		// the frame's CommonJS loader resolves every `require` against it synchronously —
		// a postMessage read cannot answer one. A host that cannot load it (a backend
		// without the command) falls back to the entry file alone.
		let files: Record<string, string> | undefined;
		let truncated = false;
		let binaries: string[] = [];
		let blobFiles: Record<string, string> | undefined;
		let code: string | undefined;
		let main = 'extension.js';
		try {
			const manifest = JSON.parse(await invoke<string>('ext_read_file', { extId: ext.id, relPath: 'package.json' })) as { main?: string };
			main = (manifest.main ?? 'extension.js').replace(/^\.\//, '');
			const bundle = await invoke<{ files: Record<string, string>; truncated: boolean; binaries?: string[]; blobFiles?: Record<string, string> }>('ext_load_code', { extId: ext.id });
			files = bundle.files;
			truncated = bundle.truncated;
			binaries = bundle.binaries ?? [];
			blobFiles = bundle.blobFiles ?? {};
		} catch {
			// The fallback: the manifest's `main` alone, resolved the way `require()` would
			// (the bare Node spelling "./out/extension" gains its ".js").
			try {
				code = await this.readMainFile(ext.id, main);
			} catch (error) {
				notify('warning', `Could not load ${ext.id}: ${String(error)}`);
				return;
			}
		}

		const frame = document.createElement('iframe');
		frame.src = extHostFrameUrl();
		frame.title = `Extension host: ${ext.id}`;
		frame.style.display = 'none';
		frame.setAttribute('sandbox', 'allow-scripts');
		const handle: FrameHandle = { frame, commandIds: new Set(), pendingCalls: new Set() };
		this.frames.set(ext.id, handle);
		const send = (message: unknown) => frame.contentWindow?.postMessage(message, '*');
		// The frame announces itself, gets its extension, and reports activation - all routed
		// through the shared message listener below via this per-extension sender.
		handle.send = send;

		frame.addEventListener('load', async () => {
			send({
				type: '__studioExtInit',
				context: {
					extensionId: ext.id,
					extensionPath: ext.path,
					// Plain data only: postMessage structured-clones this, and a `toString`
					// function here throws a DataCloneError - the frame rebuilds a real Uri
					// (with its own toString) from the bare path once it receives this.
					workspaceFolders: ExtensionHost.workspaceFolders.map((uri, index) => ({ uri: { scheme: 'file', path: uri, fsPath: uri }, name: uri.split(/[\\/]/).pop() ?? uri, index })),
					// The settings, defaults, theme, mementos, storage directories, installed
					// list and log threshold — the same facts `host.env` answers a process host.
					...(await this.extensionEnv(ext.id))
				},
				// The Node environment facts (`os`/`process` shims) and the loadable code map —
				// both top-level message fields, beside the context (one backend call, cached).
				nodeEnv: await cachedNodeEnv(),
				...(files !== undefined ? { files, truncated, binaries, blobs: blobFiles } : { code: code ?? '' })
			});
		});
		document.body.appendChild(frame);
	}

	/** The folders the workbench has open, as file URI paths (set by the Workbench). */
	static workspaceFolders: string[] = [];

	private deactivate(extId: string): void {		const handle = this.frames.get(extId);
		if (!handle) return;
		this.callFrame(handle, 'deactivate', []).catch(() => undefined);
		// The registry has no remove(): each command is re-registered disabled, so it leaves the
		// palette and its run no longer reaches the (gone) frame.
		for (const id of handle.commandIds) {
			commandsRegistered.delete(id);
			unregisterCommand(id);
		}
		this.frames.delete(extId);
		handle.frame?.remove();
		// Whatever was still running in the frame (the deactivate itself included) has no
		// frame left to answer from.
		for (const cancel of [...handle.pendingCalls]) cancel(new Error(`extension ${extId} was deactivated`));
		// The extension's UI goes with it: webview tabs close (their disposers re-enter
		// `webviewClosed`, harmless without a frame), its sidebar webview views unmount, and
		// its status bar items and output channels drop.
		for (const view of [...this.webviews.values()]) {
			if (view.extId === extId) this.closeWebview(view.extId, view.panelId);
		}
		for (const [viewId, record] of [...this.webviewViews]) {
			if (record.extId === extId) {
				record.frame?.remove();
				this.webviewViews.delete(viewId);
				this.resolvedWebviewViews.delete(viewId);
			}
		}
		for (const id of [...this.statusItems.keys()]) {
			if (id.startsWith(`${extId}:`)) this.statusItems.delete(id);
		}
		this.emitStatusBarItems();
		this.outputChannels.delete(extId);
		this.emitOutputChannels();
	}

	/** The active theme as the pages need it: its vscode-* class and its stylesheet text
	 *  (fetched from the app's own theme asset — a sandboxed page cannot link it). */
	private async pageTheme(): Promise<PageTheme> {
		const theme = themeById();
		const css = await fetch(theme.css).then((response) => response.text(), () => '');
		return { kind: theme.kind, label: theme.label, css, vars: themeVars(css) };
	}

	/** An installed extension's own icon, package-relative (for `extFileDataUrl`), or null. */
	packageIcon(extId: string): string | null {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return ext?.icon ? extIconRelPath(ext) : null;
	}

	/** A page's request of the host: the same surface the extension frames get (commands,
	 *  notifications, quick input, clipboard…), plus the page's own — opening another page of
	 *  its extension, speaking its backend's own protocol, the theme, and the workbench
	 *  surface (editors, views, the terminal, dialogs) a self-contained page acts through. */
	private async servePageRpc(method: string, args: unknown[], page: PageFrameHandle): Promise<unknown> {
		switch (method) {
			case 'backend.run': {
				// The one channel to a package's backend: `backend.run(command, args)` — a
				// manifest command from a page (like the palette's own dispatch), or the
				// package's own protocol below the manifest layer. The host forwards both
				// without interpreting a word — but it does observe the crossing, at debug
				// level: the automated full-app check (scripts/probes/full-check.mjs) reads
				// these to attribute a page that never renders (never asked / asked and
				// errored / answered), which the frame's own console cannot say across the
				// process boundary.
				const [command, commandArgs] = args as [string, unknown[]?];
				// The `__`-prefixed page services never reach a backend — they are the
				// host's: a page's own hex and picture machinery reads revision sides and
				// working-tree windows through them, over the app's own git and file reads
				// confined to the open folders (the byte services in cmd_ext.rs). A page's
				// binary-file comparison lives entirely on these.
				if (command === '__revisionFileBytes' || command === '__fileChunk') {
					const params = (commandArgs?.[0] ?? {}) as {
						repo?: string; revision?: string; path?: string; offset?: number; len?: number;
					};
					return command === '__revisionFileBytes'
						? await invoke('ext_page_revision_bytes', {
							roots: ExtensionHost.workspaceFolders,
							repo: params.repo ?? '',
							revision: params.revision ?? '',
							path: params.path ?? ''
						})
						: await invoke('ext_page_file_chunk', {
							roots: ExtensionHost.workspaceFolders,
							repo: params.repo ?? '',
							path: params.path ?? '',
							offset: Number(params.offset) || 0,
							len: Number(params.len) || 0
						});
				}
				const started = performance.now();
				console.debug(`[ggs] backend.run ${page.extId} ${String(command)} …`);
				try {
					const answer = await invoke('ext_process_run', { extId: page.extId, command, args: commandArgs ?? [] });
					console.debug(`[ggs] backend.run ${String(command)} answered in ${Math.round(performance.now() - started)} ms`);
					return answer;
				} catch (error) {
					console.warn(`[ggs] backend.run ${String(command)} errored after ${Math.round(performance.now() - started)} ms: ${String(error)}`);
					extLog('warn', page.extId, `page request backend.run ${String(command)} failed after ${Math.round(performance.now() - started)} ms: ${String(error)}`);
					throw error;
				}
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
				this.onRunInTerminal?.(args[0] as string);
				return undefined;
			}
			case 'workbench.saveFile': {
				const [title, defaultPath, filters] = args as [string, string, { name: string; extensions: string[] }[]];
				return await saveDialog({ title, defaultPath, filters });
			}
			case 'workbench.writeFile': {
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

	/* ---------- VS Code's built-in document commands (vscode.open / vscode.diff) ---------- */

	/** One side of a `vscode.diff` (or the document of a `vscode.open`): a file Uri reads
	 *  from disk, a provider-scheme Uri's text is answered by the frame that registered the
	 *  scheme's provider — the host never decodes a package's private URI shape. */
	private async resolveVscodeUri(uri: unknown): Promise<{ scheme: string; name: string; fsPath: string; label: string; content?: string; local?: boolean }> {
		const value = (uri ?? {}) as { scheme?: unknown; path?: unknown; fsPath?: unknown; query?: unknown };
		const scheme = typeof value.scheme === 'string' && value.scheme !== '' ? value.scheme : 'file';
		const path = typeof value.path === 'string' ? value.path : '';
		if (scheme === 'file') {
			const fsPath = typeof value.fsPath === 'string' && value.fsPath !== '' ? value.fsPath : path;
			return { scheme, name: fsPath.split(/[\\/]/).pop() || fsPath, fsPath, label: fsPath, local: true };
		}
		const handle = this.docProviders.get(scheme);
		if (!handle) throw new Error(`no text-document content provider is registered for the ${scheme} scheme`);
		const text = await this.callFrame(handle, 'docProvider.provide', [value]) as string | null | undefined;
		return { scheme, name: path.split('/').pop() || scheme, fsPath: path, label: path, content: text ?? '' };
	}

	/** A `ViewColumn` argument (a bare number or `{ viewColumn }`) as an editor placement:
	 *  Beside answers `'beside'`, a column number its 1-based group index; Active and
	 *  anything else stay undefined (the focused group, VS Code's default). */
	private static placementOf(column: unknown): EditorPlacement | undefined {
		const value = typeof column === 'number' ? column : (column as { viewColumn?: unknown } | null | undefined)?.viewColumn;
		if (value === -2) return 'beside'; // ViewColumn.Beside
		if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value);
		return undefined;
	}

	/** `vscode.diff(left, right, title?, columnOrOptions?)`: the diff editor over both sides' text —
	 *  a provider side carries its content, a file side stays a file the editor reads. */
	private async openVscodeDiff(left: unknown, right: unknown, title: unknown, column: unknown): Promise<void> {
		if (!left || !right) return;
		const [l, r] = await Promise.all([this.resolveVscodeUri(left), this.resolveVscodeUri(right)]);
		const serial = this.nextExtDocSerial++;
		this.onOpenDiff?.({
			id: `ext-diff-${serial}`,
			title: typeof title === 'string' && title !== '' ? title : `${r.name} (${l.scheme === 'file' ? l.name : l.label} → ${r.scheme === 'file' ? r.name : r.label})`,
			left: l.local === true
				? { revision: '', path: l.fsPath, label: l.name, exists: true, local: true }
				: { revision: '', path: l.label, label: l.name, exists: true, content: l.content ?? '' },
			right: r.local === true
				? { revision: '', path: r.fsPath, label: r.name, exists: true, local: true }
				: { revision: '', path: r.label, label: r.name, exists: true, content: r.content ?? '' }
		}, ExtensionHost.placementOf(column));
	}

	/** `vscode.open(uri, columnOrOptions?)`: a file opens in the editor; a provider-scheme
	 *  document opens in a read-only tab over the provider's text. */
	private async openVscodeDocument(uri: unknown, column: unknown): Promise<void> {
		if (!uri) return;
		const placement = ExtensionHost.placementOf(column);
		const resolved = await this.resolveVscodeUri(uri);
		if (resolved.local === true) {
			this.onOpenFile?.(resolved.fsPath, undefined, undefined, placement);
			return;
		}
		const serial = this.nextExtDocSerial++;
		this.onOpenContent?.(resolved.name || `document-${serial}`, resolved.label, resolved.content ?? '', placement);
	}

	/** Run one command in a process package's backend — the first execution spawns it
	 *  (lazy activation). A result naming a notification shows it: the convention a backend
	 *  uses to surface a message, the way a VS Code command can show one. */
	private async runProcessCommand(extId: string, command: string, args: unknown[] = []): Promise<void> {
		try {
			const result = await invoke<unknown>('ext_process_run', { extId, command, args });
			if (result && typeof result === 'object') {
				const { notify: toast } = result as {
					notify?: { kind: 'info' | 'warning' | 'error'; message: string };
				};
				if (toast && typeof toast.message === 'string') notify(toast.kind ?? 'info', toast.message);
			}
		} catch (error) {
			notify('error', `${t('extensions.processFailed')}: ${String(error)}`);
		}
	}

	/* ---------- Webview panels (window.createWebviewPanel) ---------- */

	/** The editor-tab id of a webview panel — what the workbench opens and closes by. The
	 *  extension id namespaces it: panel ids restart at 1 in every backend process. */
	webviewTabId(extId: string, panelId: number): string {
		return `webview:${extId}:${panelId}`;
	}

	/** Drain the messages held while the page could not receive them, in order — the load
	 *  event and the push that finds the document settled both come here. */
	private deliverPendingWebviewMessages(view: WebviewDelivery, owner: string): void {
		if (view.pending.length === 0 || !view.frame) return;
		const queued = view.pending.splice(0);
		extLog('info', 'host', `webview ${owner}: delivering ${queued.length} message(s) held from before the load`);
		for (const message of queued) view.frame.contentWindow?.postMessage({ __ggsWebviewHost: true, type: 'message', message }, '*');
	}

	/** The delivery gate every extension→page message crosses. A page that cannot receive
	 *  it yet — its tab or sidebar section still mounting (no frame), or its document still
	 *  loading (the page's own listeners attach as its bundle runs, before the load event) —
	 *  holds the message instead of losing it; the load event drains the queue, and so does
	 *  the push that finds the document already settled (some navigations never fire
	 *  `load`). A page's initial state rides its first pushes; losing them is the
	 *  blank-but-loaded page — the intermittent empty claude-code session, 2026-09-28. */
	private gateWebviewMessage(view: WebviewDelivery, message: unknown, owner: string): void {
		// The load grace queues first: a document that just loaded may still be replaced by
		// the pair's real setHtml, and a push delivered now would burn with it.
		if (view.loadGrace !== null) {
			view.pending.push(message);
			extLog('info', 'host', `webview ${owner}: postMessage held — the load grace is open (${view.pending.length} queued)`);
			return;
		}
		if (view.firstPaintTimer !== null && this.flushFirstPaint(view, owner)) {
			// The flush (re)assigned the document: this message must wait for the fresh
			// load's gate, not post into the navigation now in flight.
			view.pending.push(message);
			extLog('info', 'host', `webview ${owner}: postMessage held — the coalesced document just painted (${view.pending.length} queued)`);
			return;
		}
		if (!view.frame) {
			view.pending.push(message);
			extLog('info', 'host', `webview ${owner}: postMessage held — the page has not mounted yet (${view.pending.length} queued)`);
			return;
		}
		if (!view.loaded) {
			if (!frameDocumentSettled(view.frame)) {
				view.pending.push(message);
				extLog('info', 'host', `webview ${owner}: postMessage held — the document is still loading (${view.pending.length} queued)`);
				return;
			}
			view.loaded = true; // settled without a load event: this push is the drain
			this.deliverPendingWebviewMessages(view, owner);
		}
		view.frame.contentWindow?.postMessage({ __ggsWebviewHost: true, type: 'message', message }, '*');
	}

	/** Mount a webview panel into its tab's pane (the workbench's mount callback; the editor
	 *  tab owns the iframe, the disposer runs on close). The document is a srcdoc composed
	 *  with the acquireVsCodeApi bootstrap — `setHtml` reloads it, as VS Code's webviews do. */
	mountWebview(extId: string, panelId: number, container: HTMLElement): () => void {
		const view = this.webviews.get(this.webviewKey(extId, panelId));
		if (!view) extLog('warn', 'host', `webview ${extId}#${panelId}: mounted with no panel record — the tab will sit empty until the extension creates it`);
		const frame = document.createElement('iframe');
		frame.className = 'ext-page-frame';
		frame.title = view?.title ?? 'webview';
		// allow-same-origin: the webview keeps its own storage — a sandbox without it
		// throws SecurityError on the localStorage access every real webview app makes
		// (claude-code's React shell died on exactly that).
		frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
		// Insert first, load through loadFrameDoc: a detached frame (or one inside a pane
		// still being assembled offscreen) drops a srcdoc navigation silently.
		container.appendChild(frame);
		if (view) {
			view.frame = frame;
			extLog('info', 'host', `webview ${extId}#${panelId}: mounted (${frame.isConnected ? 'connected' : 'detached'})`);
			// The messages that arrived while the tab was still mounting (the initial state
			// among them) deliver once the page's own listeners exist — the load event —
			// never before, or the not-yet-navigated document swallows them.
			frame.addEventListener('load', () => this.armLoadGrace(view, `${extId}#${panelId}`));
			// The mount paints only a document the extension actually delivered: an empty
			// record html (setHtml still in flight) must not boot the bare bootstrap page —
			// its load would open the gate for a document the first setHtml is about to
			// replace, and the empty boot's grace expiring ahead of the coalescing window
			// left the real document unpainted (the intermittent blank page). The section
			// mounts hold to the same rule.
			if (view.html !== '') {
				view.painted = view.html;
				loadFrameDoc(frame, view.html, this.webviewTheme, `${extId}#${panelId}`);
			} else {
				extLog('info', 'host', `webview ${extId}#${panelId}: mount defers the first paint — the record has no html yet`);
			}
		}
		return () => this.webviewClosed(extId, panelId);
	}

	/** The tab went away (either way): drop the record and tell the extension's frame, whose
	 *  panel proxy fires `onDidDispose`. */
	private webviewClosed(extId: string, panelId: number): void {
		const view = this.webviews.get(this.webviewKey(extId, panelId));
		if (!view) return;
		this.webviews.delete(this.webviewKey(extId, panelId));
		this.webviewSessions.delete(this.webviewKey(extId, panelId));
		if (view.loadGrace !== null) clearTimeout(view.loadGrace);
		if (view.firstPaintTimer !== null) clearTimeout(view.firstPaintTimer);
		view.frame = null;
		extLog('info', 'host', `webview ${extId}#${panelId}: closed`);
		this.frames.get(view.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewDisposed', panelId });
	}

	/* ---------- Webview views (window.registerWebviewViewProvider) ---------- */

	/** Mount a webview view's iframe into its sidebar section (the workbench's mount
	 *  callback; the section owns the iframe, and `setHtml` reloads it exactly as a
	 *  panel's does). An html that arrived before the mount (or after the provider's
	 *  resolve, which the first visibility triggers) applies here. */
	mountWebviewView(viewId: string, extId: string, container: HTMLElement): () => void {
		const record = this.webviewViews.get(viewId) ?? { extId, html: '', frame: null, pending: [], loaded: false, painted: null, loadGrace: null, firstPaintTimer: null };
		this.webviewViews.set(viewId, record);
		const frame = document.createElement('iframe');
		frame.className = 'ext-page-frame';
		frame.title = `${extId}: ${viewId}`;
		// allow-same-origin: same storage posture as the webview panels.
		frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
		// Insert first, load through loadFrameDoc — the same detached-subtree drop.
		container.appendChild(frame);
		record.frame = frame;
		// The same delivery gate as a panel's: the section's mount races the provider's
		// first pushes exactly the way a tab's mount does.
		frame.addEventListener('load', () => this.armLoadGrace(record, `view:${record.extId}/${viewId}`));
		if (record.html !== '') {
			record.painted = record.html;
			loadFrameDoc(frame, record.html, this.webviewTheme, `view:${record.extId}/${viewId}`);
		}
		return () => {
			if (this.webviewViews.get(viewId)?.frame === frame) {
				record.frame = null;
				this.webviewViews.delete(viewId);
			}
			frame.remove();
		};
	}

	/** Apply a webview view's html: to its mounted iframe, or held for its mount. */
	private setWebviewViewHtml(viewId: string, html: string): void {
		const record = this.webviewViews.get(viewId);
		if (!record) {
			extLog('warn', 'host', `webview view ${viewId}: setHtml (${html.length} chars) with no record — DROPPED`);
			return;
		}
		record.html = html;
		if (!record.frame) return; // the section mounts later and loads record.html then
		const owner = `view:${record.extId}/${viewId}`;
		const grace = record.loadGrace;
		if (grace !== null) clearTimeout(grace);
		record.loadGrace = null;
		const inGrace = grace !== null;
		if (record.loaded || inGrace) {
			// A settled document (or one inside its load grace) reloads now.
			record.loaded = false;
			record.painted = html;
			loadFrameDoc(record.frame, html, this.webviewTheme, owner);
			return;
		}
		// First paint pending: the same pair-coalescing a panel gets — one boot of the
		// latest document, the initial state queued behind its load.
		if (record.firstPaintTimer !== null) clearTimeout(record.firstPaintTimer);
		record.firstPaintTimer = window.setTimeout(() => this.flushFirstPaint(record, owner), 200);
	}

	/** Open a document's delivery gate after its load, with a short grace: pushes land in
	 *  the queue for a moment so a setHtml reload that follows immediately (the shell→document
	 *  pair) cannot orphan them into the replaced document. No reload inside the window —
	 *  the gate opens and the queue drains. The drain also yields to a pending first paint:
	 *  a setHtml queued behind this grace means the live document is about to be replaced,
	 *  and delivering into it would strand the page's initial state in the doomed document —
	 *  the fresh load's own grace delivers instead. */
	private armLoadGrace(view: WebviewDelivery, owner: string): void {
		if (view.loadGrace !== null) clearTimeout(view.loadGrace);
		view.loadGrace = window.setTimeout(() => {
			view.loadGrace = null;
			if (view.firstPaintTimer !== null) return;
			view.loaded = true;
			this.deliverPendingWebviewMessages(view, owner);
		}, 150);
	}

	/** Paint a surface's pending first document now: the latest html loads once, and every
	 *  message queued behind the missing load delivers into that document. Fired by the
	 *  coalescing window's expiry and by the first message push (the state the page is
	 *  waiting for must not cross into a document that is about to be replaced). A loaded
	 *  document counts as painted only when it IS the latest html — an older one (its grace
	 *  expired inside the coalescing window) is replaced here. Returns true when the
	 *  document was (re)assigned: the caller holds whatever it was about to post for the
	 *  fresh load's gate. */
	private flushFirstPaint(record: WebviewDelivery, owner: string): boolean {
		if (record.firstPaintTimer === null) return false;
		record.firstPaintTimer = null;
		if (!record.frame) return false;
		if (record.loaded && record.painted === record.html) return false;
		record.loaded = false;
		record.painted = record.html;
		extLog('info', 'host', `webview ${owner}: the coalescing window paints the latest document (${record.html.length} chars)`);
		loadFrameDoc(record.frame, record.html, this.webviewTheme, owner);
		return true;
	}

	/** A webview view's message crossed from its iframe: route it into the owning frame. */
	private webviewViewFor(source: MessageEventSource | null): { viewId: string; extId: string } | null {
		for (const [viewId, record] of this.webviewViews) {
			if (record.frame?.contentWindow === source) return { viewId, extId: record.extId };
		}
		return null;
	}

	/** The extension disposed its panel: close its tab (the tab's disposer finishes the job),
	 *  or — if no tab ever mounted — just run the same teardown. */
	private closeWebview(extId: string, panelId: number): void {
		if (!this.webviews.has(this.webviewKey(extId, panelId))) return;
		if (this.onCloseWebviewTab) {
			this.onCloseWebviewTab(this.webviewTabId(extId, panelId));
			if (!this.webviews.has(this.webviewKey(extId, panelId))) return; // the tab's disposer already ran
		}
		this.webviewClosed(extId, panelId);
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

	/** A request an extension made of the host: logged at `debug` (its answer at `trace`),
	 *  a failure logged at `warn` with the method and the cause, then served. */
	private async serve(method: string, args: unknown[], extId: string, handle: FrameHandle): Promise<unknown> {
		const quiet = method === 'log' || method === 'output.append';
		if (!quiet && extLogEnabled('debug')) extLog('debug', extId, `→ ${method}`, extLogEnabled('trace') ? summarize(args) : undefined);
		try {
			const result = await this.serveRequest(method, args, extId, handle);
			if (!quiet && extLogEnabled('trace')) extLog('trace', extId, `← ${method}`, summarize(result));
			return result;
		} catch (error) {
			if (!quiet) extLog('warn', extId, `host request ${method} failed: ${String(error)}`, error instanceof Error ? error : undefined);
			throw error;
		}
	}

	/** The extension-facing facts every host boots from: stored settings, the declared and
	 *  core configuration defaults, display language, theme, asset base, mementos, the
	 *  `~/.ggs` storage directories, the installed list and the log threshold. */
	private async extensionEnv(extId: string): Promise<Record<string, unknown>> {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		const defaults: Record<string, unknown> = coreConfigurationDefaults();
		for (const def of extensionSettingDefs()) defaults[def.id] = def.default;
		const storage = await invoke<{ global: string; workspace?: string | null; log: string } | null>('ext_storage_paths', { extId, workspace: ExtensionHost.workspaceFolders[0] ?? null })
			.catch((error) => {
				extLog('warn', extId, `storage directories unavailable (the install directory stands in): ${String(error)}`);
				return null;
			});
		if (storage) this.storageRoots.set(extId, [storage.global, storage.log, ...(storage.workspace ? [storage.workspace] : [])]);
		const env = await cachedNodeEnv();
		return {
			settings: state.extSettings(extId),
			defaults,
			// The extension's view of the display language follows the workbench locale.
			language: locale(),
			appVersion: __APP_VERSION__,
			themeKind: themeById().kind === 'vscode-light' ? 1 : 2,
			// Where the extension's webview panels load package-local files from, and its
			// persisted mementos (both preloaded so the shim is synchronous from here on).
			webviewResourceBase: ext ? extAssetBase(ext) : `ggs://localhost/${extId}/`,
			state: { global: state.extMemento(extId, 'global'), workspace: state.extMemento(extId, 'workspace') },
			storage: storage ?? undefined,
			platform: env.platform,
			logLevel: extLogLevel(),
			extensions: this.installedExts.filter((entry) => entry.format !== 'bundled').map((entry) => ({
				id: entry.id,
				extensionPath: entry.path,
				isActive: this.frames.has(entry.id),
				packageJSON: {
					name: entry.name, publisher: entry.publisher, version: entry.version, displayName: entry.displayName ?? entry.name,
					description: entry.description, categories: entry.categories, keywords: entry.keywords,
					extensionDependencies: entry.extensionDependencies, extensionPack: entry.extensionPack,
					engines: entry.enginesVscode ? { vscode: entry.enginesVscode } : {}
				}
			}))
		};
	}

	/** The directories `vscode.workspace.fs` reaches for one extension: the open folders,
	 *  the extension's own install directory (its bundled files, read through
	 *  `context.extensionUri`) and its `~/.ggs` storage directories. */
	private fsRoots(extId: string): string[] {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return [...ExtensionHost.workspaceFolders, ...(ext ? [ext.path] : []), ...(this.storageRoots.get(extId) ?? [])];
	}

	/** Each extension's `~/.ggs` storage directories (filled by `extensionEnv`). */
	private readonly storageRoots = new Map<string, string[]>();

	/** Reveal the "Extension Host" Output channel (the `extensions.showLog` command). */
	showLog(): void {
		extLog('info', 'host', `extension host log level: ${extLogLevel()}`);
		this.onOutputReveal?.(EXT_HOST_LOG_OWNER, t('extensions.logChannel'));
	}

	/** Open `~/.ggs/logs/ext-host.log` in an editor tab (the `extensions.openLogFile` command). */
	async openLogFile(): Promise<void> {
		await flushExtLog();
		try {
			const path = await invoke<string>('ext_log_path');
			if (typeof path !== 'string' || path === '') throw new Error('no log path');
			this.onOpenFile?.(path);
		} catch (error) {
			notify('warning', tf('extensions.logFileMissing', String(error)));
		}
	}

	/** An activation (or host start) failed: the log gets the error and its stack, the
	 *  user a notification that opens the log. */
	private reportActivationFailure(extId: string, error: string, stack?: string | null): void {
		extLog('error', extId, `activation failed: ${error}`, stack ?? undefined);
		notify('warning', tf('extensions.activationFailed', extId, error), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
	}

	/** Report an extension's missing `extensionDependencies` once (VS Code refuses to
	 *  activate it; here it activates and the gap is named). */
	private checkDependencies(ext: ExtInfo): void {
		if (this.dependencyWarned.has(ext.id)) return;
		const installed = new Set(this.installedExts.filter((entry) => entry.format !== 'bundled').map((entry) => entry.id.toLowerCase()));
		// VS Code's own built-in extensions (`vscode.*`) have no install to find.
		const missing = (ext.extensionDependencies ?? []).filter((dep) => !dep.toLowerCase().startsWith('vscode.') && !installed.has(dep.toLowerCase()));
		if (missing.length === 0) return;
		this.dependencyWarned.add(ext.id);
		extLog('warn', ext.id, `missing extension dependencies: ${missing.join(', ')}`);
		notify('warning', tf('extensions.dependencyMissing', extTitle(ext), missing.join(', ')), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
	}

	/** The requests the frames and process hosts make of the workbench. */
	private async serveRequest(method: string, args: unknown[], extId: string, handle: FrameHandle): Promise<unknown> {
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
			case 'commands.registerBatch': {
				// An activation's whole registration queue in one request — each separate
				// registration would pay its own pipe round trip (~2-4 ms; claude-code
				// registers 31 on activate). Same contract as `commands.register`, per entry.
				const ids = args[0] as string[];
				for (const id of ids) {
					if (commandsRegistered.has(id) && commandsRegistered.get(id)!.handle !== handle) throw new Error(`command ${id} is already registered`);
					handle.commandIds.add(id);
					commandsRegistered.set(id, { extId, handle });
					const declared = declaredCommand(id);
					commands.register({ id, title: declared?.title ?? id, category: declared?.category ?? extId, enabled: () => true, run: () => this.runRegistered(id) });
				}
				// The activation settled: warm the page bundle into the WebView's cache now,
				// so the user's first open of a page pays only the parse, not the fetch.
				this.prewarmPageAssets(extId);
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
				return this.executeCommand(args[0] as string, (args[1] as unknown[] | undefined) ?? [], handle);
			case 'commands.list':
				return Promise.resolve(commands.all().map((c) => c.id));
			case 'docProvider.register': {
				// `workspace.registerTextDocumentContentProvider(scheme, provider)`: the
				// provider object stays in the frame; the host remembers which frame answers
				// the scheme, for `vscode.open` / `vscode.diff` of its Uris.
				const scheme = args[0];
				if (typeof scheme !== 'string' || scheme === '') throw new Error('docProvider.register needs a scheme');
				this.docProviders.set(scheme, handle);
				return Promise.resolve(undefined);
			}
			case 'docProvider.unregister': {
				const scheme = args[0] as string;
				if (this.docProviders.get(scheme) === handle) this.docProviders.delete(scheme);
				return Promise.resolve(undefined);
			}
			case 'terminal.send': {
				// `window.createTerminal().sendText(text)`: the text runs in the integrated
				// terminal (VS Code's semantics — the panel comes up with the run).
				this.onRunInTerminal?.(String(args[0] ?? ''));
				return Promise.resolve(undefined);
			}
			case 'terminal.show': {
				this.onRevealTerminal?.();
				return Promise.resolve(undefined);
			}
			case 'notify': {
				const [kind, message, items] = args as ['info' | 'warning' | 'error', string, string[]];
				return new Promise((resolve) => {
					notify(kind, message, (items ?? []).map((label) => ({ label, run: () => resolve(label) })), () => resolve(undefined));
				});
			}
			case 'showInputBox': {
				// quickInput resolves null on Escape; the API contract is undefined.
				const options = (args[2] ?? {}) as { placeHolder?: string; password?: boolean };
				return quickInput({ title: args[0] as string, value: args[1] as string, placeholder: options.placeHolder, password: options.password === true, allowFreeText: true }).then((value) => value ?? undefined);
			}
			case 'showQuickPick': {
				// The shim sends `{id?, label, description?, detail?}` entries; the picked
				// entry's id goes back (its label for an older shim), so duplicate labels stay
				// distinct and the shim maps it to the original item.
				const entries = (args[0] as { id?: string; label: string; description?: string; detail?: string }[]) ?? [];
				const items = entries.map((entry) => ({ label: entry.label, description: entry.description, detail: entry.detail, value: entry.id ?? entry.label }));
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
			case 'host.env':
				// A process host's first request, before its activation: the facts a frame
				// gets in its `__studioExtInit` message.
				return this.extensionEnv(extId);
			case 'openExternal':
				return openUrl(args[0] as string).then(() => true);
			case 'clipboard.writeText':
				return writeText(args[0] as string);
			case 'clipboard.readText':
				return readText();
			case 'log': {
				// The shim's anomaly log (unsupported APIs, listener/provider exceptions,
				// failed host requests): into the extension host log under the extension's id.
				const [level, message, detail] = args as [string, string, string | null | undefined];
				const known: ExtLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
				extLog(known.includes(level as ExtLogLevel) ? level as ExtLogLevel : 'info', extId, String(message ?? ''), detail ?? undefined);
				return Promise.resolve(undefined);
			}
			case 'secrets.get':
				return Promise.resolve(state.extSecrets(extId)[String(args[0])]);
			case 'secrets.store': {
				extLogOnce(`secrets:${extId}`, 'info', extId, 'secrets are kept in the workbench\'s local storage (not an OS keychain)');
				state.saveExtSecret(extId, String(args[0]), String(args[1] ?? ''));
				return Promise.resolve(undefined);
			}
			case 'secrets.delete':
				state.saveExtSecret(extId, String(args[0]), undefined);
				return Promise.resolve(undefined);
			case 'secrets.keys':
				return Promise.resolve(Object.keys(state.extSecrets(extId)));
			case 'workspace.readText': {
				// `openTextDocument`: an open editor's text (unsaved edits included), else the
				// file from disk through the same confined filesystem `workspace.fs` uses.
				const path = String(args[0] ?? '');
				const open = this.documentText?.(path) ?? null;
				if (open !== null) return { text: open, languageId: languageIdFor(path) || 'plaintext' };
				const read = await invoke<{ data: string }>('ext_fs', { op: 'read', roots: this.fsRoots(extId), path, to: undefined, data: undefined });
				const bytes = Uint8Array.from(atob(read.data), (char) => char.charCodeAt(0));
				return { text: new TextDecoder().decode(bytes), languageId: languageIdFor(path) || 'plaintext' };
			}
			case 'editor.save': {
				const path = String(args[0] ?? '');
				return this.onSaveFile ? await this.onSaveFile(path) : false;
			}
			case 'docProvider.read':
				// `openTextDocument` of a provider-scheme Uri: the registering frame answers.
				return (await this.resolveVscodeUri(args[0])).content ?? '';
			case 'extensions.activate':
				return this.ensureActive(String(args[0] ?? '')).then(() => undefined);
			case 'treeView.meta': {
				const [viewId, meta] = args as [string, { title?: string; description?: string; message?: string; badge?: { value: number; tooltip?: string } }];
				this.onTreeMeta?.(viewId, meta ?? {});
				return Promise.resolve(undefined);
			}
			case 'treeView.reveal': {
				this.onRevealWebviewView?.(String(args[0] ?? ''));
				return Promise.resolve(undefined);
			}
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
			case 'output.appendBatch': {
				// An activation's log lines in one request (same shape as `commands.registerBatch`).
				for (const [name, line] of args[0] as [string, string][]) this.appendOutput(extId, name, line);
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
				// vscode.workspace.fs / findFiles: one command, confined on the Rust side to the
				// open folders, the extension's own directory and its ~/.ggs storage.
				const [op, path, to, data] = args as [string, string, string?, string?];
				if (op === 'find') {
					// A glob over each open folder (or the RelativePattern's base), answered as
					// `{ root, path }` so a multi-root result keeps its folder.
					const base = typeof to === 'string' && to !== '' ? to : undefined;
					const roots = base !== undefined ? [base] : ExtensionHost.workspaceFolders;
					const found: { root: string; path: string }[] = [];
					for (const root of roots) {
						const paths = await invoke<string[]>('ext_fs', { op: 'find', roots: [root], path, to: undefined, data: undefined });
						for (const relative of paths ?? []) found.push({ root, path: relative });
					}
					return found;
				}
				return invoke('ext_fs', { op, roots: this.fsRoots(extId), path, to, data });
			}
			case 'diagnostics.set': {
				// A frame pushed its diagnostic collection changes: they land in the editor
				// diagnostics store, which re-renders every open editor for that file.
				const [diagExtId, diagPath, diagList] = args as [string, string, SerializableDiagnostic[]];
				setFileDiagnostics(diagPath, diagList ?? []);
				return Promise.resolve(undefined);
			}
			case 'languages.registerFormatting': {
				// The frame registered a document formatting provider: `{ id, selectors }`.
				// `editor.formatDocument` routes to the best-scoring provider for the document.
				const [declaration] = args as [{ id: string; selectors: FormatterSelector[] }];
				this.formattingProviders.set(`${extId}/${declaration.id}`, { extId, id: declaration.id, selectors: declaration.selectors ?? [], handle });
				return Promise.resolve(undefined);
			}
			case 'languages.unregisterFormatting': {
				const [declaration] = args as [{ id: string }];
				this.formattingProviders.delete(`${extId}/${declaration.id}`);
				return Promise.resolve(undefined);
			}
			case 'childProcess.spawn': {
				// The frame's child_process (nodeShims maps the Node API shapes onto this):
				// one spawn, one Channel of streamed stdout/stderr chunks and the exit —
				// routed back into the owning frame as `__studioExtHostEvent` pushes.
				const [spec] = args as [{ file: string; args?: string[]; cwd?: string; env?: Record<string, string> | null; shell?: boolean }];
				const onEvent = new Channel<{ handle: number; event: string; data?: string; code?: number | null }>();
				onEvent.onmessage = (message) => {
					this.frames.get(extId)?.frame?.contentWindow?.postMessage({ type: '__studioExtHostEvent', kind: 'childProcess', message }, '*');
				};
				return invoke('ext_child_spawn', { extId, spec, onEvent });
			}
			case 'childProcess.write':
				return invoke('ext_child_write', { handle: args[0], data: args[1] });
			case 'childProcess.end':
				return invoke('ext_child_end_stdin', { handle: args[0] });
			case 'childProcess.kill':
				return invoke('ext_child_kill', { handle: args[0] });
			case 'childProcess.nodeRuntime':
				// The `fork` bridge's runtime: the machine's node (a real language-server
				// process), or null when the machine has none — the frame answers Node's
				// fork-shaped `'error'` event.
				return invoke<string | null>('ext_node_runtime_path');
			case 'editor.applyEdits': {
				// A null path addresses the active file editor; false (not open) tells the
				// frame's applyEdit to fall back to file-level edits.
				const [path, edits] = args as [string | null, { startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }[]];
				return Promise.resolve(this.onApplyEdits ? this.onApplyEdits(path, edits) : false);
			}
			case 'workspace.openFile': {
				// `showTextDocument` / `revealRange`: the file, at a 1-based line/column when
				// given, in the group the caller's ViewColumn picks.
				const [path, line, column, placement] = args as [string, number?, number?, EditorPlacement?];
				this.onOpenFile?.(path, line, column, placement);
				return Promise.resolve(undefined);
			}
			case 'workspace.openContentTab': {
				// `showTextDocument` of a provider-scheme document (a chat view opening its
				// tool outputs and code blocks this way): a read-only content tab. The text
				// comes from the shim — it read the provider in `openTextDocument` — so this
				// never calls the frame back while its request is in flight.
				const [title, path, text, placement] = args as [string, string, string, EditorPlacement?];
				this.onOpenContent?.(String(title ?? ''), String(path ?? ''), String(text ?? ''), placement);
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
				// A backend restart resets its panel sequence (a live backend's ids only
				// grow), so a create reusing this extension's live panel id means every
				// panel of the previous process is dead: close them, or their tabs strand
				// as blank shells no setHtml can reach anymore.
				if (framePanelId !== null && this.webviews.has(this.webviewKey(extId, framePanelId))) {
					const stale = [...this.webviews.values()].filter((view) => view.extId === extId);
					extLog('warn', 'host', `webview ${extId}#${panelId}: created reusing a live panel id — the backend restarted; closing ${stale.length} dead panel(s) of the previous process`);
					for (const view of stale) this.closeWebview(view.extId, view.panelId);
				}
				// One tab per session: a create whose session a live panel of this extension
				// already hosts is a re-open of that session (the extension's own session→panel
				// map lost the binding — a backend restart, a missed binding report — so its
				// reveal-and-reuse never fired and every click of the same history row opened
				// another tab). The new panel takes the surface; the stale tab closes, and the
				// `webviewDisposed` it pushes settles the old panel object. A session no live
				// panel hosts — another conversation, a brand-new one — opens its own tab, as
				// VS Code's one-tab-per-conversation does. The create args cannot tell these
				// apart (claude-code creates every conversation panel as the same
				// ("claudeVSCodePanel", "Claude Code")); the relayed session traffic can.
				const pending = this.pendingWebviewOpens.get(extId);
				this.pendingWebviewOpens.delete(extId);
				if (pending && Date.now() - pending.at <= WEBVIEW_OPEN_PENDING_MS) {
					const hosted = [...this.webviews.values()].filter((view) => view.extId === extId && this.webviewSessions.get(this.webviewKey(extId, view.panelId)) === pending.sessionId);
					for (const view of hosted) {
						extLog('info', extId, `webview ${extId}#${view.panelId}: re-opening session ${pending.sessionId} it already hosts — closing the stale tab for the new panel`);
						this.closeWebview(view.extId, view.panelId);
					}
				}
				this.webviews.set(this.webviewKey(extId, panelId), { panelId, extId, title, html: '', frame: null, pending: [], loaded: false, painted: null, loadGrace: null, firstPaintTimer: null });
				extLog('info', 'host', `webview ${extId}#${panelId}: created ("${title}")`);
				this.onOpenWebview?.(panelId, title, extId);
				return Promise.resolve(panelId);
			}
			case 'webview.setTitle': {
				const [panelId, title] = args as [number, string];
				const view = this.webviews.get(this.webviewKey(extId, panelId));
				if (!view) extLog('warn', 'host', `webview ${extId}#${panelId}: setTitle with no panel record — dropped`);
				if (view) {
					view.title = title;
					// The tab wears the new title: claude-code renames its chat tab to the
					// session's summary as soon as the conversation binds — the summary IS the
					// label the user navigates their conversation tabs by.
					this.onRenameWebviewTab?.(this.webviewTabId(extId, panelId), title);
				}
				return Promise.resolve(undefined);
			}
			case 'webview.setHtml': {
				const [panelId, html] = args as [number, string];
				const view = this.webviews.get(this.webviewKey(extId, panelId));
				if (!view) {
					// The one silence that reads as a blank page: the extension delivered
					// its document and no panel existed to receive it.
					extLog('warn', 'host', `webview ${extId}#${panelId}: setHtml (${html.length} chars) with no panel record — DROPPED`);
					return Promise.resolve(undefined);
				}
				// Setting html reloads the document, exactly as VS Code's webviews do.
				view.html = html;
				if (!view.frame) {
					extLog('info', 'host', `webview ${extId}#${panelId}: setHtml (${html.length} chars) held — the tab has not mounted yet`);
					return Promise.resolve(undefined);
				}
				const owner = `${extId}#${panelId}`;
				const grace = view.loadGrace;
				if (grace !== null) clearTimeout(grace);
				view.loadGrace = null;
				const inGrace = grace !== null;
				extLog('info', 'host', `webview ${extId}#${panelId}: setHtml (${html.length} chars) — mounted: yes, loaded: ${view.loaded}, in grace: ${inGrace}`);
				if (view.loaded || inGrace) {
					// A settled document (or one inside its load grace — the pair's real
					// document) reloads now — the extension asked for a replacement, and the
					// grace's queued messages deliver into this fresh load.
					view.loaded = false; // the reload drops the old listeners; messages queue until the new load
					view.painted = html;
					loadFrameDoc(view.frame, html, this.webviewTheme, owner);
					return Promise.resolve(undefined);
				}
				// First paint still pending: hold it and coalesce the pair — the latest
				// document paints once, and the page's initial state queues behind its load
				// instead of crossing into a shell that is about to be replaced.
				if (view.firstPaintTimer !== null) clearTimeout(view.firstPaintTimer);
				extLog('info', 'host', `webview ${extId}#${panelId}: setHtml (${html.length} chars) held for the first paint — the coalescing window opens`);
				view.firstPaintTimer = window.setTimeout(() => this.flushFirstPaint(view, owner), 200);
				return Promise.resolve(undefined);
			}
			case 'webview.postMessage': {
				const [panelId, message] = args as [number, unknown];
				const view = this.webviews.get(this.webviewKey(extId, panelId));
				if (!view) {
					extLog('warn', 'host', `webview ${extId}#${panelId}: postMessage with no panel record — dropped`);
					return Promise.resolve(undefined);
				}
				this.gateWebviewMessage(view, message, `${extId}#${panelId}`);
				return Promise.resolve(undefined);
			}
			case 'webview.reveal': {
				const panelId = args[0] as number;
				if (this.webviews.has(this.webviewKey(extId, panelId))) this.onRevealWebviewTab?.(this.webviewTabId(extId, panelId));
				else extLog('warn', 'host', `webview ${extId}#${panelId}: reveal with no panel record — nothing to show`);
				return Promise.resolve(undefined);
			}
			case 'webview.dispose': {
				const [panelId] = args as [number];
				this.closeWebview(extId, panelId);
				return Promise.resolve(undefined);
			}
			case 'webviewView.register': {
				// The frame registered a provider for a declared view: record the owner. The
				// section itself renders from the manifest (the workbench's view pass); the
				// provider's resolve waits for the view's first visibility.
				const viewId = args[0] as string;
				if (!this.webviewViews.has(viewId)) this.webviewViews.set(viewId, { extId, html: '', frame: null, pending: [], loaded: false, painted: null, loadGrace: null, firstPaintTimer: null });
				else this.webviewViews.get(viewId)!.extId = extId;
				return Promise.resolve(undefined);
			}
			case 'webviewView.setHtml': {
				this.setWebviewViewHtml(args[0] as string, args[1] as string);
				return Promise.resolve(undefined);
			}
			case 'webviewView.setTitle':
			case 'webviewView.setDescription':
				// The sidebar sections carry their manifest names; a runtime title or
				// description change is accepted and noted (no re-render surface yet).
				extLogOnce(`${method}:${extId}`, 'info', extId, `${method} is accepted but the sidebar keeps the manifest's name`);
				return Promise.resolve(undefined);
			case 'webviewView.postMessage': {
				const [viewId, message] = args as [string, unknown];
				const record = this.webviewViews.get(viewId);
				if (!record) {
					extLog('warn', 'host', `webview view ${viewId}: postMessage with no view record — dropped`);
					return Promise.resolve(undefined);
				}
				this.gateWebviewMessage(record, message, `view:${record.extId}/${viewId}`);
				return Promise.resolve(undefined);
			}
			case 'webviewView.show': {
				this.onRevealWebviewView?.(args[0] as string);
				return Promise.resolve(undefined);
			}
			case 'webviewView.dispose': {
				const record = this.webviewViews.get(args[0] as string);
				if (record) {
					record.frame?.remove();
					this.webviewViews.delete(args[0] as string);
				}
				return Promise.resolve(undefined);
			}
			case 'dialog.open': {
				const options = args[0] as { canSelectMany?: boolean; defaultUri?: { fsPath?: string }; filters?: Record<string, string[]>; title?: string };
				// multiple=false yields one path, not an array — normalize both to the array
				// the shim's `Uri[] | undefined` contract carries.
				const picked = await openDialog({ title: options.title, defaultPath: options.defaultUri?.fsPath, multiple: options.canSelectMany ?? false, filters: dialogFilters(options.filters) });
				const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
				return paths;
			}
			case 'dialog.save': {
				const options = args[0] as { defaultUri?: { fsPath?: string }; filters?: Record<string, string[]>; title?: string };
				return (await saveDialog({ title: options.title, defaultPath: options.defaultUri?.fsPath, filters: dialogFilters(options.filters) })) ?? undefined;
			}
			default:
				extLogOnce(`host-request:${method}`, 'warn', extId, `unsupported host request ${method} (the extension's shim is newer than this host)`);
				return Promise.reject(new Error(`unsupported host request: ${method}`));
		}
	}

	/** `vscode.commands.executeCommand`: an extension-registered command receives its arguments
	 *  in its frame, and the handler's result comes back (CommandRegistry.execute takes no
	 *  arguments, so only the workbench's own commands go through it). Public because the
	 *  workbench routes extension status bar items' clicks through it. A declared command of
	 *  a not-yet-active extension wakes it first (activationEvents' `onCommand`).
	 *  `caller` is the handle the request arrived from: a remote (process-backed) caller's
	 *  JS thread is parked inside this very host request, so an answer that must call that
	 *  process back can never be reached — the built-in document commands detach instead. */
	executeCommand(id: string, args: unknown[] = [], caller?: FrameHandle): Promise<unknown> {
		// VS Code's own built-in commands — the surfaces an extension reaches from inside a
		// frame the way it reaches any command, answered here before any registry lookup.
		if (id === 'vscode.diff' || id === 'vscode.open') {
			// Both resolve a provider-scheme side by asking the registering extension back
			// (`docProvider.provide`). A remote caller is parked waiting for THIS answer, and
			// the provide call would wait for that parked thread — a deadlock until the
			// 30 s bridge timeout, with the whole backend frozen behind it. The open runs
			// detached: the immediate response unblocks the very thread the provide call
			// needs. A frame caller has no such re-entry; its await keeps the old contract
			// (errors reach the extension, the result lands before the promise settles).
			const open = id === 'vscode.diff'
				? this.openVscodeDiff(args[0], args[1], args[2], args[3])
				: this.openVscodeDocument(args[0], args[1]);
			const done = open.then(() => undefined);
			if (caller?.remote === true) {
				void done.catch((error) => notify('error', `${t('extensions.openFailed')}: ${String(error)}`));
				return Promise.resolve(undefined);
			}
			return done;
		}
		if (id === 'setContext') {
			const [key, value] = args as [string, unknown];
			// The value is kept as given: a mode string compares in `==`, an array serves `in`.
			if (typeof key === 'string') {
				registerContextProvider(key, () => value);
				this.onContextChanged?.();
			}
			return Promise.resolve(undefined);
		}
		if (id === 'workbench.view.scm' || id === 'workbench.view.explorer' || id === 'workbench.view.search' || id === 'workbench.view.extensions') {
			this.onShowView?.(id.slice('workbench.view.'.length));
			return Promise.resolve(undefined);
		}
		if (id === 'workbench.action.openSettings' || id === 'workbench.action.openSettingsJson' || id === 'workbench.action.openGlobalSettings') {
			return commands.execute('workbench.openSettings');
		}
		const entry = commandsRegistered.get(id);
		if (entry) return this.callFrame(entry.handle, 'runCommand', [id, args]).catch((error) => {
			extLog('error', entry.extId, `command ${id} failed: ${String(error)}`, error instanceof Error ? error : undefined);
			throw error;
		});
		const extId = this.declaringExtension(id);
		if (!extId) {
			if (!commands.all().some((command) => command.id === id)) {
				extLogOnce(`unknown-command:${id}`, 'warn', caller ? this.extIdForHandle(caller) : 'host', `executeCommand(${id}): no such command in this workbench`);
			}
			return commands.execute(id);
		}
		// A backend-only package (no `main`, no frame) dispatches its declared commands
		// straight to the backend; it keeps the caller's arguments (VS Code passes the
		// menu's own — a right-clicked file, a repository) into its backend dispatch.
		// With a real-Node runtime there are no frame-less packages — the host process
		// activates and registers like a frame — so the normal wake path serves.
		if (this.nodeHostExe === null && this.processOnly.has(extId)) return this.runProcessCommand(extId, id, args);
		// A package WITH a `main` is a frame program even when it also declares a backend
		// (VS Code semantics): the declared command's first run wakes the frame, and the
		// handler its activation registers answers. Only when activation registered
		// nothing does the backend dispatch take it (the launcher/openPage convention) —
		// routing there first was failing every lazily-activated command of a
		// backend-and-main package with "no handler registered".
		return this.ensureActive(extId).then(() => {
			const late = commandsRegistered.get(id);
			if (late) return this.callFrame(late.handle, 'runCommand', [id, args]);
			if (this.processBacked.has(extId)) return this.runProcessCommand(extId, id, args);
			return commands.execute(id);
		});
	}

	/** Run a command an extension registered: the handler lives in its frame. A declared
	 *  command whose frame is not up yet belongs to a lazily-activating extension — wake it,
	 *  then run what its activation registered. */
	/** Run the formatting providers matching `languageId` over `text` and apply the edits
	 *  to the open editor. Answers true when a formatter produced edits. */
	async formatDocument(path: string, languageId: string, text: string, tabSize: number, insertSpaces: boolean): Promise<boolean> {
		let lastError: string | null = null;
		// The providers ranked by their selector's score for this document (VS Code's
		// language / scheme / pattern rules); the best-matching one formats first.
		const ranked = [...this.formattingProviders.values()]
			.map((registration) => ({ registration, score: formatterScore(registration.selectors, path, languageId) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);
		if (ranked.length === 0) extLog('info', 'host', `format document: no formatter matches ${languageId || 'this file'} (${path})`);
		for (const { registration } of ranked) {
			const extId = registration.extId;
			await this.ensureActive(extId).catch((error) => { lastError = String(error); });
			try {
				const edits = await this.callFrame(registration.handle, 'formatDocument.run', [registration.id, { path, languageId, text }, { tabSize, insertSpaces }]) as { range?: unknown; newText?: string }[] | undefined;
				if (edits && edits.length > 0) {
					const converted = edits.map((edit) => {
						const range = edit.range as { start?: { line: number; character: number }; end?: { line: number; character: number } } | undefined;
						return {
							startLine: (range?.start?.line ?? 0) + 1,
							startCharacter: range?.start?.character ?? 0,
							endLine: (range?.end?.line ?? 0) + 1,
							endCharacter: range?.end?.character ?? 0,
							newText: edit.newText ?? ''
						};
					});
					extLog('debug', extId, `formatter ${registration.id}: ${converted.length} edits for ${path}`);
					this.onApplyEdits?.(path, converted);
					return true;
				}
			} catch (error) {
				lastError = String(error);
				extLog('error', extId, `formatter ${registration.id} failed on ${path}: ${lastError}`, error instanceof Error ? error : undefined);
			}
		}
		if (lastError !== null) notify('warning', tf('extensions.commandFailed', 'editor.formatDocument', lastError), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
		return false;
	}

	private async runRegistered(id: string, args: unknown[] = []): Promise<void> {
		try {
			await this.runRegisteredUnguarded(id, args);
		} catch (error) {
			// A palette / menu / keybinding run has no caller to hand the error to: the log
			// records it with the stack, the user sees which command failed.
			const owner = commandsRegistered.get(id)?.extId ?? this.declaringExtension(id) ?? 'host';
			// A run cut short by its extension's own deactivation (an uninstall, a reload)
			// is expected: logged, not surfaced.
			const deactivated = /was deactivated|was closed/.test(String(error));
			extLog(deactivated ? 'info' : 'error', owner, `command ${id} failed: ${String(error)}`, error instanceof Error ? error : String(error));
			if (!deactivated) notify('error', tf('extensions.commandFailed', id, String(error)), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
			throw error;
		}
	}

	private async runRegisteredUnguarded(id: string, args: unknown[] = []): Promise<void> {
		const entry = commandsRegistered.get(id);
		if (entry) {
			await this.callFrame(entry.handle, 'runCommand', [id, args]);
			return;
		}
		const extId = this.declaringExtension(id);
		if (!extId) return;
		if (this.nodeHostExe === null && this.processOnly.has(extId)) {
			await this.runProcessCommand(extId, id, args);
			return;
		}
		// A frame program first, backend dispatch as the fallthrough — the same order
		// executeCommand runs in, so a declared command answers identically from either
		// caller (the workbench's menus or the palette).
		await this.ensureActive(extId);
		const late = commandsRegistered.get(id);
		if (late) await this.callFrame(late.handle, 'runCommand', [id, args]);
		else if (this.processBacked.has(extId)) await this.runProcessCommand(extId, id, args);
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
if (!ext || ext.format === 'bundled') return Promise.resolve();
		// A backend-hosted package (a manifest `node` backend — on ggs-node by default, on
		// a real Node when opted in) activates in its host process instead of a frame: the
		// handshake answers after activation, so a settled start is a settled activation,
		// and the forwarded registrations have already landed through the remote handle.
		if (this.backendHosted(extId)) {
			activation = this.ensureNodeHost(extId).then(() => undefined, () => undefined);
			this.pendingActivations.set(extId, activation);
			void activation.then(() => this.pendingActivations.delete(extId), () => this.pendingActivations.delete(extId));
			return activation;
		}
		// A package whose program is only its backend (no `main`) has no frame to activate —
		// its commands dispatch to the backend. A package WITH a `main` activates here even
		// though it also declares a backend (VS Code semantics: the frame owns the commands,
		// the backend serves its native calls) — skipping that was leaving every declared
		// command of a backend-and-main package silently doing nothing.
		if (this.processOnly.has(extId)) return Promise.resolve();
		activation = new Promise<void>((resolve) => {
			// A package whose `activate` never settles (a hung handshake in its own code)
			// must not wedge every later command into the same forever-wait: the safety
			// valve releases the caller; the real failure still surfaces via its channel.
			const timer = setTimeout(() => {
				notify('warning', tf('extensions.activationTimeout', extId, String(Math.round(ACTIVATION_TIMEOUT / 1000))));
				resolve();
			}, ACTIVATION_TIMEOUT);
			this.activationWaiters.set(extId, () => {
				clearTimeout(timer);
				resolve();
			});
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
		const items = (await this.callFrame(frame, 'tree.getChildren', [viewId, handle]).catch((error) => {
			extLog('error', extId ?? 'host', `tree view ${viewId}: children could not be read: ${String(error)}`);
			return [];
		})) as SerializedTreeItem[];
		if (extId) {
			await Promise.all((items ?? []).map(async (item) => {
				if (item.iconUrl) item.iconUrl = (await extFileDataUrl(extId, item.iconUrl!)) ?? '';
			}));
		}
		return items ?? [];
	}

	/** A tree view interaction the extension hears about: a selection, an expansion or a
	 *  checkbox toggle (`onDidChangeSelection` / `onDidExpandElement` / …). */
	treeInteraction(viewId: string, method: 'treeView.select' | 'treeView.expand' | 'treeView.checkbox', args: unknown[]): void {
		const extId = this.treeProviders.get(viewId);
		const frame = extId ? this.frames.get(extId) : undefined;
		if (frame) void this.callFrame(frame, method, [viewId, ...args]).catch((error) => extLog('warn', extId ?? 'host', `tree view ${viewId}: ${method} failed: ${String(error)}`));
	}

	/** The workbench reports a declared view's visibility (its container selected or the
		 *  sidebar hidden): the frame's TreeView fires `onDidChangeVisibility`, an `onView:`
		 *  activation wakes the extension the first time its view is seen, and a webview
		 *  view's provider resolves at its first show (VS Code's own deferral). */
	noteViewVisible(viewId: string, visible: boolean): void {
		const contribution = extensionViewContributions().find((entry) => entry.views.some((view) => view.viewId === viewId));
		const declaredBy = contribution?.extId;
		const owner = this.treeProviders.get(viewId) ?? this.webviewViews.get(viewId)?.extId ?? declaredBy;
		if (visible && owner) void this.ensureActive(owner).then(() => {
			if (owner === undefined) return;
			// A webview view resolves its provider once, at the first visibility after its
			// extension is active — the frame parks the provider until then.
			if (contribution?.views.some((view) => view.viewId === viewId && view.type === 'webview') && visible && !this.resolvedWebviewViews.has(viewId)) {
				const frame = this.frames.get(owner);
				if (frame) {
					this.resolvedWebviewViews.add(viewId);
					void this.callFrame(frame, 'webviewView.resolve', [viewId]).catch(() => this.resolvedWebviewViews.delete(viewId));
				}
			}
		});
		const frame = owner ? this.frames.get(owner) : undefined;
		if (frame && this.treeProviders.has(viewId)) void this.callFrame(frame, 'treeView.setVisible', [viewId, visible]).catch(() => undefined);
		if (frame && this.webviewViews.has(viewId)) {
			void this.callFrame(frame, 'webviewView.setVisible', [viewId, visible]).catch(() => undefined);
			frame.send?.({ type: '__studioExtEvent', event: 'webviewViewVisible', viewId, visible });
		}
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
			// The text crosses only when it exists: a push that raced the document's own
			// load must not record the path as pushed, or the text-bearing re-emission (the
			// editor's first status update after mount) is stripped as a "same document"
			// push and the frame never holds the content — a language client's didOpen
			// then syncs an empty body and no diagnostic ever lands.
			const text = this.activeText?.() ?? undefined;
			if (text !== undefined) this.lastPushedDocument = info.path;
			push = { type: '__studioExtEvent', event: 'activeEditorChanged', editor: { ...info, text } };
		}
		for (const handle of this.frames.values()) handle.send?.(push);
	}

	/** The theme changed: every open page learns it (a page that follows the theme re-reads
	 *  its stylesheet and re-mirrors its tokens), and every extension frame's
	 *  `onDidChangeActiveColorTheme` fires. */
	noteThemeChanged(): void {
		const kind = themeById().kind === 'vscode-light' ? 1 : 2;
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'theme' } }, '*');
		}
		for (const handle of this.frames.values()) handle.send?.({ type: '__studioExtEvent', event: 'themeChanged', kind });
		void this.refreshWebviewTheme();
	}

	/** Re-read the theme for webview documents and push it into the live ones (the cached
	 *  copy is what the next `composeWebview` inlines). Pages get the parsed `--vscode-*`
	 *  map with a theme event — the bootstrap mirrors it onto the document's inline style,
	 *  the same surface VS Code's webview host writes for package script to read. */
	private async refreshWebviewTheme(): Promise<void> {
		const theme = await this.pageTheme();
		this.webviewTheme = { kind: theme.kind, css: theme.css, vars: theme.vars };
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'theme', vars: theme.vars } }, '*');
		}
		for (const view of this.webviews.values()) {
			view.frame?.contentWindow?.postMessage({ __ggsWebviewHost: true, type: 'theme', css: theme.css, kind: theme.kind, vars: theme.vars }, '*');
		}
		for (const view of this.webviewViews.values()) {
			view.frame?.contentWindow?.postMessage({ __ggsWebviewHost: true, type: 'theme', css: theme.css, kind: theme.kind, vars: theme.vars }, '*');
		}
	}

	/** The app's open folders changed: every open page learns it (a page keyed to the
	 *  workspace reloads itself; the backends hear it over their own wire). */
	noteWorkspaceChanged(folders: string[]): void {
		ExtensionHost.workspaceFolders = folders;
		for (const page of this.pageFrames.values()) {
			page.frame.contentWindow?.postMessage({ __ggsHost: true, type: 'event', event: { kind: 'workspace', folders } }, '*');
		}
		// `workspace.workspaceFolders` / `onDidChangeWorkspaceFolders` in every extension.
		for (const handle of this.frames.values()) handle.send?.({ type: '__studioExtEvent', event: 'workspaceFoldersChanged', folders });
	}

	/** An open document was edited: its new text reaches every extension (debounced per
	 *  path) as `onDidChangeTextDocument`. Nothing is read while no extension runs. */
	noteDocumentChanged(path: string, text: () => string): void {
		if (this.frames.size === 0) return;
		const pending = this.documentChangeTimers.get(path);
		if (pending !== undefined) clearTimeout(pending);
		this.documentChangeTimers.set(path, setTimeout(() => {
			this.documentChangeTimers.delete(path);
			const push = { type: '__studioExtEvent', event: 'documentChanged', path, languageId: languageIdFor(path), text: text() };
			for (const handle of this.frames.values()) handle.send?.(push);
		}, DOCUMENT_CHANGE_DEBOUNCE_MS));
	}

	/** A document's last editor closed: `onDidCloseTextDocument` in every extension. */
	noteDocumentClosed(path: string): void {
		const pending = this.documentChangeTimers.get(path);
		if (pending !== undefined) clearTimeout(pending);
		this.documentChangeTimers.delete(path);
		if (this.lastPushedDocument === path) this.lastPushedDocument = null;
		for (const handle of this.frames.values()) handle.send?.({ type: '__studioExtEvent', event: 'documentClosed', path });
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
		// A remote handle (the real-Node extension host): the call crosses ggs-ext/1, and
		// the backend process dying fails it the way a closed frame would.
		if (handle.call) {
			return new Promise((resolve, reject) => {
				const cancel = (error: Error) => {
					handle.pendingCalls.delete(cancel);
					reject(error);
				};
				handle.pendingCalls.add(cancel);
				void handle.call!(method, args).then(resolve, (error) => cancel(error instanceof Error ? error : new Error(String(error))));
			});
		}
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
		const data = event.data as { type?: string; id?: number; method?: string; args?: unknown[]; ok?: boolean; result?: unknown; extensionId?: string; error?: string; stack?: string; text?: string; kind?: string };
		if (!data || typeof data !== 'object') return;

		// An extension page's RPC (the composed bootstrap's acquireGgsApi): routed by the
		// frame it came from, the same way the logic frames' __studioExtRpc is.
		if ((data as { __ggsPage?: boolean }).__ggsPage === true) {
			const page = this.pageFor(event.source);
			if (!page) return;
			const message = data as { kind?: string; id?: number; method?: string; args?: unknown[], message?: { command?: string, commits?: number } };
			// A page's own render report — the one observation a frame cannot give any other
			// way (its DOM and its console live behind the process boundary). Any page may
			// report; the host only logs, and the automated full-app check reads the trail.
			if (message.kind === 'message' && message.message?.command === '__viewRendered') {
				console.debug(`[ggs] view rendered: ${message.message.commits ?? '?'} commits (${page.pageId})`);
				return;
			}
			if (message.kind === 'message' && message.message?.command === '__viewDiff') {
				const report = message.message as { file?: string; additions?: number; deletions?: number; header?: string };
				console.debug(`[ggs] view diff ready: ${report.file} (+${report.additions ?? 0}/-${report.deletions ?? 0}) ${report.header ?? ''}`);
				return;
			}
			if (message.kind === 'rpc' && typeof message.method === 'string') {
				// The page source is always a Window (a frame), and jsdom's postMessage takes
				// the targetOrigin string form — not the options object the DOM lib offers.
				const pageWindow = event.source as Window | null;
				this.servePageRpc(message.method, message.args ?? [], page).then(
					(result) => pageWindow?.postMessage({ __ggsHost: true, type: 'rpcResult', id: message.id, ok: true, result }, '*'),
					(error) => pageWindow?.postMessage({ __ggsHost: true, type: 'rpcResult', id: message.id, ok: false, result: String(error) }, '*')
				);
			}
			return;
		}

		// A webview panel's or webview view's message (the composed acquireVsCodeApi
		// bootstrap): it belongs to the panel or view whose frame sent it, and crosses to
		// the owning extension's frame.
			if ((data as { __ggsWebview?: boolean }).__ggsWebview === true) {
					const message = data as { kind?: string; message?: unknown };
					if (message.kind !== 'message') return;
					const view = this.webviewFor(event.source);
				if (view) {
					this.noteWebviewSessionTraffic(view.extId, view.panelId, message.message);
					this.frames.get(view.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewMessage', panelId: view.panelId, message: message.message });
					return;
				}
				const webView = this.webviewViewFor(event.source);
				if (webView) {
					this.noteWebviewSessionTraffic(webView.extId, null, message.message);
					this.frames.get(webView.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewViewMessage', viewId: webView.viewId, message: message.message });
					return;
				}
			// A page that speaks but belongs to no panel: its replies go nowhere and the
			// page usually waits forever — one of the blank-page shapes.
			extLog('warn', 'host', `a webview page sent ${String((message.message as { command?: string } | null)?.command ?? 'a message')} but no panel or view owns its frame — dropped`);
			return;
		}

		if (data.type === '__studioExtBootLog') {
			// The frames' own console, mirrored across the sandbox (their entries never reach
			// the workbench's console otherwise): a package's errors and warnings are
			// anomalies the log keeps; its chatter is debug.
			const handle = this.frameFor(event.source);
			const level = levelForConsole(String((data as { level?: string }).level ?? 'log'));
			extLog(level, handle ? this.extIdFor(handle) : 'frame', `console: ${String(data.text ?? '').slice(0, 2000)}`);
			return;
		}
		if (data.type === '__studioExtActivated') {
			// Lazy activation waits for exactly this; eager activation never set a waiter.
			extLog('info', data.extensionId ?? 'extension', 'activated');
			this.activationWaiters.get(data.extensionId ?? '')?.();
			this.activationWaiters.delete(data.extensionId ?? '');
			return; // activation succeeded; nothing to surface
		}
		if (data.type === '__studioExtActivateFailed') {
			// The failure surfaces as a notification; a lazy activation waiting on it settles
			// rather than hanging its trigger. The stack (when the frame captured one) is the
			// only way to point at the line in a foreign package that tripped.
			this.activationWaiters.get(data.extensionId ?? '')?.();
			this.activationWaiters.delete(data.extensionId ?? '');
			this.reportActivationFailure(data.extensionId ?? 'extension', String(data.error ?? 'unknown error'), typeof data.stack === 'string' ? data.stack : null);
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
			if (handle.frame && handle.frame.contentWindow === source) return handle;
		}
		return null;
	}

	private pageFor(source: MessageEventSource | null): PageFrameHandle | null {
		for (const page of this.pageFrames.values()) {
			if (page.frame.contentWindow === source) return page;
		}
		return null;
	}

	/** Learn what the relay can tell a `webview.create` apart by: which session a panel
	 *  hosts (`update_session_state` reports; the farewell flags name the session it
	 *  left), which session an `open_in_editor` just asked for (the pending signal a
	 *  re-open's create carries), and — a request with no session id — that the next
	 *  create is a brand-new conversation, clearing any stale pending signal. */
	private noteWebviewSessionTraffic(extId: string, panelId: number | null, message: unknown): void {
		const envelope = message as { request?: { type?: unknown; sessionId?: unknown; isFarewell?: unknown; panelNoLongerHosts?: unknown }; type?: unknown } | null;
		const request = envelope?.request;
		const type = typeof request?.type === 'string' ? request.type : typeof envelope?.type === 'string' ? envelope.type : '';
		if (type === 'open_in_editor' || type === 'new_conversation_tab') {
			if (typeof request?.sessionId === 'string' && request.sessionId) this.pendingWebviewOpens.set(extId, { sessionId: request.sessionId, at: Date.now() });
			else this.pendingWebviewOpens.delete(extId);
			return;
		}
		if (type === 'update_session_state' && panelId !== null && typeof request?.sessionId === 'string' && request.sessionId) {
			const key = this.webviewKey(extId, panelId);
			if (request.isFarewell === true || request.panelNoLongerHosts === true) {
				if (this.webviewSessions.get(key) === request.sessionId) this.webviewSessions.delete(key);
			} else {
				this.webviewSessions.set(key, request.sessionId);
			}
		}
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

	/** The extension id a request handle belongs to (for log lines). */
	private extIdForHandle(handle: FrameHandle): string {
		return this.extIdFor(handle);
	}
}

/** Live command registrations: command id -> the frame holding its handler. */
const commandsRegistered = new Map<string, { extId: string; handle: FrameHandle }>();

/** VS Code dialog filters (`{ 'TypeScript': ['ts', 'tsx'] }`) onto the Tauri plugin's shape. */
function dialogFilters(filters: Record<string, string[]> | undefined): { name: string; extensions: string[] }[] | undefined {
	if (filters === undefined) return undefined;
	return Object.entries(filters).map(([name, extensions]) => ({ name, extensions }));
}

/** The Node environment facts every frame's `os`/`process` shims read (`ext_node_env`) —
 *  one backend call, cached for the session. A failed call answers the observable
 *  platform's derivation, never a hardcoded OS word (CI's Linux runner once met `win32`
 *  here and every shim spelled Windows paths). */
let nodeEnvCache: Promise<NodeEnv> | null = null;
function cachedNodeEnv(): Promise<NodeEnv> {
	if (nodeEnvCache === null) {
		nodeEnvCache = invoke<NodeEnv>('ext_node_env').catch(() => defaultNodeEnv());
	}
	return nodeEnvCache;
}

/** Remove a command from the registry without touching other registrations of the same id. */
function unregisterCommand(id: string): void {
	// The registry has no remove(); re-registering a disabled command stands in until it grows
	// one. Palette entries filter on `enabled`, so the command disappears from the UI.
	commands.register({ id, title: id, enabled: () => false, run: () => undefined });
}

/** How long an editor's burst of keystrokes coalesces before its text reaches extensions. */
const DOCUMENT_CHANGE_DEBOUNCE_MS = 300;

/** A formatter's document filter as the shim sends it (plain data). */
export interface FormatterSelector {
	language?: string;
	scheme?: string;
	pattern?: string;
	base?: string;
}

/** A glob against a forward-slash path (`**` across segments, `*` / `?` within one). */
function globMatches(pattern: string, path: string): boolean {
	let regex = '';
	for (let at = 0; at < pattern.length; at++) {
		const char = pattern[at]!;
		if (char === '*' && pattern[at + 1] === '*') {
			regex += '.*';
			at++;
			if (pattern[at + 1] === '/') at++;
		} else if (char === '*') regex += '[^/]*';
		else if (char === '?') regex += '[^/]';
		else if (char === '{') regex += '(?:';
		else if (char === '}') regex += ')';
		else if (char === ',') regex += '|';
		else regex += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
	}
	try {
		return new RegExp(`^${regex}$`, 'i').test(path);
	} catch {
		return false;
	}
}

/** VS Code's selector score for a file document: `language`, `scheme` and `pattern` must
 *  each match where declared (`*` scores lower than an exact language). */
export function formatterScore(selectors: FormatterSelector[], path: string, languageId: string): number {
	if (selectors.length === 0) return 1;
	const normalized = path.replace(/\\/g, '/');
	let best = 0;
	for (const selector of selectors) {
		let score = 0;
		if (selector.language !== undefined) {
			if (selector.language === '*') score = 5;
			else if (selector.language === languageId) score = 10;
			else continue;
		}
		if (selector.scheme !== undefined) {
			if (selector.scheme !== 'file' && selector.scheme !== '*') continue;
			score = Math.max(score, 5);
		}
		if (selector.pattern !== undefined && selector.pattern !== '') {
			const base = selector.base?.replace(/\\/g, '/').replace(/\/+$/, '');
			const relative = base && normalized.toLowerCase().startsWith(base.toLowerCase() + '/') ? normalized.slice(base.length + 1) : normalized;
			const pattern = selector.pattern.replace(/\\/g, '/');
			if (!globMatches(pattern, relative) && !globMatches(`**/${pattern.replace(/^\*\*\//, '')}`, relative)) continue;
			score = Math.max(score, 10);
		}
		best = Math.max(best, score);
	}
	return best;
}

/** A request's arguments or answer, shortened for a trace line. */
function summarize(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text.length > 600 ? `${text.slice(0, 600)}…` : text;
	} catch {
		return String(value);
	}
}
