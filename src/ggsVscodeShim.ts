// The `vscode` shim bundle for the pretend Node runtime (`ggs-node`, Boa). Compiled by
// prepare.mjs to `vscode-shim.cjs` (an IIFE assigning `__ggsVscodeShim`), evaluated by
// ggs-node at bootstrap when the package's entry turns out to be a frame program — a real
// VS Code extension `main` that `require`s `vscode`. This is ggs-node hosting the
// package's own program: the same shim the frames and the real-Node host use,
// over a blocking host-request bridge (`__ggsHostRequest`, a Rust native on globalThis
// that writes one `ggs.hostRequest` line and waits for the workbench's answer).
//
// Blocking is correct here, not lazy: the JS thread is single-threaded (Boa), the workbench
// answers over the reader thread, and the extension's own activation is sequential by
// nature. Data crosses as JSON strings at the bridge; everything inside is typed objects.

import { activationContext, createVscodeApi, readLocalDocProvider, rehydrateUris, serveHostCall, UNSERVED_HOST_CALL, Uri, type HostBridge, type HostContext, type VscodeApi } from './vscodeApi';
import { probeVscodeNamespace } from './vscodeNamespaceProbe';

interface ShimGlobal {
	__ggsHostRequest: (method: string, argsJson: string) => string | null;
	ggs: { onRequest: (handler: (command: string, args: unknown[]) => void) => void };
	vscode?: unknown;
	__ggsVscodeShimInstall?: (args: InstallArgs) => InstalledVscode;
}

interface InstallArgs {
	extensionId: string;
	extensionPath: string;
	workspaceFolders?: string[];
}

interface InstalledVscode {
	/** The shim's `vscode` module — stored where `require('vscode')` and the host-event
	 *  pushes (`handleHostEvent`) reach it. */
	api: HostContext extends never ? never : VscodeApi;
	activate: (moduleExports: { activate?: (context: unknown) => unknown }) => Promise<unknown>;
}

const shim = globalThis as unknown as ShimGlobal;

shim.__ggsVscodeShimInstall = function (args: InstallArgs): InstalledVscode {
	const hostRequest = (method: string, requestArgs: unknown[]): unknown => {
		const raw = shim.__ggsHostRequest(method, JSON.stringify(requestArgs ?? []));
		return raw === null || raw === undefined ? null : JSON.parse(raw);
	};
	const env = (hostRequest('host.env', []) ?? {}) as Partial<HostContext> & {
		settings?: Record<string, unknown>;
		state?: { global: Record<string, unknown>; workspace: Record<string, unknown> };
	};
	const context: HostContext = {
		extensionId: args.extensionId,
		extensionPath: args.extensionPath,
		workspaceFolders: (args.workspaceFolders ?? []).map((uri, index) => ({ uri: Uri.file(uri), name: uri.split(/[\\/]/).pop() ?? uri, index })),
		settings: { ...(env.settings ?? {}) },
		language: env.language ?? 'en',
		appVersion: env.appVersion,
		themeKind: env.themeKind,
		webviewResourceBase: env.webviewResourceBase ?? `ggs://localhost/${args.extensionId}/`,
		state: { global: { ...(env.state?.global ?? {}) }, workspace: { ...(env.state?.workspace ?? {}) } },
		// The same context extras the frame host gets (defaults, ~/.ggs storage, the
		// installed list, the log threshold, the platform the host runs on).
		defaults: env.defaults,
		storage: env.storage,
		extensions: env.extensions,
		logLevel: env.logLevel,
		platform: env.platform
	};
	const handlers = new Map<string, (...callArgs: unknown[]) => unknown>();
	const docProviders = new Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>();
	const fsProviders = new Map<string, { readFile?: (uri: unknown) => unknown }>();
	/** The runtime's dispatch consults `ggs.onRequest` before the exports-dispatch
	 *  fallback: one dispatcher for the host-call vocabulary — registered commands, and a
	 *  content provider's text the host asks for when a diff or a read-only content tab
	 *  renders a provider-scheme document. The maps it reads are shared, so every
	 *  registration (re)installing this same function stays one live dispatcher. */
	let installed: VscodeApi | null = null;
	const dispatchHostCall = (command: string, commandArgs: unknown[]) => {
		// Tree views, the formatter run and webview views: the shared host-call table (a
		// ggs-node-hosted package's sidebar trees answered nothing before).
		const served = serveHostCall(installed, command, Array.isArray(commandArgs) ? commandArgs : [commandArgs]);
		if (served !== UNSERVED_HOST_CALL) return served;
		if (command === 'docProvider.provide') {
			// The host asks this extension for a provider-scheme document's text. The
			// provider is found by the Uri's scheme - the key it registered under.
			const [uri] = rehydrateUris(Array.isArray(commandArgs) ? commandArgs : [commandArgs]) as [{ scheme?: string }];
			const provider = docProviders.get(String(uri?.scheme ?? ''));
			if (!provider?.provideTextDocumentContent) {
				throw new Error(`no text-document content provider is registered for the ${uri?.scheme} scheme`);
			}
			return provider.provideTextDocumentContent(uri);
		}
		if (command === 'fsProvider.read') {
			// The host asks this extension for a file-system scheme's text (claude-code's
			// change-review diff sides). The answer crosses as a plain string, a thenable
			// settled by the runtime's dispatch.
			const [uri] = rehydrateUris(Array.isArray(commandArgs) ? commandArgs : [commandArgs]) as [{ scheme?: string }];
			const text = readLocalDocProvider(new Map(), uri as never, fsProviders);
			if (text === null) throw new Error(`no file-system provider is registered for the ${uri?.scheme} scheme`);
			return text;
		}
		const handler = handlers.get(command);
		if (!handler) throw new Error(`no handler registered for ${command}`);
		// The wire this call crossed is JSON at both hops (the workbench's invoke, the
		// ggs-ext/1 line), and JSON has no undefined: a placeholder argument the caller
		// passed — the host's `executeCommand('id', sessionId, undefined, …)`, or
		// claude-code's own `void 0` slots — lands here as null, and handlers
		// distinguish (`viewColumn !== void 0` decides whether to compute the column;
		// claude-code's editor.open threw on a null one). A real null argument is not a
		// shape VS Code commands take, so null arrives as the undefined the caller
		// passed — the argument shape VS Code's own dispatch guarantees. Top level only:
		// a null inside an object is data. (Frames keep theirs without this —
		// postMessage's structured clone carries undefined.)
		const wireArgs = (Array.isArray(commandArgs) ? commandArgs : [commandArgs]).map((value) => (value === null ? undefined : value));
		// A menu's context crosses the line as Uri-shaped data; the handler receives full
		// Uris, the argument shape VS Code's own command dispatch guarantees. The result
		// returns — the runtime's dispatch settles it into the runCommand answer, a
		// thenable included (an async handler's value waits, as in a frame).
		return handler(...(rehydrateUris(wireArgs) as unknown[]));
	};
	const bridge: HostBridge = {
		request: (method, requestArgs) => Promise.resolve(hostRequest(method, requestArgs as unknown[])),
		registerCommandHandler: (id, handler) => {
			handlers.set(id, handler);
			shim.ggs.onRequest(dispatchHostCall);
		},
		registerDocProvider: (scheme, provider) => {
			docProviders.set(scheme, provider);
			shim.ggs.onRequest(dispatchHostCall);
		},
		unregisterDocProvider: (scheme) => docProviders.delete(scheme),
		registerFsProvider: (scheme, provider) => {
			fsProviders.set(scheme, provider);
			shim.ggs.onRequest(dispatchHostCall);
		},
		unregisterFsProvider: (scheme) => fsProviders.delete(scheme),
		// The local answer: this process registered the scheme, so its text never crosses
		// the blocking bridge — the host's `docProvider.read` round-trip would call back
		// into this same parked JS thread and deadlock it for the full host-request
		// timeout (the `vscode.diff` reentry class). The fs-provider schemes answer the
		// same way — claude-code's diff sides live in this process's memory.
		readDocProvider: (uri) => readLocalDocProvider(docProviders, uri, fsProviders)
	};
	// The raw namespace serves the host-call dispatch (its internal `__`-members are the
	// shim's own wiring); the package-facing one carries the upgrade-safety probe — an
	// absent member logs its name instead of failing silently deep in the bundle (see
	// vscodeNamespaceProbe.ts). Values are identical either way.
	const raw = createVscodeApi(context, bridge);
	installed = raw;
	const api = probeVscodeNamespace(raw);
	shim.vscode = api;
	// The dispatcher installs eagerly: a package that registers only a content provider -
	// never a command - must still answer the host's provide call.
	shim.ggs.onRequest(dispatchHostCall);
	return {
		api,
		activate: (moduleExports) => Promise.resolve(moduleExports?.activate?.(activationContext(context, api)))
	};
};
