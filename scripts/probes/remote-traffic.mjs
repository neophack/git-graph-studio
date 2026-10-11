// The Remote Access traffic probe (docs/ggs-remote-plan.md §10.5, M7.4): the R3 numbers —
// what a cold start costs on the wire (the workbench's first paint, as served, brotli
// included), what a warm second visit costs (the Service Worker and the HTTP cache doing
// their work), and what the WebSocket carried while the File Explorer listed the folder.
// Headless Edge over CDP with a throwaway profile is the phone. Numbers land in
// target/studio/metrics.json under `remote.traffic`; nothing here gates a build (principle 6).
//
//   node scripts/probes/remote-traffic.mjs [--app <ggs exe>] [--daemon <ggs-remote exe>] [--folder <repo>] [--keep]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { encodeMsgpack, decodeMsgpack } from '../../extensions-src/ggs-remote/daemon/web/wire.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const arg = (name, fallback) => {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : fallback;
};
const exe = process.platform === 'win32' ? '.exe' : '';
const appExe = arg('--app', resolve(root, 'target/studio/cargo/debug', `git-graph-studio${exe}`));
const daemonExe = arg('--daemon', resolve(root, 'extensions-src/ggs-remote/daemon/target/release', `ggs-remote${exe}`));
const folder = arg('--folder', root);
const keep = process.argv.includes('--keep');
const EDGE = process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : null;
const PASSWORD = 'traffic-probe-kayak-42';
const home = resolve(root, 'target/studio/remote-traffic');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function freePort() {
	return new Promise((resolvePort) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}
const portOpen = (port) =>
	new Promise((ok) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			ok(true);
		});
		socket.once('error', () => ok(false));
	});
process.on('exit', () => {
	for (const child of children) {
		try {
			child.kill();
		} catch {
			/* gone */
		}
	}
});

// ---- frames (same shape as remote-live-check.mjs) ----
const T = { HELLO: 1, HELLO_ACK: 2, WINDOWS: 3 };
function frame(type, enc, payload) {
	const body = Buffer.from(payload ?? []);
	const head = Buffer.alloc(20);
	head[0] = type;
	head[1] = enc << 2;
	head.writeUInt32LE(body.length, 16);
	return Buffer.concat([head, body]);
}
const mp = (type, body) => frame(type, 2, encodeMsgpack(body));
function decode(data) {
	const bytes = Buffer.from(data);
	const out = [];
	for (let at = 0; at + 20 <= bytes.length; ) {
		const len = bytes.readUInt32LE(at + 16);
		const enc = (bytes[at + 1] & 0x0c) >> 2;
		const payload = bytes.subarray(at + 20, at + 20 + len);
		out.push({
			type: bytes[at],
			body: enc === 2 && len ? decodeMsgpack(new Uint8Array(payload)) : enc === 1 && len ? JSON.parse(payload.toString('utf8')) : payload
		});
		at += 20 + len;
	}
	return out;
}

/** A CDP page with a wire meter: Network.loadingFinished' encodedDataLength is what
 *  actually crossed — headers and body, post-compression. */
async function browserPage(cdpPort) {
	const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const target = list.find((t) => t.type === 'page');
	const cdp = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const meter = { bytes: 0, requests: [], wire: [] };
	cdp.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { ok, fail } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
		} else if (msg.method === 'Network.loadingFinished') {
			meter.bytes += msg.params.encodedDataLength ?? 0;
		}
	};
	const send = (method, params = {}) =>
		new Promise((ok, fail) => {
			const id = nextId++;
			pending.set(id, { ok, fail });
			cdp.send(JSON.stringify({ id, method, params }));
		});
	await new Promise((ok, fail) => {
		cdp.onopen = ok;
		cdp.onerror = fail;
	});
	await send('Network.enable');
	await send('Runtime.enable');
	await send('Page.enable');
	const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
	const waitFor = async (expression, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await evaluate(expression).catch(() => false)) return true;
			await sleep(300);
		}
		return false;
	};
	return {
		resetMeter: () => {
			meter.bytes = 0;
			meter.requests = [];
			meter.wire = [];
		},
		readMeter: () => meter.bytes,
		requests: () => meter.requests,
		navigate: (url) => send('Page.navigate', { url }),
		evaluate,
		waitFor,
		close: () => cdp.close()
	};
}

setTimeout(() => {
	console.error('FAIL five minutes elapsed — aborting');
	process.exit(1);
}, 5 * 60 * 1000).unref?.();

async function main() {
	for (const [label, path] of [
		['app', appExe],
		['daemon', daemonExe],
		['edge', EDGE]
	]) {
		if (!existsSync(path)) throw new Error(`the ${label} binary is missing: ${path}`);
	}
	rmSync(home, { recursive: true, force: true });
	mkdirSync(resolve(home, 'remote'), { recursive: true });
	const port = await freePort();
	const env = { ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs') };
	writeFileSync(resolve(home, 'remote/config.json'), JSON.stringify({ port, bind: '127.0.0.1', tls: { mode: 'none' }, autostart: false, mdns: false }));
	await new Promise((ok, fail) => {
		const child = spawn(daemonExe, ['set-password', PASSWORD], { env });
		child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`set-password exited ${code}`))));
	});
	const daemon = spawn(daemonExe, ['run', '--no-tray'], { env, stdio: 'ignore' });
	for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(100);

	if (!(await portOpen(5173))) {
		const vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
		children.push(vite);
		for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
	}
	const app = spawn(appExe, ['--remote-host', folder], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	let appLog = '';
	let appLogDone = false;
	app.stdout?.on('data', (d) => (appLog += d));
	app.stderr?.on('data', (d) => (appLog += d));
	app.on('exit', (code) => {
		if (!appLogDone) console.error(`the app exited ${code}:\n${appLog.split('\n').slice(-20).join('\n')}`);
	});

	const base = `http://127.0.0.1:${port}`;

	// Learn the instance's id and version off a WS the way the picker does.
	const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, device: 'traffic-probe' }) });
	if (!login.ok) throw new Error(`login failed: ${login.status}`);
	const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
	const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
	ws.binaryType = 'arraybuffer';
	let instance = null;
	const windowsWaiter = new Promise((ok) => {
		ws.onmessage = (event) => {
			for (const f of decode(event.data)) {
				if (f.type === T.WINDOWS && f.body.instances?.length) ok(f.body.instances[0]);
			}
		};
	});
	await new Promise((ok, fail) => {
		const timer = setTimeout(() => fail(new Error('websocket did not open')), 10000);
		ws.onopen = () => {
			clearTimeout(timer);
			ok();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			fail(new Error('websocket failed'));
		};
	});
	ws.send(mp(T.HELLO, { proto: 1, client: 'traffic-probe', csrf: session.csrf, caps: { deflate: false } }));
	for (let i = 0; i < 200 && !instance; i++) {
		instance = await Promise.race([windowsWaiter, sleep(200).then(() => null)]);
	}
	ws.close();
	if (!instance) {
		appLogDone = true;
		console.error(`the app log:\n${appLog.split('\n').slice(-30).join('\n')}`);
		throw new Error('no instance registered in 40 s');
	}

	const cdpPort = await freePort();
	const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${resolve(home, 'edge-profile')}`, '--window-size=1400,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
	children.push(edge);
	let page = null;
	for (let i = 0; i < 50 && !page; i++) {
		await sleep(200);
		page = await browserPage(cdpPort).catch(() => null);
	}
	if (!page) throw new Error('headless Edge did not start');

	// The cookie must live in the profile for the warm pass too — log in inside the page.
	await page.navigate(`${base}/login`);
	await page.waitFor(`document.readyState === 'complete'`, 10000);
	await page.evaluate(`fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)}, device: 'traffic probe' }) }).then((r) => r.ok)`);
	const workbench = `${base}/w/${encodeURIComponent(instance.id)}/v/${encodeURIComponent(instance.version)}/remote.html`;

	// ---- cold: the whole workbench, first visit, empty caches ----
	page.resetMeter();
	await page.navigate(workbench);
	const booted = await page.waitFor(`document.querySelectorAll('#activitybar .activity-item').length > 0 && !document.getElementById('boot-splash')`, 90000);
	const coldBytes = page.readMeter();
	const coldRequests = page.requests().slice().sort((a, b) => b.length - a.length);
	for (const r of coldRequests.slice(0, 8)) console.log(`COLD ${r.encoding || '-'} ${(r.length / 1024).toFixed(0)}KB ${r.url.slice(-56)}`);
	if (!booted) throw new Error('the workbench did not boot in the cold pass');
	const coldStats = await page.evaluate('JSON.stringify(window.__GGS_REMOTE__?.transport?.stats ?? null)').catch(() => null);

	// ---- warm: same profile again — the SW answers from its precache, the shell revalidates ----
	await sleep(1500);
	page.resetMeter();
	await page.navigate('about:blank');
	await page.navigate(workbench);
	const warmBooted = await page.waitFor(`document.querySelectorAll('#activitybar .activity-item').length > 0 && !document.getElementById('boot-splash')`, 60000);
	const warmBytes = page.readMeter();
	if (!warmBooted) throw new Error('the workbench did not boot in the warm pass');

	page.close();

	const parsed = coldStats ? JSON.parse(coldStats) : null;
	// Tear the stack down: piped children hold the event loop open otherwise.
	for (const child of [app, daemon]) {
		try {
			child.kill();
		} catch {
			/* gone */
		}
	}
	const metricsPath = resolve(root, 'target/studio/metrics.json');
	let metrics = {};
	try {
		metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
	} catch {
		/* first run */
	}
	metrics.remote = metrics.remote ?? {};
	metrics.remote.traffic = {
		coldStartBytes: coldBytes,
		warmVisitBytes: warmBytes,
		wsUpBytes: parsed?.up ?? null,
		wsDownBytes: parsed?.down ?? null,
		targets: { coldStartBytes: 1.5 * 1024 * 1024, warmVisitBytes: 50 * 1024 },
		at: new Date().toISOString()
	};
	writeFileSync(metricsPath, JSON.stringify(metrics, null, '\t') + '\n');
	const mb = (n) => (n / 1048576).toFixed(2);
	console.log(`cold start ${mb(coldBytes)} MB (target ≤ 1.50) · warm visit ${(warmBytes / 1024).toFixed(0)} KB (target ≤ 50) · ws ↑${mb(parsed?.up ?? 0)} MB ↓${mb(parsed?.down ?? 0)} MB → ${metricsPath}`);
	if (keep) {
		console.log('--keep: the stack stays up (Ctrl-C to stop)');
		await new Promise(() => undefined);
	}
}

main().catch((error) => {
	console.error(`FAIL ${error.message}`);
	process.exitCode = 1;
	process.exit(1);
});
