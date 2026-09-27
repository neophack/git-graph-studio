// Verifies whether http://ggs.localhost requests route to the ggs protocol handler.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe');
const port = '9245';
const workspace = join(tmpdir(), 'ggs-claude-live-check');

const child = spawn(exe, [workspace], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'ignore'],
	detached: true,
	env: { ...process.env, GGS_REAL_NODE: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
});
child.unref();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

let page = null;
for (let i = 0; i < 60 && !page; i++) {
	try {
		page = (await targets()).find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
	} catch {}
	if (!page) await sleep(500);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve } = pending.get(msg.id);
		pending.delete(msg.id);
		resolve(msg.result);
	}
};
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
const send = (method, params = {}) => new Promise((resolve) => {
	const id = nextId++;
	pending.set(id, { resolve });
	ws.send(JSON.stringify({ id, method, params }));
});

await sleep(8000);
const result = await send('Runtime.evaluate', {
	expression: `(async () => {
		const outcomes = {};
		for (const url of [
			'http://ggs.localhost/Anthropic.claude-code-2.1.283/webview/index.js',
			'ggs://localhost/Anthropic.claude-code-2.1.283/webview/index.js',
			'https://ggs.localhost/Anthropic.claude-code-2.1.283/webview/index.js'
		]) {
			try {
				const r = await fetch(url, { mode: 'no-cors' });
				outcomes[url.slice(0, 40)] = 'fetched type=' + r.type + ' status=' + r.status;
			} catch (e) {
				outcomes[url.slice(0, 40)] = 'FAILED ' + String(e.message).slice(0, 60);
			}
		}
		return outcomes;
	})()`,
	returnByValue: true,
	awaitPromise: true
});
console.log(JSON.stringify(result?.result?.value ?? result, null, 2));
await sleep(1500);
process.exit(0);
