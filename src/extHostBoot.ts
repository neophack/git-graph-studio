// Runs inside the sandboxed extension host frame (ext-host.html). Loads one extension's
// compiled entry point the way VS Code's Node extension host does: a CommonJS `require`
// over the package's whole loadable surface (the code map the host preloaded at
// activation), with the Node builtins shimmed (nodeShims.ts) and `require('vscode')`
// answering the API shim - then calls its `activate` export.
//
// A package whose `main` is one self-contained bundle loads exactly as before; a package
// compiled as many files, or carrying a `node_modules`, loads through the same resolver.
// A `require` the map cannot answer fails with Node's own MODULE_NOT_FOUND shape.
//
// Two message channels connect the frame with the main window (src/extHost.ts):
//   Rpc  (frame -> host): host services - the command registry, notifications, settings.
//   Call (host -> frame): running a command handler the extension registered, deactivate,
//                         tree view walks, webview view resolutions.

import { createVscodeApi, Disposable, Uri, type HostContext, type VscodeApi } from './vscodeApi';
import { createNativeModule, createNodeRequire, type NodeEnv } from './extModuleLoader';
import { createNodeBuiltins, installNodeGlobals } from './nodeShims';

/** The context as it actually crosses `postMessage`: `workspaceFolders[].uri` is bare data
 *  (no `toString`) since a function there fails the structured clone - `boot()` rebuilds
 *  each into a real `Uri` once received, the same way `extensionUri` is built below. */
type WireHostContext = Omit<HostContext, 'workspaceFolders'> & {
	workspaceFolders: { uri: { scheme: string; path: string; fsPath: string }; name: string; index: number }[];
};

interface InitMessage {
	type: '__studioExtInit';
	context: WireHostContext;
	/** The extension's compiled entry point (its `main`), as text - the shape a host that
	 *  preloaded no code map sends (the jsdom tests, a host behind an older bridge). */
	code?: string;
	/** The package's whole loadable surface (`ext_load_code`): package-relative paths ->
	 *  text. Every `require` resolves against it. */
	files?: Record<string, string>;
	/** The package's binary native modules (`.node`), as package-relative paths — a
	 *  `require` of one answers the host-served native proxy. */
	binaries?: string[];
	/** `true` when the code map hit its bounds - a require beyond it fails naming this. */
	truncated?: boolean;
	/** The Node environment facts (`ext_node_env`): platform words, home and temp dirs. */
	nodeEnv?: NodeEnv;
}

interface RpcRequest {
	type: '__studioExtRpc';
	id: number;
	method: string;
	args: unknown[];
}

interface RpcResponse {
	type: '__studioExtRpcResult';
	id: number;
	ok: boolean;
	result: unknown;
}

interface CallRequest {
	type: '__studioExtCall';
	id: number;
	method: string;
	args: unknown[];
}

interface CallResponse {
	type: '__studioExtCallResult';
	id: number;
	ok: boolean;
	result: unknown;
}

let nextRpcId = 1;
const pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

/** A request to the main window (host services: commands, notifications, settings, ...). */
function hostRequest(method: string, args: unknown[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const id = nextRpcId++;
		pendingRpc.set(id, { resolve, reject });
		parent.postMessage({ type: '__studioExtRpc', id, method, args } satisfies RpcRequest, '*');
	});
}

/** The command handlers the extension's shim registered (the handlers stay in the frame). */
const registered = new Map<string, (...args: unknown[]) => unknown>();

function handleCall(method: string, args: unknown[]): unknown {
	if (method === 'runCommand') {
		const handler = registered.get(args[0] as string);
		if (!handler) throw new Error(`command ${args[0]} is no longer registered`);
		return handler(...((args[1] as unknown[] | undefined) ?? []));
	}
	if (method === 'deactivate') {
		module_?.exports.deactivate?.();
		return undefined;
	}
	// The tree views: one level's children (serialized in-frame through getTreeItem), and
	// the visibility pushes the sidebar's view switching produces.
	if (method === 'tree.getChildren') return api_?.__serveTree.children(args[0] as string, args[1] as string | null) ?? [];
	if (method === 'treeView.setVisible') {
		api_?.__serveTree.setVisible(args[0] as string, args[1] as boolean);
		return undefined;
	}
	// A webview view's first visibility: its provider's resolveWebviewView runs here, the
	// way VS Code defers resolution to the view's first show.
	if (method === 'webviewView.resolve') return api_?.__serveWebviewView.resolve(args[0] as string);
	if (method === 'webviewView.setVisible') {
		api_?.__serveWebviewView.setVisible(args[0] as string, args[1] as boolean);
		return undefined;
	}
	throw new Error(`unknown extension host call: ${method}`);
}

let module_: { exports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } } | null = null;
/** The shim of the extension that booted (null until `__studioExtInit` lands). */
let api_: VscodeApi | null = null;

window.addEventListener('message', (event) => {
	const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown; context?: HostContext; code?: string; event?: string };
	if (!data || typeof data !== 'object') return;
	if (data.type === '__studioExtRpcResult') {
		const id = data.id as number;
		const pending = pendingRpc.get(id);
		if (!pending) return;
		pendingRpc.delete(id);
		if (data.ok) pending.resolve(data.result);
		else pending.reject(data.result);
		return;
	}
	if (data.type === '__studioExtCall') {
		const message = data as unknown as CallRequest;
		try {
			const result = handleCall(message.method, message.args);
			Promise.resolve(result).then(
				(value) => parent.postMessage({ type: '__studioExtCallResult', id: message.id, ok: true, result: value } satisfies CallResponse, '*'),
				(error) => parent.postMessage({ type: '__studioExtCallResult', id: message.id, ok: false, result: String(error) } satisfies CallResponse, '*')
			);
		} catch (error) {
			parent.postMessage({ type: '__studioExtCallResult', id: message.id, ok: false, result: String(error) } satisfies CallResponse, '*');
		}
		return;
	}
	// An event the host pushed in (configuration change, webview message, disposal) — the
	// single listener routes it into the shim, which owns the emitters.
	if (data.type === '__studioExtEvent' && typeof data.event === 'string') {
		api_?.handleHostEvent(data as Parameters<NonNullable<typeof api_>['handleHostEvent']>[0]);
		return;
	}
	if (data.type === '__studioExtInit') boot(data as InitMessage);
});

function boot(message: InitMessage): void {
	const context: HostContext = {
		...message.context,
		workspaceFolders: message.context.workspaceFolders.map((folder) => ({ ...folder, uri: Uri.file(folder.uri.path) }))
	};
	const api = createVscodeApi(context, {
		request: hostRequest,
		registerCommandHandler: (id, handler) => registered.set(id, handler)
	});
	api_ = api;
	// The Node compatibility layer: the code map (the host's preload, or this message's
	// bare entry code standing in for it), the builtin shims over it, and the globals
	// extension code assumes (`process`, `Buffer`, `global`, `setImmediate`).
	const files = message.files ?? (message.code !== undefined ? { 'extension.js': message.code } : {});
	const binaries = message.binaries ?? [];
	const nodeEnv: NodeEnv = message.nodeEnv ?? {
		platform: 'win32', arch: 'x64', homedir: '', tmpdir: '', hostname: 'studio',
		release: '', eol: '\r\n', separator: '\\', delimiter: ';'
	};
	const shimHost = { nodeEnv, extensionPath: context.extensionPath, files, binaries, bridge: { request: hostRequest } };
	const builtins = createNodeBuiltins(shimHost);
	const { require, runEntry } = createNodeRequire({
		files,
		binaries,
		truncated: message.truncated ?? false,
		extensionPath: context.extensionPath,
		vscode: api,
		builtin: (id) => (id in builtins ? builtins[id] : undefined),
		// The host-served native module of one `.node`: every call crosses as
		// `native.call(path, method, args)`, which the host forwards to the package's
		// backend — the process that loaded the binary.
		native: (rel) => createNativeModule(rel, (method, args) => hostRequest('native.call', [rel, method, args]))
	});
	installNodeGlobals(shimHost, builtins, require);
	try {
		// The entry the manifest names (`main`), resolved the way `require()` resolves it:
		// extensionless spellings gain `.js`, directories resolve through their package.json
		// or index files. A bare `code` message (no map, no manifest) runs as 'extension.js'.
		const pkg = files['package.json'] !== undefined ? JSON.parse(files['package.json']) as { main?: string } : {};
		const main = message.files !== undefined ? (pkg.main ?? 'extension.js') : 'extension.js';
		module_ = runEntry(main) as { exports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } };
		Promise.resolve(module_.exports.activate?.(activationContext(context, api))).then(
			() => parent.postMessage({ type: '__studioExtActivated', extensionId: context.extensionId }, '*'),
			(error) => parent.postMessage({ type: '__studioExtActivateFailed', extensionId: context.extensionId, error: String(error) }, '*')
		);
	} catch (error) {
		parent.postMessage({ type: '__studioExtActivateFailed', extensionId: context.extensionId, error: String(error) }, '*');
	}
}

/** The ExtensionContext VS Code hands to activate(): the mementos are the shim's persisted
 *  ones (`globalState` survives restarts, `workspaceState` per install), and `extension` is
 *  the extension's own API entry, as `vscode.extensions.getExtension(id)` reports it. */
function activationContext(context: HostContext, api: VscodeApi): Record<string, unknown> {
	return {
		subscriptions: [] as Disposable[],
		extensionPath: context.extensionPath,
		extensionUri: { scheme: 'file', path: context.extensionPath, fsPath: context.extensionPath, toString: () => 'file:' + context.extensionPath },
		globalState: api.__mementos.global,
		workspaceState: api.__mementos.workspace,
		storagePath: context.extensionPath,
		globalStoragePath: context.extensionPath,
		globalStorageUri: { scheme: 'file', path: context.extensionPath, fsPath: context.extensionPath, toString: () => 'file:' + context.extensionPath },
		storageUri: { scheme: 'file', path: context.extensionPath, fsPath: context.extensionPath, toString: () => 'file:' + context.extensionPath },
		logUri: { scheme: 'file', path: context.extensionPath, fsPath: context.extensionPath, toString: () => 'file:' + context.extensionPath },
		logPath: context.extensionPath,
		extensionMode: 3, // ExtensionMode.Production — the frame host has no dev mode
		asAbsolutePath: (relative: string) => context.extensionPath + '/' + relative,
		environmentVariableCollection: undefined,
		outputChannel: { append: () => undefined, appendLine: () => undefined, show: () => undefined, dispose: () => undefined }
	};
}

// Tell the main window the frame is ready to receive an extension.
parent.postMessage({ type: '__studioExtReady' }, '*');
