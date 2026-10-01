// @vitest-environment node
// activate() against the real VS Code API surface. This file runs on the classic threads
// pool (see vitest.config.ts): the fake `vscode` is injected by patching Module._load around
// activate()'s inner require — the vm pool's module system does not honor that patch.
//
// The fake offers ONLY APIs real VS Code ≥1.100 has — no ggs.* commands — so the
// injected-backend probe falls back to the headless CLI, exactly as a genuine VS Code host.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const extensionDir = path.resolve(__dirname, '../extensions-src/claude-remote');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const sjcl: Any = nodeRequire(path.join(extensionDir, 'sjcl.js'));
const ext = nodeRequire(path.join(extensionDir, 'extension.js'));

let home = '';
let workspace = '';
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH };

beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-activation-'));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
	workspace = path.join(home, 'work', 'my-app');
	fs.mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
	for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	fs.rmSync(home, { recursive: true, force: true });
});

/* ---------- the phone's crypto (sjcl), as web/app.js does it ---------- */

const utf8 = (s: string) => sjcl.codec.utf8String.toBits(s);
const bitsFromB64u = (s: string) => sjcl.codec.base64.toBits(s.replace(/-/g, '+').replace(/_/g, '/'));
const b64uFromBits = (b: unknown) => sjcl.codec.base64.fromBits(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A paired phone against a running server port: seals calls exactly as web/app.js does. */
async function phone(code: string, port: number) {
	const hello = await (await fetch(`http://127.0.0.1:${port}/api/hello`)).json();
	const prp = new sjcl.cipher.aes(sjcl.misc.pbkdf2(utf8(code), bitsFromB64u(hello.salt), hello.iterations, 256));
	const call = async (m: string, p: object = {}) => {
		const n = crypto.randomBytes(16).toString('hex');
		const iv = sjcl.codec.hex.toBits(crypto.randomBytes(12).toString('hex'));
		const body = { m, p, ts: Date.now(), n, dev: { id: 'activation-phone', label: 'Activation Probe' } };
		const ct = sjcl.mode.gcm.encrypt(prp, utf8(JSON.stringify(body)), iv, utf8('cr2:req:' + hello.kid), 128);
		const res = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kid: hello.kid, i: b64uFromBits(iv), d: b64uFromBits(ct) })
		});
		const env = await res.json();
		const pt = sjcl.mode.gcm.decrypt(prp, bitsFromB64u(env.d), bitsFromB64u(env.i), utf8('cr2:res:' + n), 128);
		const out = JSON.parse(sjcl.codec.utf8String.fromBits(pt));
		if (!out.ok) throw new Error(out.error);
		return out.r;
	};
	return { call };
}

describe('activation: the real VS Code surface (engines ^1.100.0)', () => {
	type Call = [string, ...unknown[]];
	function realVscode(opts: { brokenSecrets?: boolean } = {}) {
		const executed: Call[] = [];
		const secretsStore: Record<string, string> = {};
		const gState: Record<string, unknown> = {};
		const vscode = {
			version: '1.100.0',
			StatusBarAlignment: { Left: 1, Right: 2 },
			ViewColumn: { Active: -1, Beside: -2 },
			env: { uriScheme: 'vscode', appName: 'Visual Studio Code', language: 'en', clipboard: { writeText: async () => {} } },
			commands: {
				registerCommand: (id: string) => ({ dispose() { void id; } }),
				// a real host resolves unknown commands with exactly this error — the probe relies on it
				executeCommand: async (id: string, ...args: unknown[]) => {
					executed.push([id, ...args]);
					if (id === 'setContext') return undefined;
					throw new Error(`command '${id}' not found`);
				},
				getCommands: async () => []
			},
			window: {
				createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
				// autoStart starts headless; a panel during activation would be a bug
				createWebviewPanel: () => { throw new Error('unexpected panel'); },
				showErrorMessage: async () => undefined,
				showInformationMessage: async () => undefined,
				showWarningMessage: async () => undefined,
				tabGroups: { close: async () => false, activeTabGroup: { activeTab: null } }
			},
			workspace: {
				workspaceFolders: [{ name: 'my-app', uri: { fsPath: workspace } }],
				getConfiguration: () => ({ get: (key: string) => ({ backend: 'desktop', desktopTab: 'reload', port: 0, autoStart: true })[key] }),
				onDidChangeConfiguration: () => ({ dispose() {} })
			}
		};
		const context = {
			secrets: {
				get: async (k: string) => secretsStore[k],
				store: async (k: string, v: string) => { if (opts.brokenSecrets) throw new Error('no secret storage'); secretsStore[k] = v; },
				delete: async (k: string) => { delete secretsStore[k]; }
			},
			globalState: { get: (k: string) => gState[k], update: async (k: string, v: unknown) => { gState[k] = v; } },
			subscriptions: [] as { dispose?: () => void }[]
		};
		return { vscode, context, executed, secretsStore, gState };
	}
	const withVscode = (api: Any, fn: () => unknown) => {
		// the Module CLASS runs every require; node:module's exports only carry a legacy copy of
		// _load that patching does nothing to
		const Module = (nodeRequire('node:module') as Any).Module;
		const orig = Module._load;
		Module._load = function (this: Any, request: string, ...rest: unknown[]) { return request === 'vscode' ? api : orig.apply(this, [request, ...rest]); };
		try { return fn(); } finally { Module._load = orig; }
	};
	const disposeAll = (context: Any) => { for (const d of context.subscriptions.slice().reverse()) d.dispose && d.dispose(); };
	const until = async <T>(probe: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> => {
		const start = Date.now();
		let value = await probe();
		while (!ok(value)) {
			if (Date.now() - start > ms) throw new Error('timed out waiting; last value: ' + JSON.stringify(value).slice(0, 400));
			await new Promise((r) => setTimeout(r, 80));
			value = await probe();
		}
		return value;
	};

	it('activates, pairs into secret storage and serves a sealed round trip the phone accepts', async () => {
		const f = realVscode();
		const logs: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
		try {
			withVscode(f.vscode, () => ext.activate(f.context)); // sync: only the inner require needs the patch
			const port = await until(() => f.gState['claude-remote.lastPort'], (v) => typeof v === 'number' && v > 0);
			await until(() => f.executed, (ex) => ex.some(([id]) => id === 'setContext'));
			expect(f.executed).toContainEqual(['setContext', 'claude-remote.running', true]);
			// the pairing lives in secret storage — the plaintext fallback never fired
			expect(f.secretsStore['claude-remote.pairing']).toBeTruthy();
			expect(f.gState['claude-remote.pairing']).toBeUndefined();
			expect(logs.join('\n')).toMatch(/through the claude CLI/); // the ggs probe failed → headless
			// a phone pairs against the activation's own server and gets a sealed answer
			const pairing = JSON.parse(f.secretsStore['claude-remote.pairing']);
			const p = await phone(pairing.code, port);
			const hello = await p.call('hello');
			expect(hello.injection).toBe(false);
			expect(hello.app).toBe('Visual Studio Code');
			expect(hello.workspace).toEqual([{ name: 'my-app', path: workspace }]);
		} finally {
			disposeAll(f.context);
			spy.mockRestore();
		}
	});

	it('a host without secret storage still pairs — loudly, into global state', async () => {
		const f = realVscode({ brokenSecrets: true });
		const logs: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
		try {
			withVscode(f.vscode, () => ext.activate(f.context));
			await until(() => f.gState['claude-remote.pairing'], (v) => !!v); // the fallback keeps the extension usable
			expect(logs.join('\n')).toMatch(/unencrypted/); // …and says so
			await until(() => f.gState['claude-remote.lastPort'], (v) => typeof v === 'number'); // the server still starts
		} finally {
			disposeAll(f.context);
			spy.mockRestore();
		}
	});
});
