// Runs inside the sandboxed extension host frame (ext-host.html). Loads one extension's
// compiled entry point as a CommonJS module - the shape `vsce` packages - with `require`
// limited to the `vscode` API shim, then calls its `activate` export.
//
// Studio only runs extensions whose `main` is a self-contained bundle: a synchronous
// `require` of another file cannot cross the frame boundary, so it fails with a clear error.
//
// Two message channels connect the frame with the main window (src/extHost.ts):
//   Rpc  (frame -> host): host services - the command registry, notifications, settings.
//   Call (host -> frame): running a command handler the extension registered, deactivate.

import { createVscodeApi, Disposable, type HostContext, type VscodeApi } from './vscodeApi';

interface InitMessage {
	type: '__studioExtInit';
	context: HostContext;
	/** The extension's compiled entry point (its `main`), as text. */
	code: string;
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
	throw new Error(`unknown extension host call: ${method}`);
}

let module_: { exports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } } | null = null;

window.addEventListener('message', (event) => {
	const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown; context?: HostContext; code?: string };
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
	if (data.type === '__studioExtInit') boot(data as InitMessage);
});

function boot(message: InitMessage): void {
	const { context, code } = message;
	const api = createVscodeApi(context, {
		request: hostRequest,
		registerCommandHandler: (id, handler) => registered.set(id, handler)
	});
	const require = (id: string): unknown => {
		if (id === 'vscode') return api;
		throw new Error(`require('${id}') is not supported: Git Graph Studio only runs extensions whose main entry is a self-contained bundle`);
	};
	module_ = { exports: {} };
	try {
		// The CommonJS wrapper VS Code itself runs extension code through. Registration calls
		// the shim, which parks the handler here (via 'registerHandler') and forwards the
		// command id to the workbench's registry.
		new Function('require', 'module', 'exports', code)(require, module_, module_.exports);
		Promise.resolve(module_.exports.activate?.(activationContext(context))).then(
			() => parent.postMessage({ type: '__studioExtActivated', extensionId: context.extensionId }, '*'),
			(error) => parent.postMessage({ type: '__studioExtActivateFailed', extensionId: context.extensionId, error: String(error) }, '*')
		);
	} catch (error) {
		parent.postMessage({ type: '__studioExtActivateFailed', extensionId: context.extensionId, error: String(error) }, '*');
	}
}

/** The ExtensionContext VS Code hands to activate(), with an in-frame store standing in for Memento. */
function activationContext(context: HostContext): Record<string, unknown> {
	const memento = new Map<string, unknown>();
	return {
		subscriptions: [] as Disposable[],
		extensionPath: context.extensionPath,
		extensionUri: { scheme: 'file', path: context.extensionPath, fsPath: context.extensionPath, toString: () => 'file:' + context.extensionPath },
		globalState: { get: (key: string, fallback?: unknown) => memento.get(key) ?? fallback, update: (key: string, value: unknown) => memento.set(key, value), setKeysForSync: () => undefined },
		workspaceState: { get: (key: string, fallback?: unknown) => memento.get('ws:' + key) ?? fallback, update: (key: string, value: unknown) => memento.set('ws:' + key, value) },
		asAbsolutePath: (relative: string) => context.extensionPath + '/' + relative,
		environmentVariableCollection: undefined,
		outputChannel: { append: () => undefined, appendLine: () => undefined, show: () => undefined, dispose: () => undefined }
	};
}

// Tell the main window the frame is ready to receive an extension.
parent.postMessage({ type: '__studioExtReady' }, '*');
