// The extension host's main-window half: it lists the extensions the Rust side installed from
// VSIX files, spins up one sandboxed frame per extension (ext-host.html), feeds each its entry
// bundle, and serves the frames' host requests - the workbench command registry, notifications,
// quick inputs, settings persistence and opener calls - over postMessage.
//
// The git-graph-rs extension is deliberately NOT activated here: it is integrated into the app
// (its engine is in-process, its webview is hosted natively by GraphHost, and the Rust side
// lists it as a built-in whose manifest it serves from the one embedded in the binary); the
// frame-based host is for the few additional VSIX / `.ggx` extensions Studio supports.

import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { builtinContributions } from 'virtual:builtin-contributions';

import { commands } from './commands';
import { applyContributions, declaredCommand, localize, removeContributions, type ManifestContributes } from './contributions';
import { locale, registerZhCnText } from './i18n';
import * as state from './state';
import { notify, quickInput } from './ui';

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

/** The `manifest.json` of a `.ggx` package. */
export interface GgxManifest {
	format: string;
	id: string;
	version: string;
	frontend?: { page: string; config?: string; compare?: string } | null;
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

/** The extension whose webview and backend the workbench hosts natively (via GraphHost). */
const NATIVELY_HOSTED = new Set([GIT_GRAPH_RS_EXT_ID]);

interface FrameHandle {
	frame: HTMLIFrameElement;
	/** Command ids this extension registered; unregistered when it goes away. */
	commandIds: Set<string>;
	/** The calls into the frame still waiting for their result: settled (rejected) when the
	 *  frame goes away, or a command that was running in it would wait forever and its
	 *  result listener never leave the window. */
	pendingCalls: Set<(error: Error) => void>;
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

	/** Synchronously register the baked-in extensions' contributions (menus, commands,
	 *  keybindings). The data comes from the build-time virtual module, so the workbench's
	 *  first render already sees these menus - the async activateInstalled() pass skips them. */
	applyBuiltinContributions(): void {
		for (const baked of builtinContributions) this.registerContributions(baked.extId, baked.contributes, baked.nls, baked.nlsTranslations['zh-cn'] ?? {});
	}

	constructor() {
		window.addEventListener('message', (event) => this.onMessage(event));
	}

	/** List the installed extensions (the Extensions view renders these). */
	async list(): Promise<ExtInfo[]> {
		return await invoke<ExtInfo[]>('ext_list');
	}

	/** Read a text file inside an installed extension (README, CHANGELOG, manifest). */
	async readFile(extId: string, relPath: string): Promise<string> {
		return await invoke<string>('ext_read_file', { extId, relPath });
	}

	/** Install a VSIX, then activate newly installed extensions. Returns the installed id. */
	async installFromVsix(path: string): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_install_from_vsix', { path });
		await this.reload(info.id);
		return info;
	}

	/** Install a `.ggx` package (a newer version replaces an installed `.vsix` or `.ggx` of the
	 *  same id; the integrated git-graph-rs is refused on the Rust side). */
	async installFromGgx(path: string): Promise<ExtInfo> {
		const info = await invoke<ExtInfo>('ext_install_from_ggx', { path });
		await this.reload(info.id);
		return info;
	}

	/** Install whichever package format the file is. */
	installPackage(path: string): Promise<ExtInfo> {
		return path.toLowerCase().endsWith('.ggx') ? this.installFromGgx(path) : this.installFromVsix(path);
	}

	/** Uninstall an extension (the Rust side refuses built-ins), then drop its frame, its
	 *  registry commands and its contributions. */
	async uninstall(extId: string): Promise<void> {
		await invoke('ext_uninstall', { extId });
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
		const toActivate = installed.filter((ext) => !NATIVELY_HOSTED.has(ext.id) && !this.frames.has(ext.id));
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
	}

	/** Register one extension's parsed manifest contributions into the workbench. */
	private registerContributions(extId: string, contributes: ManifestContributes | null | undefined, nls: Record<string, string>, nlsZhCn: Record<string, string> = {}): void {
		this.declaredCommandIds.set(extId, (contributes?.commands ?? []).map((declared) => declared.command));
		const dispatch = (command: string) => {
			if (this.onNativeCommand?.(command)) return;
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

	/** A declared command is runnable when its extension's frame holds a handler, or the
	 *  workbench handles it natively. */
	private canRunCommand(command: string): boolean {
		if (this.nativeCommands.has(command)) return true;
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
		const ext = (await this.list().catch(() => [] as ExtInfo[])).find((e) => e.id === extId);
		if (ext) {
			await this.applyContributions(ext);
			await this.activate(ext);
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
		(handle as FrameHandle & { send?: (m: unknown) => void }).send = send;

		frame.addEventListener('load', () => {
			send({
				type: '__studioExtInit',
				context: {
					extensionId: ext.id,
					extensionPath: ext.path,
					workspaceFolders: ExtensionHost.workspaceFolders.map((uri, index) => ({ uri: { scheme: 'file', path: uri, fsPath: uri, toString: () => 'file:' + uri }, name: uri.split(/[\\/]/).pop() ?? uri, index })),
					settings: state.extSettings(ext.id),
					// The extension's view of the display language follows the workbench locale.
					language: locale()
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
				const items = (args[0] as string[]).map((label) => ({ label, value: label }));
				return quickInput({ items, placeholder: args[1] as string }).then((value) => value ?? undefined);
			}
			case 'settings.update': {
				const [id, key, value] = args as [string, string, unknown];
				state.saveExtSetting(id, key, value);
				return Promise.resolve(undefined);
			}
			case 'openExternal':
				return openUrl(args[0] as string).then(() => true);
			case 'clipboard.writeText':
				return writeText(args[0] as string);
			case 'log':
				// Studio has no per-extension output channel UI yet; the console keeps the lines.
				console.log(`[${args[0]}] ${args[1]}`);
				return Promise.resolve(undefined);
			default:
				return Promise.reject(new Error(`unsupported host request: ${method}`));
		}
	}

	/** `vscode.commands.executeCommand`: an extension-registered command receives its arguments
	 *  in its frame, and the handler's result comes back (CommandRegistry.execute takes no
	 *  arguments, so only the workbench's own commands go through it). */
	private async executeCommand(id: string, args: unknown[]): Promise<unknown> {
		const entry = commandsRegistered.get(id);
		if (entry) return await this.callFrame(entry.handle, 'runCommand', [id, args]);
		return await commands.execute(id);
	}

	/** Run a command an extension registered: the handler lives in its frame. */
	private async runRegistered(id: string, args: unknown[] = []): Promise<void> {
		const entry = commandsRegistered.get(id);
		if (entry) await this.callFrame(entry.handle, 'runCommand', [id, args]);
	}

	private callFrame(handle: FrameHandle, method: string, args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextCallId++;
			const send = (handle as FrameHandle & { send?: (m: unknown) => void }).send;
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
