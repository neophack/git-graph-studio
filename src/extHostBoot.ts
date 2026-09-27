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

import { activationContext, createVscodeApi, Disposable, readLocalDocProvider, rehydrateUris, serveHostCall, setUriPlatform, shimLog, UNSERVED_HOST_CALL, Uri, type HostContext, type VscodeApi } from './vscodeApi';
import { setShimFailureReporter } from './nodeShims/shared';
import { createNodeRequire, type NodeEnv } from './extModuleLoader';
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
	/** Binary files the package reads with `fs.readFileSync` (`.wasm` payloads),
	 *  base64-encoded, keyed package-relative. */
	blobs?: Record<string, string>;
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

/** The subscribers to the host's child-process events (one per live spawn): the main
 *  window's Channel callback crosses back as `__studioExtHostEvent` pushes. */
const childEventHandlers = new Set<(message: { handle: number; event: string; data?: string; code?: number | null }) => void>();

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

/** The text-document content providers the extension's shim parked (they stay in the
 *  frame): the host's `vscode.open` / `vscode.diff` of a provider-scheme Uri calls back
 *  into the scheme's provider for the text. */
const docProviders = new Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>();

function handleCall(method: string, args: unknown[]): unknown {
	if (method === 'runCommand') {
		const handler = registered.get(args[0] as string);
		if (!handler) throw new Error(`command ${args[0]} is no longer registered`);
		// The workbench dispatches a menu's context as Uri-shaped data (the methods cannot
		// cross the clone); the handler receives them as full Uris, as VS Code delivers.
		return handler(...(rehydrateUris((args[1] as unknown[] | undefined) ?? []) as unknown[]));
	}
	if (method === 'docProvider.provide') {
		const provider = docProviders.get(String((args[0] as { scheme?: unknown } | undefined)?.scheme ?? ''));
		if (!provider) throw new Error('no content provider registered for the scheme');
		return provider.provideTextDocumentContent?.(args[0]);
	}
	if (method === 'deactivate') {
		module_?.exports.deactivate?.();
		return undefined;
	}
	// Tree views, the formatter run and webview views: the shared host-call table.
	const served = serveHostCall(api_, method, args);
	if (served !== UNSERVED_HOST_CALL) return served;
	throw new Error(`unknown extension host call: ${method}`);
}

let module_: { exports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } } | null = null;
/** The shim of the extension that booted (null until `__studioExtInit` lands). */
let api_: VscodeApi | null = null;

for (const level of ['log', 'info', 'warn', 'error'] as const) {
	const original = console[level].bind(console);
	console[level] = (...args: unknown[]) => {
		original(...args);
		const text = args.map((a) => String(a)).join(' ');
		// Host-side logs ([frame-log]/[compat-msg]/[ggs-ext]) re-enter this wrapper under a
		// shared console (the jsdom tests host frame and workbench on one window) — without
		// this guard they mirror each other forever.
		if (text.startsWith('[ext-host]') || text.startsWith('[frame-log]') || text.startsWith('[compat-msg]') || text.startsWith('[ggs-ext]') || text.startsWith('[compat-test]')) return;
		try {
			parent.postMessage({ type: '__studioExtBootLog', level, text: text.slice(0, 400) }, '*');
		} catch { /* logging must never throw */ }
	};
}
window.addEventListener('message', (event) => {
	const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown; context?: HostContext; code?: string; event?: string; kind?: string; message?: { handle: number; event: string; data?: string; code?: number | null } };
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
	// A child-process event of the frame's own spawned tools (stdout/stderr chunk, exit):
	// routed to the handle's subscriber inside the child_process shim.
	if (data.type === '__studioExtHostEvent' && data.kind === 'childProcess') {
		const message = data.message;
		if (message && typeof message.handle === 'number') {
			for (const handler of [...childEventHandlers]) handler(message);
		}
		return;
	}
	if (data.type === '__studioExtInit') {
		boot(data as InitMessage);
	}
});

function boot(message: InitMessage): void {
	// The platform spells every `Uri.fsPath` from here on — pinned before the first Uri.
	const platform = message.context.platform ?? message.nodeEnv?.platform;
	setUriPlatform(platform);
	const context: HostContext = {
		...message.context,
		platform,
		workspaceFolders: message.context.workspaceFolders.map((folder) => ({ ...folder, uri: Uri.file(folder.uri.fsPath || folder.uri.path) }))
	};
	// The package's own manifest, parsed here for `context.extension.packageJSON` — the
	// host message carries only the code map, and the entry choice already reads this text.
	if (message.files !== undefined && context.packageJSON === undefined) {
		try {
			context.packageJSON = JSON.parse(message.files['package.json'] ?? '{}') as Record<string, unknown>;
		} catch {
			context.packageJSON = {};
		}
	}
	const api = createVscodeApi(context, {
		request: hostRequest,
		registerCommandHandler: (id, handler) => registered.set(id, handler),
		registerDocProvider: (scheme, provider) => docProviders.set(scheme, provider),
		unregisterDocProvider: (scheme) => docProviders.delete(scheme),
		// The frame's own registration answers locally — one postMessage round-trip fewer
		// for the common case, on the same contract the process hosts serve.
		readDocProvider: (uri) => readLocalDocProvider(docProviders, uri)
	});
	api_ = api;
	// A Node surface the frame cannot serve (a sync spawn, a socket) is logged before it
	// throws — a package that catches the error and carries on still leaves the trace.
	setShimFailureReporter((text, level = 'warn') => shimLog(level, text));
	// The Node compatibility layer: the code map (the host's preload, or this message's
	// bare entry code standing in for it), the builtin shims over it, and the globals
	// extension code assumes (`process`, `Buffer`, `global`, `setImmediate`).
	const files = message.files ?? (message.code !== undefined ? { 'extension.js': message.code } : {});
	const binaries = message.binaries ?? [];
	const nodeEnv: NodeEnv = message.nodeEnv ?? {
		platform: 'win32', arch: 'x64', homedir: '', tmpdir: '', hostname: 'studio',
		release: '', eol: '\r\n', separator: '\\', delimiter: ';'
	};
	const shimHost = {
		nodeEnv, extensionPath: context.extensionPath, files, binaries: message.binaries ?? [],
		blobs: message.blobs ?? {},
		bridge: {
			request: hostRequest,
			onChildEvent: (handler: (message: { handle: number; event: string; data?: string; code?: number | null }) => void) => {
				childEventHandlers.add(handler);
				return () => childEventHandlers.delete(handler);
			}
		}
	};
	const builtins = createNodeBuiltins(shimHost);
	const { require, runEntry } = createNodeRequire({
		files,
		truncated: message.truncated ?? false,
		extensionPath: context.extensionPath,
		vscode: api,
		builtin: (id) => (id in builtins ? builtins[id] : undefined)
	});
	installNodeGlobals(shimHost, builtins, require);
	// The stack crosses with the message: a foreign package's activation failure is
	// diagnosable only with the frames between its entry and the throwing line.
	const failure = (error: unknown) => parent.postMessage({
		type: '__studioExtActivateFailed',
		extensionId: context.extensionId,
		error: String(error),
		stack: error instanceof Error ? (error.stack ?? null) : null
	}, '*');
	try {
		// The entry the manifest names (`main`), resolved the way `require()` resolves it:
		// extensionless spellings gain `.js`, directories resolve through their package.json
		// or index files. A bare `code` message (no map, no manifest) runs as 'extension.js'.
		// An ESM main (`"type": "module"`) cannot run through the CommonJS wrapper; when the
		// packager shipped a string `browser` bundle — its own answer to a host with no
		// Node — that bundle runs instead, the same art VS Code's web host executes.
		const pkg = files['package.json'] !== undefined ? JSON.parse(files['package.json']) as { main?: string; browser?: string | Record<string, string>; type?: string } : {};
		const esmMain = pkg.type === 'module';
		const main = message.files !== undefined
			? ((esmMain && typeof pkg.browser === 'string' && pkg.browser !== '' ? pkg.browser : (pkg.main ?? 'extension.js')))
			: 'extension.js';
		module_ = runEntry(main) as { exports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } };
		Promise.resolve(module_.exports.activate?.(activationContext(context, api))).then(
			() => parent.postMessage({ type: '__studioExtActivated', extensionId: context.extensionId }, '*'),
			failure
		);
	} catch (error) {
		failure(error);
	}
}

// Tell the main window the frame is ready to receive an extension.
parent.postMessage({ type: '__studioExtReady' }, '*');
