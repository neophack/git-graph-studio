// The real-Node extension host: this module compiles to a standalone CommonJS bundle
// (`target/studio/node-host.cjs`, built by prepare.mjs) that a system Node runs as one
// extension's host process — VS Code's own architecture, where an extension host is a
// node process and a `require` of a package's `.node` loads its NAPI addon natively. The
// app spawns `node node-host.cjs <extension-dir>` (ext_process.rs, under the
// `GGS_REAL_NODE=1` opt-in — ggs-node is the default host) and speaks the one wire
// protocol, `ggs-ext/1`, over stdio.
//
// Everything that makes an extension run lives here exactly as in the sandboxed frame:
// the same `vscode` shim (vscodeApi.ts), the same activation context, the same host-call
// vocabulary (`runCommand`, `docProvider.provide`, the tree/webview-view plumbing). Two
// differences define the seam:
//   - the transport is ggs-ext/1, not postMessage: extension→host services cross as
//     `ggs.hostRequest` requests (the app forwards them to the workbench, which serves
//     them through the very same `serve` path the frames use), and host→extension calls
//     arrive as the protocol's requests; host pushes arrive as `ggs.hostEvent`
//     notifications;
//   - `require` is Node's own — a package's `.node` native addon, its ESM, its workers
//     and its `node_modules` all behave exactly as in VS Code. Only `require('vscode')`
//     is intercepted.
//
// stdout is the protocol, as in every backend: the extension's console crosses as `$/log`
// notifications, and package code must not write stdout directly (VS Code's extension
// host has the same rule).

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import Module from 'node:module';
import { activationContext, createVscodeApi, readLocalDocProvider, rehydrateUris, serveHostCall, UNSERVED_HOST_CALL, Uri, type HostBridge, type HostContext, type HostEvent, type VscodeApi } from './vscodeApi';

/* ---------- the wire: newline JSON-RPC on stdio, both directions ---------- */

interface Inbound {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string } | null;
}

const outboundPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
/** Outbound ids start at one billion: the wire carries both directions' ids on one channel,
 *  and the app's reader matches a response line to whatever request it sent with that id —
 *  a backend request colliding with an outstanding app id would let the host.env answer
 *  resolve the app's `initialize`. The offset keeps the two spaces disjoint. */
let nextOutboundId = 1_000_000_000;

function writeLine(line: string): void {
	process.stdout.write(line);
}

/** A request into the app (`ggs.hostRequest`): forwarded to the workbench, which answers
 *  through the same `serve` path the extension frames' RPCs take. */
function hostRequest(method: string, args: unknown[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const id = nextOutboundId++;
		outboundPending.set(id, { resolve, reject });
		writeLine(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'ggs.hostRequest', params: { method, args } })}\n`);
	});
}

/** A notification into the app's backend log — the console mirror's channel. */
function log(level: string, text: string): void {
	writeLine(`${JSON.stringify({ jsonrpc: '2.0', method: '$/log', params: { message: `[${level}] ${text}` } })}\n`);
}

/* ---------- the extension's registration surfaces (the frame's handleCall mirrors) ---------- */

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
const docProviders = new Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>();

const bridge: HostBridge = {
	request: (method, args) => hostRequest(method, args as unknown[]),
	registerCommandHandler: (id, handler) => registeredCommands.set(id, handler),
	registerDocProvider: (scheme, provider) => docProviders.set(scheme, provider),
	unregisterDocProvider: (scheme) => docProviders.delete(scheme),
	// This process's own registration answers locally; the host round-trip stays the
	// fallback for a scheme another extension registered (where the ggs-node side cannot
	// take the round-trip at all — its answer would reenter the blocked JS thread).
	readDocProvider: (uri) => readLocalDocProvider(docProviders, uri)
};

let api_: VscodeApi | null = null;
let loaded_: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } | null = null;
let context_: HostContext | null = null;

/** The host calls the extension exactly as it calls a frame (extHostBoot.handleCall): the
 *  same verbs, the same argument shapes, answered from the same shim internals. */
function handleCall(method: string, args: unknown[]): unknown {
	if (method === 'runCommand') {
		const handler = registeredCommands.get(String(args[0]));
		if (!handler) throw new Error(`command ${String(args[0])} is no longer registered`);
		// A menu's context crosses the wire as Uri-shaped data; the handler receives full
		// Uris, the argument shape VS Code's own command dispatch guarantees.
		return handler(...(rehydrateUris((args[1] as unknown[] | undefined) ?? []) as unknown[]));
	}
	if (method === 'docProvider.provide') {
		const provider = docProviders.get(String((args[0] as { scheme?: unknown } | undefined)?.scheme ?? ''));
		if (!provider) throw new Error('no content provider registered for the scheme');
		return provider.provideTextDocumentContent?.(args[0]);
	}
	if (method === 'deactivate') {
		loaded_?.deactivate?.();
		return undefined;
	}
	// Tree views, the formatter run and webview views: the shared host-call table.
	const served = serveHostCall(api_, method, args);
	if (served !== UNSERVED_HOST_CALL) return served;
	throw new Error(`unknown extension host call: ${method}`);
}

interface InitializeParams {
	extensionId: string;
	extensionPath: string;
	workspaceFolders?: string[];
}

let initializeParams: InitializeParams | null = null;
let activation: Promise<void> | null = null;
let activationError: string | null = null;
let declaredCommands: string[] = [];
/** The entry the app passed (`argv[3]`): a derived backend whose command IS the engine
 *  `.node` hosts that binary instead of the manifest's `main`. */
let entryOverride: string | null = null;

/** Activation happens once; both the `initialize` answer and every dispatched command
 *  wait for the same promise, so a command can never outrun the handlers its activation
 *  registers. The app decides when this process starts (the workbench owns the
 *  activation policy), so by the time the process exists, activating is all that is left. */
function ensureActivated(): Promise<void> {
	if (activation) return activation;
	const params = initializeParams;
	activation = (async () => {
		if (!params) throw new Error('the host sent no initialize handshake');
		const pkg = JSON.parse(readFileSync(join(params.extensionPath, 'package.json'), 'utf8')) as {
			main?: string;
			version?: string;
			contributes?: { commands?: { command: string }[] };
		};
		// The workbench facts the frame gets in its init message: settings, mementos,
		// display language, theme, the package's `ggs://` asset base.
		const env = await hostRequest('host.env', [])
			.then((value) => value as Partial<HostContext> & { settings?: Record<string, unknown>; state?: { global: Record<string, unknown>; workspace: Record<string, unknown> } })
			.catch(() => undefined);
		const folderPaths = params.workspaceFolders ?? [];
		const workspaceFolders = folderPaths.map((uri, index) => ({ uri: Uri.file(uri), name: uri.split(/[\\/]/).pop() ?? uri, index }));
		const context: HostContext = {
			extensionId: params.extensionId,
			extensionPath: params.extensionPath,
			workspaceFolders,
			settings: { ...(env?.settings ?? {}) },
			language: env?.language ?? 'en',
			appVersion: env?.appVersion,
			themeKind: env?.themeKind,
			webviewResourceBase: env?.webviewResourceBase ?? `ggs://localhost/${params.extensionId}-${pkg.version ?? '0.0.0'}/`,
			state: { global: { ...(env?.state?.global ?? {}) }, workspace: { ...(env?.state?.workspace ?? {}) } },
			// The context the frame host gets too: defaults, storage under ~/.ggs, the
			// installed list, the log threshold — and this process's own platform.
			defaults: env?.defaults,
			storage: env?.storage,
			extensions: env?.extensions,
			logLevel: env?.logLevel,
			platform: process.platform
		};
		context_ = context;
		const api = createVscodeApi(context, bridge);
		api_ = api;
		// `require('vscode')` answers the shim; everything else resolves through Node's
		// own machinery — the package's `node_modules`, its `.node` NAPI addons, its ESM.
		const nodeModule = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
		const originalLoad = nodeModule._load.bind(nodeModule);
		nodeModule._load = function (request: string, parent: unknown, isMain: boolean): unknown {
			if (request === 'vscode') return api;
			return originalLoad(request, parent, isMain);
		};

		declaredCommands = (pkg.contributes?.commands ?? []).map((entry) => entry.command);
		const mainPath = entryOverride ?? resolve(params.extensionPath, (pkg.main ?? 'index.js').replace(/^\.\//, ''));
		try {
			let loaded: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } | undefined;
			try {
				loaded = createRequire(__filename)(mainPath) as typeof loaded;
			} catch (error) {
				// A `"type": "module"` package (or an `.mjs` entry) refuses `require` on older
				// Node lines; the dynamic import is the same module for VS Code's purposes.
				if ((error as { code?: string })?.code !== 'ERR_REQUIRE_ESM') throw error;
				loaded = (await import(pathToFileURL(mainPath).href)) as typeof loaded;
				if (loaded && typeof loaded.activate !== 'function' && typeof (loaded as { default?: unknown }).default === 'object') {
					loaded = (loaded as { default: typeof loaded }).default;
				}
			}
			loaded_ = loaded ?? null;
			await Promise.resolve(loaded?.activate?.(activationContext(context, api)));
			// The activation's queued command registrations cross as one batch now (see
			// vscodeApi's flushCommandRegistrations).
			(globalThis as { __ggsFlushRegistrations?: () => void }).__ggsFlushRegistrations?.();
		} catch (error) {
			activationError =
				error instanceof Error && error.stack
					? error.stack.split('\n').slice(0, 6).join('\n')
					: String(error);
			log('error', `activation failed: ${activationError}`);
		}
	})();
	return activation;
}

/* ---------- the protocol loop ---------- */

function answer(id: number, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function answerError(id: number, message: string): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: 1, message } })}\n`);
}

function dispatch(id: number, method: string, params: unknown): void {
	if (method === 'initialize') {
		initializeParams = params as InitializeParams;
		void ensureActivated().then(
			() => answer(id, { capabilities: { commands: declaredCommands }, ...(activationError !== null ? { activationError } : {}) }),
			(error) => answerError(id, String(error))
		);
		return;
	}
	if (method === 'runCommand') {
		// The process shape the app's `ext_process_run` sends: `{command, args}` — the
		// frame call carries the same pair as `[commandId, argsArray]`, normalized here.
		const requestParams = (params ?? {}) as { command?: string; args?: unknown[] };
		void ensureActivated().then(
			() => {
				const handler = registeredCommands.get(String(requestParams.command));
				if (!handler) throw new Error(`no handler registered for ${String(requestParams.command)}`);
				return handler(...(rehydrateUris(requestParams.args ?? []) as unknown[]));
			},
		).then(
			(result) => answer(id, result === undefined ? null : result),
			(error) => answerError(id, String(error))
		);
		return;
	}
	const args = ((params as { args?: unknown[] } | undefined)?.args ?? []) as unknown[];
	void ensureActivated().then(() => handleCall(method, args)).then(
		(result) => answer(id, result === undefined ? null : result),
		(error) => answerError(id, String(error))
	);
}

function dispatchNotification(method: string, params: unknown): void {
	if (method === 'ggs.hostEvent') {
		api_?.handleHostEvent(params as HostEvent);
		return;
	}
	if (method === 'workspaceChanged') {
		// The folders the workbench now has open; the shim's `workspaceFolders` surface
		// and its change event ride on the same context object.
		const folders = (params as { folders?: string[] } | undefined)?.folders ?? [];
		if (context_) {
			context_.workspaceFolders = folders.map((uri, index) => ({ uri: Uri.file(uri), name: uri.split(/[\\/]/).pop() ?? uri, index }));
		}
		return;
	}
}

function main(): void {
	const extensionDir = resolve(process.argv[2] ?? process.cwd());
	entryOverride = process.argv[3] !== undefined ? resolve(process.argv[3]) : null;
	if (!existsSync(join(extensionDir, 'package.json'))) {
		process.stderr.write(`node-host: no package.json under ${extensionDir}\n`);
		process.exit(2);
	}

	// The extension's console crosses as log notifications: the app caps and surfaces them
	// (the Extensions view's status rows read the same trail), and stdout stays protocol.
	for (const level of ['log', 'info', 'warn', 'error'] as const) {
		console[level] = (...args: unknown[]) => {
			log(level, args.map((a) => String(a)).join(' ').slice(0, 400));
		};
	}

	createInterface({ input: process.stdin }).on('line', (line) => {
		if (!line.trim()) return;
		let wire: Inbound;
		try {
			wire = JSON.parse(line) as Inbound;
		} catch {
			return; // an unparsable line is dropped, as the Rust server does
		}
		if (wire.id !== undefined && wire.method !== undefined) {
			if (wire.method === 'shutdown') {
				try {
					loaded_?.deactivate?.();
				} catch { /* a failing deactivate never blocks the exit */ }
				answer(wire.id, null);
				process.exit(0);
			}
			dispatch(wire.id, wire.method, wire.params);
			return;
		}
		if (wire.id !== undefined) {
			const pending = outboundPending.get(wire.id);
			if (!pending) return;
			outboundPending.delete(wire.id);
			if (wire.error) pending.reject(new Error(wire.error.message ?? 'host request failed'));
			else pending.resolve(wire.result);
			return;
		}
		if (wire.method === 'exit') process.exit(0);
		if (wire.method !== undefined) dispatchNotification(wire.method, wire.params);
	});
	process.stdin.on('end', () => process.exit(0));
}

main();
