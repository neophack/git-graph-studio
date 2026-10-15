// The Node `os` builtin over the host facts (ShimHost): the errno table and the
// platform surfaces.

import type { NodeEnv } from '../extModuleLoader';
import { makeChildProcess } from './processSurfaces';
import { makeHttpLike, makeReadline, makeReadlinePromises } from './processSurfaces';
import { Buffer, encodeString, isWindows, encoder, type ShimHost } from './shared';
import { callThrowsFn, unavailableModule } from './shared';
import { makeStreamModule } from './stream';

export const ERRNO_TABLE: Record<string, number> = {
	E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97, EAGAIN: 11,
	EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16, ECANCELED: 125, ECHILD: 10,
	ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89,
	EDOM: 33, EDQUOT: 122, EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113,
	EIDRM: 43, EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5,
	EISCONN: 106, EISDIR: 21, ELOOP: 40, EMFILE: 24, EMLINK: 31, EMSGSIZE: 90,
	EMULTIHOP: 72, ENAMETOOLONG: 36, ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101,
	ENFILE: 23, ENOBUFS: 105, ENODATA: 61, ENODEV: 19, ENOENT: 2, ENOEXEC: 8,
	ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42, ENOPROTOOPT: 92, ENOSPC: 28,
	ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107, ENOTDIR: 20, ENOTEMPTY: 39,
	ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 95, EOVERFLOW: 75,
	EPERM: 1, EPIPE: 32, EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34,
	EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62, ETIMEDOUT: 110,
	ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18
};


export function makeOs(host: ShimHost) {
	const env = host.nodeEnv;
	return {
		EOL: env.eol,
		arch: () => env.arch,
		platform: () => env.platform,
		homedir: () => env.homedir,
		tmpdir: () => env.tmpdir,
		hostname: () => env.hostname,
		release: () => env.release,
		type: () => 'Windows_NT',
		endianness: () => 'LE',
		freemem: () => 0,
		totalmem: () => 0,
		uptime: () => 0,
		loadavg: () => [0, 0, 0],
		cpus: () => [] as unknown[],
		networkInterfaces: () => ({}) as Record<string, unknown[]>,
		constants: { 
			UV_UDP_REUSEADDR: 1, 
			stdio: { 
				STDIN_FILENO: 0, 
				STDOUT_FILENO: 1, 
				STDERR_FILENO: 2 
			},
			errno: ERRNO_TABLE,
			signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 }
		}
	};
}

/** The `process` global, as extension code reads it: the platform word, a production
 *  `env`, nextTick, and inert stdio streams (a sandboxed frame has no console of its own —
 *  writes go to the frame's console, which the host surfaces). */
