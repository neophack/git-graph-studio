// Where the main thread's time goes while the workbench boots: launches the release exe with
// WebView2 remote debugging on, attaches over CDP, records a devtools timeline trace across a
// page reload (the whole boot runs again: initial file / folder, explorer, graph view), and
// prints the trace's events summed by kind and, for script evaluation and function calls, by
// script - so a slow boot can be attributed to parsing, layout, or one module's work.
//
//   node scripts/cdp-trace.mjs <file-or-folder> [--exe build.exe] [--port 9223] [--settle 3000]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
	const at = args.indexOf(name);
	return at === -1 ? fallback : args[at + 1];
};
const exe = flag('--exe', join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe'));
const port = flag('--port', '9223');
const settle = Number(flag('--settle', '3000'));
if (!target || !existsSync(target) || !existsSync(exe)) {
	console.error('usage: node scripts/cdp-trace.mjs <file-or-folder> [--exe build.exe] [--port 9223]');
	process.exit(2);
}

const child = spawn(exe, [target], {
	stdio: 'ignore',
	env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

let page = null;
for (let i = 0; i < 20 && !page; i++) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
		page = list.find((t) => t.type === 'page' && !t.url.includes('view.html'));
	} catch {
		await sleep(500);
	}
}
if (!page) {
	console.error('no CDP page target');
	child.kill();
	process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const events = [];
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
let tracingDone;
const tracingComplete = new Promise((r) => { tracingDone = r; });
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	} else if (msg.method === 'Tracing.dataCollected') {
		events.push(...msg.params.value);
	} else if (msg.method === 'Tracing.tracingComplete') {
		tracingDone();
	}
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send('Page.enable');
await send('Tracing.start', {
	categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.execute,blink.user_timing',
	transferMode: 'ReportEvents'
});
await send('Page.reload', { ignoreCache: false });
await sleep(settle);
await send('Tracing.end');
await tracingComplete;
ws.close();
spawnSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow(); if (-not $p.WaitForExit(4000)) { Stop-Process -Id ${child.pid} -Force } }`], { stdio: 'ignore' });

// Complete events (ph 'X') carry a duration; nested events overlap, so the sums below are
// per kind and per script, not a partition of wall time. Only the renderer's main thread
// counts (the process/thread with the most timeline events).
const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
const byThread = new Map();
for (const e of complete) {
	const key = `${e.pid}:${e.tid}`;
	byThread.set(key, (byThread.get(key) ?? 0) + 1);
}
const [mainThread] = [...byThread.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
const main = complete.filter((e) => `${e.pid}:${e.tid}` === mainThread);
const first = Math.min(...main.map((e) => e.ts));
const last = Math.max(...main.map((e) => e.ts + e.dur));

const sumBy = (keyOf) => {
	const totals = new Map();
	for (const e of main) {
		const key = keyOf(e);
		if (!key) continue;
		totals.set(key, (totals.get(key) ?? 0) + e.dur / 1000);
	}
	return [...totals.entries()].sort((a, b) => b[1] - a[1]);
};
const shortUrl = (url) => (url ? url.replace(/^https?:\/\/tauri\.localhost/, '').replace(/^https?:\/\/[^/]+/, '') : '');

console.log(`trace window: ${((last - first) / 1000).toFixed(0)} ms on the main thread, ${main.length} events\n`);
console.log('by event kind (ms, nested events overlap):');
for (const [name, ms] of sumBy((e) => e.name).slice(0, 18)) console.log(`  ${name.padEnd(36)} ${ms.toFixed(1).padStart(8)}`);
console.log('\nscript evaluation by script (ms):');
for (const [url, ms] of sumBy((e) => (e.name === 'EvaluateScript' || e.name === 'v8.compile' || e.name === 'V8.CompileScript') ? shortUrl(e.args?.data?.url) || '(inline)' : null).slice(0, 12)) console.log(`  ${url.padEnd(56)} ${ms.toFixed(1).padStart(8)}`);
console.log('\nfunction calls by script (ms):');
for (const [url, ms] of sumBy((e) => (e.name === 'FunctionCall' || e.name === 'TimerFire' || e.name === 'EventDispatch') ? shortUrl(e.args?.data?.url ?? e.args?.data?.functionName) || '(unknown)' : null).slice(0, 12)) console.log(`  ${url.padEnd(56)} ${ms.toFixed(1).padStart(8)}`);
console.log('\nlongest single events:');
for (const e of [...main].sort((a, b) => b.dur - a.dur).slice(0, 15)) {
	const at = ((e.ts - first) / 1000).toFixed(0);
	const what = shortUrl(e.args?.data?.url) || e.args?.data?.functionName || '';
	console.log(`  +${at.padStart(5)} ms  ${(e.dur / 1000).toFixed(1).padStart(7)} ms  ${e.name} ${what}`);
}
