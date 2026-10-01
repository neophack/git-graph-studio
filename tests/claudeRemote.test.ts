// The Claude Remote extension's server core, exercised headless: the extension.js only
// touches `vscode` inside activate(), so the whole server (PSK crypto, conversation
// reader, claude-CLI task runner, encrypted HTTP surface) runs here against a fixture
// HOME and a fake `claude` on PATH.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import vm from 'node:vm';
import { createRequire } from 'node:module';
// The extension is a plain CJS file that requires node builtins at top level (vscode is
// required lazily inside activate, which these tests never call) — evaluate it in a vm
// context with a real-builtin require, exactly as both hosts would.
const nodeRequire = createRequire(import.meta.url);
const extensionSource = fs.readFileSync(
	path.resolve(__dirname, '../extensions-src/claude-remote/extension.js'), 'utf8');
const sandboxRequire = (specifier: string) => {
	if (specifier === 'vscode') throw new Error('vscode must only be required inside activate');
	return nodeRequire(specifier);
};
const module_ = { exports: {} as Record<string, unknown> };
vm.runInNewContext(
	extensionSource,
	{ require: sandboxRequire, module: module_, exports: module_.exports, console, process, Buffer, TextEncoder, TextDecoder, setTimeout, clearTimeout, btoa, atob, setInterval, clearInterval, global: {} as unknown, performance }
);
// The core surface the tests exercise (mirrors extension.js's `__core` export).
const { __core } = module_.exports as {
	__core: {
		startServer(options?: { port?: number; log?: (line: string) => void }): Promise<{
			port: number; token: string; saltB64u: string; stop(): Promise<void>;
		}>;
		listConversations(claudeDir: string): { id: string; title: string; project: string; mtimeMs: number; size: number }[];
		parseConversation(file: string): { id: string; title: string; messages: { role: string; blocks: { kind: string; imageId?: number; text?: string }[] }[]; images: { id: number; mime: string }[] };
		claudeHome(): string;
		claudeCliPath(): string;
	};
};

let home = '';
let server = null;
let token = '';
let saltB64u = '';
const fakeClaudeDir = '';

const b64u = {
	e: (bytes) => Buffer.from(bytes).toString('base64url'),
	d: (t) => Buffer.from(t, 'base64url')
};

function keyFor(salt) {
	return require('crypto').pbkdf2Sync(token, salt, 150000, 32, 'sha256');
}

async function seal(method, payload) {
	const iv = require('crypto').randomBytes(12);
	const key = keyFor(Buffer.from(saltB64u, 'base64url'));
	console.log('[dbg] seal key', key.toString('hex'), 'saltRaw', Buffer.from(saltB64u, 'base64url').toString('hex'), 'token', JSON.stringify(token));
	const ci = require('crypto').createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([ci.update(JSON.stringify(payload), 'utf8'), ci.final()]);
	const res = await fetch(`http://127.0.0.1:${server.port}/api/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ i: iv.toString('base64url'), d: Buffer.concat([ct, ci.getAuthTag()]).toString('base64url') })
	});
	const envelope = await res.json();
	const di = require('crypto').createDecipheriv('aes-256-gcm', key, b64u.d(envelope.i));
	di.setAuthTag(b64u.d(envelope.d).subarray(b64u.d(envelope.d).length - 16));
	const plain = Buffer.concat([di.update(b64u.d(envelope.d).subarray(0, b64u.d(envelope.d).length - 16)), di.final()]);
	return { status: res.status, payload: JSON.parse(plain.toString('utf8')) };
}

// A fake `claude` CLI: prints the headless-JSON shape with the prompt and a session id.
const fakeClaude = `#!/bin/sh
prompt=""
resume=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$arg"; fi
  if [ "$prev" = "--resume" ]; then resume="$arg"; fi
  prev="$arg"
done
printf '{"result":"echo: %s","session_id":"%s"}' "$prompt" "$([ -n "$resume" ] && echo "$resume-resumed" || echo new-session-uuid)"
`;

beforeAll(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-test-'));
	const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-bin-'));
	const fakePath = path.join(fakeDir, 'claude');
	fs.writeFileSync(fakePath, fakeClaude, { mode: 0o755 });
	fs.writeFileSync(path.join(fakeDir, 'claude.cmd'), fakeClaude);
	process.env.CLAUDE_CLI_PATH = fakePath;
	process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');

	// A fixture project with two conversations: one plain text, one with an image block.
	const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-fixture');
	fs.mkdirSync(projectDir, { recursive: true });
	const line = (o) => JSON.stringify(o);
	fs.writeFileSync(path.join(projectDir, 'conv-a.jsonl'), [
		line({ type: 'summary', summary: 'The fixture summary' }),
		line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first question' }] }, cwd: '/tmp/fixture', timestamp: '2026-01-01T10:00:00Z' }),
		line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }, cwd: '/tmp/fixture', timestamp: '2026-01-01T10:00:05Z' })
	].join('\n'));
	const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
	fs.writeFileSync(path.join(projectDir, 'conv-b.jsonl'), [
		line({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'what is in this image?' }] }, cwd: '/tmp/fixture', timestamp: '2026-01-02T10:00:00Z' }),
		line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'it is a png header' }] }, cwd: '/tmp/fixture', timestamp: '2026-01-02T10:00:05Z' })
	].join('\n'));

	server = await __core.startServer({ port: 0, log: () => undefined });
	token = server.token;
	saltB64u = server.saltB64u;
});

afterAll(async () => {
	if (server) await server.stop();
	fs.rmSync(home, { recursive: true, force: true });
});

describe('claude remote core', () => {
	it('the pairing key derives from the token; a wrong token fails closed', async () => {
		const ok = await seal('ping', {});
		if (ok.status !== 200) fs.writeFileSync('/tmp/cr-ping-payload.txt', JSON.stringify(ok.payload));
		expect(ok.status).toBe(200);
		expect(ok.payload.ok).toBe(true);
		const rightKey = keyFor(Buffer.from(saltB64u, 'base64url'));
		const iv = Buffer.alloc(12, 1);
		const ci = require('crypto').createCipheriv('aes-256-gcm', rightKey, iv);
		const ct = Buffer.concat([ci.update(JSON.stringify({}), 'utf8'), ci.final()]);
		const res = await fetch(`http://127.0.0.1:${server.port}/api/ping`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: iv.toString('base64url'), d: Buffer.concat([ct, ci.getAuthTag()]).toString('base64url') })
		});
		expect(res.status).toBe(200); // correct key: fine
		// A different key seals garbage the server must reject.
		const wrong = require('crypto').pbkdf2Sync('other', 'salt', 1000, 32, 'sha256');
		const ci2 = require('crypto').createCipheriv('aes-256-gcm', wrong, iv);
		const ct2 = Buffer.concat([ci2.update('{}'), ci2.final()]);
		const res2 = await fetch(`http://127.0.0.1:${server.port}/api/ping`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ i: iv.toString('base64url'), d: Buffer.concat([ct2, ci2.getAuthTag()]).toString('base64url') })
		});
		const env2 = await res2.json();
		const di2 = require('crypto').createDecipheriv('aes-256-gcm', rightKey, b64u.d(env2.i));
		const sealed2 = b64u.d(env2.d);
		di2.setAuthTag(sealed2.subarray(sealed2.length - 16));
		const body2 = JSON.parse(Buffer.concat([di2.update(sealed2.subarray(0, sealed2.length - 16)), di2.final()]).toString('utf8'));
		expect(body2.error).toContain('pairing failed');
	});

	it('lists the conversations from the claude store', async () => {
		const { payload } = await seal('list', {});
		expect(payload.length).toBe(2);
		const a = payload.find((c) => c.id === 'conv-a');
		expect(a.title).toBe('The fixture summary');
		expect(a.project).toBe('/tmp/fixture');
	});

	it('reads a conversation: text blocks, order and the image block', async () => {
		const { payload } = await seal('conversation', { id: 'conv-b' });
		expect(payload.messages.length).toBe(2);
		expect(payload.messages[0].role).toBe('user');
		const imageBlock = payload.messages[0].blocks.find((b) => b.kind === 'image');
		expect(imageBlock).toBeDefined();
		const textBlock = payload.messages[1].blocks.find((b) => b.kind === 'text');
		expect(textBlock.text).toBe('it is a png header');
		// The image id the message carries is fetchable through the encrypted endpoint.
		const img = await seal('image', { id: `${payload.id}:${imageBlock.imageId}` });
		expect(img.payload.mime).toBe('image/png');
	});

	it('send runs the claude CLI as a task; resume passes --resume; new sessions report their id', async () => {
		const started = await seal('send', { prompt: 'remote hello', sessionId: 'conv-b', project: '/tmp/fixture' });
		expect(started.payload.status).toBe('running');
		let task = null;
		for (let i = 0; i < 40; i++) {
			task = (await seal('task', { id: started.payload.id })).payload;
			if (task.status !== 'running') break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(task.status).toBe('done');
		expect(task.result).toBe('echo: remote hello');
		expect(task.sessionId).toBe('conv-b-resumed');

		const fresh = await seal('send', { prompt: 'brand new', project: '/tmp/fixture' });
		let freshTask = null;
		for (let i = 0; i < 40; i++) {
			freshTask = (await seal('task', { id: fresh.payload.id })).payload;
			if (freshTask.status !== 'running') break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(freshTask.isNewSession).toBe(true);
		expect(freshTask.sessionId).toBe('new-session-uuid');
	});
});
