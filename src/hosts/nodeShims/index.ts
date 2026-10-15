// The Node builtins the sandboxed frame serves: one file per builtin, the module
// table createNodeBuiltins composes them from, and installNodeGlobals. The Buffer,
// process internals and stream shapes live in shared.ts / processSurfaces.ts /
// stream.ts (P5-2). A directory import resolves here, so consumers are unchanged.

import { makeChildProcess } from './processSurfaces';
import { makeHttpLike, makeReadline, makeReadlinePromises } from './processSurfaces';
import { Buffer, type ShimHost } from './shared';
import { callThrowsFn, unavailableModule } from './shared';
import { makeStreamModule } from './stream';
import { defaultPath } from './path';
import { EventEmitter } from './events';
import { utilShim, assert, querystring, StringDecoder, timers, urlShim } from './util';
import { ERRNO_TABLE, makeOs } from './os';
import { makeFs } from './fs';
import { cryptoShim } from './crypto';
import { makeProcess } from './process';

export function createNodeBuiltins(host: ShimHost): Record<string, unknown> {
	const path = defaultPath(host.nodeEnv.platform);
	// The subpath spellings Node ships ('node:path/posix' et al) resolve to the matching
	// flavour rather than the platform default.
	const posixOnly = defaultPath('linux');
	const win32Only = defaultPath('win32');
	const fs = makeFs(host);
	// Streams extend the frame's own `events` class (`instanceof EventEmitter` holds) and
	// decode chunks through the Buffer shim's codecs.
	const streamModule = makeStreamModule(EventEmitter as never, (chunk, encoding) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString((encoding ?? 'utf8') as never)));
	const builtins: Record<string, unknown> = {
		path,
		'path/posix': posixOnly,
		'path/win32': win32Only,
		os: makeOs(host),
		events: Object.assign(EventEmitter, { EventEmitter, defaultMaxListeners: 10 }),
		util: utilShim,
		assert,
		url: urlShim,
		querystring,
		string_decoder: { StringDecoder },
		timers,
		fs,
		'fs/promises': fs.promises,
		crypto: cryptoShim,
		buffer: { Buffer, INSPECT_MAX_BYTES: 512, kMaxLength: 0x7fffffff },
		process: makeProcess(host),
		console,                    // Node re-exports the console; so does the frame
		perf_hooks: { performance },
		'string_decoder/': { StringDecoder },
		zlib: unavailableModule('zlib'),
		child_process: makeChildProcess(host, Buffer),
		readline: makeReadline(),
		'readline/promises': makeReadlinePromises(),
		net: unavailableModule('net'),
		http: makeHttpLike(),
		https: makeHttpLike(),
		tls: unavailableModule('tls'),
		dns: unavailableModule('dns'),
		dgram: unavailableModule('dgram'),
		cluster: unavailableModule('cluster'),
		repl: unavailableModule('repl'),
		vm: unavailableModule('vm'),
		stream: streamModule,
		'stream/promises': (streamModule as { promises: unknown }).promises,
		worker_threads: { isMainThread: true, threadId: 0, parentPort: null, workerData: null, Worker: callThrowsFn('worker_threads.Worker') },
		async_hooks: { createHook: () => ({ enable: () => undefined, disable: () => undefined }), executionAsyncId: () => 0, triggerAsyncId: () => 0 },
		v8: { getHeapStatistics: () => ({}), setFlagsFromString: () => undefined },
		inspector: { open: () => undefined, close: () => undefined, url: '' },
		'diagnostics_channel': { channel: () => ({ subscribe: () => undefined, publish: () => undefined }) },
		trace_events: { createTracing: () => ({ enable: () => undefined, disable: () => undefined }) },
			// `require('constants')`: os errno + fs access/permission flags. Packages probe
			// `constants.EBADF` (ms-python's stdio layer) at module-eval time — the names
			// must exist; the numbers follow the errno convention.
			constants: { ...ERRNO_TABLE, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
		sys: utilShim,
		module: undefined as unknown  // filled by installNodeGlobals (needs the loader's require)
	};
	return builtins;
}

/** Install the globals extension code assumes exist in a Node process: `process`, `Buffer`,
 *  `setImmediate`/`clearImmediate`, and `global` itself (webpack targets reference it). */
export function installNodeGlobals(host: ShimHost, builtins: Record<string, unknown>, nodeRequire: (request: string) => unknown): void {
	const globals = globalThis as unknown as Record<string, unknown>;
	if (globals.process === undefined) globals.process = builtins.process;
	if (globals.Buffer === undefined) globals.Buffer = Buffer;
	if (globals.setImmediate === undefined) {
		globals.setImmediate = (handler: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => handler(...args), 0);
		globals.clearImmediate = (handle: unknown) => clearTimeout(handle as number);
	}
	if (globals.global === undefined) globals.global = globalThis;
	builtins.module = {
		createRequire: () => nodeRequire,
		builtinModules: Object.keys(builtins),
		Module: class Module {
			constructor(readonly id: string) {}
			static _load: (request: string) => unknown = nodeRequire;
		},
		runMain: callThrowsFn('module.runMain')
	};
}

