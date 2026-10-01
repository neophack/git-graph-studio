// @vitest-environment node
// The Claude Remote extension, headless: the store reader, the runner and the encrypted
// LAN server run here exactly as the extension wires them (only activate() needs
// `vscode`), against a fixture HOME and a fake `claude` CLI. The client half is the
// phone's own crypto — the vendored sjcl — so every assertion about the wire is an
// assertion about what a real phone sends and accepts.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../scripts/fetch-marketplace-extensions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const extensionDir = path.resolve(__dirname, '../extensions-src/claude-remote');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const sjcl: Any = nodeRequire(path.join(extensionDir, 'sjcl.js'));

let home = '';
let root = '';
let workspace = '';
let otherProject = '';
let core: Any;
let runner: Any;
let live: Any;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH };
// A developer machine may export a provider bridge's whole env (Git Graph Studio's own
// setup does); the harness runs as the official service unless a test writes provider
// settings into the root, so those keys are saved and scrubbed for the suite's lifetime.
const PROVIDER_ENV_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
for (const k of PROVIDER_ENV_KEYS) savedEnv[k] = process.env[k];

const munge = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const line = (o: unknown) => JSON.stringify(o) + '\n';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
	const start = Date.now();
	let value = await probe();
	while (!ok(value)) {
		if (Date.now() - start > ms) throw new Error('timed out waiting; last value: ' + JSON.stringify(value).slice(0, 400));
		await sleep(80);
		value = await probe();
	}
	return value;
}

// A fake `claude`: reads the prompt from stdin, announces the session (stream-json init),
// appends the turn to the session file the real CLI would write, and answers. A prompt
// containing "slow" takes 1.5 s, so queueing and interrupting are observable.
const fakeClaude = `
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
// the real CLI's choices (2.1.x has no "default": passing it fails the turn)
const mode = at('--permission-mode');
if (mode !== null && !['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'].includes(mode)) {
	process.stderr.write("error: option '--permission-mode <mode>' argument '" + mode + "' is invalid");
	process.exit(1);
}
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
	const id = at('--resume') || crypto.randomUUID();
	const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, id + '.jsonl');
	const now = new Date().toISOString();
	const model = at('--model') || 'fake-model-1';
	process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, permissionMode: mode || 'default', model }) + '\\n');
	fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cwd: process.cwd(), timestamp: now, message: { role: 'user', content: prompt } }) + '\\n');
	setTimeout(() => {
		fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'assistant', model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'echo[' + (mode || 'default') + ']: ' + prompt }] } }) + '\\n');
		process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + prompt, session_id: id, total_cost_usd: 0.001 }) + '\\n');
	}, /slow/.test(prompt) ? 1500 : 50);
});
`;

/* ---------- the phone's crypto (sjcl), as web/app.js does it ---------- */
const utf8 = (s: string) => sjcl.codec.utf8String.toBits(s);
const bitsFromB64u = (s: string) => sjcl.codec.base64.toBits(s.replace(/-/g, '+').replace(/_/g, '/'));
const b64uFromBits = (b: unknown) => sjcl.codec.base64.fromBits(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type PhoneOpts = { ts?: number; nonce?: string; raw?: boolean; dev?: { id: string; label: string } };
type Phone = { kid: string; prp: Any; call: (m: string, p?: object, opts?: PhoneOpts) => Promise<Any> };
async function phone(code: string): Promise<Phone> {
	const hello = await (await fetch(`http://127.0.0.1:${live.port}/api/hello`)).json();
	const prp = new sjcl.cipher.aes(sjcl.misc.pbkdf2(utf8(code), bitsFromB64u(hello.salt), hello.iterations, 256));
	const kid = hello.kid;
	const call = async (m: string, p: object = {}, opts: PhoneOpts = {}) => {
		const n = opts.nonce ?? crypto.randomBytes(16).toString('hex');
		const iv = sjcl.codec.hex.toBits(crypto.randomBytes(12).toString('hex'));
		const body = { m, p, ts: opts.ts ?? Date.now(), n, dev: opts.dev ?? { id: 'test-device-01', label: 'Vitest Phone' } };
		const ct = sjcl.mode.gcm.encrypt(prp, utf8(JSON.stringify(body)), iv, utf8('cr2:req:' + kid), 128);
		const res = await fetch(`http://127.0.0.1:${live.port}/api/rpc`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kid, i: b64uFromBits(iv), d: b64uFromBits(ct) })
		});
		const env = await res.json();
		if (!env.d) return { status: res.status, plain: env };
		const pt = sjcl.mode.gcm.decrypt(prp, bitsFromB64u(env.d), bitsFromB64u(env.i), utf8('cr2:res:' + n), 128);
		const out = JSON.parse(sjcl.codec.utf8String.fromBits(pt));
		if (opts.raw) return { status: res.status, out, env };
		if (!out.ok) throw new Error(out.error);
		return out.r;
	};
	return { kid, prp, call };
}

let ph: Phone;
const desktopOpen: string[] = ['conv-a'];
const desktopOpened: string[] = [];

beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-home-'));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	root = path.join(home, '.claude');
	process.env.CLAUDE_CONFIG_DIR = root;
	workspace = path.join(home, 'work', 'my-app');
	otherProject = path.join(home, 'work', 'elsewhere');
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(otherProject, { recursive: true });
	const cli = path.join(home, 'fake-claude.js');
	fs.writeFileSync(cli, fakeClaude);
	process.env.CLAUDE_CLI_PATH = cli;
	for (const k of PROVIDER_ENV_KEYS) delete process.env[k];

	const wsDir = path.join(root, 'projects', munge(workspace));
	fs.mkdirSync(wsDir, { recursive: true });
	const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
	fs.writeFileSync(path.join(wsDir, 'conv-a.jsonl'), [
		line({ type: 'user', uuid: 'a1', cwd: workspace, gitBranch: 'main', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '<ide_selection>The user selected lines in src/main.ts</ide_selection>first question' }] } }),
		line({ type: 'assistant', uuid: 'a2', cwd: workspace, timestamp: '2026-01-01T10:00:05Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'first **answer**' }] } }),
		line({ type: 'ai-title', aiTitle: 'Fixture conversation A' })
	].join(''));
	fs.writeFileSync(path.join(wsDir, 'conv-b.jsonl'), [
		line({ type: 'user', uuid: 'b1', cwd: workspace, timestamp: '2026-01-02T10:00:00Z', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'what is in this image?' }] } }),
		line({ type: 'assistant', uuid: 'b2', cwd: workspace, timestamp: '2026-01-02T10:00:02Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me look' }] } }),
		line({ type: 'assistant', uuid: 'b3', cwd: workspace, timestamp: '2026-01-02T10:00:03Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] } }),
		line({ type: 'user', uuid: 'b4', cwd: workspace, timestamp: '2026-01-02T10:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(5000) }] } }),
		line({ type: 'assistant', uuid: 'b5', cwd: workspace, timestamp: '2026-01-02T10:00:05Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: path.join(workspace, 'src', 'a.ts'), old_string: 'old', new_string: 'new' } }] } }),
		line({ type: 'user', uuid: 'b6', cwd: workspace, timestamp: '2026-01-02T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'edited', is_error: false }] } }),
		line({ type: 'assistant', uuid: 'b7', cwd: workspace, timestamp: '2026-01-02T10:00:07Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'it is a png header' }] } })
	].join(''));
	const otherDir = path.join(root, 'projects', munge(otherProject));
	fs.mkdirSync(otherDir, { recursive: true });
	fs.writeFileSync(path.join(otherDir, 'conv-other.jsonl'), line({ type: 'user', uuid: 'o1', cwd: otherProject, timestamp: '2026-01-03T10:00:00Z', message: { role: 'user', content: 'other project prompt' } }));

	core = nodeRequire(path.join(extensionDir, 'extension.js')).__core;
	runner = new core.Runner({ cliPath: cli, defaultRoot: () => root, externalBusy: (id: string) => core.sessions.desktopBusy(core.sessions.findSession(id)) });
	live = await core.server.startServer({
		pairing: core.server.newPairing(), port: 0, host: '127.0.0.1', runner, folders: () => [{ name: 'my-app', path: workspace }], baseDir: extensionDir,
		desktopTabs: () => desktopOpen, openDesktopTab: async (id: string) => { desktopOpened.push(id); }
	});
	ph = await phone(live.pairing.code);
});

afterAll(async () => {
	runner?.dispose();
	if (live) await live.stop();
	for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	fs.rmSync(home, { recursive: true, force: true });
});

describe('pairing material', () => {
	it('a pairing is a 120-bit Crockford code, a salt and a key id; the link carries it in the fragment', () => {
		const p = core.server.newPairing();
		expect(p.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
		expect(core.server.validPairing(p)).toBe(true);
		expect(core.server.newPairing().code).not.toBe(p.code);
		expect(core.server.pairingUrl('192.168.1.5', 45321, p.code)).toBe('http://192.168.1.5:45321/#p=' + p.code);
		expect(core.server.codeFromHash('#p=' + p.code.toLowerCase())).toBe(p.code);
		expect(core.server.codeFromHash('#/some/path')).toBe(null);
		expect(core.server.codeFromHash('')).toBe(null);
	});

	it('the panel QR is the encoder’s exact module matrix inside a 4-module quiet zone', () => {
		const url = 'http://192.168.1.5:45321/#p=ABCD-EFGH-JKMN-PQRS-TVWX-YZ01';
		const svg = core.qrSvg(url, 216);
		const qr = nodeRequire(path.join(extensionDir, 'qrcode.js'))(0, 'M');
		qr.addData(url, 'Byte');
		qr.make();
		let dark = 0;
		for (let r = 0; r < qr.getModuleCount(); r++) for (let c = 0; c < qr.getModuleCount(); c++) if (qr.isDark(r, c)) dark++;
		expect((svg.match(/<rect /g) ?? []).length - 1).toBe(dark);
		expect(svg).toContain('<rect x="0" y="0" width="1" height="1"/>');
		expect(core.qrSvg(url, 216)).toBe(svg);
	});

	it('the panel page carries the reset action and never shows the code unmasked by default', () => {
		const html = core.panelHtml('zh-cn', { running: true, port: 1, urls: [], code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', kid: 'abcdefabcdef', createdAt: 0, devices: [], summary: { running: 0, queued: 0, activity: [] }, folders: [], cli: 'claude', roots: [] });
		expect(html).toContain('resetKey');
		expect(html).toContain('重置配对密钥');
		expect(html).toContain('replace(/[0-9A-Z]/g, "•")');
		const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
		expect(() => new Function(script)).not.toThrow();
	});

	it('the panel page declares a restrictive CSP and cannot be broken out of by hostile state', () => {
		// The panel is one inline document by design (both hosts inject inline boot code into
		// it), so script/style stay 'unsafe-inline' — but nothing may load or connect.
		const hostile = {
			running: true, port: 1, urls: [], code: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01', kid: 'abcdefabcdef', createdAt: 0,
			devices: [{ id: 'd1', label: '</script><img onerror=alert(1)>', ip: '1.2.3.4', online: true, lastSeen: 1, firstSeen: 1, requests: 1 }],
			summary: { running: 0, queued: 0, activity: [{ kind: 'send', at: 1, text: '</script><script>alert(2)</script>', device: '<b>x</b>' }] },
			folders: [], cli: 'claude', roots: []
		};
		const html = core.panelHtml('en', hostile);
		expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">');
		// the initial state crosses as JSON with every < escaped: no </script> breakout
		const embedded = html.slice(html.indexOf('let state = ') + 12, html.indexOf(';\n\tlet revealed'));
		expect(embedded).not.toContain('</script>');
		expect(embedded).toContain('\\u003c');
	});
});

describe('the sealed wire', () => {
	it('hello answers through AES-GCM with the desktop’s workspace', async () => {
		const info = await ph.call('hello');
		expect(info.protocol).toBe(4);
		expect(info.workspace).toEqual([{ name: 'my-app', path: workspace }]);
		expect(live.devices()[0]).toMatchObject({ label: 'Vitest Phone', online: true });
	});

	it('a wrong code fails closed (401 auth), a stale key id is told to re-pair (401 rekeyed)', async () => {
		const wrong = await phone('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
		const res = await wrong.call('hello');
		expect(res).toEqual({ status: 401, plain: { error: 'auth' } });
		const res2 = await fetch(`http://127.0.0.1:${live.port}/api/rpc`, { method: 'POST', body: JSON.stringify({ kid: '000000000000', i: 'x', d: 'y' }) });
		expect(res2.status).toBe(401);
		expect(await res2.json()).toEqual({ error: 'rekeyed' });
	});

	it('a replayed nonce and an out-of-window clock are rejected', async () => {
		const nonce = crypto.randomBytes(16).toString('hex');
		await ph.call('hello', {}, { nonce });
		expect(await ph.call('hello', {}, { nonce })).toEqual({ status: 401, plain: { error: 'replay' } });
		expect(await ph.call('hello', {}, { ts: Date.now() - 10 * 60 * 1000 })).toEqual({ status: 401, plain: { error: 'clock' } });
	});

	it('the answer is bound to its request nonce (AAD): it cannot be opened as another call’s answer', async () => {
		const { env } = await ph.call('hello', {}, { raw: true });
		expect(() => sjcl.mode.gcm.decrypt(ph.prp, bitsFromB64u(env.d), bitsFromB64u(env.i), utf8('cr2:res:someone-else'), 128)).toThrow();
	});

	it('serves the phone app with a strict CSP, and the app script parses', async () => {
		const page = await fetch(`http://127.0.0.1:${live.port}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
		expect(page.headers.get('referrer-policy')).toBe('no-referrer');
		const html = await page.text();
		expect(html).toContain('/sjcl.js');
		expect(html).not.toMatch(/<script>[^<]/); // no inline script
		const app = await (await fetch(`http://127.0.0.1:${live.port}/app.js`)).text();
		expect(() => new Function(app)).not.toThrow();
		expect(app).toContain('history.replaceState'); // the fragment code is stripped after reading
		expect(app).not.toContain('crypto.subtle');
		expect((await fetch(`http://127.0.0.1:${live.port}/sjcl.js`)).status).toBe(200);
		expect((await fetch(`http://127.0.0.1:${live.port}/../server.js`)).status).toBe(404);
	});
});

describe('the sealed wire: envelope hardening', () => {
	// None of these consume the shared server's failure budget (the lockout tests count on
	// it): a 400 bad call / 401 clock / 401 replay / 404 never reaches fail(). The one test
	// that must fail repeatedly starts its own server.

	it('/api/hello answers exactly the KDF parameters — never the code', async () => {
		const hello = await (await fetch(`http://127.0.0.1:${live.port}/api/hello`)).json();
		expect(Object.keys(hello).sort()).toEqual(['iterations', 'kid', 'now', 'protocol', 'salt']);
		expect(JSON.stringify(hello)).not.toContain(live.pairing.code);
	});

	it('nonce shape is checked before anything counts: 15/65-char nonces get a plain 400', async () => {
		expect(await ph.call('hello', {}, { nonce: 'a'.repeat(15) })).toEqual({ status: 400, plain: { error: 'bad call' } });
		expect(await ph.call('hello', {}, { nonce: 'a'.repeat(65) })).toEqual({ status: 400, plain: { error: 'bad call' } });
		expect((await ph.call('hello')).protocol).toBe(core.server.PROTOCOL); // the address is not a whit closer to locked
	});

	it('the clock window is exactly ±5 minutes', async () => {
		// 2s inside the margin for timer slop: within passes, just past is told 'clock'
		expect((await ph.call('hello', {}, { ts: Date.now() - (5 * 60 * 1000 - 2000) })).protocol).toBe(core.server.PROTOCOL);
		expect((await ph.call('hello', {}, { ts: Date.now() - (5 * 60 * 1000 + 2000) }))).toEqual({ status: 401, plain: { error: 'clock' } });
		expect((await ph.call('hello', {}, { ts: Date.now() + (5 * 60 * 1000 + 2000) }))).toEqual({ status: 401, plain: { error: 'clock' } });
	});

	it('an answer sealed under one nonce cannot be opened as another call’s answer', async () => {
		const na = crypto.randomBytes(16).toString('hex');
		const nb = crypto.randomBytes(16).toString('hex');
		const a = await ph.call('hello', {}, { nonce: na, raw: true });
		const b = await ph.call('hello', {}, { nonce: nb, raw: true });
		expect(JSON.parse(sjcl.codec.utf8String.fromBits(sjcl.mode.gcm.decrypt(ph.prp, bitsFromB64u(a.env.d), bitsFromB64u(a.env.i), utf8('cr2:res:' + na), 128))).ok).toBe(true);
		expect(JSON.parse(sjcl.codec.utf8String.fromBits(sjcl.mode.gcm.decrypt(ph.prp, bitsFromB64u(b.env.d), bitsFromB64u(b.env.i), utf8('cr2:res:' + nb), 128))).ok).toBe(true);
		// the same ciphertext under the other call's nonce: the AAD binds the answer to its request
		expect(() => sjcl.mode.gcm.decrypt(ph.prp, bitsFromB64u(a.env.d), bitsFromB64u(a.env.i), utf8('cr2:res:' + nb), 128)).toThrow();
	});

	it('GET /api/rpc answers 404; an unknown method answers a sealed 404', async () => {
		expect((await fetch(`http://127.0.0.1:${live.port}/api/rpc`)).status).toBe(404);
		const res = await ph.call('no-such-method', {}, { raw: true });
		expect(res.status).toBe(404);
		expect(res.out).toEqual({ ok: false, error: 'unknown method' }); // sealed: the phone could decrypt it
	});

	it('encoded traversal variants never reach the static map', async () => {
		for (const bad of ['/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2fserver.js', '/..%5cserver.js', '//server.js', '/\\server.js']) {
			expect((await fetch(`http://127.0.0.1:${live.port}${bad}`)).status).toBe(404);
		}
		expect((await fetch(`http://127.0.0.1:${live.port}/sjcl.js`)).status).toBe(200);
	});

	it('a body over 2 MB is cut off and the server lives on', async () => {
		let status: number | null = null;
		try {
			const res = await fetch(`http://127.0.0.1:${live.port}/api/rpc`, { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024) });
			status = res.status;
		} catch { /* the server destroys the socket after answering 413 */ }
		expect([413, null]).toContain(status);
		expect((await fetch(`http://127.0.0.1:${live.port}/api/hello`)).status).toBe(200);
	});

	it('/api/hello is unauthenticated and cheap — a burst does not feed the lockout', async () => {
		for (let i = 0; i < 40; i++) expect((await fetch(`http://127.0.0.1:${live.port}/api/hello`)).status).toBe(200);
		expect((await ph.call('hello')).protocol).toBe(4);
	});

	it('a malformed JSON envelope counts toward the lockout', async () => {
		// A fresh server: the shared one's failure counter belongs to the brute-force tests
		const own = await core.server.startServer({
			pairing: core.server.newPairing(), port: 0, host: '127.0.0.1', runner,
			folders: () => [{ name: 'my-app', path: workspace }], baseDir: extensionDir
		});
		try {
			const url = `http://127.0.0.1:${own.port}/api/rpc`;
			const post = (body: string) => fetch(url, { method: 'POST', body });
			for (let i = 0; i < 10; i++) expect((await post('not json ' + i)).status).toBe(400);
			expect((await post('not json 11')).status).toBe(429);
		} finally {
			await own.stop();
		}
	});
});

describe('paired device labels', () => {
	it('a label is stored without control characters and bounded to 60', async () => {
		await ph.call('hello', {}, { dev: { id: 'label-probe-01', label: 'bad\nlabel\u0007x' } });
		expect(live.devices().find((d: Any) => d.id === 'label-probe-01')).toMatchObject({ label: 'badlabelx' });
		await ph.call('hello', {}, { dev: { id: 'label-probe-02', label: 'x'.repeat(30) + '\n'.repeat(10) + 'y'.repeat(30) } });
		const stored = live.devices().find((d: Any) => d.id === 'label-probe-02')!;
		expect(stored.label).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(stored.label.length).toBeLessThanOrEqual(60);
	});

	it('the device table stays bounded however many ids a paired device claims', async () => {
		for (let i = 0; i < 60; i++) {
			await ph.call('hello', {}, { dev: { id: 'churn-' + String(i).padStart(2, '0') + 'x', label: 'churn ' + i } });
		}
		const devices = live.devices();
		expect(devices.length).toBeLessThanOrEqual(50);
		expect(devices.some((d: Any) => d.id === 'churn-59x')).toBe(true); // the caller is never the one evicted
	});
});

describe('the conversation store', () => {
	it('lists the workspace’s sessions by default and every project with scope=all', async () => {
		const ws = await ph.call('sessions', {});
		expect(ws.scope).toBe('workspace');
		expect(ws.sessions.map((s: Any) => s.id).sort()).toEqual(['conv-a', 'conv-b']);
		const a = ws.sessions.find((s: Any) => s.id === 'conv-a');
		expect(a).toMatchObject({ title: 'Fixture conversation A', branch: 'main', preview: 'first answer', previewRole: 'assistant', project: 'my-app' });
		const all = await ph.call('sessions', { scope: 'all' });
		expect(all.sessions.map((s: Any) => s.id)).toContain('conv-other');
		const q = await ph.call('sessions', { scope: 'all', q: 'png header' });
		expect(q.sessions.map((s: Any) => s.id)).toEqual(['conv-b']);
	});

	it('the transcript: summaries sync; bodies and results are fetched when a row is opened, never synced', async () => {
		const a = await ph.call('session', { id: 'conv-a' });
		expect(a.items[0]).toMatchObject({ k: 'user', text: 'first question', chips: ['selection: main.ts'] });
		const b = await ph.call('session', { id: 'conv-b' });
		const kinds = b.items.map((i: Any) => i.k);
		expect(kinds).toEqual(['user', 'thinking', 'tool', 'tool', 'assistant']);
		const bash = b.items[2];
		expect(bash).toMatchObject({ name: 'Bash', sum: 'List files', st: 'ok' });
		expect(bash.body).toEqual({ kind: 'code' }); // the wire carries the kind, not the text
		expect(bash.res.text).toBeUndefined();
		expect(bash.res.more).toBe(true);
		const opened = await ph.call('tool', { id: 'conv-b', item: bash.id });
		expect(opened.body).toEqual({ kind: 'code', text: 'ls -la' });
		expect(opened.res.text.length).toBe(3000);
		const edit = b.items[3];
		expect(edit.sum).toBe('src/a.ts');
		expect((await ph.call('tool', { id: 'conv-b', item: edit.id })).body).toEqual({ kind: 'diff', text: '- old\n+ new' });
		expect((await ph.call('detail', { id: 'conv-b', item: bash.id })).text.length).toBe(5000);
		const img = await ph.call('image', { id: 'conv-b', ref: b.items[0].imgs[0] });
		expect(img.mime).toBe('image/png');
		await expect(ph.call('tool', { id: 'conv-b', item: 'no-such-item' })).rejects.toThrow(/no such item/);
	});

	it('polling is incremental: an unchanged file answers same:true; a cursor returns only what changed', async () => {
		const first = await ph.call('session', { id: 'conv-a' });
		expect(first.delta).toBe(false); // a first read is a full window
		const again = await ph.call('session', { id: 'conv-a', rev: first.rev, cur: first.cur });
		expect(again.same).toBe(true);
		const file = path.join(root, 'projects', munge(workspace), 'conv-a.jsonl');
		fs.appendFileSync(file, line({ type: 'user', uuid: 'a3', cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'user', content: 'follow-up from the desktop' } }));
		const next = await ph.call('session', { id: 'conv-a', rev: first.rev, cur: first.cur });
		expect(next.same).toBeUndefined();
		expect(next.delta).toBe(true);
		expect(next.items.map((i: Any) => i.k)).toEqual(['user']); // the appended record only
		expect(next.items.at(-1)).toMatchObject({ k: 'user', text: 'follow-up from the desktop' });
		expect(next.cur.since).toBeGreaterThan(first.cur.since);
		expect(next.desktopBusy).toBe(true); // a fresh human prompt with no answer yet: mid-turn
		fs.appendFileSync(file, line({ type: 'assistant', uuid: 'a4', cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }));
		const settled = await ph.call('session', { id: 'conv-a', cur: next.cur });
		expect(settled.items.map((i: Any) => i.k)).toEqual(['assistant']);
		expect(settled.desktopBusy).toBe(false);
		// a cursor from another parse of the file (rebuilt cache, widened window) gets the full window
		const full = await ph.call('session', { id: 'conv-a', cur: { gen: 999999, since: 0 } });
		expect(full.delta).toBe(false);
		expect(full.items.map((i: Any) => i.k)).toEqual(['user', 'assistant', 'user', 'assistant']);
	});

	it('a tool result is a delta: the mutated row re-sends, still without its text', async () => {
		const file = path.join(root, 'projects', munge(workspace), 'conv-b.jsonl');
		const base = await ph.call('session', { id: 'conv-b' });
		fs.appendFileSync(file, line({ type: 'assistant', uuid: 'b8', cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: path.join(workspace, 'x.ts') } }] } }));
		const d1 = await ph.call('session', { id: 'conv-b', rev: base.rev, cur: base.cur });
		expect(d1.items.filter((i: Any) => i.k === 'tool').map((i: Any) => i.st)).toEqual(['run']);
		fs.appendFileSync(file, line({ type: 'user', uuid: 'b9', cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: '42 lines' }] } }));
		const d2 = await ph.call('session', { id: 'conv-b', cur: d1.cur });
		const tools = d2.items.filter((i: Any) => i.k === 'tool');
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ st: 'ok', name: 'Read' });
		expect(tools[0].res.text).toBeUndefined(); // opened rows fetch; the delta still carries no text
		expect((await ph.call('tool', { id: 'conv-b', item: tools[0].id })).res).toMatchObject({ text: '42 lines', more: false });
	});

	it('a long conversation opens from its tail and pages back on demand', async () => {
		const dir = path.join(root, 'projects', munge(workspace));
		const file = path.join(dir, 'conv-long.jsonl');
		// 400 turns ≈ 1.2 MB — past the cold-tail window, so a cold open parses only the
		// tail (this is what made long conversations load slowly: every open re-parsed the
		// whole file) and older history parses when a page before the held window is asked.
		let body = '';
		for (let i = 0; i < 400; i++) {
			body += line({ type: 'user', uuid: `lu${i}`, cwd: workspace, timestamp: '2026-01-05T10:00:00Z', message: { role: 'user', content: 'question '.repeat(80) + i } });
			body += line({ type: 'assistant', uuid: `la${i}`, cwd: workspace, timestamp: '2026-01-05T10:00:01Z', message: { role: 'assistant', model: 'm-final', stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer '.repeat(80) + i }] } });
		}
		fs.writeFileSync(file, body);
		try {
			const first = await ph.call('session', { id: 'conv-long' });
			expect(first.total).toBeLessThan(800); // the tail, not the whole history
			expect(first.hasMore).toBe(true);
			expect(first.items.at(-1).text).toContain('399');
			// the tail parse is the steady state: a same-cursor poll answers same
			const same = await ph.call('session', { id: 'conv-long', rev: first.rev, cur: first.cur });
			expect(same.same).toBe(true);
			// a wider window parses history backward on demand — stamps stay increasing in
			// file order (prepended history counts down below the tail's stamps), and the
			// whole conversation is reachable
			const wide = await ph.call('session', { id: 'conv-long', limit: 3900 });
			expect(wide.total).toBe(800);
			expect(wide.hasMore).toBe(false);
			expect(wide.items[0].text).toContain('question');
			const stamps = wide.items.map((i: Any) => i.q);
			expect([...stamps].sort((a: number, b: number) => a - b)).toEqual(stamps);
			// a before-page returns one page older than the held window, as a merge (delta),
			// and never disturbs the delta cursor: what appended since still arrives
			const oldest = first.items[0].q;
			const page = await ph.call('session', { id: 'conv-long', cur: first.cur, before: oldest });
			expect(page.delta).toBe(true);
			expect(page.items.length).toBeGreaterThan(0);
			expect(page.items.every((i: Any) => i.q < oldest)).toBe(true);
			expect(page.hasMore).toBe(true);
			fs.appendFileSync(file, line({ type: 'user', uuid: 'lu-new', cwd: workspace, timestamp: '2026-01-05T11:00:00Z', message: { role: 'user', content: 'appended meanwhile' } }));
			const delta = await ph.call('session', { id: 'conv-long', cur: first.cur });
			expect(delta.items.map((i: Any) => i.text)).toEqual(['appended meanwhile']);
		} finally {
			fs.rmSync(file);
		}
	});
});

describe('a pending AskUserQuestion, answered from the phone', () => {
	// The phone's question card. The fixture is the shape the real tool writes (the exact
	// payload of a live session), and the fake `answerQuestion` stands in for Git Graph
	// Studio clicking the conversation's own card — which then writes the tool_result a
	// real tab writes, and the card flips to answered on the next poll.
	const file = () => path.join(root, 'projects', munge(workspace), 'conv-q.jsonl');
	const askToolUse = line({
		type: 'assistant', uuid: 'qu1', cwd: workspace, timestamp: '2026-01-06T10:00:01Z',
		message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tuq1', name: 'AskUserQuestion', input: {
			questions: [
				{ question: 'VS Code 兼容性验证做到什么程度？', header: 'VS Code 验证', options: [{ label: '自动化测试级验证', description: '快，覆盖命令面' }, { label: '自动化 + 实机安装验证', description: '慢，但真实' }], multiSelect: false },
				{ question: '本次工作完成后如何提交？', header: '提交策略', options: [{ label: '一次提交', description: '一个完整的提交' }, { label: '分步提交', description: '按阶段拆分' }], multiSelect: true }
			]
		} }] }
	});
	const asked: { sessionId: string; item: string; answers: Any[] }[] = [];
	let own: Any;
	let p: Phone;
	// phone() and call() address the global `live`'s port; this server is its own, so the
	// global is rebound for this describe's lifetime (the pattern the regressions describe
	// uses for the second workspace folder).
	let savedLive: Any;

	beforeAll(async () => {
		fs.writeFileSync(file(), [
			line({ type: 'user', uuid: 'q0', cwd: workspace, timestamp: '2026-01-06T10:00:00Z', message: { role: 'user', content: '帮我决定提交方式' } }),
			askToolUse
		].join(''));
		own = await core.server.startServer({
			pairing: core.server.newPairing(), port: 0, host: '127.0.0.1', runner,
			folders: () => [{ name: 'my-app', path: workspace }], baseDir: extensionDir,
			answerQuestion: async ({ sessionId, item, answers }: { sessionId: string; item: string; answers: Any[] }) => { asked.push({ sessionId, item, answers }); }
		});
		savedLive = live;
		live = own;
		p = await phone(own.pairing.code);
	});
	afterAll(async () => {
		live = savedLive;
		fs.rmSync(file(), { force: true });
		await own.stop();
	});
	const questionItem = async () => (await p.call('session', { id: 'conv-q' })).items.find((i: Any) => i.k === 'tool' && i.name === 'AskUserQuestion');

	it('the question rides the sync whole — its options, not a lazy body', async () => {
		const item = await questionItem();
		expect(item).toMatchObject({ name: 'AskUserQuestion', st: 'run' });
		expect(item.sum).toContain('VS Code 兼容性验证');
		expect(item.body.kind).toBe('question'); // the one body the sync does not strip
		expect(item.body.questions).toHaveLength(2);
		expect(item.body.questions[0]).toMatchObject({ header: 'VS Code 验证', multi: false, q: 'VS Code 兼容性验证做到什么程度？' });
		expect(item.body.questions[0].opts).toEqual([
			{ label: '自动化测试级验证', desc: '快，覆盖命令面' },
			{ label: '自动化 + 实机安装验证', desc: '慢，但真实' }
		]);
		expect(item.body.questions[1]).toMatchObject({ header: '提交策略', multi: true });
	});

	it('answer validates the picks against the offered options before the desktop sees them', async () => {
		const item = await questionItem();
		const bad = (answers: Any) => p.call('answer', { id: 'conv-q', item: item.id, answers });
		await expect(bad([])).rejects.toThrow(/every question/);
		await expect(bad([{ question: 'x', header: 'x', picks: ['一次提交'] }])).rejects.toThrow(/every question/); // one of two
		await expect(bad([{ question: 'x', header: 'x', picks: [] }, { question: 'y', header: 'y', picks: ['一次提交'] }])).rejects.toThrow(/pick exactly one option/); // the empty pick is on the single-choice question
		await expect(bad([{ question: 'x', header: 'x', picks: ['自动化测试级验证'] }, { question: 'y', header: 'y', picks: [] }])).rejects.toThrow(/pick at least one option/); // …and the empty multi-choice question
		await expect(bad([{ question: 'x', header: 'x', picks: ['自动化', '实机'] }, { question: 'y', header: 'y', picks: ['一次提交'] }])).rejects.toThrow(/pick exactly one option/); // a radio keeps one
		await expect(bad([{ question: 'x', header: 'x', picks: ['自动化'] }, { question: 'y', header: 'y', picks: ['一次提交'] }])).rejects.toThrow(/not one of the offered options/); // a label the card never offered (a prefix is not the label)
		await expect(bad([{ question: 'x', header: 'x', picks: ['Other'] }, { question: 'y', header: 'y', picks: ['一次提交'] }])).rejects.toThrow(/needs its text/);
		await expect(p.call('answer', { id: 'conv-q', item: 'no-such-item', answers: [] })).rejects.toThrow(/no such item/);
		await expect(p.call('answer', { id: 'nope', item: 'x', answers: [] })).rejects.toThrow(/no such conversation/);
		expect(asked).toEqual([]); // none of it reached the desktop
		// a host without the tab (the headless CLI backend — the shared server) refuses outright
		live = savedLive; // ph is paired to the shared server; address it, not `own`
		const shared = await ph.call('session', { id: 'conv-q' });
		await expect(ph.call('answer', { id: 'conv-q', item: shared.items.find((i: Any) => i.k === 'tool').id, answers: [{ question: 'x', header: 'x', picks: ['自动化测试级验证'] }, { question: 'y', header: 'y', picks: ['一次提交'] }] })).rejects.toThrow(/needs the desktop/);
		live = own;
	});

	it('the phone’s picks reach the conversation’s tab, and the landing result flips the card', async () => {
		const item = await questionItem();
		const answers = item.body.questions.map((q: Any, i: number) => ({ question: q.q, header: q.header, picks: i === 0 ? [q.opts[0].label] : ['Other'], other: i === 0 ? undefined : '看情况再定' }));
		await p.call('answer', { id: 'conv-q', item: item.id, answers });
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ sessionId: 'conv-q', item: item.id });
		expect(asked[0].answers[0].picks).toEqual(['自动化测试级验证']);
		expect(asked[0].answers[1]).toMatchObject({ picks: ['Other'], other: '看情况再定' });
		// the tab's answer lands on disk the way a real one does
		fs.appendFileSync(file(), line({ type: 'user', uuid: 'q2', cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuq1', content: 'Your questions have been answered: "VS Code 兼容性验证做到什么程度？"="自动化测试级验证", "本次工作完成后如何提交？"="看情况再定". You can now continue with these answers in mind.' }] } }));
		const after = await until(() => p.call('session', { id: 'conv-q' }), (v: Any) => v.items.find((i: Any) => i.k === 'tool').st === 'ok');
		const tool = after.items.find((i: Any) => i.k === 'tool');
		expect(tool.res.text).toBeUndefined(); // the answered card fetches its result; the sync still carries no text
		const fetched = await p.call('tool', { id: 'conv-q', item: tool.id });
		expect(fetched.res.text).toContain('"本次工作完成后如何提交？"="看情况再定"');
		// the spent card no longer answers
		await expect(p.call('answer', { id: 'conv-q', item: tool.id, answers })).rejects.toThrow(/no longer waiting/);
	});
});

describe('remote turns', () => {
	it('a new conversation runs in the workspace folder, reports its session id and shows the remote prompt', async () => {
		const sent = await ph.call('send', { draftId: 'draft-one', cwd: workspace, text: 'hello from the phone', mode: 'now', permissionMode: 'acceptEdits' });
		expect(sent.lane).toBe('draft:draft-one');
		const view = await until(() => ph.call('session', { lane: sent.lane, id: sent.lane }), (v: Any) => !v.draft && v.items.some((i: Any) => i.k === 'assistant'));
		expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(view.items[0]).toMatchObject({ k: 'user', text: 'hello from the phone', remote: true });
		expect(view.items[1].text).toBe('echo[acceptEdits]: hello from the phone');
		const list = await ph.call('sessions', {});
		expect(list.sessions.some((s: Any) => s.id === view.id)).toBe(true);
	});

	it('refuses a new conversation outside the open workspace', async () => {
		await expect(ph.call('send', { draftId: 'x', cwd: otherProject, text: 'nope' })).rejects.toThrow(/workspace folder/);
		// traversal dress is still just a path that is not an open workspace folder
		await expect(ph.call('send', { draftId: 'x', cwd: '..', text: 'nope' })).rejects.toThrow(/workspace folder/);
		await expect(ph.call('send', { draftId: 'x', cwd: workspace + '/../../..', text: 'nope' })).rejects.toThrow(/workspace folder/);
		await expect(ph.call('send', { draftId: 'x', cwd: '\\\\server\\share', text: 'nope' })).rejects.toThrow(/workspace folder/);
		// an existing conversation is looked up by id in the store, never as a path
		await expect(ph.call('send', { sessionId: '..\\..\\x', text: 'nope' })).rejects.toThrow(/no such conversation/);
		await expect(ph.call('send', { sessionId: '../../etc/passwd', text: 'nope' })).rejects.toThrow(/no such conversation/);
	});

	it('"queue" waits for the running turn; "now" interrupts it', async () => {
		await ph.call('send', { sessionId: 'conv-b', text: 'slow one', mode: 'now' });
		const queued = await ph.call('send', { sessionId: 'conv-b', text: 'after the turn', mode: 'queue' });
		expect(queued.state.running.text).toBe('slow one');
		expect(queued.state.queue.map((q: Any) => q.text)).toEqual(['after the turn']);
		const done = await until(() => ph.call('session', { id: 'conv-b' }), (v: Any) => !v.lane.running && !v.lane.queue.length && v.items.at(-1).text === 'echo[default]: after the turn');
		expect(done.lane.last.status).toBe('done');
		// the order on disk is the order sent
		const texts = done.items.filter((i: Any) => i.k === 'user').map((i: Any) => i.text);
		expect(texts.slice(-2)).toEqual(['slow one', 'after the turn']);

		await ph.call('send', { sessionId: 'conv-b', text: 'slow and doomed', mode: 'now' });
		await sleep(200);
		const now = await ph.call('send', { sessionId: 'conv-b', text: 'urgent', mode: 'now' });
		expect(now.state.queue.length + (now.state.running ? 1 : 0)).toBeGreaterThan(0);
		const after = await until(() => ph.call('session', { id: 'conv-b' }), (v: Any) => !v.lane.running && v.items.at(-1).text === 'echo[default]: urgent');
		expect(after.items.some((i: Any) => i.text === 'echo[default]: slow and doomed')).toBe(false);
	});

	it('stop interrupts and pauses the queue; cancel removes; resume releases', async () => {
		await ph.call('send', { sessionId: 'conv-a', text: 'slow first', mode: 'now' });
		const q1 = await ph.call('send', { sessionId: 'conv-a', text: 'second', mode: 'queue' });
		await ph.call('send', { sessionId: 'conv-a', text: 'third', mode: 'queue' });
		const stopped = await ph.call('stop', { lane: q1.lane });
		expect(stopped.state.paused).toBe(true);
		await until(() => ph.call('session', { id: 'conv-a' }), (v: Any) => !v.lane.running);
		await sleep(1200);
		const paused = await ph.call('session', { id: 'conv-a' });
		expect(paused.lane.running).toBe(null); // nothing fired behind the user's back
		expect(paused.lane.queue.map((q: Any) => q.text)).toEqual(['second', 'third']);
		const second = paused.lane.queue[0].id;
		await ph.call('cancel', { lane: q1.lane, entry: second });
		await ph.call('resume', { lane: q1.lane });
		const v = await until(() => ph.call('session', { id: 'conv-a' }), (x: Any) => !x.lane.running && !x.lane.queue.length && x.items.at(-1).text === 'echo[default]: third');
		expect(v.items.some((i: Any) => i.text === 'echo[default]: second')).toBe(false);
	});
});

describe("the runner's argument firewall", () => {
	// On Windows a bare `claude` rides the shell (the npm .cmd shim), so everything a phone
	// can reach into argv must already be validated to a plain word before the spawn.
	type Spawn = { command: string; argv: string[]; opts: Any };
	const spawns: Spawn[] = [];
	// The runner kills a turn's tree through the same spawn surface (`taskkill` on win32),
	// and the recorder keeps counting after a test's dispose — each test counts its own.
	beforeEach(() => { spawns.length = 0; });
	const fakeChild = () => ({ pid: 4321, stdout: { on() {} }, stderr: { on() {} }, stdin: { on() {}, write() {}, end() {} }, on() {}, kill() {} });
	const recordingRunner = () => new core.Runner({
		cliPath: 'claude', defaultRoot: () => root,
		spawn: (command: string, argv: string[], opts: Any) => { spawns.push({ command, argv, opts }); return fakeChild(); }
	});

	it('a model that is not a plain word never reaches argv', () => {
		const r = recordingRunner();
		try {
			const hostile = ['a&b', 'a&&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a`b', 'a"b', "a'b", 'a b', 'a;b', '$(x)', 'a\\b', 'a\nb', 'x'.repeat(81)];
			for (let i = 0; i < hostile.length; i++) r.send({ draftId: 'fw-' + i, cwd: workspace, text: 'x', mode: 'now', model: hostile[i] });
			expect(spawns.length).toBe(hostile.length); // every prompt still ran — without a model
			for (const s of spawns) expect(s.argv).not.toContain('--model');
			for (const bad of hostile) expect(spawns.every((s) => !s.argv.includes(bad))).toBe(true);
			if (process.platform === 'win32') for (const s of spawns) expect(s.opts.shell).toBe(true); // exactly the branch the firewall guards
		} finally {
			r.dispose();
		}
	});

	it('a word-shaped model and an allowlisted permission mode ride as plain argv', () => {
		const r = recordingRunner();
		try {
			r.send({ draftId: 'fw-ok', cwd: workspace, text: 'x', mode: 'now', model: 'sonnet[1m]', permissionMode: 'acceptEdits' });
			const argv = spawns.at(-1)!.argv;
			expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet[1m]');
			expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
			r.send({ draftId: 'fw-bad-mode', cwd: workspace, text: 'x', mode: 'now', permissionMode: 'rm -rf /' });
			expect(spawns.at(-1)!.argv).not.toContain('--permission-mode'); // off-list falls back to default: no flag
		} finally {
			r.dispose();
		}
	});

	it('an oversized prompt or a full queue is refused before any spawn', () => {
		const r = recordingRunner();
		try {
			expect(() => r.send({ draftId: 'fw-big', cwd: workspace, text: 'x'.repeat(200_000), mode: 'now' })).toThrow(/too long/);
			let accepted = 0;
			for (let i = 0; i < 30; i++) {
				try { r.send({ sessionId: 'fw-lane', cwd: workspace, text: 'q' + i, mode: 'queue' }); accepted++; } catch (e) { expect(String(e)).toMatch(/queue is full/); break; }
			}
			expect(accepted).toBeLessThanOrEqual(21); // one running + twenty queued
			expect(spawns.length).toBe(1); // the refused and queued prompts never spawned
		} finally {
			r.dispose();
		}
	});
});

describe('models and the desktop', () => {
	it('modelInfo: the settings pin wins, a tier alias resolves through the provider env, else the recent model', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-model-'));
		const cwd = path.join(dir, 'proj');
		fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
		const saved = process.env.ANTHROPIC_MODEL;
		delete process.env.ANTHROPIC_MODEL;
		try {
			expect(core.sessions.modelInfo({ root: dir, cwd, fallback: 'recent-model' })).toMatchObject({ current: 'recent-model', source: 'recent', pinned: null });
			fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash', ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' } }));
			const env = core.sessions.modelInfo({ root: dir, cwd, fallback: 'recent-model' });
			expect(env).toMatchObject({ current: 'glm-5.3', source: 'env', provider: 'open.bigmodel.cn' });
			expect(env.tiers.find((x: Any) => x.id === 'haiku').resolved).toBe('glm-5.3-flash');
			fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ model: 'haiku[1m]' }));
			expect(core.sessions.modelInfo({ root: dir, cwd })).toMatchObject({ current: 'glm-5.3-flash', pinned: 'haiku[1m]', source: 'settings' });
		} finally {
			if (saved !== undefined) process.env.ANTHROPIC_MODEL = saved;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('the phone sees each session’s model, the running model, and can choose one', async () => {
		const sent0 = await ph.call('send', { sessionId: 'conv-b', text: 'warm up', mode: 'now' });
		const before = await until(() => ph.call('session', { id: sent0.lane }), (v: Any) => !v.lane.running && v.items.at(-1).text === 'echo[default]: warm up');
		expect(before.session.model).toBe('fake-model-1');
		const models = await ph.call('models', { id: 'conv-b' });
		expect(models.session).toBe('fake-model-1');
		expect(models.tiers.map((x: Any) => x.id)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
		expect((await ph.call('hello')).model).toHaveProperty('current');
		await ph.call('send', { sessionId: 'conv-b', text: 'slow on opus', mode: 'now', model: 'opus' });
		const running = await until(() => ph.call('session', { id: 'conv-b' }), (v: Any) => !!v.lane.running && v.lane.running.model === 'opus');
		expect(running.lane.running.model).toBe('opus');
		const done = await until(() => ph.call('session', { id: 'conv-b' }), (v: Any) => !v.lane.running && v.items.at(-1).text === 'echo[default]: slow on opus');
		expect(done.session.model).toBe('opus');
		expect(done.lane.last.model).toBe('opus');
	});

	it('resolveModelName: a tier alias becomes the provider model the env maps it to; everything else passes through', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-model-'));
		const cwd = path.join(dir, 'proj');
		fs.mkdirSync(cwd, { recursive: true });
		try {
			// no remap anywhere: the official service serves the alias itself
			expect(core.sessions.resolveModelName('opus', { root: dir, cwd })).toBe('opus');
			expect(core.sessions.resolveModelName('sonnet[1m]', { root: dir, cwd })).toBe('sonnet[1m]');
			// a full model id is never remapped — it already names what the run sends
			expect(core.sessions.resolveModelName('claude-opus-4-6', { root: dir, cwd })).toBe('claude-opus-4-6');
			expect(core.sessions.resolveModelName(null, { root: dir, cwd })).toBe(null);
			fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash' } }));
			expect(core.sessions.resolveModelName('opus', { root: dir, cwd })).toBe('glm-5.3');
			expect(core.sessions.resolveModelName('opus[1m]', { root: dir, cwd })).toBe('glm-5.3');
			expect(core.sessions.resolveModelName('sonnet[1m]', { root: dir, cwd })).toBe('glm-5.3-flash');
			expect(core.sessions.resolveModelName('glm-5.3', { root: dir, cwd })).toBe('glm-5.3'); // not an alias: verbatim
			expect(core.sessions.resolveModelName('haiku', { root: dir, cwd })).toBe('haiku'); // this tier has no remap
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a third-party provider is named by its own models on the phone: the alias a pick rides resolves before it is shown', async () => {
		const settings = path.join(root, 'settings.json');
		fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash' } }));
		try {
			const models = await ph.call('models', { id: 'conv-b' });
			expect(models).toMatchObject({ current: 'glm-5.3', source: 'env', provider: 'open.bigmodel.cn' });
			expect(models.tiers.find((x: Any) => x.id === 'opus').resolved).toBe('glm-5.3');
			await ph.call('send', { sessionId: 'conv-b', text: 'slow third-party turn', mode: 'now', model: 'opus' });
			// the banner names the model actually answering, not the alias the pick rode on
			const running = await until(() => ph.call('session', { id: 'conv-b' }), (v: Any) => !!v.lane.running && v.lane.running.model === 'glm-5.3');
			expect(running.lane.running.model).toBe('glm-5.3');
			const done = await until(() => ph.call('session', { id: 'conv-b' }), (v: Any) => !v.lane.running && v.items.at(-1).text === 'echo[default]: slow third-party turn');
			expect(done.session.model).toBe('glm-5.3');
			expect(done.lane.last.model).toBe('glm-5.3');
		} finally {
			fs.rmSync(settings, { force: true });
		}
	});

	it('marks the sessions open on the desktop and opens one on request', async () => {
		const list = await ph.call('sessions', {});
		expect(list.sessions.find((s: Any) => s.id === 'conv-a').onDesktop).toBe(true);
		expect(list.sessions.find((s: Any) => s.id === 'conv-b').onDesktop).toBe(false);
		await ph.call('openOnDesktop', { id: 'conv-b' });
		expect(desktopOpened).toEqual(['conv-b']);
		await expect(ph.call('openOnDesktop', { id: 'nope' })).rejects.toThrow(/no such conversation/);
	});
});

describe('the desktop tab of a remote turn', () => {
	type Call = [string, ...unknown[]];
	const fakeVscode = (opts: { ggs: boolean; hosted?: string[]; activeViewType?: string; claude?: boolean }) => {
		const calls: Call[] = [];
		let hosted = new Set(opts.hosted ?? []);
		const closedTabs: unknown[] = [];
		const activeTab = { input: { viewType: opts.activeViewType ?? 'mainThreadWebview-claudeVSCodePanel' } };
		const vscode = {
			commands: {
				getCommands: async () => (opts.claude === false ? [] : ['claude-vscode.editor.open']),
				executeCommand: async (id: string, ...args: unknown[]) => {
					calls.push([id, ...args]);
					if (id === 'ggs.sessionTabs.list') { if (!opts.ggs) throw new Error('command not found'); return [...hosted]; }
					if (id === 'ggs.sessionTabs.close') { if (!opts.ggs) throw new Error('command not found'); return hosted.delete(String(args[0])) ? 1 : 0; }
					if (id === 'claude-vscode.editor.open') { hosted.add(String(args[0])); return undefined; }
					throw new Error('unknown ' + id);
				}
			},
			window: { tabGroups: { activeTabGroup: { activeTab }, close: async (tab: unknown) => { closedTabs.push(tab); return true; } } }
		};
		return { vscode, calls, closedTabs, reset: (ids: string[]) => { hosted = new Set(ids); } };
	};
	const make = (vscode: Any, mode = 'reload', busy = false) => core.createDesktopTabs(vscode, { mode: () => mode, busy: () => busy, settleMs: 1 });
	const opens = (calls: Call[]) => calls.filter((c) => c[0] === 'claude-vscode.editor.open').map((c) => c[1]);

	it('Git Graph Studio: opens the tab at the start, closes and reopens exactly the session’s tab at the end', async () => {
		const f = fakeVscode({ ggs: true });
		const tabs = make(f.vscode);
		await tabs.onTurn('start', { sessionId: 's1' });
		expect(opens(f.calls)).toEqual(['s1']);
		expect(f.calls.find((c) => c[0] === 'claude-vscode.editor.open')!.at(-1)).toEqual({ programmatic: 'pin-to-panel' });
		expect([...tabs.list()]).toEqual(['s1']);
		await tabs.onTurn('end', { sessionId: 's1' });
		expect(f.calls.filter((c) => c[0] === 'ggs.sessionTabs.close')).toEqual([['ggs.sessionTabs.close', 's1']]);
		expect(opens(f.calls)).toEqual(['s1', 's1']);
		expect(f.closedTabs).toEqual([]); // the exact host path, never the active-tab guess
	});

	it('a tab the user closed during the turn stays closed; a busy desktop or a queued next turn is never reloaded', async () => {
		const f = fakeVscode({ ggs: true });
		const tabs = make(f.vscode);
		await tabs.onTurn('start', { sessionId: 's2' });
		f.reset([]);
		await tabs.onTurn('end', { sessionId: 's2' });
		expect(opens(f.calls)).toEqual(['s2']);

		const g = fakeVscode({ ggs: true, hosted: ['s3'] });
		await make(g.vscode, 'reload', true).onTurn('end', { sessionId: 's3' });
		await make(g.vscode).onTurn('end', { sessionId: 's3', moreQueued: true });
		expect(g.calls.filter((c) => c[0] === 'ggs.sessionTabs.close')).toEqual([]);
	});

	it('VS Code: reveals, then closes the active tab only when it is a Claude Code panel', async () => {
		const f = fakeVscode({ ggs: false });
		await make(f.vscode).onTurn('end', { sessionId: 's4' });
		expect(f.closedTabs).toHaveLength(1);
		expect(opens(f.calls)).toEqual(['s4', 's4']);

		const g = fakeVscode({ ggs: false, activeViewType: 'workbench.editor.file' });
		await make(g.vscode).onTurn('end', { sessionId: 's5' });
		expect(g.closedTabs).toEqual([]);
		expect(opens(g.calls)).toEqual(['s5']);
	});

	it('mode "open" only opens; mode "off" and a missing Claude Code extension do nothing', async () => {
		const f = fakeVscode({ ggs: true, hosted: ['s6'] });
		await make(f.vscode, 'open').onTurn('end', { sessionId: 's6' });
		await make(f.vscode, 'off').onTurn('start', { sessionId: 's6' });
		expect(opens(f.calls)).toEqual([]);
		const g = fakeVscode({ ggs: true, claude: false });
		await make(g.vscode).onTurn('start', { sessionId: 's7' });
		expect(opens(g.calls)).toEqual([]);
	});

	it('the runner reports the new session id, each start, and each end', async () => {
		const seen: [string, Any][] = [];
		const r = new core.Runner({ cliPath: process.env.CLAUDE_CLI_PATH, defaultRoot: () => root, onTurn: (phase: string, info: Any) => seen.push([phase, info]) });
		try {
			r.send({ draftId: 'hooks', cwd: workspace, text: 'hook me', mode: 'now' });
			await until(() => seen.length, (n) => n >= 2);
			const id = seen[0]![1].sessionId;
			expect(seen.map(([phase]) => phase)).toEqual(['session', 'end']);
			expect(seen[1]![1]).toMatchObject({ sessionId: id, status: 'done', moreQueued: false });
			r.send({ sessionId: id, cwd: workspace, root, text: 'again', mode: 'now' });
			await until(() => seen.length, (n) => n >= 4);
			expect(seen.slice(2).map(([phase]) => phase)).toEqual(['start', 'end']);
		} finally {
			r.dispose();
		}
	});
});

describe('injected turns: the prompt is sent from the desktop tab', () => {
	// A stand-in for Git Graph Studio's `ggs.claudeChat.*` over a desktop Claude Code tab:
	// a sent prompt lands in the session file the tab writes (the user record, then the
	// answer — later for a "slow" prompt), Stop writes the interrupt marker.
	const fakeDesktop = () => {
		const tickets = new Map<string, { phase: string; sessionId: string | null; sid: string }>();
		const busy = new Set<string>();
		const sent: string[] = [];
		const stops: string[] = [];
		const picked: (string | null)[] = []; // the model each prompt asked the tab to switch to
		let n = 0;
		const file = (sid: string) => path.join(root, 'projects', munge(workspace), sid + '.jsonl');
		const write = (sid: string, record: object) => fs.appendFileSync(file(sid), line({ uuid: crypto.randomUUID(), cwd: workspace, timestamp: new Date().toISOString(), ...record }));
		const stop = (sid: string) => {
			if (!busy.has(sid)) return false;
			busy.delete(sid);
			stops.push(sid);
			write(sid, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
			return true;
		};
		const injector = {
			send: async ({ sessionId, text, interrupt, model }: { sessionId: string | null; text: string; interrupt: boolean; model?: string | null }) => {
				picked.push(model ?? null);
				const id = 't' + ++n;
				const sid = sessionId ?? crypto.randomUUID();
				const ticket = { phase: 'opening', sessionId, sid };
				tickets.set(id, ticket);
				setTimeout(() => {
					if (interrupt) stop(sid);
					sent.push(text);
					busy.add(sid);
					write(sid, { type: 'user', message: { role: 'user', content: text } });
					ticket.phase = 'sent';
					ticket.sessionId = sid;
					setTimeout(() => {
						if (!busy.has(sid)) return;
						write(sid, { type: 'assistant', message: { role: 'assistant', model: 'desktop-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'desktop: ' + text }] } });
						busy.delete(sid);
					}, /slow/.test(text) ? 1200 : 150);
				}, 50);
				return { ticket: id };
			},
			state: async ({ ticket }: { ticket: string }) => {
				const t = tickets.get(ticket)!;
				return { phase: t.phase, error: null, sessionId: t.sessionId, open: true, busy: busy.has(t.sid) };
			},
			stop: async ({ ticket }: { ticket: string }) => ({ stopped: stop(tickets.get(ticket)!.sid) })
		};
		return { injector, sent, stops, picked };
	};
	const runnerWith = (injector: Any) => new core.Runner({
		injector, pollMs: 40, cliPath: 'never-run', defaultRoot: () => root,
		externalBusy: (id: string) => core.sessions.desktopBusy(core.sessions.findSession(id)),
		spawn: () => { throw new Error('an injected turn must not spawn the CLI'); }
	});

	it('a new conversation is sent from a desktop tab; its session id and the turn come back', async () => {
		const desk = fakeDesktop();
		const r = runnerWith(desk.injector);
		try {
			const { lane } = r.send({ draftId: 'inj-new', cwd: workspace, text: 'hello desktop', mode: 'now', model: 'opus', permissionMode: 'plan' });
			const state = await until(() => r.laneState(lane), (s: Any) => s.last && s.last.status === 'done');
			expect(desk.sent).toEqual(['hello desktop']);
			// The phone's model pick crosses to the host (it picks it in the tab's own model
			// picker before typing the prompt).
			expect(desk.picked).toEqual(['opus']);
			expect(state.sessionId).toMatch(/^[0-9a-f-]{36}$/);
			const window = core.sessions.transcriptWindow(core.sessions.readTranscript(core.sessions.findSession(state.sessionId).file));
			expect(window.items.map((i: Any) => i.text)).toEqual(['hello desktop', 'desktop: hello desktop']);
			expect(window.model).toBe('desktop-model'); // the tab's own model, whatever the phone picked
			// A pick-free follow-up sends null: the tab's current model stands.
			r.send({ sessionId: state.sessionId, cwd: workspace, root, text: 'no pick', mode: 'queue' });
			await until(() => desk.picked.length, (len: number) => len === 2);
			expect(desk.picked[1]).toBe(null);
		} finally {
			r.dispose();
		}
	});

	it('"queue" waits for the desktop turn to finish; "now" stops it through the tab first', async () => {
		const desk = fakeDesktop();
		const r = runnerWith(desk.injector);
		try {
			const first = r.send({ draftId: 'inj-q', cwd: workspace, text: 'slow first', mode: 'now' });
			await until(() => r.laneState(first.lane), (s: Any) => !!s.sessionId);
			r.send({ sessionId: r.laneState(first.lane).sessionId, cwd: workspace, root, text: 'second', mode: 'queue' });
			await sleep(400);
			expect(desk.sent).toEqual(['slow first']); // still waiting behind the running turn
			const done = await until(() => r.laneState(first.lane), (s: Any) => !s.running && !s.queue.length && s.last.status === 'done', 8000);
			expect(desk.sent).toEqual(['slow first', 'second']);
			expect(desk.stops).toEqual([]);

			const id = done.sessionId;
			r.send({ sessionId: id, cwd: workspace, root, text: 'slow doomed', mode: 'now' });
			await until(() => desk.sent.length, (len) => len === 3);
			r.send({ sessionId: id, cwd: workspace, root, text: 'urgent', mode: 'now' });
			const after = await until(() => r.laneState(id), (s: Any) => !s.running && !s.queue.length && desk.sent.length === 4 && s.last.status === 'done', 8000);
			expect(desk.sent.slice(2)).toEqual(['slow doomed', 'urgent']);
			expect(desk.stops).toEqual([id]); // the tab's own Stop, once
			const items = core.sessions.transcriptWindow(core.sessions.readTranscript(core.sessions.findSession(id).file)).items;
			expect(items.some((i: Any) => i.text === 'desktop: slow doomed')).toBe(false);
			expect(items.at(-1).text).toBe('desktop: urgent');
			expect(after.last.status).toBe('done');
		} finally {
			r.dispose();
		}
	});

	it('a tab that fails to take the prompt fails the turn; disposing never stops a desktop turn', async () => {
		const failing = { send: async () => ({ ticket: 'x' }), state: async () => ({ phase: 'error', error: 'the Claude Code chat did not become ready', sessionId: null, open: false, busy: null }), stop: async () => ({ stopped: false }) };
		const r = runnerWith(failing);
		const { lane } = r.send({ draftId: 'inj-fail', cwd: workspace, text: 'x', mode: 'now' });
		const state = await until(() => r.laneState(lane), (s: Any) => s.last && s.last.status === 'error');
		expect(state.last.error).toMatch(/did not become ready/);
		r.dispose();

		const desk = fakeDesktop();
		const r2 = runnerWith(desk.injector);
		r2.send({ draftId: 'inj-dispose', cwd: workspace, text: 'slow keep going', mode: 'now' });
		await until(() => desk.sent.length, (len) => len === 1);
		r2.dispose();
		await sleep(300);
		expect(desk.stops).toEqual([]);
	});
});

describe('the session store', () => {
	it('reads only the host’s own store: GGS ~/.ggs/claude, VS Code ~/.claude, CLAUDE_CONFIG_DIR over either', () => {
		const roots = core.sessions.claudeRoots;
		expect(roots({}, 'ggs')).toEqual([path.join(os.homedir(), '.ggs', 'claude')]);
		expect(roots({}, 'claude')).toEqual([path.join(os.homedir(), '.claude')]);
		expect(roots({ CLAUDE_CONFIG_DIR: root }, 'ggs')).toEqual([path.resolve(root)]);
		expect(roots({ CLAUDE_CONFIG_DIR: root }, 'claude')).toEqual([path.resolve(root)]);
		// a session in the other host's store is not this host's. The fixture lives wherever
		// the code itself looks (the VM pool's os.homedir() may not see this process's
		// USERPROFILE), and the cleanup removes only what the fixture created — never a
		// whole user directory.
		const ggsRoot = roots({}, 'ggs')[0]!;
		const ggsDir = path.join(ggsRoot, 'projects', munge(workspace));
		fs.mkdirSync(ggsDir, { recursive: true });
		fs.writeFileSync(path.join(ggsDir, 'conv-ggs-only.jsonl'), line({ type: 'user', uuid: 'g1', cwd: workspace, message: { role: 'user', content: 'from ggs' } }));
		try {
			expect(core.sessions.listSessions({ roots: roots({}, 'claude') }).some((x: Any) => x.id === 'conv-ggs-only')).toBe(false);
			expect(core.sessions.listSessions({ roots: roots({}, 'ggs') }).map((x: Any) => x.id)).toContain('conv-ggs-only');
			expect(core.sessions.findSession('conv-ggs-only', roots({}, 'claude'))).toBe(null);
		} finally {
			fs.rmSync(ggsDir, { recursive: true, force: true });
			for (const dir of [path.dirname(ggsDir), ggsRoot, path.dirname(ggsRoot)]) {
				try { fs.rmdirSync(dir); } catch { /* not empty (or not ours to remove): leave it */ }
			}
		}
	});
});

describe('regressions', () => {
	it('a record written twice shows once (ids stay unique for the keyed renderer)', () => {
		const dir = path.join(root, 'projects', munge(workspace));
		const file = path.join(dir, 'conv-dup.jsonl');
		const user = line({ type: 'user', uuid: 'd1', cwd: workspace, timestamp: '2026-01-04T10:00:00Z', message: { role: 'user', content: 'once' } });
		const answer = line({ type: 'assistant', uuid: 'd2', cwd: workspace, timestamp: '2026-01-04T10:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'only once' }] } });
		const anonymous = line({ type: 'user', cwd: workspace, message: { role: 'user', content: 'no uuid' } });
		fs.writeFileSync(file, user + answer + user + answer + anonymous + anonymous);
		const items = core.sessions.transcriptWindow(core.sessions.readTranscript(file)).items;
		expect(items.map((i: Any) => i.text)).toEqual(['once', 'only once', 'no uuid', 'no uuid']);
		expect(new Set(items.map((i: Any) => i.id)).size).toBe(items.length);
		fs.rmSync(file);
	});

	it('the transcript cache stays bounded; an evicted session re-reads intact', () => {
		const dir = path.join(root, 'projects', munge(workspace));
		const files: string[] = [];
		for (let i = 0; i < core.sessions.MAX_CACHED_TRANSCRIPTS + 4; i++) {
			const file = path.join(dir, `conv-cache-${i}.jsonl`);
			fs.writeFileSync(file, line({ type: 'user', uuid: `c${i}`, cwd: workspace, message: { role: 'user', content: `prompt ${i}` } }));
			files.push(file);
			core.sessions.readTranscript(file);
		}
		expect(core.sessions.cachedTranscripts()).toBe(core.sessions.MAX_CACHED_TRANSCRIPTS);
		expect(core.sessions.transcriptWindow(core.sessions.readTranscript(files[0]!)).items[0].text).toBe('prompt 0');
		for (const file of files) fs.rmSync(file);
	});

	it('a follow-up to a new conversation in the second workspace folder stays in that folder', async () => {
		const second = await core.server.startServer({
			pairing: core.server.newPairing(), port: 0, host: '127.0.0.1', runner,
			folders: () => [{ name: 'my-app', path: workspace }, { name: 'elsewhere', path: otherProject }], baseDir: extensionDir
		});
		const savedLive = live;
		live = second;
		try {
			const p2 = await phone(second.pairing.code);
			const first = await p2.call('send', { draftId: 'two-folders', cwd: otherProject, text: 'slow start elsewhere', mode: 'now' });
			// the phone's follow-up names the lane only — no folder
			const follow = await p2.call('send', { lane: first.lane, text: 'and continue', mode: 'queue' });
			expect(follow.state.cwd).toBe(otherProject);
			const done = await until(() => p2.call('session', { lane: first.lane, id: first.lane }), (v: Any) => !v.draft && !v.lane.running && !v.lane.queue.length && v.items.at(-1)?.text === 'echo[default]: and continue', 10000);
			expect(done.session.cwd).toBe(otherProject);
			expect(done.items.filter((i: Any) => i.k === 'user').map((i: Any) => i.text)).toEqual(['slow start elsewhere', 'and continue']);
		} finally {
			live = savedLive;
			await second.stop();
		}
	});
});

describe('key reset and brute force', () => {
	it('rekey locks the old key out; the new code pairs', async () => {
		const next = core.server.newPairing();
		live.rekey(next);
		expect(await ph.call('hello')).toEqual({ status: 401, plain: { error: 'rekeyed' } });
		expect(live.devices()).toEqual([]);
		ph = await phone(next.code);
		expect((await ph.call('hello')).protocol).toBe(4);
	});

	it('repeated decryption failures lock the address out', async () => {
		const wrong = await phone('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
		let last: Any = null;
		for (let i = 0; i < 11; i++) last = await wrong.call('hello');
		expect(last.status).toBe(429);
		expect((await ph.call('hello')).status).toBe(429); // the whole address, right key or not
	});
});

describe('the VSIX packer (what prepare.mjs bundles into every installer)', () => {
	it('packs every runtime file and passes the installer gate', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-vsix-'));
		try {
			const out = path.join(dir, 'bundled', 'claude-remote.vsix');
			const packed = spawnSync(process.execPath, [path.join(extensionDir, 'build.mjs'), '--out', out], { encoding: 'utf8' });
			expect(packed.status).toBe(0);
			expect(packed.stdout).toContain('zip self-check OK');
			validatePackage(out, { engineRequired: false });
			const zip = fs.readFileSync(out);
			for (const file of ['extension.js', 'sessions.js', 'runner.js', 'server.js', 'panel.js', 'desktop.js', 'qrcode.js', 'sjcl.js', 'web/index.html', 'web/app.js', 'web/app.css', 'web/icon.svg']) {
				expect(zip.includes(Buffer.from('extension/' + file))).toBe(true);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('still derives the node backend on install: the server call ships verbatim', () => {
		// Git Graph Studio's install scan (cmd_ext.rs QUALIFIED_SERVER_CALLS, a substring match
		// over the packed source) routes this package to the node backend by the literal
		// `http.createServer`. build.mjs writes a store-format zip — no compression — so the
		// call is findable as bare bytes; a future bundler/minifier would strand the extension
		// in the frame host, and this test would go red first.
		const source = fs.readFileSync(path.join(extensionDir, 'server.js'), 'utf8');
		expect(source).toMatch(/(http|https|net|tls|dgram)\.createServer/);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-vsix-'));
		try {
			const out = path.join(dir, 'claude-remote.vsix');
			const packed = spawnSync(process.execPath, [path.join(extensionDir, 'build.mjs'), '--out', out], { encoding: 'utf8' });
			expect(packed.status).toBe(0);
			expect(fs.readFileSync(out).includes(Buffer.from('http.createServer'))).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('host conformance (VS Code’s real Node and Git Graph Studio’s ggs-node behave alike)', () => {
	// The same probe runs under ggs-node in src-tauri/tests/node_runtime.rs against the same
	// expected report — this is the real-Node half of that contract.
	it('answers the conformance probe’s expected report under real Node', async () => {
		const conformance = nodeRequire(path.join(extensionDir, 'test', 'conformance.js'));
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-conformance-'));
		try {
			const expected = conformance.expected();
			expect(await conformance.run('crypto')).toEqual(expected.crypto);
			expect(await conformance.run('e2e', work)).toEqual(expected.e2e);
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	}, 60_000);

	it('runs a .js CLI through each host’s own Node: real Node itself, Electron as Node, ggs-node through the system node', () => {
		const { nodeExecutable } = nodeRequire(path.join(extensionDir, 'runner.js'));
		const plain: Record<string, string> = {};
		expect(nodeExecutable(plain, { node: '22.0.0' })).toBe(process.execPath);
		expect(plain).toEqual({});
		// VS Code's extension host is Electron: its binary is Node only under this flag
		const electron: Record<string, string> = {};
		expect(nodeExecutable(electron, { node: '22.0.0', electron: '37.0.0' })).toBe(process.execPath);
		expect(electron.ELECTRON_RUN_AS_NODE).toBe('1');
		// ggs-node is an extension host, not a script runner: its execPath would load the
		// CLI as an extension entry, exit 0 and lose the prompt
		const ggs: Record<string, string> = {};
		expect(nodeExecutable(ggs, { node: '22.0.0-ggs', ggs: 'node-runtime' })).toBe('node');
		expect(ggs).toEqual({});
	});
});
