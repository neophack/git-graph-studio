// Launches the app with the real-Node host, opens the Claude Code page, and LEAVES THE
// APP RUNNING for interactive use. Not a check — an opener.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9235');
const exe = flag('--exe', [
	join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'debug', 'git-graph-studio.exe')
].find((p) => existsSync(p)));
if (!exe || !existsSync(exe)) {
	console.error('no built exe found');
	process.exit(2);
}

const workspace = join(tmpdir(), 'ggs-claude-live-check');
const child = spawn(exe, [workspace], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'ignore'],
	detached: true,
	env: {
		...process.env,
		GGS_REAL_NODE: '1',
		WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
	}
});
child.unref();
console.log('launched pid ' + child.pid + ' — GGS_REAL_NODE=1, CDP port ' + port);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

let page = null;
for (let attempt = 0; attempt < 60 && !page; attempt++) {
	try {
		page = (await targets()).find((target) => target.type === 'page' && !target.url.startsWith('devtools'));
	} catch { /* not up yet */ }
	if (!page) await sleep(500);
}
if (!page) {
	console.error('no CDP page target — the app is running, open Claude Code from the palette manually');
	process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	}
};
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result?.result?.value ?? null;
};

// Wait for the backend (the claude-code host process) to come up, then open the page.
for (let attempt = 0; attempt < 40; attempt++) {
	await sleep(500);
	const status = await evaluate(`(async () => (await import('/@id/@tauri-apps/api/core').catch(() => import('/node_modules/.vite/deps/@tauri-apps_api_core.js'))).invoke('ext_process_status'))()`).catch(() => null);
	const entry = (status ?? []).find((e) => e.extensionId === 'Anthropic.claude-code');
	if (entry && entry.pid > 0) {
		console.log('claude-code backend running, pid ' + entry.pid);
		break;
	}
}

await sleep(2500);
const opened = await evaluate(`(async () => {
	const open = document.querySelector('#overlays .quick-input input');
	open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	await new Promise((resolve) => setTimeout(resolve, 200));
	document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 400));
	const input = document.querySelector('#overlays .quick-input input');
	if (!input) return false;
	input.value = '> Claude Code: Open in New Tab';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	for (let attempt = 0; attempt < 20; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		const row = [...document.querySelectorAll('#overlays .quick-input .row')].find((r) => /Open in New Tab/.test(r.textContent));
		if (row) {
			row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
			return true;
		}
	}
	return false;
})()`);
console.log(opened ? 'the Claude Code page is open — the app stays running' : 'the palette run failed — open Claude Code from the palette manually');
process.exit(opened ? 0 : 1);
