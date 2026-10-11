// @vitest-environment node
// The Claude Remote 2.0 extension, headless: the E2E crypto layer (both its native and
// its sjcl paths), the PC identity (including the multi-window registration race), the
// relay client against an in-memory relay that implements the same wire contract the
// Rust server's tests pin (so either side drifting shows up here), the two conversation
// sources emitting one shape, the phone's request table over a fixture store, and the
// official-session mirror's read-only rules. Only activate() needs `vscode` — that is
// claudeRemoteActivation.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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

let home = '';
let root = '';
let workspace = '';
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
	const start = Date.now();
	let value = await probe();
	while (!ok(value)) {
		if (Date.now() - start > ms) throw new Error('timed out waiting; last value: ' + JSON.stringify(value).slice(0, 400));
		await sleep(60);
		value = await probe();
	}
	return value;
}

const requireExtension = (name: string): Any => nodeRequire(path.join(extensionDir, name));
const extCrypto = () => requireExtension('crypto.js');

/* ---------- the fixture store (the conversation JSONL the readers serve) ---------- */

const munge = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
function writeSession(projectCwd: string, id: string, records: object[]) {
	const dir = path.join(root, 'projects', munge(projectCwd));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.jsonl`);
	for (const record of records) fs.appendFileSync(file, JSON.stringify(record) + '\n');
	return file;
}

/* ---------- an in-memory relay implementing the server's wire contract ---------- */

function mockRelay() {
	const users: Any[] = [];
	const registers: Any[] = [];
	const devices: Any[] = [];
	const rings = new Map<string, { cursor: number; items: Any[] }>();
	const sent: Any[] = [];
	let cursorSeq = 0;
	const ring = (window: string) => {
		let entry = rings.get(window);
		if (!entry) rings.set(window, (entry = { cursor: 0, items: [] }));
		return entry;
	};
	const push = (window: string, item: Any) => {
		const entry = ring(window);
		entry.cursor = ++cursorSeq;
		entry.items.push({ ...item, c: entry.cursor });
	};
	const userBySecret = (secret: string | undefined) => users.find((u) => u.agentSecret === secret);
	return {
		registers,
		users,
		devices,
		sent,
		rings,
		/** Deliver a frame into a window's ring, as another member would. */
		deliver(window: string, frame: Any) {
			push(window, { v: 1, kind: 'frame', ...frame });
		},
		/** Announce an epoch change to a window (what a rekey does to its siblings). */
		announceEpoch(window: string, epoch: number) {
			push(window, { v: 1, kind: 'epoch_changed', epoch, from: '', to: window, seq: 0, ct: '' });
		},
		async handle(method: string, url: string, headers: Any, body: Any): Promise<{ status: number; json: Any }> {
			const tail = url.replace('https://relay.test', '');
			const path_ = tail.split('?')[0];
			const query = new URL(tail, 'https://relay.test').searchParams;
			const secret = String(headers?.authorization ?? '').replace(/^Bearer /, '') || undefined;
			if (path_ === '/api/v1/register' && method === 'POST') {
				registers.push({ auth: body.auth, token: body.token });
				const user = { userId: 'u_' + crypto.randomBytes(8).toString('hex').padEnd(16, '0'), agentSecret: crypto.randomBytes(32).toString('hex'), auth: body.auth, epoch: 1 };
				users.push(user);
				return { status: 201, json: { user_id: user.userId, agent_secret: user.agentSecret, epoch: 1 } };
			}
			if (path_ === '/api/v1/me/pairing' && method === 'PUT') {
				const user = userBySecret(secret);
				if (!user) return { status: 401, json: { error: 'auth' } };
				if (Number(body.expect_epoch) !== user.epoch) return { status: 409, json: { error: 'stale epoch' } };
				user.epoch += 1;
				user.auth = body.auth;
				return { status: 200, json: { ok: true, epoch: user.epoch } };
			}
			if (path_ === '/api/v1/me/devices' && method === 'GET') {
				const user = userBySecret(secret);
				if (!user) return { status: 401, json: { error: 'auth' } };
				return { status: 200, json: { devices: devices.filter((d) => d.user === user.userId).map((d) => ({ id: d.id, name: d.name, created: 1, last_seen: Date.now(), online: false })), password_set: !!user.password } };
			}
			if (path_ === '/api/v1/me/windows' && method === 'GET') {
				const user = userBySecret(secret);
				if (!user) return { status: 401, json: { error: 'auth' } };
				return { status: 200, json: { windows: rings.size ? [...rings.keys()].map((id) => ({ id, meta_ct: null, host: 'ggs', seen: Date.now(), online: true })) : [] } };
			}
			if (path_ === '/api/v1/agent/send' && method === 'POST') {
				const user = userBySecret(secret);
				if (!user) return { status: 401, json: { error: 'auth' } };
				for (const frame of body.frames ?? []) sent.push(frame);
				return { status: 200, json: { ok: true, accepted: (body.frames ?? []).length, cursor: cursorSeq } };
			}
			if (path_ === '/api/v1/agent/poll' && method === 'GET') {
				const user = userBySecret(secret);
				if (!user) return { status: 401, json: { error: 'auth' } };
				const window = query.get('window') ?? '';
				const cursor = Number(query.get('cursor') ?? 0);
				const entry = ring(window);
				let frames = entry.items.filter((item) => item.c > cursor);
				if (!frames.length) {
					// a real long-poll parks: so does the mock, so the client's loop
					// breathes (and delivers made while parked are seen on wake)
					await sleep(120);
					frames = entry.items.filter((item) => item.c > cursor);
				}
				return { status: 200, json: { v: 1, frames, cursor: entry.cursor, epoch: user.epoch, user: user.userId } };
			}
			return { status: 404, json: { error: 'no such path ' + path_ } };
		}
	};
}

let relayMock: ReturnType<typeof mockRelay>;
const realFetch = globalThis.fetch;

beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-home-'));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.CLAUDE_CONFIG_DIR = root = path.join(home, '.ggs', 'claude');
	workspace = path.join(home, 'workspace');
	fs.mkdirSync(workspace, { recursive: true });
});
afterAll(() => {
	for (const key of Object.keys(savedEnv)) {
		if (savedEnv[key] === undefined) delete (process.env as Any)[key];
		else (process.env as Any)[key] = savedEnv[key];
	}
	globalThis.fetch = realFetch;
	try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows locks */ }
});

/** Point the identity/relay client at the in-memory relay for one test. */
function serveRelay() {
	relayMock = mockRelay();
	globalThis.fetch = (async (input: Any, init: Any = {}) => {
		const url = String(input instanceof URL ? input.href : input);
		const body = init.body ? JSON.parse(String(init.body)) : undefined;
		const headers: Any = {};
		for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
		const response = await relayMock.handle(init.method ?? 'GET', url, headers, body);
		return { status: response.status, ok: response.status < 400, text: async () => JSON.stringify(response.json), json: async () => response.json } as Any;
	}) as Any;
	return relayMock;
}

/* ---------- the crypto layer ---------- */

describe('the E2E crypto layer', () => {
	it('derives the key schedule exactly as the phone does (HKDF vectors vs Node)', () => {
		const c = extCrypto();
		const K = Buffer.alloc(32, 7);
		expect(c.deriveAuth(K).equals(Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from('crr1/auth'), 32)))).toBe(true);
		expect(c.deriveE2E(K).equals(Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from('crr1/e2e'), 32)))).toBe(true);
	});

	it('answers the RFC 4231 HMAC vector and the pairing proof shape', () => {
		const c = extCrypto();
		const mac = c.hmacSha256(Buffer.alloc(20, 0x0b), [Buffer.from('Hi There')]);
		expect(mac.toString('hex')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
		const proof = c.pairProof(Buffer.alloc(32, 1), 'nonce', 'u_x', 3);
		expect(proof).toBe(crypto.createHmac('sha256', Buffer.alloc(32, 1)).update('crr1/pair|nonce|u_x|3').digest('hex'));
	});

	it('seals and opens frames, and rejects tampering and re-addressing', () => {
		const c = extCrypto();
		const kE2E = c.deriveE2E(Buffer.alloc(32, 9));
		const envelope = { userId: 'u_x', epoch: 2, from: 'w_abcdefghijklmnop', to: 'd_1234567890abcdef', seq: 11 };
		const body = c.sealFrame(kE2E, envelope, { t: 'hello', text: 'hi' });
		expect(c.openFrame(kE2E, envelope, body)).toEqual({ t: 'hello', text: 'hi' });
		expect(() => c.openFrame(kE2E, envelope, { ...body, c: body.c.slice(0, -2) + 'AA' })).toThrow();
		expect(() => c.openFrame(kE2E, { ...envelope, to: 'd_zzzzzzzzzzzzzzzz' }, body)).toThrow(); // re-addressed
		expect(() => c.openFrame(c.deriveE2E(Buffer.alloc(32, 8)), envelope, body)).toThrow(); // wrong key
		expect(() => c.openFrame(kE2E, { ...envelope, epoch: 3 }, body)).toThrow(); // rekeyed peer
	});

	it("a sandboxed frame's call-throws crypto stubs fall back to sjcl instead of dying", () => {
		// The frame shim's shape: createHmac/createCipheriv/hkdfSync are FUNCTIONS whose
		// invocation throws (typeof alone answered "function" — the probe's whole point).
		// createHash and randomBytes are genuinely served there.
		const Module = nodeRequire('module') as Any;
		const originalLoad = Module._load;
		const throwsNow = (name: string) => () => { throw new Error(`${name} is not supported by the Git Graph Studio extension host`); };
		Module._load = function (request: string, ...rest: Any[]) {
			if (request !== 'crypto') return originalLoad.call(this, request, ...rest);
			const real = originalLoad.call(this, request, ...rest);
			return {
				createHash: real.createHash, // served in a frame
				randomBytes: real.randomBytes, // served in a frame
				createHmac: throwsNow('crypto.createHmac'),
				createCipheriv: throwsNow('crypto.createCipheriv'),
				createDecipheriv: throwsNow('crypto.createDecipheriv'),
				hkdfSync: throwsNow('crypto.hkdfSync')
			};
		};
		try {
			delete nodeRequire.cache[nodeRequire.resolve(path.join(extensionDir, 'crypto.js'))];
			const c = requireExtension('crypto.js');
			const K = Buffer.alloc(32, 5);
			// Every primitive answers — over sjcl — and agrees with Node's own vectors.
			expect(c.deriveE2E(K).equals(Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from('crr1/e2e'), 32)))).toBe(true);
			expect(c.hmacSha256(Buffer.alloc(20, 0x0b), [Buffer.from('Hi There')]).toString('hex')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
			const envelope = { userId: 'u_x', epoch: 1, from: 'w_abcdefghijklmnop', to: 'd_1234567890abcdef', seq: 4 };
			const kE2E = c.deriveE2E(K);
			const body = c.sealFrame(kE2E, envelope, { frame: 'hosted' });
			expect(c.openFrame(kE2E, envelope, body)).toEqual({ frame: 'hosted' });
			// And the wire stays one: the native codec opens what the fallback sealed.
			delete nodeRequire.cache[nodeRequire.resolve(path.join(extensionDir, 'crypto.js'))];
			const cNative = requireExtension('crypto.js');
			expect(() => cNative.openFrame(cNative.deriveE2E(K), envelope, body)).not.toThrow();
		} finally {
			Module._load = originalLoad;
			delete nodeRequire.cache[nodeRequire.resolve(path.join(extensionDir, 'crypto.js'))];
		}
	});

	it('the sjcl fallback (frame hosts, plain-HTTP phones) answers the same vectors', () => {
		// Shadow require('crypto') with a bare surface for one load: the pure-JS paths carry.
		const Module = nodeRequire('module') as Any;
		const originalLoad = Module._load;
		Module._load = function (request: string, ...rest: Any[]) {
			if (request === 'crypto') return {};
			return originalLoad.call(this, request, ...rest);
		};
		try {
			delete nodeRequire.cache[nodeRequire.resolve(path.join(extensionDir, 'crypto.js'))];
			const c = requireExtension('crypto.js');
			const K = Buffer.alloc(32, 5);
			expect(c.deriveE2E(K).equals(Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from('crr1/e2e'), 32)))).toBe(true);
			const mac = c.hmacSha256(Buffer.alloc(20, 0x0b), [Buffer.from('Hi There')]);
			expect(mac.toString('hex')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
			const envelope = { userId: 'u_x', epoch: 1, from: 'w_abcdefghijklmnop', to: 'd_1234567890abcdef', seq: 1 };
			const kE2E = c.deriveE2E(K);
			const body = c.sealFrame(kE2E, envelope, { any: ['payload', 1] });
			expect(c.openFrame(kE2E, envelope, body)).toEqual({ any: ['payload', 1] });
			expect(() => c.openFrame(kE2E, { ...envelope, seq: 2 }, body)).toThrow();
			// and the native path opens what the fallback sealed (one wire, both sides)
			delete nodeRequire.cache[nodeRequire.resolve(path.join(extensionDir, 'crypto.js'))];
			const cNative = requireExtension('crypto.js');
			expect(() => cNative.openFrame(cNative.deriveE2E(K), envelope, body)).not.toThrow();
		} finally {
			Module._load = originalLoad;
			delete nodeRequire.cache[nodeRequire.resolve(path.join(extensionDir, 'crypto.js'))];
		}
	});
});

/* ---------- the identity ---------- */

describe('the PC identity', () => {
	const identity = () => requireExtension('identity.js');

	it('normalizes relay addresses and round-trips the pairing link', () => {
		const id = identity();
		expect(id.normalizeServer('https://relay.example.com:8787/')).toBe('https://relay.example.com:8787');
		expect(id.normalizeServer('nas.local:8787')).toBe('https://nas.local:8787');
		expect(id.normalizeServer('  ')).toBe(null);
		const K = crypto.randomBytes(32);
		const link = id.linkUrl('https://relay.example.com', 'u_abc123', K, 4);
		expect(link).toBe(`https://relay.example.com/c/u_abc123#${K.toString('base64url')}.4`);
		const parsed = id.parseLink(link);
		expect(parsed).toMatchObject({ serverUrl: 'https://relay.example.com', userId: 'u_abc123', epoch: 4 });
		expect(parsed.K).toBe(K.toString('base64url')); // the stored spelling, never a Buffer
		expect(id.parseLink('https://relay.example.com/c/u_x#nope')).toBe(null);
		expect(id.validIdentity({ userId: 'u_ab12cd34ef56ab12', agentSecret: 'f'.repeat(64), K: K.toString('base64url'), epoch: 1, serverUrl: 'https://a' })).toBe(true);
		expect(id.validIdentity({ userId: 'x', agentSecret: 'y', K: 'z', epoch: 1, serverUrl: 'https://a' })).toBe(false);
	});

	it('registers through the wire and rekeys forward-only', async () => {
		serveRelay();
		const id = identity();
		const first = await id.register('https://relay.test');
		expect(first.userId).toMatch(/^u_/);
		expect(first.epoch).toBe(1);
		expect(relayMock.registers).toHaveLength(1);
		const second = await id.rekey(first);
		expect(second.epoch).toBe(2);
		expect(second.K).not.toBe(first.K);
		await expect(id.rekey(first)).rejects.toThrow(/rekeyed|stale/);
	});

	it("a dead credential's rekey fails 401-tagged, and forget + load registers fresh (the relay-data-reset recovery)", async () => {
		serveRelay();
		const id = identity();
		const first = await id.register('https://relay.test');
		// A ghost credential (the relay's data was wiped): every authenticated call 401s.
		const ghost = { ...first, agentSecret: 'f'.repeat(64) };
		await expect(id.rekey(ghost)).rejects.toMatchObject({ status: 401, message: /rekeying failed: auth/ });
		// check() says false for the ghost, null when the relay is unreachable.
		expect(await id.check(ghost)).toBe(false);
		const savedFetch = globalThis.fetch;
		globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as Any;
		expect(await id.check(ghost)).toBe(null);
		globalThis.fetch = savedFetch;
		// forget + load: the recovery path mints a fresh identity on the same relay.
		const secrets = new Map<string, string>();
		const global = new Map<string, Any>();
		const context = { secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); }, delete: async (k: string) => { secrets.delete(k); } }, globalState: { get: (k: string) => global.get(k), update: async (k: string, v: Any) => { if (v === undefined) global.delete(k); else global.set(k, v); } } };
		await id.writeIdentity(context, first);
		expect(id.validIdentity(await id.readIdentity(context))).toBe(true);
		await id.forget(context);
		expect(await id.readIdentity(context)).toBe(null);
		const fresh = await id.load(context, { serverUrl: 'https://relay.test' });
		expect(relayMock.registers).toHaveLength(2); // registered again, not adopted
		expect(fresh.userId).not.toBe(first.userId);
	});

	it('two windows racing the first creation register exactly once and adopt one identity', async () => {
		serveRelay();
		const id = identity();
		// Both windows share the install's secrets and the global state (that sharing is
		// what makes them one PC) — the lock is the only thing that separates them.
		const secrets = new Map<string, string>();
		const global = new Map<string, Any>();
		const context = () => ({
			secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); } },
			globalState: { get: (k: string) => global.get(k), update: async (k: string, v: Any) => { global.set(k, v); } }
		});
		const [a, b] = await Promise.all([
			id.load(context(), { serverUrl: 'https://relay.test' }),
			id.load(context(), { serverUrl: 'https://relay.test' })
		]);
		expect(relayMock.registers).toHaveLength(1);
		expect(a.userId).toBe(b.userId);
		expect(a.K).toBe(b.K);
	});

	it('refuses to register without a relay address, and a broken state storage fails loudly', async () => {
		const id = identity();
		const state = new Map<string, Any>();
		const context = { secrets: { get: async () => undefined, store: async () => undefined }, globalState: { get: (k: string) => state.get(k), update: async (k: string, v: Any) => { state.set(k, v); } } };
		await expect(id.load(context, {})).rejects.toThrow(/no relay is configured/);
		// A memento that never answers back would have hung the old lock protocol forever.
		const broken = { secrets: context.secrets, globalState: { get: () => undefined, update: async () => undefined } };
		await expect(id.load(broken, { serverUrl: 'https://relay.test' })).rejects.toThrow(/not answering/);
	});
});

/* ---------- the relay client ---------- */

describe('the relay client (long-poll transport)', () => {
	it('exchanges frames with a phone: sealed in, sealed out, AAD-verified', async () => {
		(globalThis as Any).WebSocket = undefined; // the poll pair is the transport under test
		serveRelay();
		const id = requireExtension('identity.js');
		const identityValue = await id.register('https://relay.test');
		const frames: Any[] = [];
		const relay = requireExtension('relay.js').createRelay(identityValue, {
			windowId: 'w_abcdefghijklmnop',
			meta: () => ({ name: 'workspace' }),
			getIdentity: () => identityValue,
			onFrame: (plain: Any) => frames.push(plain),
			onEpoch: () => undefined,
			onOnline: () => undefined,
			log: () => undefined
		});
		relay.start();
		await sleep(200); // the first poll attaches the window's ring
		const device = 'd_1234567890abcdef';
		const kE2E = extCrypto().deriveE2E(identityValue.K);
		const envelope = { userId: identityValue.userId, epoch: 1, from: device, to: 'w_abcdefghijklmnop', seq: 7 };
		const sealed = extCrypto().sealFrame(kE2E, envelope, { t: 'sessions' });
		relayMock.deliver('w_abcdefghijklmnop', { from: device, to: 'w_abcdefghijklmnop', seq: 7, ct: sealed.n + '.' + sealed.c });
		await until(() => frames, (v) => v.length > 0);
		expect(frames[0]).toEqual({ t: 'sessions' });
		// The window's answer crosses sealed and opens under the same AAD rule.
		// The poller's first crossing is its sealed window.metadata control — and its
		// `ct` must be the wire's "n.c" STRING: a bare object here read as a protocol
		// violation server-side and closed the connection on every publish, flapping
		// the window off the relay (the phone's every RPC then timed out).
		await until(() => relayMock.sent, (v) => v.some((frame) => frame.kind === 'window.meta'));
		const meta = relayMock.sent.find((frame) => frame.kind === 'window.meta');
		expect(typeof meta.ct).toBe('string');
		expect(meta.ct).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		relay.send(device, { t: 'reply', rid: 1, ok: true, r: { list: [] } });
		await until(() => relayMock.sent, (v) => v.some((frame) => frame.kind === 'frame'));
		const wire = relayMock.sent.find((frame) => frame.kind === 'frame');
		expect(wire).toMatchObject({ v: 1, kind: 'frame', from: 'w_abcdefghijklmnop', to: device });
		const [n, c] = String(wire.ct).split('.');
		const opened = extCrypto().openFrame(kE2E, { userId: identityValue.userId, epoch: 1, from: wire.from, to: wire.to, seq: wire.seq }, { n, c });
		expect(opened).toMatchObject({ t: 'reply', ok: true });
		relay.stop();
	});

	it('delivers epoch_changed to the identity reload, and a rekeyed key opens nothing old', async () => {
		(globalThis as Any).WebSocket = undefined;
		serveRelay();
		const id = requireExtension('identity.js');
		const identityValue = await id.register('https://relay.test');
		const epochs: number[] = [];
		const relay = requireExtension('relay.js').createRelay(identityValue, {
			windowId: 'w_abcdefghijklmnop',
			meta: () => ({}),
			getIdentity: () => identityValue,
			onFrame: () => undefined,
			onEpoch: (epoch: number) => epochs.push(epoch),
			onOnline: () => undefined,
			log: () => undefined
		});
		relay.start();
		await sleep(200);
		relayMock.announceEpoch('w_abcdefghijklmnop', 2);
		await until(() => epochs, (v) => v.length > 0);
		expect(epochs[0]).toBe(2);
		// A frame sealed under the old K fails authentication under the rekeyed one.
		const old = extCrypto().sealFrame(extCrypto().deriveE2E(identityValue.K), { userId: identityValue.userId, epoch: 1, from: 'd_1234567890abcdef', to: 'w_abcdefghijklmnop', seq: 1 }, {});
		expect(() => extCrypto().openFrame(extCrypto().deriveE2E(crypto.randomBytes(32)), { userId: identityValue.userId, epoch: 2, from: 'd_1234567890abcdef', to: 'w_abcdefghijklmnop', seq: 1 }, old)).toThrow();
		relay.stop();
	});
});

/* ---------- the tap source ---------- */

/** A fake vscode whose ggs.claudeChat / ggs.claudeTap commands are scripted per test. */
function fakeVscodeGgs(script: { [command: string]: (arg: Any) => Any }) {
	const listeners: ((item: Any) => void)[] = [];
	const calls: [string, Any][] = [];
	return {
		calls,
		commands: {
			executeCommand: async (command: string, arg?: Any) => {
				calls.push([command, arg]);
				const answer = script[command];
				if (!answer) throw new Error(`command '${command}' not found`);
				return answer(arg);
			}
		},
		env: {
			onClaudeConversationTap: (listener: (item: Any) => void) => {
				listeners.push(listener);
				return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
			}
		},
		emit: (item: Any) => listeners.forEach((fn) => fn(item))
	};
}

describe('the tap source', () => {
	it('emits one shape for the host\'s tap batches and drives the tab through tickets', async () => {
		const { createTapSource } = requireExtension('sources/tap.js');
		const vscode = fakeVscodeGgs({
			'ggs.claudeChat.state': (arg) => (arg && arg.ticket ? { phase: 'sent' } : { phase: 'sent' }),
			'ggs.claudeTap.subscribe': () => ({ ok: true }),
			'ggs.claudeTap.unsubscribe': () => ({ ok: true }),
			'ggs.claudeChat.send': () => ({ ticket: 't1' }),
			'ggs.claudeChat.permission': () => ({ ticket: 't1' }),
			'ggs.claudeChat.remoteState': () => ({ available: true, rc: { status: 'connected', connectUrl: 'https://claude.ai/x', sessionUrl: null, bridgeEpoch: 1 } })
		});
		const events: Any[] = [];
		let changes = 0;
		const tap = createTapSource(vscode, { log: () => undefined, onEvent: (e: Any) => events.push(e), onChange: () => { changes++; } });
		expect(await tap.start()).toBe(true);
		vscode.emit({ dir: 'out', kind: 'sdk', panelId: 1, sessionId: 's1', message: { type: 'io_message', message: { type: 'assistant', content: 'hi' } } });
		vscode.emit({ dir: 'in', kind: 'permission', panelId: 1, sessionId: 's1', message: { type: 'tool_permission_request', toolName: 'Bash' } });
		vscode.emit({ dir: 'out', kind: 'rc', panelId: 1, sessionId: 's1', message: { channelRemoteControlState: { status: 'connected' } } });
		vscode.emit({ dir: 'out', kind: 'gap', panelId: 1, sessionId: null, message: null });
		expect(events.map((e) => [e.kind, e.sessionId, e.dir])).toEqual([
			['sdk', 's1', 'out'],
			['permission', 's1', 'in'],
			['rc', 's1', undefined],
			['gap', undefined, undefined]
		]);
		expect(changes).toBeGreaterThanOrEqual(2); // the sdk and permission events wake the phone
		// A denied subscription answers false and never listens.
		const denied = fakeVscodeGgs({ 'ggs.claudeTap.subscribe': () => ({ ok: false, reason: 'the user declined' }) });
		const deniedTap = createTapSource(denied, { log: () => undefined, onEvent: () => undefined, onChange: () => undefined });
		expect(await deniedTap.start()).toBe(false);
		// The driving half settles the ticket and reads the remote state.
		expect(await tap.send({ sessionId: 's1', text: 'hello' })).toMatchObject({ phase: 'sent' });
		expect(vscode.calls.some(([id]) => id === 'ggs.claudeChat.send')).toBe(true);
		expect(await tap.remoteState({ sessionId: 's1' })).toMatchObject({ available: true });
		tap.stop();
	});

	it('the probe distinguishes a GGS host from VS Code', async () => {
		const { probe } = requireExtension('sources/tap.js');
		expect(await probe(fakeVscodeGgs({ 'ggs.claudeChat.state': () => ({ phase: 'sent' }) }))).toBe(true);
		expect(await probe(fakeVscodeGgs({}))).toBe(false);
	});
});

/* ---------- the sdk host source ---------- */

// A fake `claude` CLI: stream-json in and out, `--permission-prompt-tool stdio` honoured —
// a prompt containing "perm" raises a control_request and proceeds on its response.
const fakeCli = `
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const crypto = require('crypto');
const id = at('--resume') || crypto.randomUUID();
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const dir = require('path').join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
require('fs').mkdirSync(dir, { recursive: true });
const file = require('path').join(dir, id + '.jsonl');
const append = (o) => require('fs').appendFileSync(file, JSON.stringify(o) + '\\n');
write({ type: 'system', subtype: 'init', session_id: id, model: at('--model') || 'fake-1' });
const finish = (prompt) => {
	append({ type: 'user', uuid: crypto.randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
	append({ type: 'assistant', uuid: crypto.randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'fake-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'echo: ' + prompt }] } });
	write({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + prompt, session_id: id });
};
let buffer = '';
let waitingForPermission = null;
process.stdin.on('data', (c) => {
	buffer += c;
	let nl;
	while ((nl = buffer.indexOf('\\n')) >= 0) {
		const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
		let request;
		try { request = JSON.parse(line); } catch { continue; }
		if (request.type === 'control_response') {
			if (waitingForPermission) { const p = waitingForPermission; waitingForPermission = null; finish(p + ' [answered]'); }
			continue;
		}
		const prompt = (request.content ?? []).map((b) => b.text ?? '').join('');
		if (/perm/.test(prompt)) {
			write({ type: 'control_request', request_id: 'pr-1', request: { tool: 'Bash', input: { command: 'rm -rf build' } } });
			waitingForPermission = prompt;
		} else {
			finish(prompt);
		}
	}
});
`;

describe('the sdk host source', () => {
	it('runs a turn end to end: sdk events, session adoption, the permission round trip', async () => {
		const { createSdkHostSource } = requireExtension('sources/sdkHost.js');
		const cli = path.join(home, 'fake-claude.js');
		fs.writeFileSync(cli, fakeCli);
		const events: Any[] = [];
		const source = createSdkHostSource({
			log: () => undefined,
			cliPath: cli,
			defaultRoot: () => root,
			onEvent: (e: Any) => events.push(e),
			onChange: () => undefined,
			spawn: (command: string, args: string[], options: Any) => spawn(command, args, options)
		});
		const result = source.send({ cwd: workspace, text: 'perm please', mode: 'now' });
		await until(() => events, (v) => v.some((e) => e.kind === 'permission'));
		const question = events.find((e) => e.kind === 'permission');
		expect(question.message.request_id).toBe('pr-1');
		// The phone's answer crosses as a control_response on the child's stdin. The lane
		// was remapped to the adopted session id (the CLI announced it in its init).
		expect(source.permission(question.sessionId, { decision: 'allowAlways' })).toBe(true);
		await until(() => events, (v) => v.some((e) => e.kind === 'sdk' && e.message.type === 'result'));
		const init = events.find((e) => e.kind === 'sdk' && e.message.type === 'system');
		expect(init.message.subtype).toBe('init');
		// The session id was adopted, and the transcript the phone reads carries the turn.
		const lane = source.lanes.get(result.sessionId) ?? [...source.lanes.values()].find((l: Any) => l.sessionId);
		expect(lane.sessionId).toBeTruthy();
		const sessions = requireExtension('sessions.js');
		sessions.setHost('ggs');
		expect(sessions.findSession(lane.sessionId)).toBeTruthy();
		source.dispose();
	}, 20000);

	it("a mode picked before the conversation's first turn rides that turn (the preset is not eaten by a default)", async () => {
		const { createSdkHostSource } = requireExtension('sources/sdkHost.js');
		const cli = path.join(home, 'mode-claude.js');
		fs.writeFileSync(cli, fakeCli);
		// Capture the argv the CLI actually receives; the phone picks a mode for a
		// conversation that has no lane yet (naming the draft lane key it was given),
		// then sends the first prompt without any explicit permissionMode.
		const spawned: string[][] = [];
		const source = createSdkHostSource({
			log: () => undefined,
			cliPath: cli,
			defaultRoot: () => root,
			onEvent: () => undefined,
			onChange: () => undefined,
			spawn: (command: string, args: string[], options: Any) => { spawned.push(args); return spawn(command, args, options); }
		});
		expect(source.setMode('draft:modepick1', 'plan')).toBe(true);
		source.send({ draftId: 'modepick1', cwd: workspace, text: 'preset please', mode: 'queue' });
		await until(() => spawned, (v) => v.length > 0);
		expect(spawned[0]).toContain('--permission-mode');
		expect(spawned[0][spawned[0].indexOf('--permission-mode') + 1]).toBe('plan');
		// A turn without any pick carries no mode flag at all (the CLI applies its own
		// default) — and a nonsense pick is refused without touching the CLI.
		source.dispose();
		const plain: string[][] = [];
		const bare = createSdkHostSource({
			log: () => undefined,
			cliPath: cli,
			defaultRoot: () => root,
			onEvent: () => undefined,
			onChange: () => undefined,
			spawn: (command: string, args: string[], options: Any) => { plain.push(args); return spawn(command, args, options); }
		});
		bare.send({ draftId: 'modelss', cwd: workspace, text: 'no pick', mode: 'queue' });
		await until(() => plain, (v) => v.length > 0);
		expect(plain[0]).not.toContain('--permission-mode');
		expect(bare.setMode('draft:modless', 'yolo')).toBe(false);
		bare.dispose();
	}, 20000);

	it('queues behind a running turn and interrupts on "now"', async () => {
		const { createSdkHostSource } = requireExtension('sources/sdkHost.js');
		const slowCli = path.join(home, 'slow-claude.js');
		fs.writeFileSync(slowCli, fakeCli.replace("if (/perm/.test(prompt)) {", "if (/slow/.test(prompt)) { setTimeout(() => finish(prompt), 1200); return; }\n\t\tif (/perm/.test(prompt)) {"));
		const events: Any[] = [];
		const source = createSdkHostSource({
			log: () => undefined,
			cliPath: slowCli,
			defaultRoot: () => root,
			onEvent: (e: Any) => events.push(e),
			onChange: () => undefined,
			spawn: (command: string, args: string[], options: Any) => spawn(command, args, options)
		});
		source.send({ cwd: workspace, text: 'slow one', mode: 'now' });
		const second = source.send({ cwd: workspace, text: 'right away', mode: 'now' }); // interrupts the first
		await until(() => events, (v) => v.filter((e) => e.kind === 'sdk' && e.message.type === 'result').length >= 1, 15000);
		expect(second).toBeTruthy();
		source.dispose();
	}, 25000);
});

/* ---------- the phone's request table ---------- */

describe('the control table', () => {
	beforeAll(() => {
		writeSession(workspace, 'conv-a', [
			{ type: 'user', uuid: 'u1', cwd: workspace, timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'first prompt' } },
			{ type: 'assistant', uuid: 'a1', cwd: workspace, timestamp: '2026-10-01T10:00:01Z', message: { role: 'assistant', model: 'fake-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'first answer' }] } }
		]);
	});

	function makeControl({ tap = null, sdk = null, tabSessions = [] as string[], answer = null as Any, controlAllowed = true, pendingPermission = null as Any }: { tap?: Any; sdk?: Any; tabSessions?: string[]; answer?: Any; controlAllowed?: boolean; pendingPermission?: Any } = {}) {
		const { Runner } = requireExtension('runner.js');
		const { createControl } = requireExtension('control.js');
		const runner = new Runner({ log: () => undefined, onChange: () => undefined, spawn: () => { throw new Error('the control table test never spawns'); } });
		const official = { supported: () => !!tap, state: async () => ({ available: tap ? true : null, status: 'off', connectUrl: null, sessionUrl: null }), toggle: async () => { throw new Error('no official writes in this test'); } };
		return { control: createControl({ log: () => undefined, onChange: () => undefined, folders: () => [{ name: 'workspace', path: workspace }], runner, sdkHost: sdk, tap, desktopTabs: () => new Set(tabSessions), answerQuestion: answer ?? undefined, official, controlAllowed: () => controlAllowed, pendingPermission: pendingPermission ? () => pendingPermission : undefined, onPermissionAnswered: () => undefined }), runner };
	}

	it('answers the session list, the transcript windows and the same/delta contract', async () => {
		const { control } = makeControl();
		const list = await control.dispatch({ t: 'sessions' });
		expect(list.sessions.map((s: Any) => s.id)).toContain('conv-a');
		expect(list.sessions[0].project).toBeTruthy();
		const session = await control.dispatch({ t: 'session', id: 'conv-a' });
		expect(session.items.map((item: Any) => [item.k, item.text])).toEqual([['user', 'first prompt'], ['assistant', 'first answer']]);
		const again = await control.dispatch({ t: 'session', id: 'conv-a', rev: session.rev });
		expect(again.same).toBe(true);
		await expect(control.dispatch({ t: 'session', id: 'nope' })).rejects.toThrow(/no such conversation/);
	});

	it('routes a prompt through the sdk host when no tab is driven, and validates the folder', async () => {
		const sends: Any[] = [];
		const sdk = { send: (arg: Any) => (sends.push(arg), { lane: 'lane-1', sessionId: null }), interrupt: () => true, permission: () => true, setMode: () => true, busy: () => false, dispose: () => undefined };
		const { control } = makeControl({ sdk });
		const result = await control.dispatch({ t: 'send', sessionId: 'conv-a', text: 'go', mode: 'queue' });
		expect(result.via).toBe('sdk');
		expect(sends[0]).toMatchObject({ sessionId: 'conv-a', text: 'go', mode: 'queue' });
		await expect(control.dispatch({ t: 'send', cwd: 'C:\\not-a-workspace', text: 'x' })).rejects.toThrow(/choose an open workspace folder/);
	});

	it("on a tap host every turn rides the conversation's tab — open or not, new conversations included — and never a side CLI", async () => {
		const sends: Any[] = [];
		const stops: Any[] = [];
		const tap = {
			send: async (arg: Any) => (sends.push(arg), { phase: 'sent' }),
			stopTurn: async (arg: Any) => (stops.push(arg), { stopped: true }),
			state: async () => ({ phase: 'sent', busy: false }),
			open: async () => ({ phase: 'sent' }),
			answer: async () => ({ phase: 'sent' }),
			permission: async () => ({ phase: 'sent' }),
			mode: async () => ({ phase: 'sent' }),
			remoteControl: async () => ({ phase: 'sent', rc: null }),
			remoteState: async () => ({ available: true, rc: null })
		};
		// No tab is open for conv-a: the turn still belongs to the tab (the host's send
		// opens it) — a second CLI here would branch the history under the desktop.
		const { control } = makeControl({ tap, sdk: { send: () => { throw new Error('the sdk host must not run beside a tap'); }, interrupt: () => { throw new Error('the sdk host must not run beside a tap'); }, permission: () => false, setMode: () => false, busy: () => false, dispose: () => undefined } });
		const result = await control.dispatch({ t: 'send', sessionId: 'conv-a', text: 'tab please' });
		expect(result.via).toBe('tab');
		expect(sends[0]).toMatchObject({ sessionId: 'conv-a', text: 'tab please' });
		// A brand-new conversation (no session yet) opens a fresh tab through the same send.
		const fresh = await control.dispatch({ t: 'send', cwd: workspace, text: 'a brand new one' });
		expect(fresh.via).toBe('tab');
		expect(sends[1]).toMatchObject({ text: 'a brand new one' });
		expect(sends[1].sessionId).toBeUndefined();
		// Stop reaches the tab's own Stop, keyed by the conversation.
		const stopped = await control.dispatch({ t: 'stop', lane: 'conv-a', sessionId: 'conv-a' });
		expect(stopped.ok).toBe(true);
		expect(stops[0]).toMatchObject({ sessionId: 'conv-a' });
		const permission = await control.dispatch({ t: 'permission', sessionId: 'conv-a', decision: 'allow' });
		expect(permission.ok).toBe(true);
		await expect(control.dispatch({ t: 'permission', sessionId: 'conv-a', decision: 'maybe' })).rejects.toThrow(/decision/);
	});

	it('official mode without mirrorControl serves reads and refuses every action', async () => {
		const tap = {
			send: async () => { throw new Error('the read-only phone never sends'); },
			stopTurn: async () => { throw new Error('read-only'); },
			state: async () => ({ phase: 'sent', busy: false }),
			open: async () => ({}),
			answer: async () => { throw new Error('read-only'); },
			permission: async () => { throw new Error('read-only'); },
			mode: async () => { throw new Error('read-only'); },
			remoteControl: async () => ({}),
			remoteState: async () => ({})
		};
		const { control } = makeControl({ tap, controlAllowed: false });
		await expect(control.dispatch({ t: 'send', sessionId: 'conv-a', text: 'nope' })).rejects.toThrow(/read-only/);
		await expect(control.dispatch({ t: 'stop', lane: 'conv-a' })).rejects.toThrow(/read-only/);
		await expect(control.dispatch({ t: 'permission', sessionId: 'conv-a', decision: 'deny' })).rejects.toThrow(/read-only/);
		// The reads flow exactly as a mirror serves them.
		const list = await control.dispatch({ t: 'sessions' });
		expect(list.sessions.map((entry: Any) => entry.id)).toContain('conv-a');
		const session = await control.dispatch({ t: 'session', id: 'conv-a' });
		expect(session.items.length).toBeGreaterThan(0);
	});

	it("mode.set works on the sdk host — remembered for a lane-less conversation's first turn", async () => {
		const setModes: Any[] = [];
		const MODES = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions', 'manual', 'dontAsk'];
		const sdk = { send: () => ({ lane: 'lane-1', sessionId: null }), interrupt: () => true, permission: () => true, setMode: (sessionId: string, mode: string) => (MODES.includes(mode) ? (setModes.push([sessionId, mode]), true) : false), busy: () => false, dispose: () => undefined };
		const { control } = makeControl({ sdk });
		const pick = await control.dispatch({ t: 'mode', sessionId: 'conv-a', mode: 'acceptEdits' });
		expect(pick.ok).toBe(true);
		expect(setModes[0]).toEqual(['conv-a', 'acceptEdits']);
		// A nonsense mode answers false, never touching the host.
		const bad = await control.dispatch({ t: 'mode', sessionId: 'conv-a', mode: 'yolo' });
		expect(bad.ok).toBe(false);
		expect(setModes).toHaveLength(1);
	});

	it('the session meta carries the pending permission the phone renders as a card', async () => {
		const card = { tool: 'Bash', summary: 'rm -rf build', at: Date.now() };
		const { control } = makeControl({ pendingPermission: card });
		const session = await control.dispatch({ t: 'session', id: 'conv-a' });
		expect(session.session.pendingPermission).toEqual(card);
		const again = await control.dispatch({ t: 'session', id: 'conv-a', rev: session.rev });
		// A same-rev poll still tells the phone about the pending card (it is not part of
		// the transcript revision — it lives beside it).
		expect(again.same).toBe(true);
		expect(again.session.pendingPermission).toEqual(card);
	});

	it('validates the phone\'s question answers against the offered options', async () => {
		writeSession(workspace, 'conv-q', [
			{ type: 'user', uuid: 'uq', cwd: workspace, timestamp: '2026-10-01T11:00:00Z', message: { role: 'user', content: 'pick one' } },
			{ type: 'assistant', uuid: 'aq', cwd: workspace, timestamp: '2026-10-01T11:00:01Z', message: { role: 'assistant', model: 'fake-1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } }] } }
		]);
		const answers: Any[] = [];
		const { control } = makeControl({
			tap: { answer: async (arg: Any) => (answers.push(arg), { phase: 'sent' }), send: async () => ({ phase: 'sent' }), stopTurn: async () => ({}), state: async () => ({ phase: 'sent' }), open: async () => ({}), permission: async () => ({}), mode: async () => ({}), remoteControl: async () => ({}), remoteState: async () => ({}) }, answer: async (arg: Any) => { answers.push(arg); },
			sdk: { send: () => { throw new Error('not here'); }, interrupt: () => false, permission: () => false, setMode: () => false, busy: () => false, dispose: () => undefined }
		});
		const session = await control.dispatch({ t: 'session', id: 'conv-q' });
		const item = session.items.find((i: Any) => i.k === 'tool');
		expect(item.body.kind).toBe('question');
		const good = await control.dispatch({ t: 'answer', id: 'conv-q', item: item.id, answers: [{ picks: ['A'] }] });
		expect(good.ok).toBe(true);
		expect(answers[0].answers[0].picks).toEqual(['A']);
		await expect(control.dispatch({ t: 'answer', id: 'conv-q', item: item.id, answers: [{ picks: ['Z'] }] })).rejects.toThrow(/not one of the offered/);
		await expect(control.dispatch({ t: 'answer', id: 'conv-q', item: item.id, answers: [{ picks: [] }] })).rejects.toThrow(/pick/);
	});
});

/* ---------- the mirror's read-only rules ---------- */

describe('the official-session mirror', () => {
	const mirrorModule = () => requireExtension('mirror.js');

	it('mirrors sdk and permission events verbatim, never the connectUrl by default', () => {
		const { createMirror, cleanse } = mirrorModule();
		const forwarded: Any[] = [];
		const mirror = createMirror({ config: () => ({ mirrorOfficial: 'always', mirrorConnectUrl: false }), log: () => undefined, forward: (payload: Any) => forwarded.push(payload) });
		expect(mirror.offer({ kind: 'sdk', sessionId: 's1', dir: 'out', message: { type: 'io_message', message: { type: 'assistant' } } })).toBe(true);
		expect(mirror.offer({ kind: 'permission', sessionId: 's1', dir: 'in', message: { type: 'tool_permission_request' } })).toBe(true);
		expect(forwarded.map((f) => f.event.kind)).toEqual(['sdk', 'permission']);
		const clean = cleanse({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'connected', connectUrl: 'https://claude.ai/live-key', sessionUrl: 'https://claude.ai/s', bridgeEpoch: 3 } } }, { mirrorConnectUrl: false });
		expect(clean.message).toEqual({ status: 'connected', sessionUrl: 'https://claude.ai/s', bridgeEpoch: 3 });
		expect(JSON.stringify(clean)).not.toContain('live-key');
		const optedIn = cleanse({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'connected', connectUrl: 'https://claude.ai/live-key' } } }, { mirrorConnectUrl: true });
		expect(optedIn.message.connectUrl).toBe('https://claude.ai/live-key');
	});

	it('gates whenConnected on the conversation\'s own state, per conversation', () => {
		const { createMirror } = mirrorModule();
		const forwarded: Any[] = [];
		const mirror = createMirror({ config: () => ({ mirrorOfficial: 'whenConnected', mirrorConnectUrl: false }), log: () => undefined, forward: (payload: Any) => forwarded.push(payload) });
		expect(mirror.offer({ kind: 'sdk', sessionId: 's1', dir: 'out', message: {} })).toBe(false);
		expect(mirror.offer({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'connected' } } })).toBe(true);
		expect(mirror.offer({ kind: 'sdk', sessionId: 's1', dir: 'out', message: {} })).toBe(true);
		// 'connecting' is NOT the end: a mirrored session that re-connects keeps
		// mirroring (a truthy-status delete here used to close the gate on it).
		expect(mirror.offer({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'connecting' } } })).toBe(true);
		expect(mirror.offer({ kind: 'sdk', sessionId: 's1', dir: 'out', message: {} })).toBe(true);
		// Only a terminal state closes it — and the closing event crosses once.
		expect(mirror.offer({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'disconnected' } } })).toBe(true);
		expect(mirror.offer({ kind: 'sdk', sessionId: 's1', dir: 'out', message: {} })).toBe(false);
		expect(mirror.offer({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'connecting' } } })).toBe(false);
		expect(mirror.offer({ kind: 'sdk', sessionId: 's2', dir: 'out', message: {} })).toBe(false);
		expect(forwarded.filter((f) => f.event.kind === 'sdk')).toHaveLength(2);
	});

	it('off mirrors nothing — the official switch is the only stream then', () => {
		const { createMirror } = mirrorModule();
		const forwarded: Any[] = [];
		const mirror = createMirror({ config: () => ({ mirrorOfficial: 'off', mirrorConnectUrl: false }), log: () => undefined, forward: (payload: Any) => forwarded.push(payload) });
		expect(mirror.offer({ kind: 'sdk', sessionId: 's1', dir: 'out', message: {} })).toBe(false);
		expect(mirror.offer({ kind: 'rc', sessionId: 's1', message: { channelRemoteControlState: { status: 'connected' } } })).toBe(false);
		expect(forwarded).toHaveLength(0);
	});

	it('never touches the write path — no official import, no settings writes, no synthesized requests', () => {
		const mirrorSource = fs.readFileSync(path.join(extensionDir, 'mirror.js'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '') // the header explains the rule in prose; the code is what must hold
			.replace(/^\s*\/\/.*$/gm, '');
		expect(mirrorSource).not.toMatch(/official\.js/);
		expect(mirrorSource).not.toMatch(/toggle_remote_control|remoteControlAtStartup|writeFileSync/);
	});
});

/* ---------- the package still packs ---------- */

describe('the VSIX packer', () => {
	it('packs the 2.0 file set and the store validator accepts it', async () => {
		const { validatePackage } = await import('../scripts/fetch-marketplace-extensions.mjs');
		const { execFileSync } = await import('node:child_process');
		const out = path.join(home, 'claude-remote-test.vsix');
		execFileSync(process.execPath, [path.join(extensionDir, 'build.mjs'), '--out', out]);
		expect(fs.existsSync(out)).toBe(true);
		validatePackage(out, { slug: 'claude-remote', engineRequired: false });
	}, 30000);
});

/* ---------- the phone page's crypto (the relay-hosted PWA) ---------- */

describe("the phone page's crypto", () => {
	const phoneCrypto = () => nodeRequire(path.resolve(__dirname, '../claude-remote-server/web/crypto.js'));

	it('derives the same keys, proves the same pairing, and opens what the extension seals', async () => {
		const c = phoneCrypto();
		const K = crypto.randomBytes(32);
		const keys = await c.deriveKeys(K);
		expect(Buffer.from(keys.kE2E).equals(Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from('crr1/e2e'), 32)))).toBe(true);
		const proof = await c.pairProof(keys.kAuth, 'nonce-1', 'u_ph0ne1122334455', 2);
		expect(proof).toBe(crypto.createHmac('sha256', Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from('crr1/auth'), 32))).update('crr1/pair|nonce-1|u_ph0ne1122334455|2').digest('hex'));
		const ext = requireExtension('crypto.js');
		const envelope = { userId: 'u_ph0ne1122334455', epoch: 2, from: 'w_abcdefghijklmnop', to: 'd_1234567890abcdef', seq: 9 };
		// phone opens what the window sealed, and the window opens what the phone sealed
		const fromWindow = ext.sealFrame(Buffer.from(keys.kE2E), envelope, { sessions: true });
		expect(await c.openFrame(keys.kE2E, envelope, fromWindow)).toEqual({ sessions: true });
		const fromPhone = await c.sealFrame(keys.kE2E, { ...envelope, from: 'd_1234567890abcdef', to: 'w_abcdefghijklmnop' }, { t: 'send', text: 'hi' });
		expect(ext.openFrame(Buffer.from(keys.kE2E), { ...envelope, from: 'd_1234567890abcdef', to: 'w_abcdefghijklmnop' }, fromPhone)).toEqual({ t: 'send', text: 'hi' });
	});
});

/* ---------- host conformance (real Node here, ggs-node in node_runtime.rs) ---------- */

describe("host conformance (VS Code's real Node and Git Graph Studio's ggs-node behave alike)", () => {
	it("answers the conformance probe's expected report under real Node", async () => {
		const conformance = nodeRequire(path.join(extensionDir, 'test', 'conformance.js'));
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-conformance-'));
		// Earlier describes stub the relay's fetch; the probe serves its own real server.
		const fetchBefore = globalThis.fetch;
		globalThis.fetch = realFetch;
		try {
			const expected = conformance.expected();
			expect(await conformance.run('crypto')).toEqual(expected.crypto);
			expect(await conformance.run('e2e', work)).toEqual(expected.e2e);
		} finally {
			globalThis.fetch = fetchBefore;
			// Windows: the fake-CLI child's handles can outlive the test by a beat —
			// the scratch dir is in the OS temp either way, a failed sweep is not a failure.
			for (let i = 0; i < 3; i++) {
				try { fs.rmSync(work, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
			}
		}
	}, 60_000);

	it("runs a .js CLI through each host's own Node: real Node itself, Electron as Node, ggs-node through the system node", () => {
		const { nodeExecutable } = nodeRequire(path.join(extensionDir, 'runner.js'));
		const plain: Record<string, string> = {};
		expect(nodeExecutable(plain, { node: '22.0.0' })).toBe(process.execPath);
		expect(plain).toEqual({});
		const electron: Record<string, string> = {};
		expect(nodeExecutable(electron, { node: '22.0.0', electron: '37.0.0' })).toBe(process.execPath);
		expect(electron.ELECTRON_RUN_AS_NODE).toBe('1');
		const ggs: Record<string, string> = {};
		expect(nodeExecutable(ggs, { node: '22.0.0-ggs', ggs: 'node-runtime' })).toBe('node');
		expect(ggs).toEqual({});
	});
});
