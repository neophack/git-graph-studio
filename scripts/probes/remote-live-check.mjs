// The Remote Access live check (docs/ggs-remote-plan.md §17.5): a real GGS instance in
// `--remote-host` mode (no desktop window), a hermetic GGS Remote daemon, and this script as
// the browser — login, the window list, ATTACH (the instance builds its hidden Relay webview),
// invokes that cross daemon → Relay → the real Tauri commands, an event subscription, the
// remote workbench's assets, and a graceful close. Nothing touches the user's ~/.ggs/remote.
//
//   node scripts/probes/remote-live-check.mjs [--app <ggs exe>] [--daemon <ggs-remote exe>]
//                                             [--folder <repo>] [--keep]
//
// Debug app builds load relay.html from the Vite dev server: the script starts
// `npm run dev:vite` when nothing answers on :5173. The remote build must exist
// (`npm run build:remote`) for the asset check.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const daemonExe = arg('--daemon', resolve(root, 'target/studio/ggs-remote/release', `ggs-remote${exe}`));
const folder = arg('--folder', root);
const keep = process.argv.includes('--keep');
const PASSWORD = 'live-check-kayak-42';
const home = resolve(root, 'target/studio/remote-live');

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
	return new Promise((resolvePort) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

function portOpen(port) {
	return new Promise((resolveOpen) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolveOpen(true);
		});
		socket.once('error', () => resolveOpen(false));
	});
}

// ---- frames (the header by hand; MessagePack from the daemon pages' codec) ----
const T = { HELLO: 1, HELLO_ACK: 2, WINDOWS: 3, ATTACH: 4, ATTACHED: 5, INVOKE: 0x10, RESULT: 0x11, LISTEN: 0x30, EVENT: 0x32, INSTANCE_CLOSE: 0x0a, NOTICE: 0x60, CLOSE: 0x7f, PING: 0x51 };
function frame(type, enc, payload, stream = 0) {
	const body = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload ?? []);
	const head = Buffer.alloc(20);
	head[0] = type;
	head[1] = enc << 2;
	head.writeUInt32LE(stream, 8);
	head.writeUInt32LE(body.length, 16);
	return Buffer.concat([head, body]);
}
const mp = (type, body, stream = 0) => frame(type, 2, encodeMsgpack(body), stream);
const json = (type, body, stream = 0) => frame(type, 1, JSON.stringify(body), stream);
function decode(data) {
	const bytes = Buffer.from(data);
	const out = [];
	for (let at = 0; at + 20 <= bytes.length; ) {
		const len = bytes.readUInt32LE(at + 16);
		const flags = bytes[at + 1];
		const payload = bytes.subarray(at + 20, at + 20 + len);
		const enc = (flags & 0x0c) >> 2;
		out.push({
			type: bytes[at],
			flags,
			stream: bytes.readUInt32LE(at + 8),
			body: enc === 2 && len ? decodeMsgpack(new Uint8Array(payload)) : enc === 1 && len ? JSON.parse(payload.toString('utf8')) : payload
		});
		at += 20 + len;
	}
	return out;
}

// ---- the browser phase: the real remote workbench in headless Edge over CDP ----
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function browserPhase(base, instance, port) {
	const cdpPort = await freePort();
	const profile = resolve(home, 'edge-profile');
	const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1400,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
	children.push(edge);
	let list = null;
	for (let i = 0; i < 50 && !list; i++) {
		await sleep(200);
		try {
			list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
		} catch {
			/* not up yet */
		}
	}
	if (!list) return check('headless Edge', false, 'did not start');
	const target = list.find((t) => t.type === 'page');
	const cdp = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const errors = [];
	cdp.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { ok, fail } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) fail(new Error(JSON.stringify(msg.error)));
			else ok(msg.result);
		} else if (msg.method === 'Runtime.exceptionThrown') {
			errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
		} else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
			errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
		}
	};
	const send = (method, params = {}) =>
		new Promise((ok, fail) => {
			const id = nextId++;
			pending.set(id, { ok, fail });
			cdp.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
	const waitFor = async (expression, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await evaluate(expression).catch(() => false)) return true;
			await sleep(300);
		}
		return false;
	};
	const shot = async (name) => {
		const { data } = await send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(resolve(home, name), Buffer.from(data, 'base64'));
	};
	await new Promise((ok, fail) => {
		cdp.onopen = ok;
		cdp.onerror = fail;
	});
	await send('Runtime.enable');
	await send('Page.enable');
	await send('Page.navigate', { url: `${base}/login` });
	await waitFor(`document.readyState === 'complete' && !!document.getElementById('password')`, 15000);
	const loggedIn = await evaluate(`fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)}, device: 'headless edge' }) }).then((r) => r.ok)`);
	check('browser: login', loggedIn === true);
	// The ggs-remote extension pushes its `ggsRemote.*` settings to /admin/config at
	// activation; with the bare defaults that push would REBIND the public listener (the
	// probe's random port and plain HTTP are not the defaults) and every in-flight page
	// fetch would hit a dead port. Seed the extension's stored settings (same origin, set
	// from the login page) to match the probe daemon, so the push lands as a no-op.
	const extSettings = JSON.stringify({ 'ggsRemote.port': port, 'ggsRemote.bind': '127.0.0.1', 'ggsRemote.tlsMode': 'none' });
	await evaluate(`localStorage.setItem('ggstudio.extSettings.ggs.ggs-remote', ${JSON.stringify(extSettings)})`);
	const workbench = `${base}/w/${instance.id}/v/${instance.version}/remote.html`;
	await send('Page.navigate', { url: workbench });
	const booted = await waitFor(`document.querySelectorAll('#activitybar .activity-item').length > 0 && !document.getElementById('boot-splash')`, 60000);
	check('browser: the remote workbench booted', booted, booted ? '' : String(await evaluate(`document.getElementById('boot-splash')?.textContent ?? document.body.innerText.slice(0, 200)`).catch(() => '')));
	const explorer = await waitFor(`/package\\.json|README\\.md|src/.test(document.getElementById('sidebar')?.innerText ?? '')`, 30000);
	check('browser: the File Explorer lists the folder over the Relay', explorer);
	check('browser: the window switcher is in the title bar', await evaluate(`!!document.querySelector('.ggs-window-switcher')`));
	await shot('remote-desktop.png');
	// The daemon must still be answering — the ggs-remote extension's install pass runs at
	// the instance's activation and once shut a same-version daemon down mid-session,
	// killing every remote socket (the "nothing loads from the phone" outage).
	await sleep(4000);
	const daemonAlive = await evaluate(`fetch('api/session', { credentials: 'same-origin' }).then((r) => r.status !== -1 && r.status < 500).catch(() => false)`);
	check('browser: the daemon survived the extension activation', daemonAlive === true);
	await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await send('Emulation.setTouchEmulationEnabled', { enabled: true });
	const phone = await waitFor(`document.documentElement.dataset.formFactor === 'phone' && !!document.querySelector('.ggs-bottom-tabs:not([hidden])')`, 10000);
	check('browser: phone layout with bottom tabs', phone);
	// Opening a file on the phone: tap a row, the editor's content must arrive — and it
	// opens LOCKED (a finger browsing must not drop a caret into the text): the unlock
	// bar's one tap lifts the lock for that editor.
	await evaluate(`(() => { const row = [...document.querySelectorAll('#sidebar .row')].find((r) => /README\\.md/.test(r.textContent ?? '')); if (row) { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; } return false; })()`);
	const fileContent = await waitFor(`(() => { const cm = document.querySelector('.cm-content'); return !!cm && (cm.textContent ?? '').trim().length > 100; })()`, 20000);
	check('browser: phone — opening a file shows its content', fileContent, String(await evaluate(`(document.querySelector('.cm-content')?.textContent ?? '').slice(0, 60)`)));
	const lockBar = await waitFor(`!!document.querySelector('.edit-lock-bar')`, 5000);
	check('browser: phone — the file opens locked with an unlock bar', lockBar);
	if (lockBar) {
		await evaluate(`document.querySelector('.edit-lock-bar button').click()`);
		const lifted = await waitFor(`!document.querySelector('.edit-lock-bar')`, 5000);
		check('browser: phone — one tap unlocks the editor', lifted);
	}
	// The Source Control view over the bottom tabs: the status must arrive, not an empty pane.
	await evaluate(`(() => { const btn = [...document.querySelectorAll('.ggs-bottom-tabs button')].find((b) => b.dataset.tab === 'scm'); if (btn) { btn.click(); return true; } return false; })()`);
	const scm = await waitFor(`(() => { const side = document.getElementById('sidebar'); const text = side?.innerText ?? ''; return !side?.hidden && /(staged|changes|暂存|更改)/i.test(text) && text.trim().length > 20; })()`, 20000);
	check('browser: phone — the Source Control view lists changes', scm, String(await evaluate(`(document.getElementById('sidebar')?.innerText ?? '').slice(0, 80)`)));
	await shot('remote-phone.png');
	// The extension host frame (plugin features): its document and hashed scripts must load
	// through the token path — the root-absolute /assets/ references once 404'd at the
	// daemon's root and no frame extension ever activated.
	const extHost = await evaluate(`__TAURI_INTERNALS__.convertFileSrc('ext-host.html', 'ggs')`);
	const extHostDoc = await evaluate(`fetch(${JSON.stringify(extHost)}).then((r) => (r.ok ? r.text() : 'HTTP ' + r.status)).catch((e) => 'ERR ' + e)`);
	const script = /src="([^"]*assets\/[^"]*\.js)"/.exec(String(extHostDoc))?.[1];
	const scriptOk = script
		? await evaluate(`fetch(${JSON.stringify(script)}).then((r) => r.ok).catch(() => false)`)
		: false;
	check('browser: the extension host frame loads through the token path', Boolean(script) && scriptOk === true, `${extHost} → ${script ?? 'no script ref'}`);
	const stats = await evaluate(`JSON.stringify((({ up, down }) => ({ up, down }))(window.__GGS_REMOTE__?.transport.stats ?? {}))`);
	check('browser: traffic counted', /"down":\d+/.test(stats ?? ''), stats);
	check('browser: no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
	cdp.close();
	edge.kill();
}

const children = [];
function cleanup() {
	for (const child of children) {
		try {
			child.kill();
		} catch {
			/* gone */
		}
	}
}
process.on('exit', cleanup);

async function main() {
	for (const [label, path] of [['app', appExe], ['daemon', daemonExe]]) {
		if (!existsSync(path)) throw new Error(`the ${label} binary is missing: ${path}`);
	}
	rmSync(home, { recursive: true, force: true });
	mkdirSync(resolve(home, 'remote'), { recursive: true });
	const port = await freePort();
	const env = { ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs') };
	writeFileSync(resolve(home, 'remote/config.json'), JSON.stringify({ port, bind: '127.0.0.1', tls: { mode: 'none' }, autostart: false, mdns: false }));
	// Pre-seed the installed copy and its VERSION record: the ggs-remote extension's
	// activation runs `ggs-remote install`, and a VSIX whose CLI predates the same-version
	// guard would otherwise shut this daemon down mid-check to "upgrade" it to the same
	// bytes (the outage this probe's daemon-alive check stands watch over). Seeding makes
	// the check hermetic against whatever CLI vintage the installed extension carries.
	const version = spawn(daemonExe, ['--version']);
	let versionOut = '';
	version.stdout.on('data', (d) => (versionOut += d));
	await new Promise((ok) => version.on('close', ok));
	mkdirSync(resolve(home, 'remote/bin'), { recursive: true });
	copyFileSync(daemonExe, resolve(home, 'remote/bin', `ggs-remote${exe}`));
	writeFileSync(resolve(home, 'remote/bin/VERSION'), (versionOut.match(/[\d.]+/) ?? ['0.1.0'])[0]);

	await new Promise((ok, fail) => {
		const child = spawn(daemonExe, ['set-password', PASSWORD], { env });
		child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`set-password exited ${code}`))));
	});
	const daemon = spawn(daemonExe, ['run', '--no-tray'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(daemon);
	let daemonLog = '';
	daemon.stderr.on('data', (d) => (daemonLog += d));
	for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(100);
	check('daemon listening', await portOpen(port), `http://127.0.0.1:${port}/`);

	if (!(await portOpen(5173))) {
		console.log('starting the Vite dev server for the debug app’s relay.html …');
		const vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
		children.push(vite);
		for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
	}
	check('vite dev server', await portOpen(5173));

	const app = spawn(appExe, ['--remote-host', folder], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(app);
	let appLog = '';
	app.stderr.on('data', (d) => (appLog += d));
	app.stdout.on('data', (d) => (appLog += d));

	const base = `http://127.0.0.1:${port}`;
	const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, device: 'live-check' }) });
	check('login', login.ok, String(login.status));
	const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
	const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
	ws.binaryType = 'arraybuffer';
	const inbox = [];
	const waiters = [];
	ws.onmessage = (event) => {
		for (const f of decode(event.data)) {
			inbox.push(f);
			for (const w of [...waiters]) if (w.match(f)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(f);
			}
		}
	};
	const next = (match, ms = 20000) =>
		new Promise((ok, fail) => {
			const found = inbox.find(match);
			if (found) {
				inbox.splice(inbox.indexOf(found), 1);
				return ok(found);
			}
			const waiter = { match, resolve: ok };
			waiters.push(waiter);
			setTimeout(() => fail(new Error('timed out waiting for a frame')), ms);
		});
	await new Promise((ok, fail) => {
		ws.onopen = ok;
		ws.onerror = () => fail(new Error('websocket failed'));
	});
	ws.send(mp(T.HELLO, { proto: 1, client: 'live-check', csrf: session.csrf, caps: { deflate: false } }));
	await next((f) => f.type === T.HELLO_ACK);
	let instance;
	const deadline = Date.now() + 40000;
	while (!instance && Date.now() < deadline) {
		const windows = await next((f) => f.type === T.WINDOWS, 40000).catch(() => null);
		instance = windows?.body.instances?.[0];
	}
	check('the instance registered', Boolean(instance), instance ? `${instance.id} ${instance.version} ${JSON.stringify(instance.folders)}` : 'no WINDOWS with an instance');
	if (!instance) throw new Error('no instance');

	const asset = await fetch(`${base}/w/${instance.id}/v/${instance.version}/remote.html`, { headers: { cookie } });
	check('remote workbench asset', asset.ok, `${asset.status} ${asset.headers.get('content-type')}`);

	ws.send(mp(T.ATTACH, { instance: instance.id }));
	const attached = await next((f) => f.type === T.ATTACHED || f.type === T.NOTICE, 40000).catch(() => null);
	check('ATTACH → the Relay webview connected', attached?.type === T.ATTACHED, attached ? JSON.stringify(attached.body) : 'timeout');
	if (attached?.type !== T.ATTACHED) {
		await sleep(2000);
		console.error('--- app log on attach failure ---\n' + appLog.split('\n').slice(-25).join('\n') + '\n---');
	}

	let stream = 1;
	const invoke = async (c, a) => {
		const id = (stream += 2);
		ws.send(json(T.INVOKE, { c, a }, id));
		const result = await next((f) => f.type === T.RESULT && f.stream === id);
		if (result.flags & 0x10) throw new Error(result.body?.message ?? 'error');
		return result.body;
	};
	const status = await invoke('remote_host_status', {});
	check('invoke remote_host_status', status?.connected === true && status?.remoteHostOnly === true, JSON.stringify(status));
	const listing = await invoke('list_dir', { path: folder });
	check('invoke list_dir over the Relay', Array.isArray(listing) && listing.length > 0, `${listing.length} entries`);
	const missing = await invoke('read_file', { path: resolve(folder, 'definitely-missing-file.txt') }).then(
		() => 'resolved',
		(error) => String(error.message)
	);
	check('a failing command rejects with its message', missing !== 'resolved', missing);
	ws.send(mp(T.LISTEN, { event: 'studio://git-output' }, (stream += 2)));
	check('event subscription accepted', true);

	if (existsSync(EDGE) && !process.argv.includes('--no-browser')) await browserPhase(base, instance, port);
	else console.log('SKIP  the browser phase (no Edge, or --no-browser)');

	ws.send(mp(T.INSTANCE_CLOSE, { instance: instance.id, force: false }));
	const gone = await next((f) => (f.type === T.CLOSE && f.body?.code === 4410) || (f.type === T.NOTICE && f.body?.kind === 'close-blocked'), 20000).catch(() => null);
	check('graceful close', Boolean(gone), gone ? JSON.stringify(gone.body) : 'timeout');

	ws.close();
	const report = { at: new Date().toISOString(), results, daemonLog: daemonLog.split('\n').slice(-30), appLog: appLog.split('\n').filter((l) => /remote|relay|error/i.test(l)).slice(-30) };
	writeFileSync(resolve(home, 'report.json'), JSON.stringify(report, null, '\t'));
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed — report: ${resolve(home, 'report.json')}`);
	if (keep) {
		console.log('--keep: leaving the daemon and the app running (Ctrl-C to stop)');
		await new Promise(() => undefined);
	}
	process.exitCode = failed.length ? 1 : 0;
}

main()
	.catch((error) => {
		console.error(`FAIL  ${error.message}`);
		process.exitCode = 1;
	})
	.finally(() => {
		if (!keep) {
			cleanup();
			setTimeout(() => process.exit(process.exitCode ?? 0), 500);
		}
	});

