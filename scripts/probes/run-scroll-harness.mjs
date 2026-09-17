// Drive dev/dev-harness.html?scroll=1 — every scrolling surface through the wheel, the page
// keys and the drawn scrollbar in real layout — in headless Edge over CDP, and print the
// checks that did not pass. The dev server must be up (`npx vite --port <port>`); each run
// wants its own id so the harness boots clean.
// Usage: node scripts/probes/run-scroll-harness.mjs <devServerPort> <runId>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const devPort = process.argv[2] ?? '5173';
const run = process.argv[3] ?? String(Date.now());
const cdpPort = 9555;
const profile = mkdtempSync(join(tmpdir(), 'ggs-harness-'));
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
	'--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1400,900',
	'--no-first-run', '--disable-gpu', 'about:blank'
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list = null;
for (let i = 0; i < 50 && !list; i++) {
	await sleep(200);
	try { list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); } catch { /* not up yet */ }
}
if (!list) { edge.kill(); throw new Error('edge did not start'); }
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
await send('Page.navigate', { url: `http://localhost:${devPort}/dev/dev-harness.html?scroll=1&run=${run}` });
let report = null;
for (let i = 0; i < 180 && !report; i++) {
	await sleep(1000);
	const result = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__scrollReport || null)', returnByValue: true });
	report = JSON.parse(result.result.value);
}
ws.close();
edge.kill();
if (!report) { console.log('NO REPORT'); process.exit(2); }
const failed = report.filter((r) => r.status === 'fail');
const passed = report.filter((r) => r.status === 'pass');
for (const r of report) if (r.status !== 'pass') console.log(`${r.status.toUpperCase()} [${r.surface}] ${r.check}: expected ${r.expected}, got ${r.actual}`);
console.log(`${passed.length}/${passed.length + failed.length} passed`);
process.exit(failed.length ? 1 : 0);
