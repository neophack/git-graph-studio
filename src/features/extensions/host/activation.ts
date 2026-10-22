import type { ActivationPolicy } from './sharedTypes';
// Activation: the boot pass, activation policies (implicit onLanguage), contributions registration, reload/deactivate and the activation environment.

import { commandsRegistered, unregisterCommand } from './dispatch';
import { FrameHandle } from './sharedTypes';
import { cachedNodeEnv } from './hostRequests';
import { extAssetBase, extHostFrameUrl } from './pages';
import { extTitle } from './store';
import { ExtensionHost } from './extensionHost';

import { type ExtInfo, extLoadCode, extReadFile, extStoragePaths } from '../../../platform/ipc/ext';
import { extNodeRuntime, extProcessStart, extProcessStop } from '../../../platform/ipc/extProcess';
import { extFs } from '../../../platform/ipc/ext';
import { applyContributions, extensionSettingDefs, extensionThemeList, localize, registerContextProvider, registerExtensionSnippets, registerExtensionThemes, removeContributions, type ExtensionThemeDef, type ManifestContributes } from '../contributions';
import { extLog, extLogLevel } from '../extLog';
import { settings as appSettings, syncExtensionThemes, themeById } from '../../../platform/settings';
import { locale, registerZhCnText, t, tf } from '../../../platform/i18n';
import * as state from '../../../platform/state';
import { notify } from '../../../platform/ui/index';
import { forgetExtDataUrls } from '../../../platform/extAssets';
import { hook } from '../../../platform/hooks';

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
 *  survives a `script-src 'nonce-…'` policy the package shipped. It also pins
 *  `globalThis._VSCODE_FILE_ROOT` to the extension's asset base before any page script
 *  runs — the root monaco-vscode-api bundles (claude-code's webview) resolve their
 *  language-worker module ids against; VS Code's host defines it, and without it the
 *  loader's ESM path falls into its AMD branch and dies reading `require.toUrl` of
 *  undefined. */

/** The activation concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const activationMethods: ThisType<ExtensionHost> = {
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
		this.nodeHostExe = await extNodeRuntime().catch(() => null);
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
		// A remote page also mirrors the lazy backend packages the desktop window already
		// woke (their activation ran there): an empty journal means nothing runs yet.
		if (hook('session').frontendClass() === 'remote') {
			const lazy = installed.filter((ext) => this.backendHosted(ext.id) && !toActivate.includes(ext));
			await Promise.all(lazy.map((ext) => this.replayRegistrations(ext.id)));
		}
		this.onContributionsApplied?.();
		this.onViewsChanged?.();
	},

	async applyContributions(ext: ExtInfo): Promise<void> {
		let manifest: { contributes?: ManifestContributes; activationEvents?: string[]; main?: string } | null = null;
		let nls: Record<string, string> = {};
		let nlsZhCn: Record<string, string> = {};
		try {
			manifest = JSON.parse(await extReadFile(ext.id, 'package.json')) as { contributes?: ManifestContributes; activationEvents?: string[] };
			const localization = await extReadFile(ext.id, 'package.nls.json').catch(() => null);
			if (localization) nls = JSON.parse(localization) as Record<string, string>;
			const zhCn = await extReadFile(ext.id, 'package.nls.zh-cn.json').catch(() => null);
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
	},

	async loadContributionFiles(extId: string, contributes: ManifestContributes | undefined): Promise<void> {
		const snippetFiles: { language: string; text: string }[] = [];
		for (const declared of contributes?.snippets ?? []) {
			try {
				snippetFiles.push({ language: declared.language, text: await extReadFile(extId, declared.path) });
			} catch {
				// Unreadable snippet file: skip it, keep the rest.
			}
		}
		registerExtensionSnippets(extId, snippetFiles);
		const themes: ExtensionThemeDef[] = [];
		for (const declared of contributes?.themes ?? []) {
			try {
				const parsed = JSON.parse(await extReadFile(extId, declared.path)) as {
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
	},

	registerContributions(extId: string, contributes: ManifestContributes | null | undefined, nls: Record<string, string>, nlsZhCn: Record<string, string> = {}): void {
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
	},

	async reload(extId: string): Promise<void> {
			this.deactivate(extId);
		removeContributions(extId);
		// The package's own files may all have changed with the version: the cached icon
		// data URLs follow the new install, never the retired bytes.
		forgetExtDataUrls(extId);
		// An upgraded process package restarts fresh: the old backend does not survive it.
		await extProcessStop(extId).catch(() => undefined);
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
			await extProcessStart(extId).catch((error) => {
				extLog('error', extId, `backend failed to start: ${String(error)}`, error);
				notify('error', tf('extensions.backendStartFailed', extId, String(error)), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
			});
		}
		// The install (or upgrade) may have changed what the workbench shows of it — the
		// activity-bar launcher above all, which the boot pass renders once and a mid-session
		// install would otherwise never surface.
		this.onViewsChanged?.();
	},

	async activate(ext: ExtInfo): Promise<void> {
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
			const manifest = JSON.parse(await extReadFile(ext.id, 'package.json')) as { main?: string };
			main = (manifest.main ?? 'extension.js').replace(/^\.\//, '');
			const bundle = await extLoadCode(ext.id);
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
	},

	deactivate(extId: string): void {		const handle = this.frames.get(extId);
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
		// An outstanding withProgress toast belongs to this frame — its `progress.end`
		// will never arrive now, and a spinning notification must not outlive it.
		for (const [id, record] of [...this.progress]) {
			if (record.extId === extId) {
				record.toast.done();
				this.progress.delete(id);
			}
		}
		for (const [key, registration] of [...this.completionProviders]) {
			if (registration.extId === extId) this.completionProviders.delete(key);
		}
		for (const [key, registration] of [...this.hoverProviders]) {
			if (registration.extId === extId) this.hoverProviders.delete(key);
		}
		if ([...this.fileDecorationProviders.keys()].some((key) => key.startsWith(`${extId}/`))) {
			for (const key of [...this.fileDecorationProviders.keys()]) {
				if (key.startsWith(`${extId}/`)) this.fileDecorationProviders.delete(key);
			}
			this.extensionDecorations = this.extensionDecorations.filter((entry) => !entry.key.startsWith(`${extId}/`));
			this.onFileDecorationsChanged?.();
		}
		for (const [key, registration] of [...this.definitionProviders]) {
			if (registration.extId === extId) this.definitionProviders.delete(key);
		}
		// The frame's decoration marks leave the editors with it.
		for (const key of this.decorTypesByExt.get(extId) ?? []) this.onSetDecorations?.(null, key, []);
		this.decorTypesByExt.delete(extId);
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
	},

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
	},

	reportActivationFailure(extId: string, error: string, stack?: string | null): void {
		extLog('error', extId, `activation failed: ${error}`, stack ?? undefined);
		notify('warning', tf('extensions.activationFailed', extId, error), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
	},

	checkDependencies(ext: ExtInfo): void {
		if (this.dependencyWarned.has(ext.id)) return;
		const installed = new Set(this.installedExts.filter((entry) => entry.format !== 'bundled').map((entry) => entry.id.toLowerCase()));
		// VS Code's own built-in extensions (`vscode.*`) have no install to find.
		const missing = (ext.extensionDependencies ?? []).filter((dep) => !dep.toLowerCase().startsWith('vscode.') && !installed.has(dep.toLowerCase()));
		if (missing.length === 0) return;
		this.dependencyWarned.add(ext.id);
		extLog('warn', ext.id, `missing extension dependencies: ${missing.join(', ')}`);
		notify('warning', tf('extensions.dependencyMissing', extTitle(ext), missing.join(', ')), [{ label: t('extensions.showLog'), run: () => this.showLog() }]);
	},

	async extensionEnv(extId: string): Promise<Record<string, unknown>> {
		const ext = this.installedExts.find((candidate) => candidate.id === extId);
		const defaults: Record<string, unknown> = coreConfigurationDefaults();
		for (const def of extensionSettingDefs()) defaults[def.id] = def.default;
		const storage = await extStoragePaths(extId, ExtensionHost.workspaceFolders[0] ?? null)
			.catch((error) => {
				extLog('warn', extId, `storage directories unavailable (the install directory stands in): ${String(error)}`);
				return null;
			});
		if (storage) this.storageRoots.set(extId, [storage.global, storage.log, ...(storage.workspace ? [storage.workspace] : [])]);
		const env = await cachedNodeEnv();
		// Every env answer is a new activation of the extension (a process's `host.env`, a
		// frame's init): the panels still on record were the previous process's. They keep
		// their tabs — the fresh process may replace them in place through `tabGroups` (Git
		// Graph does) — so its own panels are numbered past them, never onto their ids.
		this.webviewGenerations.set(extId, (this.webviewGenerations.get(extId) ?? 0) + 1);
		let webviewPanelBase = 0;
		for (const view of this.webviews.values()) {
			if (view.extId === extId) webviewPanelBase = Math.max(webviewPanelBase, view.panelId);
		}
		return {
			tabs: this.tabGroupsSnapshot(),
			webviewPanelBase,
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
	},

	async matchesWorkspaceContains(patterns: string[]): Promise<boolean> {
		const roots = ExtensionHost.workspaceFolders;
		if (patterns.length === 0 || roots.length === 0) return false;
		for (const pattern of patterns) {
			try {
				const found = (await extFs(/[*?]/.test(pattern) ? 'find' : 'exists', roots, pattern)) as string[];
				if (found.length > 0) return true;
			} catch {
				// The path (or the backend answer) is unavailable: this pattern cannot match.
			}
		}
		return false;
	},
};
