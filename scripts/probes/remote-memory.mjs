// The Remote Access memory probe (docs/ggs-remote-plan.md §17.5, M7.4): a hermetic daemon
// (nothing touches the user's ~/.ggs/remote), its idle RSS after a settle, and the RSS with
// one signed-in browser session. The Relay webview's cost belongs to an app instance and is
// measured by remote-traffic.mjs's run instead. Numbers land in
// target/studio/metrics.json under `remote.memory`.
//
//   node scripts/probes/remote-memory.mjs [--daemon <ggs-remote exe>] [--keep]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const daemonExe = process.argv.includes('--daemon')
	? resolve(root, process.argv[process.argv.indexOf('--daemon') + 1])
	: resolve(root, 'extensions-src/ggs-remote/daemon/target/release', `ggs-remote${exe}`);
const keep = process.argv.includes('--keep');
const PASSWORD = 'memory-probe-kayak-42';
const home = resolve(root, 'target/studio/remote-memory');

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

/** One plain HTTP call against the daemon's public port (self-signed HTTPS → use http by
 *  writing the port into a config first; the probe runs the daemon with tls none). */
async function http(port, method, path, headers, body) {
	const socket = net.connect(port, '127.0.0.1');
	await new Promise((ok, fail) => {
		socket.once('connect', ok);
		socket.once('error', fail);
	});
	const payload = body ?? '';
	const request = [
		`${method} ${path} HTTP/1.1`,
		`Host: 127.0.0.1:${port}`,
		'Connection: close',
		`Content-Length: ${payload.length}`,
		...Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}`),
		'',
		payload
	].join('\r\n');
	socket.write(request);
	let raw = Buffer.alloc(0);
	socket.on('data', (chunk) => {
		raw = Buffer.concat([raw, chunk]);
	});
	await new Promise((ok) => socket.once('close', ok));
	const text = raw.toString('utf8');
	const head = text.slice(0, text.indexOf('\r\n\r\n'));
	return { status: Number(head.split(' ')[1] ?? 0), head, body: text.slice(text.indexOf('\r\n\r\n') + 4) };
}

/** The process's RSS in bytes (tasklist on Windows, ps elsewhere). */
async function rss(pid) {
	if (process.platform === 'win32') {
		const out = await new Promise((ok) => {
			const task = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
			let text = '';
			task.stdout.on('data', (c) => (text += c));
			task.on('close', () => ok(text));
		});
		const k = Number((out.match(/"([\d,]+) K"/) ?? [])[1]?.replace(/,/g, '') ?? 0);
		return k * 1024;
	}
	const out = await new Promise((ok) => {
		const task = spawn('ps', ['-o', 'rss=', '-p', String(pid)]);
		let text = '';
		task.stdout.on('data', (c) => (text += c));
		task.on('close', () => ok(text));
	});
	return Number(out.trim() || 0) * 1024;
}

async function readLoopback() {
	const file = resolve(home, 'loopback.json');
	for (let i = 0; i < 200; i++) {
		if (existsSync(file)) {
			try {
				return JSON.parse(readFileSync(file, 'utf8'));
			} catch {
				/* written mid-rename */
			}
		}
		await sleep(25);
	}
	throw new Error('the daemon never wrote loopback.json');
}

rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
if (!existsSync(daemonExe)) {
	console.error(`daemon binary not found at ${daemonExe} — build it with cargo build --release in extensions-src/ggs-remote/daemon`);
	process.exit(2);
}
const publicPort = await freePort();
writeFileSync(
	resolve(home, 'config.json'),
	JSON.stringify({ port: publicPort, bind: '127.0.0.1', tls: { mode: 'none' }, mdns: false, autostart: false, paused: false }, null, '\t')
);
const child = spawn(daemonExe, ['run', '--no-tray'], {
	env: { ...process.env, GGS_REMOTE_HOME: home, GGS_HOME: resolve(home, 'ggs') },
	stdio: 'ignore',
	detached: false
});
console.log(`daemon pid ${child.pid} on 127.0.0.1:${publicPort}`);

try {
	const loopback = await readLoopback();
	const admin = (method, path, body) =>
		http(loopback.port, method, path, { Authorization: `Bearer ${readFileSync(resolve(home, 'admin.token'), 'utf8').trim()}`, 'Content-Type': 'application/json' }, body ? JSON.stringify(body) : undefined);
	for (let i = 0; i < 50; i++) {
		if ((await admin('GET', '/admin/status', null)).status === 200) break;
		await sleep(100);
	}
	await admin('POST', '/admin/password', { password: PASSWORD });

	await sleep(5000); // settle: TLS material, caches, the housekeeping tick
	const idle = await rss(child.pid);

	// One signed-in browser session (login + the session probe; no instance to attach).
	const login = await http(publicPort, 'POST', '/api/login', { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${publicPort}` }, JSON.stringify({ password: PASSWORD, device: 'memory-probe', remember: false }));
	const cookie = (login.head.match(/set-cookie: ([^;]+)/i) ?? [])[1];
	await http(publicPort, 'GET', '/api/session', { Cookie: cookie });
	await sleep(2000);
	const withSession = await rss(child.pid);

	const metricsPath = resolve(root, 'target/studio/metrics.json');
	let metrics = {};
	try {
		metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
	} catch {
		/* first run */
	}
	metrics.remote = metrics.remote ?? {};
	metrics.remote.memory = {
		daemonIdleBytes: idle,
		daemonWithOneSessionBytes: withSession,
		platform: process.platform,
		at: new Date().toISOString(),
		budgetBytes: process.platform === 'linux' ? 12 * 1024 * 1024 : 15 * 1024 * 1024,
		withinBudget: idle <= (process.platform === 'linux' ? 12 * 1024 * 1024 : 15 * 1024 * 1024)
	};
	mkdirSync(resolve(root, 'target/studio'), { recursive: true });
	writeFileSync(metricsPath, JSON.stringify(metrics, null, '\t') + '\n');
	console.log(`idle ${(idle / 1048576).toFixed(1)} MB · with one session ${(withSession / 1048576).toFixed(1)} MB → ${metricsPath}`);
} finally {
	if (!keep) child.kill();
	else console.log(`--keep: the daemon stays (pid ${child.pid}, home ${home})`);
}
