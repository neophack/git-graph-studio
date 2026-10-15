import type { PageFrameHandle, PageDiffRequest, PageTheme } from './sharedTypes';
// The ggs:// page surface: page frames, their RPC service (vscode.open/diff, theme), asset URLs and the page/webview boot composition vocabulary.

import { FrameHandle } from './sharedTypes';
import { extIconRelPath } from './store';
import { ExtensionHost } from './extensionHost';

import { writeFile } from '../../../platform/ipc/fs';
import { type ExtInfo, extPageFileChunk, extPageRevisionBytes, extReadFile } from '../../../platform/ipc/ext';
import { extProcessRun } from '../../../platform/ipc/extProcess';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { extLog } from '../extLog';
import { themeById } from '../../../platform/settings';
import { hook } from '../../../platform/hooks';

/** The theme of the moment, as a page's 'theme.stylesheet' request answers it and the theme
 *  event pushes carry it: the active theme's vscode-* class, its stylesheet text, and the
 *  --vscode-* declarations parsed out of it. */


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

export function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** One open extension page: a sandboxed iframe in an editor tab, speaking the page RPC the
 *  composed bootstrap (`acquireGgsApi`) defines. The editor tab owns it — its disposer is
 *  the tab's `onClose`. */

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
	return hook('assetUrl')(dirName, 'ggs') + '/';
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

export function extHostFrameUrl(): string {
	// A remote workbench always takes the package path: its frame document is the instance's
	// own, served by the daemon under the session's resource token (§12.2).
	if (!import.meta.env.PROD && !hook('session').remote()) return '/ext-host.html';
	return hook('assetUrl')('ext-host.html', 'ggs');
}

/** The pages concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const pagesMethods: ThisType<ExtensionHost> = {
	prewarmPageAssets(extId: string): void {
		if (this.prewarmedExts.has(extId)) return;
		this.prewarmedExts.add(extId);
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		if (ext?.pageBundle !== true) return;
		const url = `${extAssetBase(ext)}webview/index.js`;
		const started = performance.now();
		void fetch(url)
			.then((response) => (response.ok ? response.arrayBuffer() : null))
			.then((bytes) => {
				if (bytes) extLog('info', extId, `page bundle prewarmed (${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - started)} ms)`);
			})
			.catch(() => undefined);
	},

	async readFile(extId: string, relPath: string): Promise<string> {
		return await extReadFile(extId, relPath);
	},

	async readMainFile(extId: string, main: string): Promise<string> {
		try {
			return await extReadFile(extId, main);
		} catch (error) {
			if (/\.[a-zA-Z0-9]+$/.test(main)) throw error;
			return await extReadFile(extId, `${main}.js`);
		}
	},

	async servePageRpc(method: string, args: unknown[], page: PageFrameHandle): Promise<unknown> {
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
						? await extPageRevisionBytes(ExtensionHost.workspaceFolders, params.repo ?? '', params.revision ?? '', params.path ?? '')
						: await extPageFileChunk(ExtensionHost.workspaceFolders, params.repo ?? '', params.path ?? '', Number(params.offset) || 0, Number(params.len) || 0);
				}
				const started = performance.now();
				console.debug(`[ggs] backend.run ${page.extId} ${String(command)} …`);
				try {
					const answer = await extProcessRun(page.extId, command, commandArgs ?? []);
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
				return await writeFile(path, contents);
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
	},

	packageIcon(extId: string): string | null {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return ext?.icon ? extIconRelPath(ext) : null;
	},

	async pageTheme(): Promise<PageTheme> {
		const theme = themeById();
		const css = await fetch(theme.css).then((response) => response.text(), () => '');
		return { kind: theme.kind, label: theme.label, css, vars: themeVars(css) };
	},
};
