// The Node `process` surface and the stdio streams over the host bridge
// (the richer process halves live in processSurfaces.ts / shared.ts).

import { type ShimHost } from './shared';
import { callThrowsFn } from './shared';
import { EventEmitter } from './events';

export function makeProcess(host: ShimHost): Record<string, unknown> {
	const env = host.nodeEnv;
	const listeners = new EventEmitter();
	return {
		platform: env.platform,
		arch: env.arch,
		env: {
			NODE_ENV: 'production',
			HOME: env.homedir,
			USERPROFILE: env.homedir,
			TEMP: env.tmpdir,
			TMP: env.tmpdir,
			COMPUTERNAME: env.hostname,
			HOSTNAME: env.hostname,
			OS: 'Windows_NT',
			APPDATA: env.platform === 'win32' ? env.homedir.replace(/[\\/]+$/, '') + '/AppData/Roaming' : env.homedir,
			VSCODE_PID: '0',
			VSCODE_CWD: host.extensionPath,
			ELECTRON_RUN_AS_NODE: '1',
			// The host's real environment rides last: tool discovery (`PATH`,
			// `ProgramW6432`, `LOCALAPPDATA`, ...) reads the actual machine, not the
			// synthesized fallbacks above.
			...(env.env ?? {})
		},
		argv: ['node', host.extensionPath + '/extension.js'],
		argv0: 'node',
		execPath: 'node',
		execArgv: [] as string[],
		pid: 1,
		ppid: 0,
		title: 'node',
		version: 'v20.11.1',
		versions: { node: '20.11.1', v8: '11.3.414.16-node.15', uv: '1.46.0', zlib: '1.2.13' },
		features: { uv: true, worker: false, inspector: false },
		nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
			queueMicrotask(() => fn(...args));
		},
		cwd: () => host.extensionPath,
		chdir: callThrowsFn('process.chdir'),
		exit: ((code?: number) => {
			console.warn(`extension called process.exit(${code ?? 0}) — ignored by the extension host frame`);
			return undefined as never;
		}) as unknown as (code?: number) => never,
		hrtime: Object.assign(
			(time?: [number, number]): [number, number] => {
				const now = performance.now() * 1e-3;
				if (time === undefined) return [Math.floor(now), Math.floor((now % 1) * 1e9)];
				const previous = time[0]! + time[1]! / 1e9;
				const diff = Math.max(0, now - previous);
				return [Math.floor(diff), Math.floor((diff % 1) * 1e9)];
			},
			{ bigint: () => BigInt(Math.round(performance.now() * 1e6)) }
		),
		uptime: () => performance.now() / 1000,
		memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
		stdout: makeStdio('stdout'),
		stderr: makeStdio('stderr'),
		stdin: { on: () => undefined, read: () => null, pipe: () => undefined },
		on: listeners.on.bind(listeners) as never,
		once: listeners.once.bind(listeners) as never,
		off: listeners.off.bind(listeners) as never,
		removeListener: listeners.off.bind(listeners) as never,
		addListener: listeners.on.bind(listeners) as never,
		emit: listeners.emit.bind(listeners) as never,
		listeners: listeners.listeners.bind(listeners) as never,
		browser: false,
		connected: true,
		type: 'renderer'
	};
}

export function makeStdio(name: 'stdout' | 'stderr'): Record<string, unknown> {
	const write = (chunk: unknown): boolean => {
		const text = typeof chunk === 'string' ? chunk : String(chunk);
		(name === 'stdout' ? console.log : console.error).call(console, text.replace(/\n$/, ''));
		return true;
	};
	return {
		write,
		fd: name === 'stdout' ? 1 : 2,
		columns: 120,
		rows: 30,
		isTTY: false,
		on: () => undefined,
		once: () => undefined,
		end: write as never,
		destroy: () => undefined
	};
}

/* ---------- The assembly ---------- */

/** Build every builtin shim for one activation. The `module` shim needs the loader's
 *  `require`, which itself needs these shims — it is filled in by the caller afterwards. */
