// The typed IPC seam's contract test (plan §5.6): every function platform/ipc/*.ts
// exports is callable and reaches the backend with a command name the Rust side actually
// registers. A typo inside a wrapper — the failure mode this guards — fails here at the
// wrapper that carries it, instead of surfacing as a runtime "unknown command" only in
// the view that calls it. The registered set comes from scripts/check-ipc.mjs's reader of
// generate_handler!, the same source the build-time check compares against; this test is
// the runtime half (a wrapper that throws while building its arguments fails too).
import { describe, expect, it } from 'vitest';

import { rustCommandNames } from '../scripts/check-ipc.mjs';
import * as app from '../src/platform/ipc/app';
import * as assoc from '../src/platform/ipc/assoc';
import * as can from '../src/platform/ipc/can';
import * as ext from '../src/platform/ipc/ext';
import * as extChild from '../src/platform/ipc/extChild';
import * as extProcess from '../src/platform/ipc/extProcess';
import * as fsDomain from '../src/platform/ipc/fs';
import * as fuzzy from '../src/platform/ipc/fuzzy';
import * as gallery from '../src/platform/ipc/gallery';
import * as ipcMcp from '../src/platform/ipc/mcp';
import * as providers from '../src/platform/ipc/providers';
import * as pty from '../src/platform/ipc/pty';
import * as remote from '../src/platform/ipc/remote';
import * as revision from '../src/platform/ipc/revision';
import * as scm from '../src/platform/ipc/scm';
import * as search from '../src/platform/ipc/search';
import * as symbols from '../src/platform/ipc/symbols';
import * as analysis from '../src/platform/ipc/analysis';
import * as viewer from '../src/platform/ipc/viewer';
import * as settings from '../src/platform/ipc/settings';
import { backend } from './tauriMock';

/** The permissive stand-in every argument position receives: the wrappers only build
 *  plain argument objects around their parameters, so any property read or nested access
 *  answers itself and the object crosses to the scripted invoke unchanged. */
const anything = new Proxy(function hole() { return hole; } as never, {
	apply: () => anything,
	get: () => anything,
});

const domains: Record<string, Record<string, unknown>> = {
	app, assoc, can, ext, extChild, extProcess, fs: fsDomain, fuzzy, gallery,
	mcp: ipcMcp, providers, pty, remote, revision, scm, search, symbols, analysis, viewer, settings,
};

describe('the typed IPC seam', () => {
	it('every exported wrapper reaches a command the backend registers', async () => {
		const registered = rustCommandNames().names;
		const reached = new Map<string, string>();
		for (const [domain, module] of Object.entries(domains)) {
			for (const [name, exported] of Object.entries(module)) {
				if (typeof exported !== 'function') continue;
				const callsBefore = backend.calls.length;
				try {
					await (exported as (...args: unknown[]) => Promise<unknown>)(...Array.from({ length: (exported as { length: number }).length }, () => anything));
				} catch (error) {
					// The scripted backend rejects commands it has no handler for — the call
					// is still recorded, which is all this test needs. Anything that threw
					// BEFORE reaching invoke (argument building) shows up as no fresh call.
					if (backend.calls.length === callsBefore) throw new Error(`${domain}.${name} threw before invoking: ${String(error)}`);
				}
				const fresh = backend.calls.slice(callsBefore).map((call) => call.command);
				if (fresh.length === 0) throw new Error(`${domain}.${name} invoked nothing`);
				for (const command of fresh) {
					if (typeof command !== 'string') throw new Error(`${domain}.${name} invoked a non-literal command name`);
					reached.set(command, `${domain}.${name}`);
					if (!registered.has(command)) throw new Error(`${domain}.${name} invokes '${command}', which generate_handler! never registers`);
				}
			}
		}
		// The seam must stay whole: these are wrappers, not a sample. A domain that stops
		// exporting functions (a rename, a move) shows up as a missing command here only
		// if the count drops without the command set moving — the check below pins the
		// floor at every domain carrying at least one wrapper.
		for (const domain of Object.keys(domains)) {
			const exports = Object.values(domains[domain]!).filter((value) => typeof value === 'function').length;
			expect(exports, `${domain} exports its wrappers`).toBeGreaterThan(0);
		}
		expect(reached.size, 'the seam covers the domains').toBeGreaterThanOrEqual(130);
	});
});
