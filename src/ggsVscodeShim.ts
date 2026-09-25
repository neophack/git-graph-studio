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

import { activationContext, createVscodeApi, rehydrateUris, Uri, type HostBridge, type HostContext, type VscodeApi } from './vscodeApi';

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
	const env = (hostRequest('host.env', []) ?? {}) as {
		settings?: Record<string, unknown>;
		language?: string;
		appVersion?: string;
		themeKind?: number;
		webviewResourceBase?: string;
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
		state: { global: { ...(env.state?.global ?? {}) }, workspace: { ...(env.state?.workspace ?? {}) } }
	};
	const handlers = new Map<string, (...callArgs: unknown[]) => unknown>();
	const docProviders = new Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>();
	const bridge: HostBridge = {
		request: (method, requestArgs) => Promise.resolve(hostRequest(method, requestArgs as unknown[])),
		registerCommandHandler: (id, handler) => {
			handlers.set(id, handler);
			// The runtime's dispatch consults `ggs.onRequest` before the exports-dispatch
			// fallback: one dispatcher, reading the same map the frame's mailbox would.
			shim.ggs.onRequest((command, commandArgs) => {
				const handler = handlers.get(command);
				if (!handler) throw new Error(`no handler registered for ${command}`);
				// A menu's context crosses the line as Uri-shaped data; the handler receives
				// full Uris, the argument shape VS Code's own command dispatch guarantees.
				const result = handler(...(rehydrateUris(Array.isArray(commandArgs) ? commandArgs : [commandArgs]) as unknown[]));
				void result;
			});
		},
		registerDocProvider: (scheme, provider) => docProviders.set(scheme, provider),
		unregisterDocProvider: (scheme) => docProviders.delete(scheme)
	};
	const api = createVscodeApi(context, bridge);
	shim.vscode = api;
	return {
		api,
		activate: (moduleExports) => Promise.resolve(moduleExports?.activate?.(activationContext(context, api)))
	};
};
