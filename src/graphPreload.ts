// The Git Graph Engine seam's boot warmer (module 10) — and the composer of the view page
// itself: the extension generates its whole page (src/gitGraphView.ts getHtmlForWebview — the
// markup, the inline initial state, the per-branch colours, the CSP and the rescan empty
// state), bundled as gitgraph/viewpage.js by scripts/compare-bundle.mjs. This module composes
// that generated page with the host environment the way VS Code provides a webview its
// environment: the theme's token stylesheet and vscode-* classes, an acquireVsCodeApi whose
// messages become the view's request protocol (served by graphHost.ts), and the deferred
// loading of the view bundle (it must not run before the theme sheet has applied — its read
// of the --vscode-* tokens is synchronous at boot, and VS Code guarantees the ordering
// natively). No page content of the app's own is written here: everything the user sees is
// the extension's.
//
// The warmer starts the composed page in a hidden frame while the workbench chunk is still
// downloading, so the view bundle's fetch, parse and first data requests overlap the splash;
// GraphHost claims the frame (claimGraphPreload) when the workbench comes up, and its mount
// feeds the live page the full repository set over loadRepos instead of regenerating.
//
// This file is part of the TypeScript seam (docs/ggs-development-plan.md §3.7,
// scripts/check-seams.mjs): like graphHost.ts it names the view page bundle, which is why the
// seam check allowlists it. It never speaks the view's own request protocol - only
// graphHost.ts does.

import { invoke } from '@tauri-apps/api/core';

import { themeById } from './settings';
import * as state from './state';

/** The extension's own view page generator: gitgraph/viewpage.js, built from its compiled
 *  src/gitGraphView.ts (scripts/compare-bundle.mjs). `buildViewPage` runs the extension's own
 *  getHtmlForWebview over the extension host's inputs - the same call VS Code's host makes. */
declare global {
	interface Window {
		GitGraphViewPage?: { buildViewPage(options: Record<string, unknown>): string };
	}
}

/** Everything the extension host feeds getHtmlForWebview: the stored settings (read through
 *  the config stub's overrides), the repository states, the remembered view states and the
 *  pending loadViewTo. */
export interface ViewPageInput {
	settings: Record<string, unknown>;
	repos: Record<string, unknown>;
	lastActiveRepo: string | null;
	loadViewTo: Record<string, unknown> | null;
	globalState: Record<string, unknown>;
	workspaceState: Record<string, unknown>;
}

let viewPageBundle: Promise<void> | null = null;

/** Load the view page generator once per document. A generator that is already present (tests
 *  pre-set it) resolves at once; a failed load rejects, and the caller falls back to whatever
 *  it can do without a page (the host logs it). */
export function loadViewPageGenerator(): Promise<void> {
	if (window.GitGraphViewPage) return Promise.resolve();
	viewPageBundle ??= new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = '/gitgraph/viewpage.js';
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('The Git Graph view page generator (gitgraph/viewpage.js) did not load'));
		document.head.appendChild(script);
	});
	return viewPageBundle;
}

/** Generate the extension's own page and compose it with the host environment for the current
 *  theme. */
export async function buildViewPageHtml(input: ViewPageInput): Promise<string> {
	await loadViewPageGenerator();
	const generate = window.GitGraphViewPage;
	if (!generate) throw new Error('The Git Graph view page generator did not load');
	return composeViewPage(generate.buildViewPage({ ...input }), themeById());
}

/**
 * Compose the extension's generated page with the host environment:
 * - the theme's token stylesheet and the webview default body styles ride under the head,
 *   ahead of everything, as VS Code injects them into a webview;
 * - the page's own `<script src>` tags (the markdown renderer and the view bundle) are lifted
 *   out of the body —
 *   the shim re-appends them, same URLs and nonce, once the theme sheet has applied, and each
 *   one's load is reported as the boot signal the host's preload logic waits for;
 * - the acquireVsCodeApi protocol shim rides under the page's own nonce so its CSP lets it
 *   run. A page with no lifted scripts is the extension's own empty state (no repository):
 *   the shim marks it so the host's boot bookkeeping stays quiet, and its rescan button still
 *   reaches the host.
 */
export function composeViewPage(generated: string, theme: { css: string; kind: string; label: string }): string {
	const scripts: string[] = [];
	const lifted = generated.replace(/<script nonce="[^"]+" src="([^"]+)"><\/script>/g, (_all, src: string) => {
		scripts.push(src);
		return '';
	});
	const nonce = /nonce="([^"]+)"/.exec(lifted)?.[1] ?? '';
	const prelude = `<link id="ggs-host-theme" rel="stylesheet" href="${theme.css}" />` +
		'<style>html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); }</style>';
	const withHtmlClass = lifted.replace(/<html([^>]*)>/, (_all, attrs: string) => `<html${attrs} class="${theme.kind}">`);
	return withHtmlClass
		.replace('<head>', '<head>' + prelude + viewPageShim(nonce, scripts))
		.replace(/<body((?:\s[^>]*)?)>/, (_all, attrs: string) => {
			// Keep the page's own body classes (the sticky header): the theme kind joins them.
			const own = /\sclass="([^"]*)"/.exec(attrs);
			const rest = own ? attrs.replace(/\sclass="[^"]*"/, '') : attrs;
			const classes = (own ? own[1]! + ' ' : '') + theme.kind;
			return `<body${rest} class="${classes}" data-vscode-theme-kind="${theme.kind}" data-vscode-theme-name="${theme.label}">`;
		});
}

/** The host-environment shim injected under the page's own nonce: everything VS Code gives a
 *  webview natively that the app must provide instead — acquireVsCodeApi (view state in
 *  sessionStorage, requests posted to the host), the theme-token mirroring the view's
 *  synchronous boot read needs, the shell's keyboard shortcuts while the view has focus, the
 *  script-error reporting into the host's session log, and the boot watchdog. */
function viewPageShim(nonce: string, scripts: string[]): string {
	const config = JSON.stringify({ nonce, scripts }).replace(/</g, '\\u003c');
	return '<script nonce="' + nonce + '">(function(){\n' +
		'var GG = ' + config + ';\n' +
		// A script error here or in the view bundle must not leave the page as a silent
		// near-empty skeleton: it goes to the host's session log, so "Open Session Log" shows
		// what died.
		'window.addEventListener("error", function (event) {\n' +
		'\ttry { window.parent.postMessage({ __studioGraphError: (event.message || "Script error") +\n' +
		'\t\t(event.filename ? " (" + event.filename.split("/").pop() + ":" + event.lineno + ")" : "") }, "*"); } catch (e) { }\n' +
		'});\n' +
		// VS Code injects the --vscode-* theme tokens as an inline style on <html>, which is
		// where the view reads them (web/utils.ts getVSCodeStyle) - in particular the colour
		// behind the "scroll to commit" flash and the Find widget's highlight. The composer
		// carries the current theme as a stylesheet linked ahead of everything; once it has
		// applied, its resolved values are mirrored into inline style, before the view script
		// that reads them ever runs. A later, live theme switch re-mirrors on a message from
		// the host (it swaps the stylesheet in place first).
		'function mirrorThemeVars() {\n' +
		'\tvar computed = getComputedStyle(document.documentElement);\n' +
		'\t["--vscode-font-family", "--vscode-editor-font-family", "--vscode-editor-findMatchHighlightBackground", "--vscode-selection-background"].forEach(function (name) {\n' +
		'\t\tvar value = computed.getPropertyValue(name).trim();\n' +
		'\t\tif (value) document.documentElement.style.setProperty(name, value);\n' +
		'\t});\n' +
		'}\n' +
		// The acquireVsCodeApi shim: state in sessionStorage, requests through the parent.
		'window.acquireVsCodeApi = function () { return {\n' +
		'\tgetState: function () { try { return JSON.parse(sessionStorage.getItem("ggstudio.viewState") || "null"); } catch (e) { return null; } },\n' +
		'\tsetState: function (s) { sessionStorage.setItem("ggstudio.viewState", JSON.stringify(s)); },\n' +
		'\tpostMessage: function (message) { window.parent.postMessage({ __studioGraphRequest: message }, "*"); }\n' +
		'}; };\n' +
		// Route the parent\'s responses back through this window\'s message listeners, which is
		// where the view listens for them; a live theme switch arrives the same way.
		'window.addEventListener("message", function (event) {\n' +
		'\tvar data = event.data;\n' +
		'\tif (data && data.__studioGraphResponse !== undefined) window.postMessage(data.__studioGraphResponse, "*");\n' +
		'\tif (data && data.__studioThemeReady) mirrorThemeVars();\n' +
		'});\n' +
		// Keyboard shortcuts of the shell (Ctrl+B, Ctrl+`, …) must work while the graph has focus.
		'window.addEventListener("keydown", function (event) {\n' +
		'\tif (!(event.ctrlKey || event.metaKey)) return;\n' +
		'\tvar key = event.key.toLowerCase();\n' +
		'\tif (["`", "j", "b", "o", "w", "tab", "pageup", "pagedown"].indexOf(key) !== -1 || (event.shiftKey && (key === "e" || key === "g"))) {\n' +
		'\t\tevent.preventDefault();\n' +
		'\t\twindow.parent.document.dispatchEvent(new KeyboardEvent("keydown", {\n' +
		'\t\t\tkey: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey\n' +
		'\t\t}));\n' +
		'\t}\n' +
		'});\n' +
		// The empty-state page carries no view scripts: mark it so the host's boot bookkeeping
		// (and the watchdog below) knows no bundle was ever going to run here.
		'var noScripts = GG.scripts.length === 0;\n' +
		'window.__ggViewNoRepo = noScripts;\n' +
		'var started = false;\n' +
		'function bootView() {\n' +
		'\tif (started) return;\n' +
		'\tstarted = true;\n' +
		'\tmirrorThemeVars();\n' +
		'\tif (noScripts) return;\n' +
		'\t// markdown-it must be global before the view runs; async=false keeps the order. The\n' +
		'\t// nonce is the page\'s own, so the CSP it carries admits these too. The frame\'s load\n' +
		'\t// event does not prove the view bundle has executed: the host (graphHost.ts) waits for this\n' +
		'\t// signal before talking to the page, and falls back to a plain regeneration when the\n' +
		'\t// signal never comes. __ggViewBooted is set on the window - not when the scripts are\n' +
		'\t// appended - so reading it back means the bundle has actually run.\n' +
		'\tGG.scripts.forEach(function (src, index, list) {\n' +
		'\t\tvar script = document.createElement("script");\n' +
		'\t\tscript.setAttribute("nonce", GG.nonce);\n' +
		'\t\tscript.src = src;\n' +
		'\t\tscript.async = false;\n' +
		'\t\tif (index === list.length - 1) {\n' +
		'\t\t\tvar notify = function (ok) { try { window.parent.postMessage({ __studioGraphBooted: ok === true }, "*"); } catch (e) { } };\n' +
		'\t\t\tscript.addEventListener("load", function () { window.__ggViewBooted = true; notify(true); });\n' +
		'\t\t\tscript.addEventListener("error", function () { notify(false); });\n' +
		'\t\t}\n' +
		'\t\tdocument.head.appendChild(script);\n' +
		'\t});\n' +
		'}\n' +
		'if (noScripts) {\n' +
		'\tbootView();\n' +
		'} else {\n' +
		'\tvar themeLink = document.getElementById("ggs-host-theme");\n' +
		'\tvar settled = false;\n' +
		'\tvar finishBoot = function () { if (settled) return; settled = true; bootView(); };\n' +
		'\tif (themeLink) { themeLink.addEventListener("load", finishBoot); themeLink.addEventListener("error", finishBoot); }\n' +
		'\twindow.setTimeout(finishBoot, 1000);\n' +
		'}\n' +
		'window.setTimeout(function () {\n' +
		'\tif (window.__ggViewBooted || window.__ggViewNoRepo) return;\n' +
		'\tvar div = document.createElement("div");\n' +
		'\tdiv.style.cssText = "padding:20px;color:var(--vscode-errorForeground,#f48771)";\n' +
		'\tdiv.textContent = "The Git Graph view failed to start. Open the session log (View \\u2192 Open Session Log) or restart the app; if it persists, reinstall Git Graph Studio.";\n' +
		'\t(document.getElementById("content") || document.body).appendChild(div);\n' +
		'}, 4000);\n' +
		'})();</script>';
}

/* ---------- The boot warmer ---------- */

/** The frame the warmer started, still unclaimed. */
let preloaded: { frame: HTMLIFrameElement; repo: string } | null = null;

/** Boot the view page in a hidden frame for the folder this launch will open. Safe to call
 *  once per window; a no-op when the launch shows a file or a comparison, remembers no
 *  folder (or a workspace - the graph keys off the first root, resolved later), or when the
 *  page generator is not there (tests). Never throws into the caller: a failed warm-up only
 *  means the mount regenerates the page itself. */
export function startGraphPreload(): void {
	if (preloaded) return;
	void warm().catch(() => undefined);
}

async function warm(): Promise<void> {
	// The same launch-form choice the boot makes: a remembered workspace wins, then the
	// folder argument, then the remembered folder. Keep in step with workbench.boot.
	const context = await invoke<{ file: string | null; actions: unknown[]; repo: string | null }>('boot_context').catch(() => null);
	if (context === null || context.file !== null || context.actions.length > 0) return;
	const remembered = state.lastFolder();
	const last = remembered !== null && remembered.toLowerCase().endsWith('.ggs-workspace')
		? remembered
		: context.repo ?? remembered;
	if (last === null || last.toLowerCase().endsWith('.ggs-workspace')) return;
	if (!window.GitGraphViewPage) {
		try {
			await loadViewPageGenerator();
		} catch {
			return; // no page generator (tests): nothing to warm
		}
	}
	// Exactly the page GraphHost.mount generates - the mount reconciles it with the full
	// repository set over loadRepos.
	const html = await buildViewPageHtml({
		settings: state.graphSettings(),
		repos: { [last]: state.repoState(last) },
		lastActiveRepo: last,
		loadViewTo: null,
		globalState: state.globalViewState(),
		workspaceState: state.workspaceViewState()
	});
	const frame = document.createElement('iframe');
	frame.title = 'Git Graph';
	frame.setAttribute('aria-label', 'Git Graph');
	frame.style.display = 'none';
	document.body.appendChild(frame);
	preloaded = { frame, repo: last };
	// After this point the page owns its own boot; the host side learns of it through the
	// page's __studioGraphBooted message or by reading window.__ggViewBooted (see
	// graphHost.whenPreloadSettled).
	frame.srcdoc = html;
}

/** The frame the warmer started, removed from the document and handed to GraphHost; `null`
 *  when the warmer did not run or the frame was already claimed. */
export function claimGraphPreload(): { frame: HTMLIFrameElement; repo: string } | null {
	const claimed = preloaded;
	preloaded = null;
	claimed?.frame.remove();
	return claimed;
}
