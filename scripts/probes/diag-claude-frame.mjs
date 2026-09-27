// Diagnoses the blank claude-code webview: launches the app, opens the page, then dumps
// every frame context's live DOM + console, plus the full setHtml payload.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe');
const port = '9239';
const workspace = join(tmpdir(), 'ggs-claude-live-check');

const child = spawn(exe, [workspace], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'pipe'],
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
const contexts = [];
const consoleLines = [];
let setHtmlPayload = null;
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	} else if (msg.method === 'Runtime.executionContextCreated') {
		const ctx = msg.params.context;
		contexts.push({ id: ctx.id, name: ctx.name, origin: ctx.origin });
	} else if (msg.method === 'Runtime.consoleAPICalled') {
		const text = msg.params.args.map((a) => String(a.value ?? a.description ?? a.type ?? '')).join(' ');
		consoleLines.push(`[${msg.params.type}] ${text.slice(0, 300)}`);
	} else if (msg.method === 'Runtime.exceptionThrown') {
		const d = msg.params.exceptionDetails;
		consoleLines.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`.slice(0, 500));
	} else if (msg.method === 'Runtime.bindingCalled') {
		if (msg.params.name === 'probeCapture' && msg.params.payload.includes('setHtml')) {
			setHtmlPayload = msg.params.payload;
		}
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
await send('Runtime.enable');
await send('Runtime.addBinding', { name: 'probeCapture' });
const evaluate = async (expression, contextId) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
	if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'ctx error');
	return result?.result?.value ?? null;
};

// Capture the full webview HTML: hook the workbench's ext-host-request handling by
// sniffing the events the page already listens to.
await evaluate(`(async () => {
	const mod = await import('/@id/@tauri-apps/api/event').catch(() => import('/node_modules/.vite/deps/@tauri-apps_api_event.js'));
	window.__htmlCapture = [];
	await mod.listen('ext-host-request', (event) => {
		if (event.payload.extId === 'Anthropic.claude-code' && event.payload.method === 'webview.setHtml') {
			window.__htmlCapture.push(String(event.payload.args[1] ?? ''));
			probeCapture('setHtml captured, len=' + String(event.payload.args[1] ?? '').length);
		}
	});
})()`).catch((e) => console.log('[capture hook failed]', e.message));

// Open the page.
await sleep(6000);
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
		if (row) {
			row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
			return;
		}
	}
})()`).catch((e) => console.log('[open failed]', e.message));

// Give the webview time to load and (possibly) crash.
await sleep(15000);

console.log('=== contexts ===');
for (const ctx of contexts) {
	console.log(`ctx ${ctx.id} name=${JSON.stringify(ctx.name)} origin=${ctx.origin}`);
}
console.log('=== per-context DOM ===');
for (const ctx of contexts) {
	try {
		const info = await evaluate(`(() => ({
			url: location.href.slice(0, 80),
			ready: document.readyState,
			title: document.title.slice(0, 60),
			bodyChildren: document.body ? document.body.childElementCount : -1,
			rootHtml: (document.querySelector('#root, #app') ?? document.body)?.innerHTML?.slice(0, 200) ?? '(no root)',
			scripts: document.querySelectorAll('script').length,
			text: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120) : ''
		}))()`, ctx.id);
		console.log(`--- ctx ${ctx.id}:`, JSON.stringify(info).slice(0, 400));
	} catch (e) {
		console.log(`--- ctx ${ctx.id}: (gone) ${String(e.message).slice(0, 80)}`);
	}
}
console.log('=== console (last 20) ===');
for (const line of consoleLines.slice(-20)) console.log(line.slice(0, 300));
if (setHtmlPayload) {
	console.log('=== setHtml head ===');
	console.log(setHtmlPayload.slice(0, 600));
}
process.exit(0);
