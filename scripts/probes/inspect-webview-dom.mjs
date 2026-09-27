// Inspects the live webview iframes: attributes, srcdoc state, and the active tab.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe');
const port = '9241';
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
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value ?? null;

await sleep(9000);
await evaluate(`(async () => {
	const open = document.querySelector('#overlays .quick-input input');
	open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	await new Promise((resolve) => setTimeout(resolve, 200));
	document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 400));
	const input = document.querySelector('#overlays .quick-input input');
	if (!input) return;
	input.value = '> Claude Code: Open in New Tab';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	for (let attempt = 0; attempt < 20; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		const row = [...document.querySelectorAll('#overlays .quick-input .row')].find((r) => /Open in New Tab/.test(r.textContent));
		if (row) { row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return; }
	}
})()`).catch(() => {});
await sleep(12000);

const dump = await evaluate(`(() => {
	const frames = [...document.querySelectorAll('iframe')].map((f, i) => ({
		i,
		title: f.title || '',
		src: (f.src || '').slice(0, 60),
		srcdocLen: (f.getAttribute('srcdoc') || '').length,
		cls: f.className.slice(0, 40),
		parentCls: f.parentElement ? f.parentElement.className.slice(0, 40) : '',
		connected: f.isConnected,
		display: f.parentElement ? getComputedStyle(f.parentElement).display : ''
	}));
	const tabs = [...document.querySelectorAll('.tab')].map((t) => ({ text: t.textContent.trim(), active: t.className.includes('active') }));
	const activeEditor = document.querySelector('.editor-group.active, .editor-area')?.innerHTML?.slice(0, 200) ?? '';
	return { frames, tabs, activeEditor };
})()`);
console.log(JSON.stringify(dump, null, 2));
process.exit(0);
