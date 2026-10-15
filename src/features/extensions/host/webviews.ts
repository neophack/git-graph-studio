import type { WebviewDelivery, WebviewHandle, WebviewViewRecord } from './sharedTypes';
// The webview surfaces: panels and sidebar views, mirror copies, html composition, load watchdogs, session bookkeeping and asset roots.

import { extAssetBase, jsonForScript } from './pages';
import type { ExtensionHost } from './extensionHost';

import { Channel } from '../../../platform/ipc/core';
import { writeFile } from '../../../platform/ipc/fs';
import { extChildEndStdin, extChildKill, type ExtChildEvent, extChildSpawn, extChildStopFor, extChildWrite, extNodeRuntimePath } from '../../../platform/ipc/extChild';
import { type ExtInfo, extInstallBundled, extInstallFromVsix, extList, extLoadCode, extLogPath, type NodeEnv, extNodeEnv, extPageFileChunk, extPageRevisionBytes, extReadFile, extStoragePaths, extUninstall, type StudioManifest } from '../../../platform/ipc/ext';
import { type ExtProcessInfo, extNodeRuntime, extProcessHostRespond, extProcessInvoke, extProcessPushEvent, extProcessRegistrations, extProcessRun, extProcessStart, extProcessStatus, extProcessStop } from '../../../platform/ipc/extProcess';
import { type GalleryEntry, extGalleryAsset, extGalleryFeatured, extGalleryInstall, extGalleryLookup } from '../../../platform/ipc/gallery';
import { extFs } from '../../../platform/ipc/ext';
import { listen } from '../../../platform/ipc/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from '../../../platform/commands';
import { applyContributions, applyExtensionSettings, declaredCommand, extensionSettingDefs, extensionThemeList, extensionViewContributions, languageIdFor, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from '../contributions';
import { describeDetail, extLog, extLogEnabled, extLogLevel, extLogOnce, flushExtLog, levelForConsole, setExtLogOutput, type ExtLogLevel } from '../extLog';
import { defaultNodeEnv } from '../../../hosts/extModuleLoader';
import type { EditorPlacement } from '../../editor/types';
import { setFileDiagnostics, type SerializableDiagnostic } from '../editorDiagnostics';
import { settings as appSettings, syncExtensionThemes, themeById } from '../../../platform/settings';
import { locale, registerZhCnText, t, tf } from '../../../platform/i18n';
import * as state from '../../../platform/state';
import { notify, progressToast, quickInput, type ProgressToast } from '../../../platform/ui/index';
import { extFileDataUrl, forgetExtDataUrls, imageMime } from '../../../platform/extAssets';
import { hook } from '../../../platform/hooks';
import type { SerializedTreeItem } from '../treeView';
import { answerChatPermission, answerChatQuestion, chatBusy, chatControls, interruptChat, pickChatModel, pressSend, setChatInput, setChatPermissionMode, type ChatAnswer } from '../claudeChatInject';

export const WEBVIEW_OPEN_PENDING_MS = 15_000;

/** A diff a page asks the workbench to open (the editor input's shape minus the kind):
 *  the two sides carry a revision/path/label and whether that side exists. */

/** One webview panel a frame extension created (`window.createWebviewPanel`): the tab-side
 *  record. The workbench opens the tab (`onOpenWebview`); the iframe lives in it and this
 *  host half feeds it HTML and relays messages both ways. */

/** One sidebar webview view (`window.registerWebviewViewProvider`): the section-side
 *  record — the same delivery gate a panel crosses, on the section's mount instead of a
 *  tab's (the sidebar chat is the same claude-code page a tab hosts, and blanks the same
 *  way when its first pushes cross before the section mounts). */

function webviewBoot(nonce: string | null, fileRoot: string): string {
	return `<script${nonce ? ` nonce="${nonce}"` : ''}>
(function () {
	if (globalThis._VSCODE_FILE_ROOT === undefined) globalThis._VSCODE_FILE_ROOT = ${jsonForScript(fileRoot)};
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

function composeWebview(html: string, theme: { kind: 'vscode-dark' | 'vscode-light'; css: string; vars: Record<string, string> } | null, fileRoot: string): string {
	// The extension's own CSP nonce (VS Code's convention: the html declares one nonce and
	// the injected api script reuses it) — without it a `script-src 'nonce-…'` policy
	// blocks the boot and the webview can never speak.
	const nonce = /nonce="([A-Za-z0-9+/=_-]+)"/.exec(html)?.[1] ?? null;
	const themeHead = theme === null
		? ''
		: `<style id="__ggsTheme">${theme.css}</style><script${nonce ? ` nonce="${nonce}"` : ''}>document.documentElement.classList.add('${theme.kind}');var s=document.documentElement.style,v=${jsonForScript(theme.vars)};for(var k in v)s.setProperty(k,v[k]);</script>`;
	const boot = themeHead + webviewBoot(nonce, fileRoot);
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

/** The package-asset roots a webview's HTML can carry from ANOTHER frontend: a backend
 *  extension runs once per instance and bakes its `asWebviewUri` / `cspSource` from the
 *  frontend that served its activation — the desktop's `ggs://localhost/` (or Windows'
 *  `http://ggs.localhost/`), or one remote session's token route
 *  (`…[/u/<link>]/w/<instance>/ggs/<token>/`, its port colon possibly percent-encoded by
 *  an older shim). */

const FOREIGN_ASSET_ROOT = /ggs:\/\/localhost\/|https?:\/\/ggs\.localhost\/|https?:\/\/[^\s"'<>/]+(?:\/u\/[^\s"'<>/]+)?\/w\/[^\s"'<>/]+\/ggs\/[^\s"'<>/]+\//g;

/** Point every package-asset root in a webview's HTML at THIS frontend's own: the remote
 *  page cannot load `ggs://`, and one user's page must never load through another user's
 *  token (the token is that session's credential). */

export function localizeAssetRoots(html: string): string {
	const own = hook('assetUrl')('', 'ggs');
	return html.replace(FOREIGN_ASSET_ROOT, () => own);
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

export function loadFrameDoc(frame: HTMLIFrameElement, html: string, theme: { kind: 'vscode-dark' | 'vscode-light'; css: string; vars: Record<string, string> } | null, owner: string, fileRoot: string): void {
	const composed = composeWebview(localizeAssetRoots(html), theme, fileRoot);
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

/** The webviews concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const webviewsMethods: ThisType<ExtensionHost> = {
	webviewKey(extId: string, panelId: number): string {
		return `${extId}#${panelId}`;
	},

	deliverPendingWebviewMessages(view: WebviewDelivery, owner: string): void {
		if (view.pending.length === 0 || !view.frame) return;
		const queued = view.pending.splice(0);
		extLog('info', 'host', `webview ${owner}: delivering ${queued.length} message(s) held from before the load`);
		for (const message of queued) view.frame.contentWindow?.postMessage({ __ggsWebviewHost: true, type: 'message', message }, '*');
	},

	gateWebviewMessage(view: WebviewDelivery, message: unknown, owner: string): void {
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
	},

	mountWebview(extId: string, panelId: number, container: HTMLElement): () => void {
		if (this.sharesWebviews(extId)) {
			// A remote page shows the desktop window's live panel (§22.6). Closing the copy
			// crosses: module 19's sync sees the tab go and closes the PC's real panel (its
			// close reaches the extension, and the backend's dispose mirror clears every
			// remaining copy). Until that mirror lands here the record stays, so the
			// extension's next reveal of the panel opens the copy again.
			const key = this.webviewKey(extId, panelId);
			this.webviewCopies.add(key);
			const dispose = this.mountWebviewCopy(container, hook('webviewStreams')!.panelStream(extId, panelId));
			return () => {
				this.webviewCopies.delete(key);
				dispose();
			};
		}
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
				loadFrameDoc(frame, view.html, this.webviewTheme, `${extId}#${panelId}`, this.webviewAssetBase(extId));
			} else {
				extLog('info', 'host', `webview ${extId}#${panelId}: mount defers the first paint — the record has no html yet`);
			}
		}
		return () => this.webviewClosed(extId, panelId);
	},

	mountWebviewView(viewId: string, extId: string, container: HTMLElement): () => void {
		// A remote page shows the desktop window's live page of the view (§22.6).
		if (this.sharesWebviews(extId)) return this.mountWebviewCopy(container, hook('webviewStreams')!.viewStream(viewId));
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
			loadFrameDoc(frame, record.html, this.webviewTheme, `view:${record.extId}/${viewId}`, this.webviewAssetBase(record.extId));
		}
		return () => {
			if (this.webviewViews.get(viewId)?.frame === frame) {
				// The section went away (the sidebar rebuilds on any install or uninstall), the
				// frame with it. The record keeps its html for the next mount — the pane fills
				// at once — while every volatile gate (the loaded flag, the grace timers)
				// belonged to the dead frame and resets. The remount must also resolve its
				// provider again: a view marked resolved forever sits blank through every
				// later rebuild, its record answering no document to a frame that no longer
				// exists.
				if (record.loadGrace !== null) clearTimeout(record.loadGrace);
				if (record.firstPaintTimer !== null) clearTimeout(record.firstPaintTimer);
				this.webviewViews.set(viewId, { extId: record.extId, html: record.html, frame: null, pending: [], loaded: false, painted: null, loadGrace: null, firstPaintTimer: null });
				this.resolvedWebviewViews.delete(viewId);
			}
			frame.remove();
		};
	},

	webviewClosed(extId: string, panelId: number): void {
		const view = this.webviews.get(this.webviewKey(extId, panelId));
		if (!view) return;
		this.webviews.delete(this.webviewKey(extId, panelId));
		this.webviewSessions.delete(this.webviewKey(extId, panelId));
		if (view.loadGrace !== null) clearTimeout(view.loadGrace);
		if (view.firstPaintTimer !== null) clearTimeout(view.firstPaintTimer);
		view.frame = null;
		extLog('info', 'host', `webview ${extId}#${panelId}: closed`);
		this.frames.get(view.extId)?.send?.({ type: '__studioExtEvent', event: 'webviewDisposed', panelId });
	},

	resetViewsAfterBackendRestart(extId: string): void {
		const frame = this.frames.get(extId);
		for (const [viewId, record] of [...this.webviewViews]) {
			if (record.extId !== extId) continue;
			this.resolvedWebviewViews.delete(viewId);
			if (!record.frame || !frame) continue;
			this.resolvedWebviewViews.add(viewId);
			void this.callFrame(frame, 'webviewView.resolve', [viewId]).catch(() => this.resolvedWebviewViews.delete(viewId));
		}
	},

	setWebviewViewHtml(extId: string, viewId: string, html: string): void {
		// A view's html can precede its mount (a journal replay on a re-attached frontend,
		// the backend racing the sidebar's first show): the record is created on demand so
		// the html waits for the section instead of being dropped.
		let record = this.webviewViews.get(viewId);
		if (!record) {
			record = { extId, html: '', frame: null, pending: [], loaded: false, painted: null, loadGrace: null, firstPaintTimer: null };
			this.webviewViews.set(viewId, record);
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
			loadFrameDoc(record.frame, html, this.webviewTheme, owner, this.webviewAssetBase(record.extId));
			return;
		}
		// First paint pending: the same pair-coalescing a panel gets — one boot of the
		// latest document, the initial state queued behind its load.
		if (record.firstPaintTimer !== null) clearTimeout(record.firstPaintTimer);
		record.firstPaintTimer = window.setTimeout(() => this.flushFirstPaint(record, owner), 200);
	},

	armLoadGrace(view: WebviewDelivery, owner: string): void {
		if (view.loadGrace !== null) clearTimeout(view.loadGrace);
		view.loadGrace = window.setTimeout(() => {
			view.loadGrace = null;
			if (view.firstPaintTimer !== null) return;
			view.loaded = true;
			this.deliverPendingWebviewMessages(view, owner);
		}, 150);
	},

	flushFirstPaint(record: WebviewDelivery, owner: string): boolean {
		if (record.firstPaintTimer === null) return false;
		record.firstPaintTimer = null;
		if (!record.frame) return false;
		if (record.loaded && record.painted === record.html) return false;
		record.loaded = false;
		record.painted = record.html;
		extLog('info', 'host', `webview ${owner}: the coalescing window paints the latest document (${record.html.length} chars)`);
		loadFrameDoc(record.frame, record.html, this.webviewTheme, owner, this.webviewAssetBase(record.extId));
		return true;
	},

	webviewViewFor(source: MessageEventSource | null): { viewId: string; extId: string } | null {
		for (const [viewId, record] of this.webviewViews) {
			if (record.frame?.contentWindow === source) return { viewId, extId: record.extId };
		}
		return null;
	},

	releaseWebview(extId: string, panelId: number): void {
		const key = this.webviewKey(extId, panelId);
		const view = this.webviews.get(key);
		if (!view) return;
		this.webviews.delete(key);
		this.webviewSessions.delete(key);
		if (view.loadGrace !== null) clearTimeout(view.loadGrace);
		if (view.firstPaintTimer !== null) clearTimeout(view.firstPaintTimer);
		view.frame = null;
		this.onCloseWebviewTab?.(this.webviewTabId(extId, panelId));
		extLog('info', 'host', `webview ${extId}#${panelId}: the desktop window's panel closed — its copy goes`);
	},

	closeWebview(extId: string, panelId: number): void {
		if (!this.webviews.has(this.webviewKey(extId, panelId))) return;
		// A copy's panel is the desktop window's to dispose: here only the copy goes.
		if (this.sharesWebviews(extId)) {
			this.releaseWebview(extId, panelId);
			return;
		}
		if (this.onCloseWebviewTab) {
			this.onCloseWebviewTab(this.webviewTabId(extId, panelId));
			if (!this.webviews.has(this.webviewKey(extId, panelId))) return; // the tab's disposer already ran
		}
		this.webviewClosed(extId, panelId);
	},

	closeSessionTabs(sessionId: string): number {
		if (!sessionId) return 0;
		const hosting = [...this.webviewSessions].filter(([, hosted]) => hosted === sessionId).map(([key]) => this.webviews.get(key)).filter((view) => view !== undefined);
		for (const view of hosting) this.closeWebview(view.extId, view.panelId);
		return hosting.length;
	},

	webviewAssetBase(extId: string): string {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return ext ? extAssetBase(ext) : `ggs://localhost/${extId}/`;
	},

	async refreshWebviewTheme(): Promise<void> {
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
	},

	noteWebviewSessionTraffic(extId: string, panelId: number | null, message: unknown): void {
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
	},

	webviewTabId(extId: string, panelId: number): string {
		return `webview:${extId}:${panelId}`;
	},

	sharesWebviews(extId: string): boolean {
		return hook('session').frontendClass() === 'remote' && this.backendHosted(extId);
	},

	mountWebviewCopy(container: HTMLElement, stream: string): () => void {
		const bridge = hook('webviewStreams');
		if (!bridge) return () => undefined;
		return bridge.mountCopy(container, stream);
	},

	webviewFrameFor(stream: string): HTMLIFrameElement | null {
		const parsed = hook('webviewStreams')?.parseStream(stream) ?? null;
		if (!parsed) return null;
		if ('view' in parsed) return this.webviewViews.get(parsed.view)?.frame ?? null;
		return this.webviews.get(this.webviewKey(parsed.extId, parsed.panelId))?.frame ?? null;
	},

	ensureWebviewShown(stream: string): void {
		const parsed = hook('webviewStreams')?.parseStream(stream) ?? null;
		if (parsed && 'view' in parsed && !this.resolvedWebviewViews.has(parsed.view)) this.noteViewVisible(parsed.view, true);
	},
};
