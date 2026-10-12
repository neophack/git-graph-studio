// The Hub load probe (docs/ggs-remote-plan.md §20.12 压测): N fake PCs tunnel into one real
// Hub (each an Ed25519 key proving its uuid, the exact handshake the daemon speaks), M
// browser sessions ride them (4 per PC by default), and the probe records what the plan
// asked for — the Hub's memory and CPU — next to its own /metrics. Nothing gates a build;
// the numbers land in target/studio/metrics.json under `remote.hubLoad`.
//
//   node scripts/probes/hub-load.mjs [--hub <ggs-remote-hub exe>] [--tunnels 500]
//                                    [--sessions 2000] [--seconds 30] [--keep]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
import { encodeMsgpack, decodeMsgpack } from '../../extensions-src/ggs-remote/daemon/web/wire.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const arg = (name, fallback) => {
	const at = process.argv.indexOf(name);
	return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const exe = process.platform === 'win32' ? '.exe' : '';
const hubExe = process.argv.includes('--hub')
	? process.argv[process.argv.indexOf('--hub') + 1]
	: resolve(root, 'extensions-src/ggs-remote/hub/target/release', `ggs-remote-hub${exe}`);
const TUNNELS = arg('--tunnels', 500);
const SESSIONS = arg('--sessions', 2000);
const SECONDS = arg('--seconds', 30);
const keep = process.argv.includes('--keep');
const home = resolve(root, 'target/studio/remote-hub-load');
let hubLog = '';
if (!existsSync(hubExe)) throw new Error(`the hub binary is missing: ${hubExe} (cargo build --release in hub/)`);
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
	new Promise((ok) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => ok(port));
		});
	});
const portOpen = (port) =>
	new Promise((ok) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			ok(true);
		});
		socket.once('error', () => ok(false));
	});

// ---- frames & identity (the daemon's own shapes: 20-byte header, MessagePack bodies) ----
const T = { HELLO: 0x80, CHALLENGE: 0x81, AUTH: 0x82, READY: 0x83, CONN_OPEN: 0x84, CONN_CLOSE: 0x85, PING: 0x88, PONG: 0x88 };
function frame(type, payload) {
	const body = Buffer.from(payload ?? []);
	const head = Buffer.alloc(20);
	head[0] = type;
	head[1] = 2 << 2; // msgpack
	head.writeUInt32LE(body.length, 16);
	return Buffer.concat([head, body]);
}
function framesOf(data) {
	const bytes = Buffer.from(data);
	const out = [];
	for (let at = 0; at + 20 <= bytes.length; ) {
		const len = bytes.readUInt32LE(at + 16);
		if (at + 20 + len > bytes.length) break;
		const enc = (bytes[at + 1] & 0x0c) >> 2;
		const payload = bytes.subarray(at + 20, at + 20 + len);
		out.push({ type: bytes[at], body: enc === 2 && len ? decodeMsgpack(new Uint8Array(payload)) : payload });
		at += 20 + len;
	}
	return out;
}
/// `uuid_for` (hub/src/identity.rs): UUIDv8 over SHA-256("ggs-remote-uuid/1" ‖ key)[..16].
function uuidFor(publicKey) {
	const digest = crypto.createHash('sha256').update('ggs-remote-uuid/1').update(publicKey).digest();
	digest[6] = (digest[6] & 0x0f) | 0x80;
	digest[8] = (digest[8] & 0x3f) | 0x80;
	const hex = digest.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const authMessage = (nonce, host) => Buffer.concat([Buffer.from('ggs-hub-auth/1'), nonce, Buffer.from(host)]);

// ---- one fake PC: handshake, then pump (answer pings, swallow browser CONN_OPENs) ----
async function fakePc(port, key, uuid) {
	const rawPublic = Buffer.from(key.export({ type: 'spki', format: 'jwk' }).x, 'base64url');
	const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
	ws.binaryType = 'arraybuffer';
	await new Promise((ok, fail) => {
		ws.onopen = ok;
		ws.onerror = () => fail(new Error('tunnel connect failed'));
	});
	ws.send(frame(T.HELLO, encodeMsgpack({ pubkey: new Uint8Array(rawPublic), daemonVersion: 'load-probe', proto: 1 })));
	let ready = null;
	await new Promise((ok, fail) => {
		const timeout = setTimeout(() => fail(new Error('no T_READY')), 10_000);
		ws.onmessage = (event) => {
			for (const f of framesOf(event.data)) {
				if (f.type === T.CHALLENGE) {
					const sig = crypto.sign(null, authMessage(new Uint8Array(f.body.nonce), f.body.host), key);
					ws.send(frame(T.AUTH, encodeMsgpack({ sig: new Uint8Array(sig) })));
				} else if (f.type === T.READY) {
					if (f.body.uuid !== uuid) fail(new Error(`uuid mismatch: ${f.body.uuid}`));
					ready = f.body;
					clearTimeout(timeout);
					ok();
				}
			}
		};
	});
	// The pump: answer heartbeats; CONN_OPENs just count (the load needs no daemon logic).
	let conns = 0;
	ws.onmessage = (event) => {
		for (const f of framesOf(event.data)) {
			if (f.type === T.PING) ws.send(frame(T.PONG));
			else if (f.type === T.CONN_OPEN) conns += 1;
		}
	};
	return { ws, ready, conns: () => conns };
}

// ---- the hub process's own numbers (Windows: PowerShell; elsewhere: /proc) ----
async function hubProcessStats(pid) {
	if (process.platform === 'win32') {
		const out = await new Promise((ok) => {
			const child = spawn('powershell', [
				'-NoProfile', '-Command',
				`$p = Get-Process -Id ${pid}; "{0:N1} {1:N3}" -f ($p.WorkingSet64/1MB), $p.TotalProcessorTime.TotalSeconds`
			], { stdio: ['ignore', 'pipe', 'ignore'] });
			let text = '';
			child.stdout.on('data', (d) => (text += d));
			child.on('exit', () => ok(text.trim()));
		});
		const [rss, cpu] = out.split(/\s+/).map(Number);
		return { rssMb: rss, cpuSeconds: cpu };
	}
	try {
		const status = readFileSync(`/proc/${pid}/status`, 'utf8');
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
		const hz = 100;
		return {
			rssMb: Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) / 1024,
			cpuSeconds: (Number(stat[13] ?? 0) + Number(stat[14] ?? 0)) / hz
		};
	} catch {
		return { rssMb: 0, cpuSeconds: 0 };
	}
}

async function metrics(metricsPort) {
	const text = await fetch(`http://127.0.0.1:${metricsPort}/metrics`).then((r) => r.text()).catch(() => '');
	const number = (name) => Number(new RegExp(`${name} (\\d+)`).exec(text)?.[1] ?? -1);
	return { tunnels: number('ggs_hub_tunnels_online'), sessions: number('ggs_hub_sessions_online'), up: number('ggs_hub_bytes_up_total'), down: number('ggs_hub_bytes_down_total') };
}

async function main() {
	const port = await freePort();
	const metricsPort = await freePort();
	// handshake_rate / http_rate / visitors_per_day_per_tunnel = 0: their defaults are abuse
	// guards for real fleets — a single load box starting hundreds of tunnels and hammering
	// requests from one address is exactly what each of them stops.
	writeFileSync(resolve(home, 'hub.toml'), `listen = "127.0.0.1:${port}"\npublic_url = "http://127.0.0.1:${port}"\ntls = { mode = "none" }\nmax_tunnels = 2000\nhandshake_rate = 0\nhttp_rate = 0\nvisitors_per_day_per_tunnel = 0\nmetrics_listen = "127.0.0.1:${metricsPort}"\n`);
	const hub = spawn(hubExe, ['--config', resolve(home, 'hub.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
	hub.stderr.on('data', (d) => (hubLog += d));
	hub.stdout.on('data', (d) => (hubLog += d));
	const exit = new Promise((resolveExit) => hub.on('exit', resolveExit));
	for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(100);
	if (!(await portOpen(port))) throw new Error(`the hub never listened:\n${hubLog}`);
	const at0 = await hubProcessStats(hub.pid);
	console.log(`hub up (pid ${hub.pid}) — ${TUNNELS} tunnels, ${SESSIONS} sessions, ${SECONDS} s of traffic`);

	// Bring the PCs up in waves so the handshake cost itself stays visible in the timeline.
	const pcs = [];
	const pcWave = 25;
	let handshakes = 0;
	for (let wave = 0; wave < TUNNELS; wave += pcWave) {
		const slice = Array.from({ length: Math.min(pcWave, TUNNELS - wave) }, () => crypto.generateKeyPairSync('ed25519'));
		const up = await Promise.all(slice.map(async (pair) => {
			const rawPublic = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'jwk' }).x, 'base64url');
			const uuid = uuidFor(rawPublic);
			return fakePc(port, pair.privateKey, uuid);
		}));
		pcs.push(...up);
		handshakes += up.length;
		if (handshakes % 100 === 0) console.log(`  ${handshakes}/${TUNNELS} tunnels`);
	}
	const atTunnels = await hubProcessStats(hub.pid);
	const seen = await metrics(metricsPort);
	console.log(`tunnels online: ${seen.tunnels} (hub metrics) — rss ${atTunnels.rssMb} MB`);

	// The browser sessions: M WebSocket connections spread over the PCs (no login — the hub
	// counts a session the moment /u/<uuid>/ws upgrades; the CONN_OPEN lands on the PC).
	const sessions = [];
	for (let i = 0; i < SESSIONS; i++) {
		const pc = pcs[i % pcs.length];
		sessions.push(new Promise((ok, fail) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/u/${pc.ready.uuid}/ws`);
			ws.binaryType = 'arraybuffer';
			ws.onopen = () => ok(ws);
			ws.onerror = () => fail(new Error('browser session failed'));
		}));
		if (sessions.length % 250 === 0) await sleep(50); // let the hub breathe between waves
	}
	const opened = [];
	let failed = 0;
	for (const promise of sessions) {
		opened.push(await promise.catch(() => {
			failed += 1;
			return null;
		}));
	}
	const atSessions = await hubProcessStats(hub.pid);
	const withSessions = await metrics(metricsPort);
	console.log(`sessions online: ${withSessions.sessions} (failed ${failed}) — rss ${atSessions.rssMb} MB`);

	// Some traffic: every session sends a small frame every second (uplink through the
	// tunnel); the PCs swallow them. The byte counters tell the rest.
	const traffic = setInterval(() => {
		for (const ws of opened) ws?.send(frame(0x51, new Uint8Array(16))); // PING-shaped, small
	}, 1000);
	await sleep(SECONDS * 1000);
	clearInterval(traffic);
	const atEnd = await hubProcessStats(hub.pid);
	const end = await metrics(metricsPort);
	const connsSeen = pcs.reduce((sum, pc) => sum + pc.conns(), 0);
	const cpuDelta = Math.max(0, atEnd.cpuSeconds - atSessions.cpuSeconds);
	console.log(`after ${SECONDS} s — rss ${atEnd.rssMb} MB, cpu ${cpuDelta.toFixed(1)} s, ${connsSeen} CONN_OPENs reached the PCs, ${(end.up / 1e6).toFixed(1)} MB up / ${(end.down / 1e6).toFixed(1)} MB down`);

	const report = {
		at: new Date().toISOString(),
		tunnels: TUNNELS,
		sessions: SESSIONS,
		failedSessions: failed,
		metrics: end,
		hub: {
			rssStartMb: at0.rssMb,
			rssAfterTunnelsMb: atTunnels.rssMb,
			rssAfterSessionsMb: atSessions.rssMb,
			rssAfterTrafficMb: atEnd.rssMb,
			cpuSecondsDuringTraffic: Number(cpuDelta.toFixed(2)),
			kbPerTunnel: Number(((atTunnels.rssMb - at0.rssMb) * 1024 / TUNNELS).toFixed(1)),
			kbPerSession: Number(((atSessions.rssMb - atTunnels.rssMb) * 1024 / Math.max(1, SESSIONS - failed)).toFixed(1))
		}
	};
	writeFileSync(resolve(home, 'report.json'), JSON.stringify(report, null, '\t'));
	// The same numbers into metrics.json (remote.hubLoad), the way the other probes do.
	try {
		const metricsPath = resolve(root, 'target/studio/metrics.json');
		const all = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, 'utf8')) : {};
		all.remote = { ...(all.remote ?? {}), hubLoad: report };
		writeFileSync(metricsPath, JSON.stringify(all, null, '\t'));
	} catch {
		/* metrics.json is best-effort */
	}
	console.log(`report: ${resolve(home, 'report.json')} — metrics.json remote.hubLoad`);

	for (const ws of opened) ws?.close();
	if (!keep) {
		for (const pc of pcs) pc.ws.close();
		hub.kill();
		setTimeout(() => process.exit(0), 500);
	} else {
		console.log('--keep: the hub and its load stay up (Ctrl-C to stop)');
		await Promise.race([exit, new Promise(() => undefined)]);
	}
}

main().catch((error) => {
	console.error(`FAIL  ${error.message}`);
	console.error(hubLog?.split('\n').slice(-5).join('\n'));
	process.exit(1);
});
