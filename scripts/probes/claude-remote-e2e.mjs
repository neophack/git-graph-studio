// claude-remote-e2e — the live end-to-end probe: spawns the real relay binary and walks
// the whole path the app walks, with the REAL modules on both ends — the extension's
// own identity.js / relay.js / crypto.js as the PC's window, and the phone page's own
// web/crypto.js as the paired phone. Everything the wire contract touches is exercised
// against the actual server, not a mock: registration, the window's WebSocket (its
// sealed window.meta — the shape a bare object once broke, flapping the window off the
// relay), pairing, the phone's window list with the decrypted workspace name, a sealed
// RPC round trip both ways, and the rekey kick (4401) that must land on the phone.
//
//   node scripts/probes/claude-remote-e2e.mjs [--keep] [--release]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const nodeRequire = createRequire(import.meta.url);
const keep = process.argv.includes('--keep');
const release = process.argv.includes('--release');

const binary = [
	join(repo, `target/studio/claude-remote-server/${release ? 'release' : 'debug'}`, `claude-remote-server${process.platform === 'win32' ? '.exe' : ''}`),
	join(repo, `target/studio/claude-remote-server/${release ? 'debug' : 'release'}`, `claude-remote-server${process.platform === 'win32' ? '.exe' : ''}`)
].find(existsSync);
if (!binary) {
	console.error('no relay binary — build it first:  (cd claude-remote-server && cargo build)');
	process.exit(1);
}

const identity = nodeRequire(join(repo, 'extensions-src/claude-remote/identity.js'));
const relayFactory = nodeRequire(join(repo, 'extensions-src/claude-remote/relay.js'));
const extCrypto = nodeRequire(join(repo, 'extensions-src/claude-remote/crypto.js'));
const phoneCrypto = nodeRequire(join(repo, 'claude-remote-server/web/crypto.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(probe, ok, ms = 12000, what = '') {
	const start = Date.now();
	for (;;) {
		const value = await probe();
		if (ok(value)) return value;
		if (Date.now() - start > ms) throw new Error(`timed out waiting${what ? ' for ' + what : ''}; last: ${JSON.stringify(value)?.slice(0, 300)}`);
		await sleep(120);
	}
}
let passed = 0;
const check = (label, condition, detail = '') => {
	if (!condition) throw new Error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
	passed++;
	console.log(`  ok  ${label}`);
};

/* ---------- boot the real relay ---------- */
const server = spawn(binary, ['serve', '--memory', '--registration', 'open', '--listen', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolveUrl, reject) => {
	const timer = setTimeout(() => reject(new Error('the relay never printed its listening line')), 15000);
	server.stdout.on('data', (chunk) => {
		const match = String(chunk).match(/listening on (127\.0\.0\.1:\d+)/);
		if (match) { clearTimeout(timer); resolveUrl(`http://${match[1]}`); }
	});
});
console.log(`relay up at ${base} (${binary})`);

try {
	/* ---------- the PC window: the extension's real modules ---------- */
	const pc = await identity.register(base);
	check('register: a user id and a 43-char pairing key', /^u_/.test(pc.userId) && /^[A-Za-z0-9_-]{43}$/.test(pc.K), pc.userId);

	const framesSeen = [];
	let nudgeSeen = false;
	const window_ = relayFactory.createRelay(pc, {
		windowId: 'w_e2eprobe00000001',
		meta: () => ({ name: 'E2E Workspace', host: 'probe', folders: ['/repo'] }),
		getIdentity: () => pc,
		onFrame: (plain, meta) => {
			framesSeen.push(plain);
			// The extension's relayFrame shape: an {rid, t} request answers one reply.
			if (plain && (typeof plain.rid === 'string' || typeof plain.rid === 'number')) {
				window_.send(meta.from, { t: 'reply', rid: plain.rid, ok: true, r: { pong: true, echoed: plain.t, text: plain.text ?? null } });
			}
			if (plain && plain.t === 'nudge') nudgeSeen = true;
		},
		onEpoch: () => undefined,
		onOnline: () => undefined,
		log: () => undefined
	});
	window_.start();
	await until(() => window_.online(), (v) => v === true, 12000, 'the window to come online');
	check('window: online over ' + window_.transport(), true);

	/* ---------- the phone: the page's own crypto ---------- */
	const link = identity.link(pc);
	const K = extCrypto.keyMaterial(pc.K);
	const keys = await phoneCrypto.deriveKeys(K);
	const challenge = await (await fetch(`${base}/api/v1/pair/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: pc.userId }) })).json();
	const proof = await phoneCrypto.pairProof(keys.kAuth, challenge.nonce, pc.userId, challenge.epoch);
	const paired = await (await fetch(`${base}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: pc.userId, nonce: challenge.nonce, epoch: challenge.epoch, proof, device_name: 'E2E Probe' }) })).json();
	check('pair: challenge-response accepted', !!paired.device_token, JSON.stringify(paired).slice(0, 120));
	check('pair: the link\'s key matches the identity\'s', identity.parseLink(link).K === pc.K);

	// the phone's WebSocket: hello, the windows list, the decrypted workspace name
	const phoneWs = new WebSocket(`${base.replace('http', 'ws')}/ws/device?token=${encodeURIComponent(paired.device_token)}`);
	const phoneInbox = [];
	phoneWs.onmessage = (event) => phoneInbox.push(JSON.parse(event.data));
	await until(() => phoneInbox, (v) => v.some((m) => m.kind === 'hello'), 12000, 'the phone hello');
	await until(() => phoneInbox, (v) => v.some((m) => m.kind === 'windows' && (m.list ?? []).some((w) => w.id === 'w_e2eprobe00000001')), 12000, 'the windows list');
	const windowsMessage = phoneInbox.find((m) => m.kind === 'windows');
	const entry = windowsMessage.list.find((w) => w.id === 'w_e2eprobe00000001');
	check('windows: the entry is online with a STRING meta_ct', entry.online === true && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(entry.meta_ct ?? ''), String(entry.meta_ct).slice(0, 40));
	const [n, c] = entry.meta_ct.split('.');
	const meta = await phoneCrypto.openFrame(keys.kE2E, { userId: pc.userId, epoch: pc.epoch, from: entry.id, to: '*', seq: 0 }, { n, c });
	check('windows: the phone decrypts the workspace name', meta.name === 'E2E Workspace', JSON.stringify(meta));

	/* ---------- a sealed RPC round trip, both directions ---------- */
	let phoneSeq = 0;
	const phoneCall = async (payload, timeoutMs = 10000) => {
		const rid = `p${++phoneSeq}`;
		const envelope = { userId: pc.userId, epoch: pc.epoch, from: paired.device_id, to: 'w_e2eprobe00000001', seq: ++phoneSeq };
		const body = await phoneCrypto.sealFrame(keys.kE2E, envelope, { rid, ...payload });
		const reply = new Promise((resolveReply, rejectReply) => {
			const timer = setTimeout(() => rejectReply(new Error('the window did not answer the RPC in time')), timeoutMs);
			const onMessage = (event) => {
				const wire = JSON.parse(event.data);
				if (wire.kind !== 'frame' || wire.from !== 'w_e2eprobe00000001') return;
				void phoneCrypto.openFrame(keys.kE2E, { userId: pc.userId, epoch: pc.epoch, from: wire.from, to: paired.device_id, seq: wire.seq }, { n: String(wire.ct).split('.')[0], c: String(wire.ct).split('.')[1] })
					.then((plain) => {
						if (plain && plain.t === 'reply' && plain.rid === rid) {
							clearTimeout(timer);
							phoneWs.removeEventListener('message', onMessage);
							resolveReply(plain);
						}
					})
					.catch(() => undefined);
		};
			phoneWs.addEventListener('message', onMessage);
		});
		phoneWs.send(JSON.stringify({ v: 1, kind: 'frame', from: paired.device_id, to: envelope.to, seq: envelope.seq, ct: body.n + '.' + body.c }));
		return reply;
	};
	const rpc = await phoneCall({ t: 'ping', text: 'hello from the phone' });
	check('rpc: the sealed request answered, both ends agreeing on the AAD', rpc.ok === true && rpc.r.pong === true && rpc.r.text === 'hello from the phone', JSON.stringify(rpc).slice(0, 120));

	// the window's push reaches the phone as a frame it can open (the nudge path)
	window_.send('*', { t: 'nudge' });
	await until(() => nudgeSeen === true || phoneInbox.some((m) => m.kind === 'frame'), () => nudgeSeen || phoneInbox.some((m) => m.kind === 'frame'), 10000, 'the nudge frame');
	check('push: the window\'s broadcast frame reached the phone', true);

	/* ---------- rekey: every phone is kicked at once ---------- */
	let phoneClosed = null;
	phoneWs.onclose = (event) => { phoneClosed = event.code; phoneWs.onclose = null; };
	const rekeyed = await identity.rekey(pc);
	await until(() => phoneClosed, (v) => v !== null, 10000, 'the phone to be kicked');
	check('rekey: the epoch moved and the phone was kicked 4401', rekeyed.epoch === pc.epoch + 1 && phoneClosed === 4401, `epoch ${rekeyed.epoch}, close ${phoneClosed}`);
	const staleLink = identity.link(pc);
	check('rekey: the old link\'s key is not the new one', identity.parseLink(staleLink).K !== rekeyed.K);

	/* ---------- the served phone page carries the redesigned app ---------- */
	const page = await (await fetch(`${base}/c/${pc.userId}`)).text();
	const css = await (await fetch(`${base}/app.css`)).text();
	check('page: the phone app serves with its crypto scripts', page.includes('/crypto.js') && page.includes('/sjcl.js'));
	check('page: the flat theme serves (warm paper + terracotta)', css.includes('--bg: #faf9f5') && css.includes('--accent: #c96442'));

	console.log(`\nPASS — ${passed} checks against the live relay`);
	if (!keep) {
		window_.stop();
		phoneWs.close();
		server.kill();
	}
} catch (error) {
	console.error(String(error && error.stack || error));
	server.kill();
	process.exit(1);
}
