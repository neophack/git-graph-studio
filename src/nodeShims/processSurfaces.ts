import type { Buffer, BufferFactory, ShimHost } from '../nodeShims';
import { EventEmitter, callThrowsFn, processNextTick } from './shared';

// The frame's child_process: real spawned tools through the host bridge. The shim keeps
// Node's API shapes — spawn's streamed events, execFile's collected callback, the sync
// variants failing at call time (a sandboxed frame cannot block its event loop).

/* ---------- child_process: the frame's real spawned tools ---------- */

/** One spawned tool as Node's API shapes it: the streams are `EventEmitter`s fed by the
 *  host's streamed chunks (base64 over the bridge, decoded here into Buffers), stdin
 *  writes cross as follow-up requests, and the exit arrives last. The sync variants are
 *  the honest gap — a sandboxed frame cannot block its event loop, so `spawnSync` /
 *  `execSync` / `execFileSync` fail at call time naming exactly that. */
export function makeChildProcess(host: ShimHost, Buffer: BufferFactory): Record<string, unknown> {
	type ChildMessage = { handle: number; event: string; data?: string; code?: number | null };
	const subscribers = new Map<number, (message: ChildMessage) => void>();
	/** Events that arrived before their spawn's bridge round trip bound the handle —
	 *  a fast `git --version` can exit before the frame learns its own handle. */
	const earlyEvents: ChildMessage[] = [];
	const subscribe = host.bridge.onChildEvent ?? (() => () => undefined);
	subscribe((message) => {
		const handler = subscribers.get(message.handle);
		if (handler) handler(message);
		else earlyEvents.push(message);
	});

	/** Collect a spawn's options out of Node's flexible argument orders. */
	function optionsOf(args: unknown[], at: number): Record<string, unknown> {
		const value = args[at];
		return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	}

	type ShimChild = EventEmitter & {
		stdin: Record<string, unknown>; stdout: EventEmitter; stderr: EventEmitter;
		pid: number | null; killed: boolean; exitCode: number | null; exitSignal: null;
		kill: () => boolean;
	};

	function spawn(first: unknown, second?: unknown, third?: unknown): ShimChild {
		const file = String(first);
		const args = (Array.isArray(second) ? second : []).map((a) => String(a));
		const options = (Array.isArray(second) ? third : second) as Record<string, unknown> | undefined ?? {};
		const spec = {
			file,
			args,
			cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
			env: options.env !== undefined ? (options.env as Record<string, string> | null) : null,
			shell: Boolean(options.shell)
		};
		const child = new EventEmitter() as ShimChild;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.pid = null;
		child.killed = false;
		child.exitCode = null;
		child.exitSignal = null;
		// The handle only exists once the spawn crosses the bridge; a stdin write or a kill
		// issued before that queues here and runs the moment the handle lands.
		let boundHandle: number | null = null;
		let stdinClosed = false;
		const queued: (() => void)[] = [];
		const withHandle = (operation: (handle: number) => void): void => {
			if (boundHandle !== null) operation(boundHandle);
			else queued.push(() => operation(boundHandle as number));
		};
		const flush = (): void => {
			for (const operation of queued.splice(0)) operation();
		};
		child.stdin = {
			write(chunk: unknown, encodingOrCallback?: unknown, maybeCallback?: unknown) {
				const payload = typeof chunk === 'string' ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8') : Buffer.from(chunk as Uint8Array);
				const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
				withHandle((handle) => {
					void host.bridge.request('childProcess.write', [handle, payload.toString('base64')]).then(
						() => (typeof done === 'function' ? done() : undefined),
						(error) => child.emit('error', error instanceof Error ? error : new Error(String(error)))
					);
				});
				return true;
			},
			end(callback?: unknown) {
				if (stdinClosed) return;
				stdinClosed = true;
				child.stdin.writableEnded = true;
				withHandle((handle) => {
					void host.bridge.request('childProcess.end', [handle]).then(
						() => (typeof callback === 'function' ? callback() : undefined),
						() => undefined
					);
				});
			},
			writable: true,
			writableEnded: false
		};
		child.kill = () => {
			if (child.killed) return true;
			child.killed = true;
			withHandle((handle) => {
				void host.bridge.request('childProcess.kill', [handle]).catch(() => undefined);
			});
			return true;
		};
		const onEvent = (message: ChildMessage) => {
			if (message.event === 'stdout' || message.event === 'stderr') {
				child[message.event].emit('data', Buffer.from(message.data ?? '', 'base64'));
				return;
			}
			if (message.event === 'exit') {
				child.exitCode = message.code ?? null;
				child.emit('exit', message.code ?? null, message.code === null ? 'SIGTERM' : null);
				// Node closes each stdio stream after the data: 'end' for the readers, then
				// 'close' when the fd is gone — code that waits on stream 'close'
				// (resolveSpawnOutput-style collectors) hangs forever without it.
				child.stdout.emit('end');
				child.stdout.emit('close');
				child.stderr.emit('end');
				child.stderr.emit('close');
				child.emit('close', message.code ?? null, message.code === null ? 'SIGTERM' : null);
			}
		};
		void host.bridge.request('childProcess.spawn', [spec]).then(
			(result) => {
				const { handle, pid } = result as { handle: number; pid: number | null };
				child.pid = pid ?? null;
				boundHandle = handle;
				subscribers.set(handle, onEvent);
				// Deliver anything that raced the spawn round trip, preserving order.
				const raced = earlyEvents.filter((message) => message.handle === handle);
				for (let index = earlyEvents.length - 1; index >= 0; index -= 1) {
					if (earlyEvents[index]!.handle === handle) earlyEvents.splice(index, 1);
				}
				for (const message of raced) onEvent(message);
				flush();
			},
			(error) => {
				// Node raises spawn failures as an `'error'` event, never a throw.
				processNextTick(() => {
					child.emit('error', error instanceof Error ? error : new Error(String(error)));
					child.emit('close', null);
				});
			}
		);
		return child;
	}

	/** `execFile`/`exec`: collect the streams, answer the callback Node-style — strings by
	 *  default (`encoding: 'utf8'`), Buffers under `encoding: 'buffer'`, an `Error` with
	 *  `code`/`stdout`/`stderr` attached when the exit was not clean. */
	function execFile(first: unknown, second?: unknown, third?: unknown, fourth?: unknown): EventEmitter {
		const file = String(first);
		const args = Array.isArray(second) ? second.map((a) => String(a)) : [];
		const rest = Array.isArray(second) ? [third, fourth] : [second, third];
		const options = optionsOf(rest as unknown[], 0);
		const callback = [third, fourth].find((value) => typeof value === 'function') as ((error: Error | null, stdout: unknown, stderr: unknown) => void) | undefined;
		const maxBuffer = typeof options.maxBuffer === 'number' ? options.maxBuffer : 1024 * 1024;
		const asString = options.encoding !== 'buffer';
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let killedForMaxBuffer = false;
		const child = spawn(file, args, { ...options, shell: false });
		// The streams are their own emitters beside the child's; the collection taps them
		// here, after spawn's own wiring.
		attachCollector(child.stdout as EventEmitter, 'stdout');
		attachCollector(child.stderr as EventEmitter, 'stderr');
		function attachCollector(stream: EventEmitter, which: 'stdout' | 'stderr'): void {
			stream.on('data', (...args: unknown[]) => {
				const chunk = args[0] as Buffer;
				const target = which === 'stdout' ? { get: () => stdout, set: (v: Buffer) => { stdout = v; } } : { get: () => stderr, set: (v: Buffer) => { stderr = v; } };
				const grown = Buffer.concat([target.get(), chunk]);
				if (grown.length > maxBuffer) {
					killedForMaxBuffer = true;
					child.kill();
					return;
				}
				target.set(grown);
			});
		}
		if (callback) {
			// Node answers the execFile/exec callback exactly once — either the spawn failed
			// ('error') or the process ran to completion ('close'), never both.
			let settled = false;
			const answer = (error: Error | null, stdout: unknown, stderr: unknown): void => {
				if (settled) return;
				settled = true;
				callback(error, stdout, stderr);
			};
			child.on('close', (...args: unknown[]) => {
				const code = args[0] as number | null;
				const decode = (buffer: Buffer) => (asString ? buffer.toString('utf8') : buffer);
				if (code === 0 && !killedForMaxBuffer) {
					answer(null, decode(stdout), decode(stderr));
					return;
				}
				const error = new Error(`Command failed: ${file}${args.length ? ' ' + args.join(' ') : ''}`) as Error & { code: number | null; killed: boolean; stdout: unknown; stderr: unknown };
				error.code = killedForMaxBuffer ? null : code;
				error.killed = killedForMaxBuffer;
				error.stdout = decode(stdout);
				error.stderr = decode(stderr);
				answer(error, decode(stdout), decode(stderr));
			});
			child.on('error', (...args: unknown[]) => {
				const thrown = args[0] instanceof Error ? args[0] as Error : new Error(String(args[0]));
				answer(thrown, asString ? '' : Buffer.alloc(0), asString ? '' : Buffer.alloc(0));
			});
		}
		return child;
	}

	function exec(command: unknown, options?: unknown, callback?: unknown): EventEmitter {
		const opts = optionsOf([options], 0);
		const shellCommand = String(command);
		const isWindows = host.nodeEnv.platform === 'win32';
		const shellWords: string[] = isWindows ? ['cmd.exe', '/d', '/s', '/c', shellCommand] : ['/bin/sh', '-c', shellCommand];
		const [shell, ...shellArgs] = shellWords;
		const execOptions = { ...(typeof opts === 'object' && opts !== null ? opts : {}), shell: true } as Record<string, unknown>;
		const child = execFile(shell, shellArgs, execOptions, typeof callback === 'function' ? callback as never : undefined);
		return child;
	}

	return {
		spawn,
		exec,
		execFile,
		spawnSync: callThrowsFn('child_process.spawnSync (a sandboxed frame cannot block its event loop; use the async forms)'),
		execSync: callThrowsFn('child_process.execSync (a sandboxed frame cannot block its event loop; use the async forms)'),
		execFileSync: callThrowsFn('child_process.execFileSync (a sandboxed frame cannot block its event loop; use the async forms)'),
		fork: callThrowsFn('child_process.fork'),
		ChildProcess: class ChildProcess {}
	};
}

/** Node's `process.nextTick` for the shim's own plumbing: the frame's global nextTick is
 *  installed by `installNodeGlobals`, but the module builder may run before that — a
 *  microtask is the same ordering class for an error event. */

/* ---------- readline: a terminal-less but shape-complete surface ---------- */

/** The callback readline: interfaces answer questions with empty strings and fire 'close'
 *  on close — enough for packages that only construct one defensively. */
export function makeReadline(): Record<string, unknown> {
	class Interface extends EventEmitter {
		question(_query: string, callback?: (answer: string) => void): void {
			if (typeof callback === 'function') processNextTick(() => callback(''));
		}
		close(): void {
			this.emit('close');
		}
		prompt(): void {}
		pause(): this { return this; }
		resume(): this { return this; }
		write(): boolean { return true; }
	}
	return {
		Interface,
		createInterface: (options?: unknown) => new Interface(),
		clearLine: () => true,
		clearScreenDown: () => true,
		moveCursor: () => true,
		emitKeypressEvents: () => undefined
	};
}

/** The promises readline, over the same inert interface. */
export function makeReadlinePromises(): Record<string, unknown> {
	const callback = makeReadline();
	const createInterface = (options?: unknown) => {
		const base = (callback.createInterface as (options?: unknown) => EventEmitter & { question: (query: string, cb?: (answer: string) => void) => void })(options);
		const wrapped = Object.create(base) as EventEmitter & { question: () => Promise<string> };
		wrapped.question = (): Promise<string> => Promise.resolve('');
		return wrapped;
	};
	return {
		Interface: class PromisesInterface {},
		createInterface
	};
}

/* ---------- http/https: an inert local server, for packages that start one ---------- */

/** A pretend HTTP server: `createServer().listen()` resolves its listening callback and
 *  everything else is inert. Packages that run a local companion server (avatar servers,
 *  live previews) keep activating — the URLs they build just never answer, the same
 *  graceful degradation as every other surface the frame cannot host. */
export function makeHttpLike(): Record<string, unknown> {
	const createServer = (_handler?: unknown) => {
		const server = new EventEmitter() as EventEmitter & {
			listen: (...args: unknown[]) => unknown;
			close: (callback?: () => void) => unknown;
			address: () => { address: string; port: number; family: string } | null;
		};
		server.listen = (...args: unknown[]) => {
			const callback = args.find((argument) => typeof argument === 'function') as (() => void) | undefined;
			processNextTick(() => {
				// Node emits 'listening' on the server itself; code that awaits the event
				// (instead of the callback) hangs without it.
				server.emit('listening');
				callback?.();
			});
			return server;
		};
		server.close = (callback?: () => void) => {
			if (typeof callback === 'function') processNextTick(callback as () => void);
			return server;
		};
		server.address = () => ({ address: '127.0.0.1', port: 0, family: 'IPv4' });
		return server;
	};
	return {
		createServer,
		Server: class Server {},
		request: callThrowsFn('http.request (the frame hosts no network server; use fetch over the workbench bridge)'),
		get: callThrowsFn('http.get (the frame hosts no network server; use fetch over the workbench bridge)')
	};
}

