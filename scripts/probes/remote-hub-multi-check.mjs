// The GGS Remote multi-PC live check over a real Hub (docs/ggs-remote-plan.md §20): one Hub,
// two daemons in hermetic homes (two "PCs"), two real GGS instances in --remote-host mode —
// one folder each — and ONE browser user logged into BOTH PCs through the Hub's /u/<uuid>/
// paths on the single shared origin. Verifies the multi-user story end to end: parallel
// sessions, Cookie path isolation, per-PC storage prefixes, both workbenches alive at once,
// a password change on PC A kicking only A, and the front-door guards (cross-PC cookie,
// Origin/CSRF on the WebSocket, path traversal, offline-link probing, login rate limit).
//
//   node scripts/probes/remote-hub-multi-check.mjs [--app <ggs exe>] [--daemon <ggs-remote exe>]
//                                                 [--hub <ggs-remote-hub exe>] [--keep]
//
// Debug app builds load relay.html from the Vite dev server; the script starts
// `npm run dev:vite` when nothing answers on :5173. Nothing touches ~/.ggs.
import { spawn, execSync } from 'node:child_process';
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
const hubExe = arg('--hub', resolve(root, 'extensions-src/ggs-remote/hub/target/release', `ggs-remote-hub${exe}`));
const keep = process.argv.includes('--keep');
const PASSWORD_A = 'hub-multi-tangerine-42';
const PASSWORD_A2 = 'hub-multi-rotated-99';
const PASSWORD_B = 'hub-multi-kayak-77';
const home = resolve(root, 'target/studio/remote-hub-test');

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

// ---- frames (header by hand; MessagePack from the daemon pages' codec) ----
const T = { HELLO: 1, HELLO_ACK: 2, WINDOWS: 3, ATTACH: 4, ATTACHED: 5, INVOKE: 0x10, RESULT: 0x11, NOTICE: 0x60, CLOSE: 0x7f };
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

// ---- process bookkeeping ----
const children = [];
function run(cmd, args, opts = {}) {
	const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
	children.push(child);
	return child;
}
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

const admin = async (pc, method, path, body) => {
	const args = ['admin', method, path];
	if (body !== undefined) args.push(body);
	const child = run(daemonExe, args, { env: pc.env });
	let out = '';
	let err = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (err += d));
	const code = await new Promise((ok) => child.on('exit', ok));
	if (code !== 0) throw new Error(`admin ${method} ${path} on ${pc.name} exited ${code}: ${err || out}`);
	return out;
};

// One "PC": hermetic daemon home + app home, its own loopback port, its own repo folder.
async function makePc(name, password, folder) {
	const base = resolve(home, name);
	rmSync(base, { recursive: true, force: true });
	mkdirSync(resolve(base, 'remote'), { recursive: true });
	mkdirSync(resolve(base, 'ggs'), { recursive: true });
	const port = await freePort();
	const env = { ...process.env, GGS_REMOTE_HOME: resolve(base, 'remote'), GGS_HOME: resolve(base, 'ggs') };
	writeFileSync(resolve(base, 'remote/config.json'), JSON.stringify({ port, bind: '127.0.0.1', tls: { mode: 'none' }, autostart: false, mdns: false }));
	// Pre-seed the installed copy + VERSION (the ggs-remote extension's activation runs
	// `ggs-remote install`; the same-version guard must find this daemon current).
	const version = run(daemonExe, ['--version'], { env });
	let versionOut = '';
	version.stdout.on('data', (d) => (versionOut += d));
	await new Promise((ok) => version.on('close', ok));
	mkdirSync(resolve(base, 'remote/bin'), { recursive: true });
	copyFileSync(daemonExe, resolve(base, 'remote/bin', `ggs-remote${exe}`));
	writeFileSync(resolve(base, 'remote/bin/VERSION'), (versionOut.match(/[\d.]+/) ?? ['0.1.0'])[0]);
	// The CLI's set-password writes auth.json directly while the daemon is down.
	await new Promise((ok, fail) => {
		const child = run(daemonExe, ['set-password', password], { env });
		let err = '';
		child.stderr.on('data', (d) => (err += d));
		child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`set-password exited ${code}: ${err}`))));
	});
	const daemon = run(daemonExe, ['run', '--no-tray'], { env });
	let log = '';
	daemon.stderr.on('data', (d) => (log += d));
	for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(100);
	check(`${name}: daemon listening`, await portOpen(port), `http://127.0.0.1:${port}/`);
	return { name, password, folder, port, env, base, daemonLog: () => log };
}

// A browser-side WebSocket session through the Hub's tunnel (cookie + csrf + origin set up
// exactly as the page's transport would).
function wsSession(hubPort, pc, cookie) {
	const origin = `http://127.0.0.1:${hubPort}`;
	const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/u/${pc.uuid}/ws`, { headers: { cookie, origin } });
	ws.binaryType = 'arraybuffer';
	const inbox = [];
	const waiters = [];
	let closed = null;
	ws.onmessage = (event) => {
		for (const f of decode(event.data)) {
			inbox.push(f);
			for (const w of [...waiters]) if (w.match(f)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(f);
			}
		}
	};
	const closePromise = new Promise((ok) => {
		ws.onclose = (event) => {
			closed = { code: event.code, reason: event.reason };
			ok(closed);
		};
	});
	const opened = new Promise((ok, fail) => {
		ws.onopen = ok;
		ws.onerror = () => fail(new Error('the websocket failed to open'));
	});
	const next = (match, ms = 30000) =>
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
	return { ws, next, closePromise, closed: () => closed, opened };
}

// ---- the browser phase: one Edge profile, one user, both PCs on the one origin ----
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function cdpSession(url) {
	const cdp = new WebSocket(url);
	let nextId = 1;
	const pending = new Map();
	const errors = [];
	const notifications = [];
	cdp.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { ok, fail } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) fail(new Error(JSON.stringify(msg.error)));
			else ok(msg.result);
		} else {
			notifications.push(msg);
			if (msg.method === 'Runtime.exceptionThrown') {
				errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
			} else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
				errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
			}
		}
	};
	const send = (method, params = {}) =>
		new Promise((ok, fail) => {
			const id = nextId++;
			pending.set(id, { ok, fail });
			cdp.send(JSON.stringify({ id, method, params }));
		});
	const opened = new Promise((ok, fail) => {
		cdp.onopen = ok;
		cdp.onerror = fail;
	});
	return { cdp, send, errors, opened };
}

async function browserPhase(hubPort, pcs, instances) {
	if (!existsSync(EDGE)) return check('browser phase', false, 'no Edge at the usual path');
	const cdpPort = await freePort();
	const profile = resolve(home, 'edge-profile');
	rmSync(profile, { recursive: true, force: true });
	const edge = run(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1400,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
	const browserWs = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.json()))).webSocketDebuggerUrl;
	const browser = cdpSession(browserWs);
	await browser.opened;
	const tabs = {};
	const consoleErrors = {};
	for (const pc of pcs) {
		const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
		const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.id === targetId);
		const session = cdpSession(page.webSocketDebuggerUrl);
		await session.opened;
		await session.send('Runtime.enable');
		await session.send('Page.enable');
		tabs[pc.name] = session;
		consoleErrors[pc.name] = session.errors;
	}
	const evaluate = async (pc, expression) =>
		(await tabs[pc.name].send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
	const waitFor = async (pc, expression, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await evaluate(pc, expression).catch(() => false)) return true;
			await sleep(300);
		}
		return false;
	};
	const navigate = async (pc, url) => {
		await tabs[pc.name].send('Page.navigate', { url });
		await sleep(400);
	};
	const shot = async (pc, name) => {
		const { data } = await tabs[pc.name].send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(resolve(home, name), Buffer.from(data, 'base64'));
	};

	const hubBase = `http://127.0.0.1:${hubPort}`;
	// Log into BOTH PCs from the one profile: the cookies differ only by Path.
	for (const pc of pcs) {
		await navigate(pc, `${hubBase}/u/${pc.uuid}/login`);
		const ready = await waitFor(pc, `document.readyState === 'complete' && !!document.getElementById('password')`, 15000);
		check(`browser: ${pc.name} login page renders`, ready);
		const loggedIn = await evaluate(pc, `fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(pc.password)}, device: 'hub-multi edge' }) }).then((r) => r.ok)`);
		check(`browser: ${pc.name} login through the Hub`, loggedIn === true);
		// Seed the extension's stored settings to this daemon's actual listener, so the
		// ggs-remote extension's activation-time config push lands as a no-op (raw key for
		// the login page, prefixed key for the scoped workbench storage, §20.6.1).
		const settings = JSON.stringify({ 'ggsRemote.port': pc.port, 'ggsRemote.bind': '127.0.0.1', 'ggsRemote.tlsMode': 'none' });
		await evaluate(pc, `localStorage.setItem('ggstudio.extSettings.ggs.ggs-remote', ${JSON.stringify(settings)}); localStorage.setItem(${JSON.stringify(`u:/u/${pc.uuid}/:`)} + 'ggstudio.extSettings.ggs.ggs-remote', ${JSON.stringify(settings)})`);
	}
	// Both sessions must be alive at once on the one origin.
	for (const pc of pcs) {
		const valid = await evaluate(pc, `fetch('api/session', { credentials: 'same-origin' }).then((r) => r.ok)`);
		check(`browser: ${pc.name} session valid while the other PC is logged in too`, valid === true);
	}
	const cookieLeak = await evaluate(pcs[0], `document.cookie.includes('ggsr')`);
	check('browser: the session cookie is HttpOnly (invisible to scripts)', cookieLeak === false, String(await evaluate(pcs[0], 'document.cookie')));
	// The window-select page lists this PC's window only.
	for (const pc of pcs) {
		await navigate(pc, `${hubBase}/u/${pc.uuid}/windows`);
		const listed = await waitFor(pc, `document.body.innerText.includes(${JSON.stringify(instances[pc.name].title)})`, 15000);
		check(`browser: ${pc.name} window-select page lists its window`, listed, String(await evaluate(pc, 'document.body.innerText.slice(0, 120)')).slice(0, 100));
	}
	// Straight into the workbench on both PCs — the tabs stay open in parallel.
	for (const pc of pcs) {
		const inst = instances[pc.name];
		await navigate(pc, `${hubBase}/u/${pc.uuid}/w/${inst.id}/v/${inst.version}/remote.html`);
		const booted = await waitFor(pc, `document.querySelectorAll('#activitybar .activity-item').length > 0 && !document.getElementById('boot-splash')`, 90000);
		check(`browser: ${pc.name} workbench booted through the Hub`, booted, booted ? '' : String(await evaluate(pc, `document.getElementById('boot-splash')?.textContent ?? document.body.innerText.slice(0, 200)`).catch(() => '')));
	}
	// The two explorers must show their own PC's folder at the same time.
	for (const pc of pcs) {
		const marker = pc.marker;
		const explorer = await waitFor(pc, `document.getElementById('sidebar')?.innerText.includes(${JSON.stringify(marker)})`, 30000);
		check(`browser: ${pc.name} explorer shows its own folder (${marker})`, explorer, String(await evaluate(pc, `(document.getElementById('sidebar')?.innerText ?? '').slice(0, 100)`)));
	}
	// Storage isolation: a write through A's scoped Storage must be invisible to B's scoped
	// view on the same origin (§20.6.1 — the prefix is the whole defence).
	await evaluate(pcs[0], `localStorage.setItem('hub-multi-probe', 'written-by-a')`);
	const readA = await evaluate(pcs[0], `localStorage.getItem('hub-multi-probe')`);
	const readB = await evaluate(pcs[1], `localStorage.getItem('hub-multi-probe')`);
	check('browser: A reads back its own scoped write', readA === 'written-by-a', String(readA));
	check('browser: B does not see A storage through its scoped view', readB === null, String(readB));
	await shot(pcs[0], 'hub-pc-a-desktop.png');
	await shot(pcs[1], 'hub-pc-b-desktop.png');

	return { evaluate, waitFor, navigate, consoleErrors, close: async () => {
		for (const pc of pcs) tabs[pc.name].cdp.close();
		browser.cdp.close();
		edge.kill();
	} };
}

async function main() {
	for (const [label, path] of [['app', appExe], ['daemon', daemonExe], ['hub', hubExe]]) {
		if (!existsSync(path)) throw new Error(`the ${label} binary is missing: ${path}`);
	}
	rmSync(home, { recursive: true, force: true });
	mkdirSync(home, { recursive: true });

	// PC-B gets its own scratch repository, so the two explorers are provably different.
	const repoB = resolve(home, 'pc-b-repo');
	mkdirSync(repoB, { recursive: true });
	writeFileSync(resolve(repoB, 'ZTEST-PC-B.md'), '# PC B\n\nThis folder is served by PC B through the Hub.\n');
	mkdirSync(resolve(repoB, 'src'), { recursive: true });
	writeFileSync(resolve(repoB, 'src', 'hello.js'), 'console.log("pc-b");\n');
	execSync('git init -q -b main . && git add -A && git -c user.name=probe -c user.email=probe@local commit -qm init', { cwd: repoB });

	// ---- the Hub ----
	const hubPort = await freePort();
	const metricsPort = await freePort();
	writeFileSync(resolve(home, 'hub.toml'), `listen = "127.0.0.1:${hubPort}"\npublic_url = "http://127.0.0.1:${hubPort}"\ntls = { mode = "none" }\nmetrics_listen = "127.0.0.1:${metricsPort}"\n`);
	const hub = run(hubExe, ['--config', resolve(home, 'hub.toml'), '--verbose']);
	let hubLog = '';
	hub.stderr.on('data', (d) => (hubLog += d));
	hub.stdout.on('data', (d) => (hubLog += d));
	for (let i = 0; i < 50 && !(await portOpen(hubPort)); i++) await sleep(100);
	check('hub listening', await portOpen(hubPort), `http://127.0.0.1:${hubPort}/ (metrics :${metricsPort})`);
	// §20.5: the public port answers /u/<uuid>/… and nothing else — liveness lives on the
	// metrics listener, and a request outside the links drops with zero bytes (fetch sees
	// the socket close before any response and throws).
	const health = await fetch(`http://127.0.0.1:${metricsPort}/healthz`).then((r) => r.status).catch(() => 0);
	check('hub /healthz (metrics listener)', health === 200, String(health));
	const rootProbe = await fetch(`http://127.0.0.1:${hubPort}/`).then((r) => r.status).catch(() => 0);
	check('hub public port silent outside links', rootProbe === 0, String(rootProbe));

	// ---- the two PCs ----
	const pcA = await makePc('pc-a', PASSWORD_A, root);
	const pcB = await makePc('pc-b', PASSWORD_B, repoB);
	pcA.marker = 'package.json';
	pcB.marker = 'ZTEST-PC-B.md';
	const pcs = [pcA, pcB];

	if (!(await portOpen(5173))) {
		console.log('starting the Vite dev server for the debug app’s relay.html …');
		const vite = run('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
		for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
	}
	check('vite dev server', await portOpen(5173));

	for (const pc of pcs) {
		const app = run(appExe, ['--remote-host', pc.folder], { env: pc.env });
		let log = '';
		app.stderr.on('data', (d) => (log += d));
		app.stdout.on('data', (d) => (log += d));
		pc.appLog = () => log;
	}

	// ---- both daemons join the Hub ----
	for (const pc of pcs) {
		await admin(pc, 'POST', '/admin/hub/connect', JSON.stringify({ url: `http://127.0.0.1:${hubPort}` }));
		let status = null;
		for (let i = 0; i < 100; i++) {
			status = JSON.parse(await admin(pc, 'GET', '/admin/hub/status'));
			if (status.state === 'online') break;
			if (status.state === 'rejected' || status.state === 'no-password') break;
			await sleep(100);
		}
		check(`${pc.name}: tunnel online`, status?.state === 'online', JSON.stringify(status));
		if (status?.state !== 'online') throw new Error(`${pc.name} tunnel not online: ${JSON.stringify(status)}`);
		pc.uuid = status.uuid;
	}
	const metrics = await fetch(`http://127.0.0.1:${metricsPort}/metrics`).then((r) => r.text()).catch(() => '');
	check('hub metrics: two tunnels online', /ggs_hub_tunnels_online 2/.test(metrics), (metrics.match(/ggs_hub_tunnels_online \d+/) ?? ['missing'])[0]);

	// ---- protocol: each PC tunnel reaches its own app ----
	const hubBase = `http://127.0.0.1:${hubPort}`;
	const sessions = {};
	const instances = {};
	for (const pc of pcs) {
		const login = await fetch(`${hubBase}/u/${pc.uuid}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pc.password, device: 'hub-multi-node' }) });
		check(`${pc.name}: node login through the Hub`, login.ok, String(login.status));
		const setCookie = login.headers.get('set-cookie') ?? '';
		const cookie = setCookie.split(';')[0];
		const pathScope = /Path=([^;]+)/.exec(setCookie)?.[1];
		check(`${pc.name}: cookie scoped to its own base path`, pathScope === `/u/${pc.uuid}/`, setCookie);
		pc.cookie = cookie;
		const session = await (await fetch(`${hubBase}/u/${pc.uuid}/api/session`, { headers: { cookie } })).json();
		const s = wsSession(hubPort, pc, cookie);
		sessions[pc.name] = s;
		await s.opened;
		s.ws.send(mp(T.HELLO, { proto: 1, client: 'hub-multi-check', csrf: session.csrf, caps: { deflate: false } }));
		await s.next((f) => f.type === T.HELLO_ACK);
		const windows = await s.next((f) => f.type === T.WINDOWS, 90000);
		const inst = windows.body.instances?.find((i) => i.folders?.[0] === pc.folder.replace(/\\/g, '/')) ?? windows.body.instances?.[0];
		check(`${pc.name}: its app instance listed through the tunnel`, Boolean(inst), inst ? `${inst.id} v${inst.version} ${JSON.stringify(inst.folders)}` : JSON.stringify(windows.body.instances?.map((i) => i.folders)));
		if (!inst) throw new Error(`${pc.name} has no instance`);
		instances[pc.name] = inst;
		s.ws.send(mp(T.ATTACH, { instance: inst.id }));
		const attached = await s.next((f) => f.type === T.ATTACHED || f.type === T.NOTICE, 60000).catch(() => null);
		check(`${pc.name}: ATTACH through the tunnel`, attached?.type === T.ATTACHED, attached ? JSON.stringify(attached.body).slice(0, 120) : 'timeout');
		let stream = 1;
		s.invoke = async (c, a) => {
			const id = (stream += 2);
			s.ws.send(json(T.INVOKE, { c, a }, id));
			const result = await s.next((f) => f.type === T.RESULT && f.stream === id);
			if (result.flags & 0x10) throw new Error(result.body?.message ?? 'error');
			return result.body;
		};
		const status = await s.invoke('remote_host_status', {});
		check(`${pc.name}: invoke over its tunnel`, status?.connected === true, JSON.stringify(status));
		const listing = await s.invoke('list_dir', { path: pc.folder });
		const names = JSON.stringify(listing);
		check(`${pc.name}: list_dir returns its own folder`, Array.isArray(listing) && (pc.name === 'pc-a' ? names.includes('package.json') : names.includes('ZTEST-PC-B.md')), `${(listing ?? []).length} entries`);
	}

	// ---- the offline page and the uuid gate: only a well-formed link is ever answered ----
	const unknown = await fetch(`${hubBase}/u/00000000-0000-8000-8000-000000000000/login`).then((r) => r.text()).catch(() => '');
	const unknownStripped = await fetch(`${hubBase}/u/00000000-0000-8000-8000-000000000000`).then((r) => r.text()).catch(() => '');
	check('offline page: unknown well-formed links answer the same page', unknown.length > 0 && unknown === unknownStripped, `${unknown.length} bytes`);
	// A malformed uuid segment is not a link — the gate drops it with zero bytes (fetch
	// throws on a socket that closes before any response).
	const malformed = await fetch(`${hubBase}/u/not-a-uuid/login`).then((r) => r.text()).catch(() => '');
	check('uuid gate: a malformed uuid drops with nothing', malformed === '', `${malformed.length} bytes`);
	// The link shapes a user actually types (print-link spells publicBase with the trailing
	// slash; a hand-stripped one without). Both must reach the PC (or the offline page), not
	// a Hub router fallthrough.
	const canonical = await fetch(`${hubBase}/u/${pcA.uuid}/`).then((r) => r.status).catch(() => 0);
	check('link shape: the canonical publicBase (trailing slash) serves the PC', canonical === 200 || canonical === 303 || canonical === 302, String(canonical));
	const stripped = await fetch(`${hubBase}/u/${pcA.uuid}`).then((r) => r.status).catch(() => 0);
	check('link shape: /u/<uuid> without the slash serves the PC', stripped === 200 || stripped === 303 || stripped === 302, String(stripped));

	// ---- cross-PC reach: the A cookie must be worthless on B ----
	const crossPc = await fetch(`${hubBase}/u/${pcB.uuid}/api/session`, { headers: { cookie: pcA.cookie } });
	check('cross-PC: the A cookie is rejected on the B daemon', crossPc.status === 401, String(crossPc.status));
	const noAuth = await fetch(`${hubBase}/u/${pcA.uuid}/api/session`);
	check('no cookie: session API refuses', noAuth.status === 401, String(noAuth.status));
	const instA = instances['pc-a'];
	const assetNoSession = await fetch(`${hubBase}/u/${pcA.uuid}/w/${instA.id}/v/${instA.version}/remote.html`);
	check('asset route without a session: 401', assetNoSession.status === 401, String(assetNoSession.status));
	const traversal = await fetch(`${hubBase}/u/${pcA.uuid}/w/${instA.id}/v/${instA.version}/../../../../../etc/passwd`, { headers: { cookie: pcA.cookie } });
	check('path traversal on the asset route: no file content', traversal.status !== 200, String(traversal.status));
	const traversal2 = await fetch(`${hubBase}/u/${pcA.uuid}/w/${instA.id}/v/${instA.version}/%2e%2e/%2e%2e/secrets`, { headers: { cookie: pcA.cookie } });
	check('encoded path traversal: rejected', traversal2.status === 404 || traversal2.status === 400, String(traversal2.status));

	// ---- Origin and CSRF on the WebSocket through the tunnel ----
	await new Promise((resolveOrigin) => {
		const bad = new WebSocket(`ws://127.0.0.1:${hubPort}/u/${pcB.uuid}/ws`, { headers: { cookie: pcB.cookie, origin: 'http://evil.example' } });
		let settled = false;
		const settle = (ok, detail) => {
			if (settled) return;
			settled = true;
			check('ws with a foreign Origin: the daemon closes it 4403', ok, detail);
			try { bad.close(); } catch { /* never opened */ }
			resolveOrigin();
		};
		bad.onclose = (event) => settle(event.code === 4403, `close ${event.code} ${event.reason}`);
		bad.onerror = () => settle(false, 'socket error before any close');
		setTimeout(() => settle(false, 'still open after 6 s'), 6000);
	});
	{
		const s = wsSession(hubPort, pcB, pcB.cookie);
		await s.opened;
		s.ws.send(mp(T.HELLO, { proto: 1, client: 'hub-multi-check', csrf: 'forged', caps: { deflate: false } }));
		const close = await s.closePromise;
		check('ws HELLO with a forged csrf: closed 4403', close?.code === 4403, JSON.stringify(close));
	}

	// ---- the browser: one user, both PCs, both workbenches at once ----
	const browser = await browserPhase(hubPort, pcs, instances);

	// ---- the kick: the PC-A password change must reach only PC-A ----
	const t0 = Date.now();
	await admin(pcA, 'POST', '/admin/password', JSON.stringify({ password: PASSWORD_A2 }));
	let aStatus = 0;
	for (let i = 0; i < 20; i++) {
		aStatus = await fetch(`${hubBase}/u/${pcA.uuid}/api/session`, { headers: { cookie: pcA.cookie } }).then((r) => r.status).catch(() => 0);
		if (aStatus === 401) break;
		await sleep(250);
	}
	check('kick: the A node session dies within seconds', aStatus === 401, `${aStatus} after ${Date.now() - t0} ms`);
	const kickedClose = await Promise.race([sessions['pc-a'].closePromise, sleep(4000).then(() => null)]);
	check('kick: the A websocket closed by the daemon', Boolean(kickedClose), JSON.stringify(kickedClose));
	const bStill = await fetch(`${hubBase}/u/${pcB.uuid}/api/session`, { headers: { cookie: pcB.cookie } }).then((r) => r.status).catch(() => 0);
	check('kick: the B session survives the A password change', bStill === 200, String(bStill));
	if (browser) {
		const aPage = await browser.evaluate(pcA, `fetch(${JSON.stringify(`/u/${pcA.uuid}/api/session`)}, { credentials: 'same-origin' }).then((r) => r.status).catch(() => -1)`);
		check('kick: the A browser tab logged out', aPage === 401, String(aPage));
		const bPage = await browser.evaluate(pcB, `fetch(${JSON.stringify(`/u/${pcB.uuid}/api/session`)}).then((r) => r.status).catch(() => -1)`);
		check('kick: the B browser tab still logged in', bPage === 200, String(bPage));
		const bAlive = await browser.waitFor(pcB, `document.getElementById('sidebar')?.innerText.includes('ZTEST-PC-B.md')`, 10000);
		check('kick: the B workbench still functional', bAlive === true);
		for (const pc of pcs) {
			check(`browser: ${pc.name} page errors`, browser.consoleErrors[pc.name].length === 0, browser.consoleErrors[pc.name].slice(0, 4).join(' | ').slice(0, 400));
		}
	}

	// ---- login rate limit on A through the Hub (last: it locks this IP on A) ----
	let saw429 = false;
	const codes = [];
	for (let i = 0; i < 8; i++) {
		const r = await fetch(`${hubBase}/u/${pcA.uuid}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password', device: 'ratelimit' }) });
		codes.push(r.status);
		if (r.status === 429) {
			saw429 = true;
			break;
		}
	}
	check('rate limit: repeated wrong passwords on A get 429', saw429, codes.join(','));
	const bLoginStill = await fetch(`${hubBase}/u/${pcB.uuid}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pcB.password, device: 'still-ok' }) }).then((r) => r.status).catch(() => 0);
	check('rate limit: the B login is unaffected by the A lockout', bLoginStill === 200, String(bLoginStill));

	for (const s of Object.values(sessions)) {
		try {
			s.ws.close();
		} catch {
			/* gone */
		}
	}
	if (browser) await browser.close();
	const report = { at: new Date().toISOString(), results, hubLog: hubLog.split('\n').slice(-40), daemonA: pcA.daemonLog().split('\n').slice(-20), daemonB: pcB.daemonLog().split('\n').slice(-20) };
	writeFileSync(resolve(home, 'report.json'), JSON.stringify(report, null, '\t'));
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed — report: ${resolve(home, 'report.json')}`);
	if (keep) {
		console.log('--keep: leaving the hub, both daemons and both apps running (Ctrl-C to stop)');
		console.log(`  PC A: ${hubBase}/u/${pcA.uuid}/   (new password: ${PASSWORD_A2})`);
		console.log(`  PC B: ${hubBase}/u/${pcB.uuid}/   (password: ${PASSWORD_B})`);
		await new Promise(() => undefined);
	}
	process.exitCode = failed.length ? 1 : 0;
}

main()
	.catch((error) => {
		console.error(`FAIL  ${error.message}`);
		console.error(error.stack?.split('\n').slice(0, 4).join('\n'));
		process.exitCode = 1;
	})
	.finally(() => {
		if (!keep) {
			cleanup();
			setTimeout(() => process.exit(process.exitCode ?? 0), 500);
		}
	});
