// @vitest-environment node
// activate() against the real VS Code API surface. This file runs on the classic threads
// pool (see vitest.config.ts): the fake `vscode` is injected by patching Module._load around
// activate()'s inner require — the vm pool's module system does not honor that patch.
//
// The fake offers ONLY APIs real VS Code ≥1.100 has — no ggs.* commands — so the tap probe
// falls back to the sdk-host source, exactly as a genuine VS Code host. The relay is the
// in-memory one from claudeRemote.test.ts's contract: activation registers the PC on it
// when an address is configured, and never touches the network when one is not.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const ext = nodeRequire(path.join(extensionDir, 'extension.js'));

let home = '';
let workspace = '';
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH };
const realFetch = globalThis.fetch;

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
	globalThis.fetch = realFetch;
	try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

/** The relay's register endpoint, as the contract's test double answers it. */
function serveRelayRegister(calls: Any[]) {
	globalThis.fetch = (async (input: Any, init: Any = {}) => {
		const url = String(input instanceof URL ? input.href : input);
		calls.push(url);
		if (url.endsWith('/api/v1/register') && (init.method ?? 'GET') === 'POST') {
			const user = 'u_act1vat10n2test';
			return { status: 201, ok: true, text: async () => JSON.stringify({ user_id: user, agent_secret: 'a'.repeat(64), epoch: 1 }), json: async () => ({ user_id: user, agent_secret: 'a'.repeat(64), epoch: 1 }) } as Any;
		}
		if (url.includes('/api/v1/agent/')) return { status: 200, ok: true, text: async () => JSON.stringify({ v: 1, frames: [], cursor: 0, epoch: 1, user: 'u_act1vat10n2test' }), json: async () => ({ v: 1, frames: [], cursor: 0, epoch: 1, user: 'u_act1vat10n2test' }) } as Any;
		return { status: 404, ok: false, text: async () => '{}', json: async () => ({}) } as Any;
	}) as Any;
}

describe('activation: the real VS Code surface (engines ^1.100.0)', () => {
	function realVscode(opts: { brokenSecrets?: boolean; settings?: Record<string, unknown> } = {}) {
		const executed: [string, ...unknown[]][] = [];
		const secretsStore: Record<string, string> = {};
		const gState: Record<string, unknown> = {};
		const settings: Record<string, unknown> = { backend: 'desktop', desktopTab: 'reload', autoConnect: false, ...(opts.settings ?? {}) };
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
				getCommands: async () => [] as string[]
			},
			window: {
				createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
				createWebviewPanel: () => { throw new Error('unexpected panel'); },
				showErrorMessage: async () => undefined,
				showInformationMessage: async () => undefined,
				showWarningMessage: async () => undefined,
				showInputBox: async () => undefined,
				showQuickPick: async () => undefined,
				tabGroups: { close: async () => false, activeTabGroup: { activeTab: null } }
			},
			workspace: {
				workspaceFolders: [{ name: 'my-app', uri: { fsPath: workspace } }],
				getConfiguration: () => ({ get: (key: string) => settings[key] }),
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

	it('activates headless (no ggs surface: the sdk-host source), registers its commands, and stays offline without a relay address', async () => {
		const f = realVscode();
		const logs: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
		try {
			withVscode(f.vscode, () => ext.activate(f.context));
			// Every command of the 2.0 surface is registered; nothing throws without a relay.
			const registered = f.context.subscriptions.filter((d) => d && typeof d === 'object').length;
			expect(registered).toBeGreaterThan(5);
			expect(f.secretsStore['claude-remote.identity']).toBeUndefined(); // no address → no registration
			await until(() => logs.join('\n'), (text) => /sdk host/.test(text)); // the tap probe failed → the sdk source
		} finally {
			disposeAll(f.context);
			spy.mockRestore();
		}
	});

	it('with a relay configured, autoConnect registers this PC into secret storage and long-polls it', async () => {
		const fetches: string[] = [];
		serveRelayRegister(fetches);
		(globalThis as Any).WebSocket = undefined; // the VS Code host under test has no client WebSocket
		const f = realVscode({ settings: { serverUrl: 'https://relay.test', autoConnect: true } });
		const logs: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
		try {
			withVscode(f.vscode, () => ext.activate(f.context));
			await until(() => fetches, (urls) => urls.some((u) => u.endsWith('/api/v1/register')));
			const identity = JSON.parse(f.secretsStore['claude-remote.identity']);
			expect(identity.userId).toBe('u_act1vat10n2test');
			expect(identity.epoch).toBe(1);
			expect(identity.K).toMatch(/^[A-Za-z0-9_-]{43}$/); // the pairing key, stored in its string spelling
			// The window's connection crosses the long-poll pair.
			await until(() => fetches, (urls) => urls.some((u) => u.includes('/api/v1/agent/poll?window=w_')));
			await until(() => logs.join('\n'), (text) => /sdk host/.test(text));
		} finally {
			disposeAll(f.context);
			spy.mockRestore();
			delete (globalThis as Any).WebSocket;
		}
	});

	it('a host without secret storage still activates, and without a relay neither path stores an identity', async () => {
		const f = realVscode({ brokenSecrets: true });
		const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			withVscode(f.vscode, () => ext.activate(f.context));
			await until(() => f.context.subscriptions, (subs) => subs.length > 5);
			expect(f.gState['claude-remote.identity']).toBeUndefined(); // nothing was configured — nothing stored either way
		} finally {
			disposeAll(f.context);
			spy.mockRestore();
		}
	});
});
