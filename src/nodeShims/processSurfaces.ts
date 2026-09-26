import type { Buffer, BufferFactory, ShimHost } from '../nodeShims';
import { EventEmitter, callThrowsFn, processNextTick, traceShim } from './shared';

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

	/** `fork`: the package's own server process (a language server, most often) over a
	 *  real Node runtime the host reports. Node pairs fork's ends over an IPC file
	 *  descriptor, which a sandboxed frame cannot hold — so the child runs `--stdio` and
	 *  the LSP base protocol's Content-Length framing carries what `.send()` and
	 *  `'message'` would: the same JSON messages, framed differently. Without a Node
	 *  runtime the child answers Node's fork-shaped `'error'` event. */
	function fork(first: unknown, second?: unknown, third?: unknown): EventEmitter {
		const modulePath = String(first);
		const forkArgs = (Array.isArray(second) ? second : []).map((a) => String(a));
		const options = (Array.isArray(second) ? third : second) as Record<string, unknown> | undefined ?? {};
		const absolute = /^[A-Za-z]:[\\/]/.test(modulePath) || modulePath.startsWith('/') ? modulePath : host.extensionPath.replace(/[\\/]+$/, '') + '/' + modulePath.replace(/^[\\/]+/, '');
		const outer = new EventEmitter() as EventEmitter & {
			stdin: Record<string, unknown>; stdout: EventEmitter; stderr: EventEmitter;
			pid: number | null; killed: boolean; exitCode: number | null; exitSignal: null;
			stdio: unknown[]; connected: boolean;
			send: (message: unknown, _chunk?: unknown, callback?: (error: Error | null) => void) => boolean;
			disconnect: () => void; kill: () => boolean;
		};
		outer.stdout = new EventEmitter();
		outer.stderr = new EventEmitter();
		outer.pid = null;
		outer.killed = false;
		outer.exitCode = null;
		outer.exitSignal = null;
		outer.stdio = [null, outer.stdout, outer.stderr];
		// Node's fork reports the channel connected the moment fork returns (the client
		// checks this synchronously before its first send); the wiring below only fills in
		// where the bytes then go. Any send in that window queues in order.
		outer.connected = true;
		outer.disconnect = () => {
			outer.connected = false;
		};
		let wired: { send: (message: unknown) => boolean; kill: () => boolean } | null = null;
		// The client sends its `initialize` the moment fork returns — long before the
		// runtime lookup and spawn cross the bridge. Node's IPC channel queues that send;
		// this one queues it here and flushes in order once wired.
		const sendQueue: { message: unknown; callback?: (error: Error | null) => void }[] = [];
		const drainQueue = (): void => {
			for (const pending of sendQueue.splice(0)) wired!.send(pending.message);
		};
		outer.send = (message: unknown, _chunk?: unknown, callback?: (error: Error | null) => void): boolean => {
			if (!wired) {
				sendQueue.push({ message, callback });
				return true;
			}
			if (!outer.connected) {
				if (typeof callback === 'function') processNextTick(() => callback(new Error('channel closed')));
				return false;
			}
			return wired.send(message);
		};

		// The LSP base-protocol deframer: headers are ASCII, the body is exactly
		// `Content-Length` bytes, so byte-wise slicing never splits a character's frame.
		let buffered = new Uint8Array(0);
		let contentLength: number | null = null;
		const utf8 = new TextDecoder();
		const utf8Encode = new TextEncoder();
		const SEP = [13, 10, 13, 10];
		const indexOfSep = (data: Uint8Array): number => {
			scan: for (let at = 0; at <= data.length - SEP.length; at += 1) {
				for (let offset = 0; offset < SEP.length; offset += 1) {
					if (data[at + offset] !== SEP[offset]) continue scan;
				}
				return at;
			}
			return -1;
		};
		const pushFrameBytes = (chunk: Uint8Array): void => {
			const merged = new Uint8Array(buffered.length + chunk.length);
			merged.set(buffered);
			merged.set(chunk, buffered.length);
			buffered = merged;
			for (;;) {
				if (contentLength === null) {
					const sep = indexOfSep(buffered);
					if (sep === -1) return;
					const headers = utf8.decode(buffered.slice(0, sep));
					const match = /content-length: (\d+)/i.exec(headers);
					if (!match) {
						buffered = new Uint8Array(0);
						return;
					}
					contentLength = Number(match[1]);
					buffered = buffered.slice(sep + SEP.length);
				}
				if (buffered.length < contentLength) return;
				const body = utf8.decode(buffered.slice(0, contentLength));
				buffered = buffered.slice(contentLength);
				contentLength = null;
				try {
					outer.emit('message', JSON.parse(body));
				} catch {
					// A body that does not parse ends this conversation's stream — Node would
					// crash the child; here the reader stops, the child keeps running.
					return;
				}
			}
		};

			void (async () => {
				const nodePath = (await host.bridge.request('childProcess.nodeRuntime', [])) as string | null;
				if (!nodePath) throw new Error(`fork ${modulePath}: no Node runtime on this machine to run the server process with`);
				const inner = spawn(nodePath, [absolute, '--stdio', ...forkArgs], options);
				outer.pid = inner.pid;
				outer.killed = inner.killed;
				outer.kill = () => inner.kill();
				outer.stdin = inner.stdin;
				inner.stderr.on('data', (chunk: unknown) => {
					outer.stderr.emit('data', chunk);
					// A language server writes its diagnostics to stderr: the log keeps them.
					try { traceShim('debug', `fork ${modulePath}: stderr: ${String(Buffer.from(chunk as Uint8Array).toString('utf8')).slice(0, 2000)}`); } catch { /* trace */ }
				});
				inner.stdout.on('data', (chunk: unknown) => {
					// Terse wire tracing: the notification/request method per arriving frame —
					// the conversation a language client runs is otherwise invisible.
					try {
						const method = /"method":"([^"]+)/.exec(String(Buffer.from(chunk as Uint8Array).toString('utf8')));
						if (method) traceShim('trace', `fork ${modulePath}: recv ${method[1]}`);
					} catch { /* trace */ }
					pushFrameBytes(chunk as Uint8Array);
				});
			inner.on('exit', (codeArg: unknown, signalArg: unknown) => {
				const code = codeArg as number | null;
				const signal = signalArg as string | null;
				outer.exitCode = code ?? inner.exitCode;
				outer.exitSignal = (signal ?? null) as null;
				outer.connected = false;
				outer.emit('exit', outer.exitCode, outer.exitSignal);
				outer.emit('close', outer.exitCode, outer.exitSignal);
			});
			wired = {
				send: (message: unknown): boolean => {
					const payload = utf8Encode.encode(JSON.stringify(message));
					const header = utf8Encode.encode(`Content-Length: ${payload.length}\r\n\r\n`);
					(outer.stdin as { write: (chunk: Uint8Array) => boolean }).write(header);
					(outer.stdin as { write: (chunk: Uint8Array) => boolean }).write(payload);
					try { traceShim('trace', `fork ${modulePath}: send ${String(JSON.stringify(message).match(/"method":"[^"]+/) ?? [''])[0]}`); } catch { /* trace */ }
					return true;
				},
				kill: () => inner.kill()
			};
			drainQueue();
		})().catch((error) => {
			processNextTick(() => {
				outer.emit('error', error instanceof Error ? error : new Error(String(error)));
				outer.emit('close', null);
			});
		});
		return outer;
	}

	return {
		spawn,
		exec,
		execFile,
		spawnSync: callThrowsFn('child_process.spawnSync (a sandboxed frame cannot block its event loop; use the async forms)'),
		execSync: callThrowsFn('child_process.execSync (a sandboxed frame cannot block its event loop; use the async forms)'),
		execFileSync: callThrowsFn('child_process.execFileSync (a sandboxed frame cannot block its event loop; use the async forms)'),
		fork,
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

