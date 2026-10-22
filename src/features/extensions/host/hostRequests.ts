// The ggs.hostRequest service: the frame/page request dispatcher, its logging wrapper, the confined fs roots and the dialog/env helpers it serves.

import { claudePageMessage } from './claude';
import { commandsRegistered, unregisterCommand } from './dispatch';
import { FrameHandle } from './sharedTypes';
import { FormatterSelector } from './sharedTypes';
import { ExtStatusBarItem } from './sharedTypes';
import { WEBVIEW_OPEN_PENDING_MS, loadFrameDoc } from './webviews';
import { ExtensionHost } from './extensionHost';

import { Channel } from '../../../platform/ipc/core';
import { extChildEndStdin, extChildKill, extChildSpawn, extChildWrite, extNodeRuntimePath } from '../../../platform/ipc/extChild';
import { type NodeEnv, extNodeEnv } from '../../../platform/ipc/ext';
import { extFs } from '../../../platform/ipc/ext';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { commands } from '../../../platform/commands';
import { declaredCommand, languageIdFor } from '../contributions';
import { extLog, extLogEnabled, extLogOnce, type ExtLogLevel } from '../extLog';
import { defaultNodeEnv } from '../../../hosts/extModuleLoader';
import type { EditorPlacement } from '../../editor/types';
import { setFileDiagnostics, type SerializableDiagnostic } from '../editorDiagnostics';
import * as state from '../../../platform/state';
import { notify, progressToast, quickInput } from '../../../platform/ui/index';


function dialogFilters(filters: Record<string, string[]> | undefined): { name: string; extensions: string[] }[] | undefined {
	if (filters === undefined) return undefined;
	return Object.entries(filters).map(([name, extensions]) => ({ name, extensions }));
}

/** The Node environment facts every frame's `os`/`process` shims read (`ext_node_env`) —
 *  one backend call, cached for the session. A failed call answers the observable
 *  platform's derivation, never a hardcoded OS word (CI's Linux runner once met `win32`
 *  here and every shim spelled Windows paths). */
let nodeEnvCache: Promise<NodeEnv> | null = null;

export function cachedNodeEnv(): Promise<NodeEnv> {
	if (nodeEnvCache === null) {
		nodeEnvCache = extNodeEnv().catch(() => defaultNodeEnv());
	}
	return nodeEnvCache;
}

/** Remove a command from the registry without touching other registrations of the same id. */

/** A request's arguments or answer, shortened for a trace line. */
function summarize(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text.length > 600 ? `${text.slice(0, 600)}…` : text;
	} catch {
		return String(value);
	}
}

/** The hostRequests concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const hostRequestsMethods: ThisType<ExtensionHost> = {
	async serve(method: string, args: unknown[], extId: string, handle: FrameHandle): Promise<unknown> {
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
	},

	async serveRequest(method: string, args: unknown[], extId: string, handle: FrameHandle): Promise<unknown> {
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
			case 'fsProvider.register': {
				// `workspace.registerFileSystemProvider(scheme, provider)`: the same ask-back
				// as the content providers — the frame keeps the object, the host keeps the
				// scheme's owner, `fsProvider.read` fetches a document's text from it.
				const scheme = args[0];
				if (typeof scheme !== 'string' || scheme === '') throw new Error('fsProvider.register needs a scheme');
				this.fsProviders.set(scheme, handle);
				return Promise.resolve(undefined);
			}
			case 'fsProvider.unregister': {
				const scheme = args[0] as string;
				if (this.fsProviders.get(scheme) === handle) this.fsProviders.delete(scheme);
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
				const read = (await extFs('read', this.fsRoots(extId), path)) as { data: string };
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
				this.progress.set(id, { toast: progressToast(String(args[0] ?? extId)), extId });
				return Promise.resolve(id);
			}
			case 'progress.report': {
				const [id, percent, message] = args as [number, number | null, string?];
				this.progress.get(id)?.toast.update(percent ?? null, message);
				return Promise.resolve(undefined);
			}
			case 'progress.end': {
				const id = args[0] as number;
				this.progress.get(id)?.toast.done();
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
						const paths = (await extFs('find', [root], path)) as string[] | null;
						for (const relative of paths ?? []) found.push({ root, path: relative });
					}
					return found;
				}
				return extFs(op, this.fsRoots(extId), path, to, data);
			}
			case 'diagnostics.set': {
				// A frame pushed its diagnostic collection changes: they land in the editor
				// diagnostics store, which re-renders every open editor for that file.
				const [, diagPath, diagList] = args as [string, string, SerializableDiagnostic[]];
				setFileDiagnostics(diagPath, diagList ?? []);
				return Promise.resolve(undefined);
			}
			case 'languages.registerCompletion': {
				// GGS-patch: the frame registered a completion provider (see
				// editorCompletions.ts): `{ id, selectors, triggerCharacters }`.
				const [declaration] = args as [{ id: string; selectors: FormatterSelector[]; triggerCharacters?: string[] }];
				this.completionProviders.set(`${extId}/${declaration.id}`, { extId, id: declaration.id, selectors: declaration.selectors ?? [], handle, triggerCharacters: declaration.triggerCharacters ?? [] });
				return Promise.resolve(undefined);
			}
			case 'languages.unregisterCompletion': {
				const [declaration] = args as [{ id: string }];
				this.completionProviders.delete(`${extId}/${declaration.id}`);
				return Promise.resolve(undefined);
			}
			case 'fileDecorations.register': {
				// GGS-patch: the frame registered a file decoration provider (see
				// explorerDecorations.ts — the store the explorer's badges read).
				const [declaration] = args as [{ id: string; label: string }];
				this.fileDecorationProviders.set(`${extId}/${declaration.id}`, { extId, id: declaration.id, handle });
				return Promise.resolve(undefined);
			}
			case 'fileDecorations.unregister': {
				const [declaration] = args as [{ id: string }];
				this.fileDecorationProviders.delete(`${extId}/${declaration.id}`);
				this.extensionDecorations = this.extensionDecorations.filter((entry) => !entry.key.startsWith(`${extId}/`));
				this.onFileDecorationsChanged?.();
				return Promise.resolve(undefined);
			}
			case 'languages.registerHover': {
				// GGS-patch: the frame registered a hover provider (see editorHovers.ts).
				const [declaration] = args as [{ id: string; selectors: FormatterSelector[] }];
				this.hoverProviders.set(`${extId}/${declaration.id}`, { extId, id: declaration.id, selectors: declaration.selectors ?? [], handle });
				return Promise.resolve(undefined);
			}
			case 'languages.unregisterHover': {
				const [declaration] = args as [{ id: string }];
				this.hoverProviders.delete(`${extId}/${declaration.id}`);
				return Promise.resolve(undefined);
			}
			case 'languages.registerDefinition': {
				const [declaration] = args as [{ id: string; selectors: FormatterSelector[] }];
				this.definitionProviders.set(`${extId}/${declaration.id}`, { extId, id: declaration.id, selectors: declaration.selectors ?? [], handle });
				return Promise.resolve(undefined);
			}
			case 'languages.unregisterDefinition': {
				const [declaration] = args as [{ id: string }];
				this.definitionProviders.delete(`${extId}/${declaration.id}`);
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
				return extChildSpawn(extId, spec, onEvent);
			}
			case 'childProcess.write':
				return extChildWrite(args[0] as number, args[1] as string);
			case 'childProcess.end':
				return extChildEndStdin(args[0] as number);
			case 'childProcess.kill':
				return extChildKill(args[0] as number);
			case 'childProcess.nodeRuntime':
				// The `fork` bridge's runtime: the machine's node (a real language-server
				// process), or null when the machine has none — the frame answers Node's
				// fork-shaped `'error'` event.
				return extNodeRuntimePath();
			case 'decoration.type': {
				// GGS-patch: the frame created a decoration type (see editorDecorations.ts).
				const [declaration] = args as [{ key: string; options: Record<string, string | boolean> }];
				this.decorTypesByExt.get(extId)?.add(declaration.key);
				this.onDecorateType?.(declaration.key, declaration.options ?? {});
				return Promise.resolve(undefined);
			}
			case 'decoration.dispose': {
				const [{ key }] = args as [{ key: string }];
				this.decorTypesByExt.get(extId)?.delete(key);
				this.onSetDecorations?.(null, key, []);
				return Promise.resolve(undefined);
			}
			case 'editor.setDecorations': {
				const [path, key, ranges] = args as [string | null, string, { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]];
				this.onSetDecorations?.(path, key, ranges ?? []);
				return Promise.resolve(undefined);
			}
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
				const [framePanelId, viewType, title, column, preserveFocus] = args as [number | null, string, string, unknown, boolean | undefined];
				const panelId = framePanelId ?? this.nextWebviewPanelId++;
				const generation = this.webviewGenerations.get(extId) ?? 0;
				// The panels an extension-host restart left behind (an older generation —
				// their process is gone, no setHtml reaches them anymore): the fresh
				// process's first panel takes over from them. They close AFTER the new tab
				// opens (below), VS Code's order — the replacement lands beside the dead tab
				// and slides into its place as it goes; an extension replacing its own dead
				// tabs through `tabGroups` (Git Graph's watcher) finds them already closed,
				// which its close tolerates. A copy's panels are the desktop window's to settle.
				const orphans = this.sharesWebviews(extId) ? [] : [...this.webviews.values()].filter((view) => view.extId === extId && (view.generation ?? 0) < generation);
				// A create reusing a live panel id (a shim numbering from 1 again, not past
				// the host's `webviewPanelBase`) cannot wait for that: the record must leave
				// the key before the new panel takes it, and every panel of the previous
				// process is dead with it.
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
			this.webviews.set(this.webviewKey(extId, panelId), { panelId, extId, title, viewType: typeof viewType === 'string' ? viewType : undefined, generation, html: '', frame: null, pending: [], loaded: false, painted: null, loadGrace: null, firstPaintTimer: null });
			extLog('info', 'host', `webview ${extId}#${panelId}: created ("${title}")`);
			this.onOpenWebview?.(panelId, title, extId, ExtensionHost.placementOf(column), preserveFocus !== true);
				for (const view of orphans) {
					if (this.webviews.get(this.webviewKey(view.extId, view.panelId)) !== view) continue; // already closed
					extLog('info', 'host', `webview ${extId}#${view.panelId}: left behind by an extension-host restart — closing it for the new panel #${panelId}`);
					this.closeWebview(view.extId, view.panelId);
				}
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
					loadFrameDoc(view.frame, html, this.webviewTheme, owner, this.webviewAssetBase(view.extId));
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
				// A synthesized remote-control request's answer is consumed before it
				// reaches the page (the page never made that request).
				const inner = claudePageMessage(message);
				if (this.consumeClaudeRcResponse(extId, panelId, inner)) return Promise.resolve(undefined);
				// The conversation tap copies synchronously before the delivery; its own
				// failures can never touch the message it copies (plan §2.2). It copies the
				// protocol message, not Claude Code's page wrapper around it.
				this.noteClaudeTap(extId, panelId, 'out', inner);
				this.gateWebviewMessage(view, message, `${extId}#${panelId}`);
				return Promise.resolve(undefined);
			}
			case 'tabs.close': {
				// `window.tabGroups.close(tabs)`: the tabs by id, through the editor area's own
				// close (a dirty editor keeps its save prompt). True when any tab closed — a tab
				// already gone (the orphan cleanup above beat the extension to it) is no error.
				const ids = Array.isArray(args[0]) ? (args[0] as unknown[]).filter((id): id is string => typeof id === 'string') : [];
				let closed = false;
				for (const id of ids) {
					if (this.onCloseTab?.(id) === true) closed = true;
				}
				return Promise.resolve(closed);
			}
			case 'webview.reveal': {
				const panelId = args[0] as number;
				const view = this.webviews.get(this.webviewKey(extId, panelId));
				if (view) {
					// The hook answers whether a tab held the id: a panel record without its
					// tab (a tab close whose disposer never reached this record, a teardown
					// race) must not spend the reveal silently — the panel lives, so the
					// reveal re-opens its tab from the record it kept.
					if (this.onRevealWebviewTab?.(this.webviewTabId(extId, panelId)) === false) {
						extLog('info', 'host', `webview ${extId}#${panelId}: reveal found no tab — re-opening the panel's tab`);
						this.onOpenWebview?.(panelId, view.title, extId, undefined, true);
					}
				} else {
					// The extension is revealing a panel this host has no record of: the
					// webviewDisposed that should have settled its panel object was lost
					// (a close crossing the restart boundary) and its session→panel binding
					// will hold the dead panel forever — every later click of that history
					// row would reveal into the void. Settle the panel object now; the
					// extension's dispose pass clears the binding, and its next open of the
					// session creates a fresh panel instead of revealing nothing.
					extLog('info', extId, `webview ${extId}#${panelId}: reveal with no panel record — settling the extension's stale panel object`);
					this.frames.get(extId)?.send?.({ type: '__studioExtEvent', event: 'webviewDisposed', panelId });
				}
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
				this.setWebviewViewHtml(extId, args[0] as string, args[1] as string);
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
	},

	fsRoots(extId: string): string[] {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		return [...ExtensionHost.workspaceFolders, ...(ext ? [ext.path] : []), ...(this.storageRoots.get(extId) ?? [])];
	},
};
