// The Node `fs` builtin over the workspace-confined host bridge: dirent shaping,
// path resolution and the callback/promise forms.

import type { NodeEnv } from '../extModuleLoader';
import { makeChildProcess } from './processSurfaces';
import { makeHttpLike, makeReadline, makeReadlinePromises } from './processSurfaces';
import { Buffer, encodeString, isWindows, encoder, type ShimHost } from './shared';
import { callThrowsFn, unavailableModule } from './shared';
import { makeStreamModule } from './stream';
import { bufferToBase64, decodeBase64ToBuffer } from './crypto';

export function extensionRelative(path: string, host: ShimHost): string | null {
	const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
	const root = host.extensionPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	if (normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) {
		return normalized.slice(root.length + 1);
	}
	if (!normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)) return normalized;
	return null;
}

/** Node's optional-options calling convention: the callback is the last function argument,
 *  the options (an encoding string or an object) whatever sits before it. Every callback
 *  flavour of `fs` accepts `(path, cb)` and `(path, options, cb)` alike. */
function optionsAndCallback<T extends (...args: never[]) => unknown>(args: unknown[]): { options: Record<string, unknown>; callback: T | undefined } {
	const callbackAt = args.findIndex((arg) => typeof arg === 'function');
	const callback = callbackAt === -1 ? undefined : (args[callbackAt] as T);
	const raw = callbackAt === -1 ? args[0] : args[callbackAt - 1];
	const options = typeof raw === 'string' ? { encoding: raw } : raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return { options, callback };
}

/** A `fs.Dirent` (`readdir(path, { withFileTypes: true })`). */
function makeDirent(name: string, isDirectory: boolean, parentPath: string): Record<string, unknown> {
	return {
		name,
		parentPath,
		path: parentPath,
		isFile: () => !isDirectory,
		isDirectory: () => isDirectory,
		isSymbolicLink: () => false,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false
	};
}

/** Every map key under a directory (the directory listing a synchronous `readdir` answers). */
function directoryEntries(dir: string, host: ShimHost): string[] | undefined {
	const prefix = dir === '' ? '' : dir.replace(/\/+$/, '') + '/';
	const names = new Set<string>();
	let any = false;
	for (const key of [...Object.keys(host.files), ...host.binaries]) {
		if (key.startsWith(prefix) && key.length > prefix.length) {
			any = true;
			names.add(key.slice(prefix.length).split('/')[0]!);
		}
	}
	return any ? [...names] : undefined;
}

/** Is this package-relative path one of the package's binary native modules? (Compared
 *  case-insensitively: the install sits on a case-insensitive filesystem on Windows.) */
function isBinary(rel: string, host: ShimHost): boolean {
	const folded = rel.toLowerCase();
	return host.binaries.some((candidate) => candidate.toLowerCase() === folded);
}

function fsError(code: string, message: string): Error {
	const error = new Error(`${code}: ${message}`);
	(error as { code?: string }).code = code;
	(error as { errno?: number }).errno = code === 'ENOENT' ? -2 : -13;
	return error;
}

export function makeFs(host: ShimHost) {
	const mapFile = (path: string): string | undefined => {
		const rel = extensionRelative(path, host);
		return rel === null ? undefined : host.files[rel] ?? host.files[rel.replace(/^\/+/, '')!];
	};
	const blobAt = (path: string): string | undefined => {
		const rel = extensionRelative(path, host);
		return rel === null ? undefined : host.blobs?.[rel];
	};
	// `realpath`: the code map carries no symlinks, so the honest resolution of a package
	// path is its own absolute spelling; anything else is Node's ENOENT. `.native` is the
	// same function — there is no libuv binding here to differ from it, and
	// `fs.realpath.native(...)` must answer (ms-python's path discovery reads it).
	const realpathValue = (path: string): string => {
		const rel = extensionRelative(path, host);
		if (rel !== null && (rel === '' || host.files[rel] !== undefined || isBinary(rel, host) || host.blobs?.[rel] !== undefined || directoryEntries(rel, host) !== undefined)) {
			return host.extensionPath.replace(/[\\/]+$/, '') + (rel === '' ? '' : '/' + rel);
		}
		throw fsError('ENOENT', `no such file or directory, realpath '${path}'`);
	};
	const realpath = ((path: string, cb?: (error: Error | null, resolved?: string) => void): unknown => {
		if (typeof cb === 'function') {
			try {
				cb(null, realpathValue(path));
			} catch (error) {
				cb(error as Error);
			}
			return undefined;
		}
		return new Promise<string>((resolve, reject) => {
			try {
				resolve(realpathValue(path));
			} catch (error) {
				reject(error);
			}
		});
	}) as never;
	(realpath as { native: unknown }).native = realpath;

	const fs = {
		readFileSync: (path: string, encoding?: string | { encoding?: string }): string | Buffer => {
			const text = mapFile(path);
			if (text === undefined) {
				const blob = blobAt(path);
				if (blob !== undefined) return Buffer.from(blob, 'base64');
				throw fsError('ENOENT', `no such file or directory, open '${path}'`);
			}
			const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
			return enc === undefined || enc === 'buffer' ? Buffer.from(encoder.encode(text)) : text;
		},
		existsSync: (path: string): boolean => {
			const rel = extensionRelative(path, host);
			if (rel !== null) {
				if (host.files[rel] !== undefined) return true;
				if (isBinary(rel, host)) return true;
				if (host.blobs?.[rel] !== undefined) return true;
				return directoryEntries(rel, host) !== undefined;
			}
			return false;
		},
		statSync: (path: string) => {
			const rel = extensionRelative(path, host);
			if (rel === null) throw fsError('ENOENT', `no such file or directory, stat '${path}'`);
			const isDir = rel === '' || directoryEntries(rel, host) !== undefined;
			const text = host.files[rel];
			const binary = !isDir && text === undefined && isBinary(rel, host);
			if (!isDir && text === undefined && !binary) throw fsError('ENOENT', `no such file or directory, stat '${path}'`);
			const size = text === undefined ? 0 : encoder.encode(text).length;
			const stats = {
				isFile: () => !isDir,
				isDirectory: () => isDir,
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isSymbolicLink: () => false,
				isFIFO: () => false,
				isSocket: () => false,
				size,
				blksize: 4096,
				blocks: Math.ceil(size / 512),
				atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
				atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
				dev: 0, ino: 0, mode: isDir ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0
			};
			return stats;
		},
		lstatSync: (path: string) => fs.statSync(path),
		realpathSync: (path: string): string => realpathValue(path),
		realpath,
		readdirSync: (path: string, options?: string | { withFileTypes?: boolean }): unknown[] => {
			const rel = extensionRelative(path, host);
			const names = rel === null ? undefined : directoryEntries(rel, host);
			if (names === undefined) throw fsError('ENOENT', `no such file or directory, scandir '${path}'`);
			if (typeof options === 'object' && options?.withFileTypes) {
				const base = rel === '' ? '' : `${rel}/`;
				return names.map((name) => makeDirent(name, directoryEntries(`${base}${name}`, host) !== undefined, path));
			}
			return names;
		},
		/** The callback flavours: a package file answers synchronously from the map; a
		 *  workspace path goes through the bridge (confined there, as VS Code confines
		 *  `workspace.fs` to the open folders). `(path, cb)` and `(path, options, cb)`. */
		readdir: (path: string, ...rest: unknown[]) => {
			const { options, callback } = optionsAndCallback<(error: Error | null, names?: unknown[]) => void>(rest);
			const cb = callback ?? (() => undefined);
			const rel = extensionRelative(path, host);
			if (rel !== null && directoryEntries(rel, host) !== undefined) {
				cb(null, fs.readdirSync(path, options as { withFileTypes?: boolean }));
				return;
			}
			void host.bridge.request('fs.op', ['list', path]).then(
				(answer) => {
					const entries = (answer as { name: string; kind: number }[]) ?? [];
					cb(null, options.withFileTypes ? entries.map((entry) => makeDirent(entry.name, entry.kind === 2, path)) : entries.map((entry) => entry.name));
				},
				(error) => cb(fsError('ENOENT', String(error)))
			);
		},
		lstat: (path: string, ...rest: unknown[]) => fs.stat(path, ...rest),
		access: (path: string, modeOrCb: number | ((error: Error | null) => void), maybeCb?: (error: Error | null) => void) => {
			const cb = typeof modeOrCb === 'function' ? modeOrCb : maybeCb;
			if (!cb) return;
			fs.stat(path, (error: Error | null) => cb(error ?? null));
		},
		stat: (path: string, ...rest: unknown[]) => {
			const cb = optionsAndCallback<(error: Error | null, stats?: unknown) => void>(rest).callback ?? (() => undefined);
			try {
				cb(null, fs.statSync(path));
			} catch {
				void host.bridge.request('fs.op', ['stat', path]).then(
					(answer) => {
						const stat = answer as { type: number; size: number } | null | undefined;
						// A null answer (a missing path, or a bridge without the op) is Node's
						// ENOENT: the callback fires with the error, never a throw — a package
						// probing an absent file must not die on an unhandled rejection.
						if (!stat) {
							cb(fsError('ENOENT', `stat: no such file or directory, ${path}`));
							return;
						}
						cb(null, {
							isFile: () => stat.type === 1,
							isDirectory: () => stat.type === 2,
							isSymbolicLink: () => stat.type === 64,
							isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
							size: stat.size, blksize: 4096, blocks: Math.ceil(stat.size / 512),
							atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
							atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0),
							dev: 0, ino: 0, mode: stat.type === 2 ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0
						});
					},
					(error) => cb(fsError('ENOENT', String(error)))
				);
			}
		},
		readFile: (path: string, ...rest: unknown[]) => {
			// The encoding arrives as a string or as `{ encoding }` (Node takes both).
			const { options, callback } = optionsAndCallback<(error: Error | null, data?: unknown) => void>(rest);
			const cb = callback ?? (() => undefined);
			const encoding = typeof options.encoding === 'string' ? options.encoding : undefined;
			const text = mapFile(path);
			if (text === undefined) {
				// Not in the map: an extension-dir file the preload skipped, or a workspace
				// file — the host bridge reads workspace files (confined there, as in VS Code).
				void host.bridge.request('fs.op', ['read', path]).then(
					(answer) => {
						// No answer (a bridge without the op, a vanished file) is Node's ENOENT.
						const data = (answer as { data?: string } | null | undefined)?.data;
						if (typeof data !== 'string') cb(fsError('ENOENT', `no such file or directory, open '${path}'`));
						else cb(null, decodeBase64ToBuffer(data, encoding));
					},
					(error) => cb(fsError('ENOENT', String(error)))
				);
				return;
			}
			cb(null, encoding === undefined ? Buffer.from(encoder.encode(text)) : text);
		},
		writeFile: (path: string, data: unknown, ...rest: unknown[]) => {
			const cb = optionsAndCallback<(error: Error | null) => void>(rest).callback ?? (() => undefined);
			void host.bridge.request('fs.op', ['write', path, undefined, bufferToBase64(data)]).then(
				() => cb(null),
				(error) => cb(fsError('EACCES', `cannot write '${path}' here: ${String(error)}`))
			);
		},
		mkdir: (path: string, ...rest: unknown[]) => {
			const cb = optionsAndCallback<(error: Error | null) => void>(rest).callback ?? (() => undefined);
			void host.bridge.request('fs.op', ['mkdir', path]).then(() => cb(null), (error) => cb(fsError('EACCES', String(error))));
		},
		// The executable bit git hooks and shipped helper scripts need; the backend sets it
		// inside the workspace (and answers silently on platforms without a mode).
		chmod: (path: string, mode: number, cb?: (error: Error | null) => void) => {
			void host.bridge.request('fs.op', ['chmod', path, mode.toString(8)]).then(
				() => cb?.(null),
				(error) => cb?.(fsError('EACCES', `cannot chmod '${path}': ${String(error)}`))
			);
		},
		chmodSync: (path: string, _mode?: number): void => {
			// Files inside the preload map are the extension's own install copy; a mode flip
			// there is inert in this host and stays silent, the Node-noop-on-Windows shape.
			void path;
		},
		/** The map has no directories to create; an existing directory (any file beneath
		 *  it) succeeds silently — the `if (!existsSync(dir)) mkdirSync(dir)` shape every
		 *  activation-time setup uses — and anything else fails with its reason. */
		mkdirSync: (path: string, options?: { recursive?: boolean }): void => {
			const rel = extensionRelative(path, host);
			if (rel !== null && (rel === '' || directoryEntries(rel, host) !== undefined)) return;
			if (options?.recursive === true) return;
			throw fsError('EACCES', `cannot create directory '${path}' in the Git Graph Studio extension host`);
		},
		appendFile: (path: string, data: unknown, ...rest: unknown[]) => {
			const cb = optionsAndCallback<(error: Error | null) => void>(rest).callback ?? (() => undefined);
			// The current contents (the map's copy, else the workspace file), then the data.
			const existing = mapFile(path);
			const write = (text: string) => void host.bridge.request('fs.op', ['write', path, undefined, bufferToBase64(text + (typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array)))]).then(() => cb(null), (error) => cb(fsError('EACCES', String(error))));
			if (existing !== undefined) {
				write(existing);
				return;
			}
			void host.bridge.request('fs.op', ['read', path]).then(
				(answer) => {
					const data = (answer as { data?: string } | null | undefined)?.data;
					write(typeof data === 'string' ? new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0))) : '');
				},
				() => write('')
			);
		},
		unlink: (path: string, cb: (error: Error | null) => void) => void host.bridge.request('fs.op', ['delete', path]).then(() => cb(null), (error) => cb(error as Error)),
		rmdir: (path: string, cb: (error: Error | null) => void) => void host.bridge.request('fs.op', ['delete', path]).then(() => cb(null), (error) => cb(error as Error)),
		/** `rm`/`rmdirSync`/`rmSync`: the modern removal spellings — `rmdirSync` is read
		 *  off the fs object and `.bind`-ed at module-eval time (ms-python's temp layer),
		 *  so the names must exist as functions even before any call. */
		rm: (path: string, optionsOrCb?: { recursive?: boolean; force?: boolean } | ((error: Error | null) => void), maybeCb?: (error: Error | null) => void) => {
			const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb ?? (() => undefined);
			void host.bridge.request('fs.op', ['delete', path]).then(() => cb(null), (error) => cb(error as Error));
		},
		rmSync: (path: string, _options?: { recursive?: boolean; force?: boolean }): void => {
			void host.bridge.request('fs.op', ['delete', path]);
		},
		rmdirSync: (path: string): void => {
			void host.bridge.request('fs.op', ['delete', path]);
		},
		copyFile: (from: string, to: string, cb: (error: Error | null) => void) => {
			const text = mapFile(from);
			if (text === undefined) return void cb(fsError('ENOENT', `no such file or directory, copy '${from}'`));
			void host.bridge.request('fs.op', ['write', to, undefined, bufferToBase64(text)]).then(() => cb(null), (error) => cb(error as Error));
		},
		createReadStream: () => {
			throw new Error('fs.createReadStream is not supported by the Git Graph Studio extension host');
		},
		/** File descriptors need real file handles the sandboxed frame has not got: an `open`
		 *  fails at call time with the reason (a binary viewer built on `fs.read` degrades,
		 *  an activation that never opens one does not notice). */
		open: callThrowsFn('fs.open') as never,
		read: callThrowsFn('fs.read') as never,
		close: callThrowsFn('fs.close') as never,
		fstat: callThrowsFn('fs.fstat') as never,
		/** A watch needs the host's file-event stream, which this frame does not receive;
		 *  the watcher answers nothing rather than failing the subscribe (VS Code's own
		 *  `createFileSystemWatcher` is the API extension code should prefer, and the shim
		 *  serves that). */
		watch: ((_target: unknown, _listenerOrOptions?: unknown) => ({
			close: () => undefined,
			add: () => undefined,
			unwatch: () => undefined,
			on: () => ({ close: () => undefined }),
			addListener: () => ({ close: () => undefined })
		})) as never,
		watchFile: (() => {
			const noop = () => ({ removeListener: () => undefined, close: () => undefined });
			return (target: unknown, listener: unknown) => {
				if (typeof listener === 'function') {
					// A registered callback that never fires is the honest degradation of "the
					// frame receives no file events"; firing it falsely would be worse.
				}
				return noop();
			};
		})() as never,
		unwatchFile: (): void => undefined,
		constants: {
			F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
			O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512,
			O_APPEND: 1024, O_SYNC: 4096, O_DIRECTORY: 65536, O_NOFOLLOW: 131072
		},
		promises: null as unknown
	};
	(fs.realpathSync as unknown as { native: unknown }).native = fs.realpathSync;
	fs.promises = {
		access: (path: string, _mode?: number) =>
			new Promise<void>((resolve, reject) => {
				fs.stat(path, (error: Error | null) => (error ? reject(error) : resolve()));
			}),
		realpath: (path: string) => new Promise<string>((resolve, reject) => {
			try {
				resolve(realpathValue(path));
			} catch (error) {
				reject(error);
			}
		}),
		readFile: (path: string, options?: string | { encoding?: string }) => new Promise<unknown>((resolve, reject) => fs.readFile(path, options ?? {}, (error: Error | null, data?: unknown) => (error ? reject(error) : resolve(data)))),
		writeFile: (path: string, data: unknown, _options?: unknown) => new Promise<void>((resolve, reject) => fs.writeFile(path, data, (error: Error | null) => (error ? reject(error) : resolve()))),
		appendFile: (path: string, data: unknown, _options?: unknown) => new Promise<void>((resolve, reject) => fs.appendFile(path, data, (error: Error | null) => (error ? reject(error) : resolve()))),
		// Package files answer from the map, workspace paths through the bridge — the same
		// two-tier lookup as the callback flavours (the promise forms read the map alone
		// before, so a workspace directory or file always rejected).
		stat: (path: string, _options?: unknown) => new Promise<unknown>((resolve, reject) => fs.stat(path, (error: Error | null, stats?: unknown) => (error ? reject(error) : resolve(stats)))),
		lstat: (path: string, _options?: unknown) => new Promise<unknown>((resolve, reject) => fs.stat(path, (error: Error | null, stats?: unknown) => (error ? reject(error) : resolve(stats)))),
		readdir: (path: string, options?: string | { withFileTypes?: boolean }) => new Promise<unknown>((resolve, reject) => fs.readdir(path, options ?? {}, (error: Error | null, names?: unknown[]) => (error ? reject(error) : resolve(names)))),
		mkdir: (path: string, _options?: unknown) => new Promise<void>((resolve, reject) => fs.mkdir(path, (error: Error | null) => (error ? reject(error) : resolve()))),
		unlink: (path: string) => new Promise<void>((resolve, reject) => fs.unlink(path, (error) => (error ? reject(error) : resolve())))
	};
	return fs;
}

