// Drive dev/dev-harness.html?full=1 — every module's self-test checks (the all-buttons
// sweep) plus, when the page runs under a real backend, the git-graph-rs and claude-code
// passes — in a headless browser over CDP, and print the rows that did not pass. The dev
// server must be up (`npx vite --port <port>`). NOTE the mode: a plain browser session
// runs against the scripted fake backend, so the extension phases SKIP — the full
// extension pass runs inside the app under `tauri dev` (Help -> Open Dev Harness), which
// this script cannot reach; the headless run covers the self-test sweep and the page
// error checks. Each run wants its own id so the harness boots clean.
// Usage: node scripts/probes/run-full-harness.mjs <devServerPort> <runId>
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const devPort = process.argv[2] ?? '5173';
const run = process.argv[3] ?? String(Date.now());
const cdpPort = 9566;

// The first Chromium-family browser this machine has (the scroll harness hardcodes Edge's
// Windows path; this one also runs on macOS and Linux CI).
const candidates = process.platform === 'win32'
	? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
	: process.platform === 'darwin'
		? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
		: ['google-chrome', 'chromium-browser', 'chromium'];
const browser = candidates.find((path) => existsSync(path) || !path.includes('/'));
if (!browser) {
	console.error('no Chromium-family browser found (tried: ' + candidates.join(', ') + ')');
	process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), 'ggs-full-harness-'));
const child = spawn(browser, [
	'--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1400,900',
	'--no-first-run', '--disable-gpu', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 50 && !list; i++) {
	await sleep(200);
	try { list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); } catch { /* not up yet */ }
}
if (!list) { child.kill(); throw new Error(browser + ' did not start'); }
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	}
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://localhost:${devPort}/dev/dev-harness.html?full=1&run=${run}` });
// The self-test sweep alone is hundreds of checks; the whole page settles inside ~3 min.
let report = null;
for (let i = 0; i < 240 && !report; i++) {
	await sleep(1000);
	const done = await send('Runtime.evaluate', { expression: '(window.__fullFailed !== undefined) ? window.__fullReport : null', returnByValue: true });
	report = done.result.value;
}
ws.close();
child.kill();
if (!report) { console.log('NO REPORT'); process.exit(2); }
const failed = report.filter((r) => r.status === 'fail');
const passed = report.filter((r) => r.status === 'pass');
const skipped = report.filter((r) => r.status === 'skip');
for (const r of report) if (r.status !== 'pass') console.log(`${r.status.toUpperCase()} [${r.group}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`${passed.length}/${passed.length + failed.length} passed (${skipped.length} skipped)`);
process.exit(failed.length ? 1 : 0);
