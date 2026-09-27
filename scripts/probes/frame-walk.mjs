// Walks every frame/session/context of the running app and dumps live state, to find
// where the claude webview actually renders (or fails to).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe');
const port = '9243';
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
const sessions = new Map(); // sessionId → { url }
const contexts = []; // { contextId, sessionId, origin, name }
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve } = pending.get(msg.id);
		pending.delete(msg.id);
		resolve(msg.result);
	} else if (msg.method === 'Target.attachedToTarget') {
		const { sessionId, targetInfo } = msg.params;
		sessions.set(sessionId, { url: String(targetInfo.url).slice(0, 70), type: targetInfo.type });
	} else if (msg.method === 'Runtime.executionContextCreated') {
		const ctx = msg.params.context;
		const owner = msg.params.sessionId ?? 'main';
		contexts.push({ contextId: ctx.id, sessionId: msg.params.sessionId ?? null, owner, origin: String(ctx.origin).slice(0, 50), name: String(ctx.name).slice(0, 30) });
	}
};
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params: sessionId ? { ...params, sessionId } : params }));
});
await send('Runtime.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

// Open the page.
await sleep(8000);
await (async () => {
	try {
		await send('Runtime.evaluate', { expression: `(async () => {
			const open = document.querySelector('#overlays .quick-input input');
			open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
			await new Promise((r) => setTimeout(r, 200));
			document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await new Promise((r) => setTimeout(r, 400));
			const input = document.querySelector('#overlays .quick-input input');
			if (!input) return;
			input.value = '> Claude Code: Open in New Tab';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			for (let a = 0; a < 20; a++) {
				await new Promise((r) => setTimeout(r, 250));
				const row = [...document.querySelectorAll('#overlays .quick-input .row')].find((r2) => /Open in New Tab/.test(r2.textContent));
				if (row) { row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return; }
			}
		})()`, returnByValue: true });
	} catch {}
})();
await sleep(10000);

console.log('=== attached sessions ===');
for (const [sid, info] of sessions) console.log(sid, JSON.stringify(info));
console.log('=== contexts ===');
for (const c of contexts) console.log(JSON.stringify(c));

console.log('=== probing every context ===');
for (const c of contexts) {
	try {
		const result = await send('Runtime.evaluate', {
			expression: `(() => ({ href: location.href.slice(0, 70), root: Boolean(document.querySelector('#root')), children: document.body ? document.body.childElementCount : -1, text: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 70) : '' }))()`,
			contextId: c.contextId,
			returnByValue: true
		});
		const v = result?.result?.value;
		console.log(`ctx ${c.contextId} (${c.origin}):`, v ? JSON.stringify(v).slice(0, 200) : JSON.stringify(result?.result));
	} catch (e) {
		console.log(`ctx ${c.contextId}: FAILED ${String(e.message).slice(0, 100)}`);
	}
}

console.log('=== probing attached sessions ===');
for (const [sid, info] of sessions) {
	try {
		await send('Runtime.enable', {}, sid);
		const result = await send('Runtime.evaluate', {
			expression: `(() => ({ href: location.href.slice(0, 70), root: Boolean(document.querySelector('#root')), children: document.body ? document.body.childElementCount : -1, text: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 70) : '' }))()`,
			returnByValue: true
		}, sid);
		const v = result?.result?.value;
		console.log('session', sid.slice(0, 8), JSON.stringify(info), '->', v ? JSON.stringify(v).slice(0, 250) : JSON.stringify(result?.result));
	} catch (e) {
		console.log('session', sid.slice(0, 8), 'FAILED', String(e.message).slice(0, 100));
	}
}
// Dump the claude webview srcdoc attribute for standalone rendering.
const srcdocExpr = "(() => { const f = [...document.querySelectorAll('iframe')].find((f2) => (f2.getAttribute('srcdoc') || '').length > 1000); return f ? f.getAttribute('srcdoc') : ''; })()";
const srcdocResult = await send('Runtime.evaluate', { expression: srcdocExpr, returnByValue: true });
const html = srcdocResult?.result?.value || '';
fs.mkdirSync('target/studio', { recursive: true });
fs.writeFileSync('target/studio/claude-srcdoc.html', html);
console.log('srcdoc saved: target/studio/claude-srcdoc.html', html.length, 'chars');
process.exit(0);
