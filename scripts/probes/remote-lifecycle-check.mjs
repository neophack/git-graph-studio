// The Remote Access lifecycle check (docs/remote-client-plan.md §18, L2): a real GGS
// instance in `--remote-host` mode under GGS_TEST_HOOKS=1, a hermetic ggs-remote daemon,
// and this script as the browser — the §18.1 snapshot command over the session's invoke
// path is the ground truth, and every scenario is a walk of §18.2's events with §18.1's
// invariants checked after each step. The scenario matrix (§18.3 T1–T18), the random
// sequences (§18.4) and the long run (§18.5) grow on this harness; today it carries the
// harness, the invariant evaluator, and T4's core (the remote closing and opening the PC
// window, alternating), which is where §17's window invariants and §9's extension
// stability meet. Nothing touches the user's ~/.ggs/remote.
//
//   node scripts/probes/remote-lifecycle-check.mjs [--app <ggs exe>] [--daemon <ggs-remote exe>]
//                                                 [--folder <repo>] [--rounds <n>] [--keep]
//
// Debug app builds load relay.html from the Vite dev server: the script starts
// `npm run dev:vite` when nothing answers on :5173.
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
const rounds = Number(arg('--rounds', '20'));
const keep = process.argv.includes('--keep');
const PASSWORD = 'lifecycle-check-kayak-42';
const home = resolve(root, 'target/studio/remote-lifecycle');

/** One scenario's result: every step and every invariant check, as §18.7's report wants. */
const scenarios = [];
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
const T = { HELLO: 1, HELLO_ACK: 2, WINDOWS: 3, ATTACH: 4, ATTACHED: 5, INVOKE: 0x10, RESULT: 0x11, LISTEN: 0x30, EVENT: 0x32, EMIT: 0x33, INSTANCE_DISPLAY: 0x0c, NOTICE: 0x60, PING: 0x51 };
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
		if (at + 20 + len > bytes.length) break;
		const enc = bytes[at + 1] >> 2;
		const body = bytes.subarray(at + 20, at + 20 + len);
		let parsed = null;
		try {
			parsed = enc === 2 ? decodeMsgpack(body) : JSON.parse(body.toString('utf8'));
		} catch {
			parsed = null;
		}
		out.push({ type: bytes[at], flags: bytes[at + 1], stream: bytes.readUInt32LE(at + 8), body: parsed });
		at += 20 + len;
	}
	return out;
}

// ---- §18.1's invariants, checked against snapshots ----

/** The backends' identity: pid + start count per extension, the part of I1 the snapshot
 *  proves (an unplanned restart changes both). */
function backendKeys(snapshot) {
	return Object.fromEntries((snapshot?.backends ?? []).map((b) => [b.extId, `${b.pid}:${b.startCount}`]));
}

/** I1: no backend restarted unless this step was the planned restart. */
function backendsStable(before, after) {
	const a = backendKeys(before);
	const b = backendKeys(after);
	const moved = Object.keys(a).filter((id) => a[id] !== b[id]);
	return { ok: moved.length === 0 && Object.keys(a).length === Object.keys(b).length, detail: moved.length ? `${moved.join(', ')} changed` : '' };
}

/** I9: the main window was neither rebuilt nor reloaded. */
function windowStable(before, after) {
	return {
		ok: before?.main?.created === after?.main?.created && before?.main?.pageLoads === after?.main?.pageLoads,
		detail: `created ${before?.main?.created}→${after?.main?.created}, pageLoads ${before?.main?.pageLoads}→${after?.main?.pageLoads}`
	};
}

/** I4's panel half: the webview panels the journals carry did not duplicate (the count
 *  per extension is compared; a disposed-then-recreated panel keeps it, a leak grows it). */
function panelsOf(snapshot) {
	const counts = {};
	for (const [ext, entries] of Object.entries(snapshot?.registrations ?? {})) {
		const panels = (entries ?? []).filter((e) => e?.method === 'webview.create').length;
		if (panels > 0) counts[ext] = panels;
	}
	return counts;
}

/** Run one scenario: `steps` is an async generator of {name, run(ctx)}, and after every
 *  step the given invariants are checked between the snapshots around it. */
async function runScenario(name, invariants, steps, ctx) {
	const result = { name, steps: [], ok: true };
	scenarios.push(result);
	for await (const step of steps(ctx)) {
		const entry = { step: step.name, checks: [] };
		result.steps.push(entry);
		try {
			const before = await ctx.snapshot();
			await step.run(ctx);
			const after = await ctx.snapshot();
			for (const [label, check] of Object.entries(invariants)) {
				const outcome = check(before, after, ctx);
				entry.checks.push({ check: label, ok: outcome.ok, detail: outcome.detail ?? '' });
				if (!outcome.ok) result.ok = false;
			}
		} catch (error) {
			const logs = ctx.logs ? `\n--- app ---\n${ctx.logs().split('\n').slice(-15).join('\n')}` : '';
			entry.checks.push({ check: 'the step itself', ok: false, detail: `${String(error?.message ?? error)}${logs}` });
			result.ok = false;
		}
		const mark = entry.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
		console.log(`  ${mark}  ${name} / ${step.name}`);
		for (const c of entry.checks.filter((c) => !c.ok)) console.log(`        ✗ ${c.check} — ${c.detail}`);
	}
}

async function main() {
	const children = [];
	const quit = async () => {
		if (keep) return;
		for (const child of children.splice(0)) child.kill();
	};
	process.on('exit', () => quit());
	rmSync(home, { recursive: true, force: true });
	mkdirSync(resolve(home, 'remote'), { recursive: true });
	// A fixed free port and plain HTTP, spelled in the hermetic config before the daemon
	// spawns (its own default is a random port); the bin/VERSION seed mirrors
	// remote-live-check's — the ggs-remote extension's install pass must not "upgrade"
	// this daemon to the same bytes mid-run.
	const port = await freePort();
	const env = { ...process.env, GGS_REMOTE_HOME: resolve(home, 'remote'), GGS_HOME: resolve(home, 'ggs'), GGS_TEST_HOOKS: '1' };
	writeFileSync(resolve(home, 'remote/config.json'), JSON.stringify({ port, bind: '127.0.0.1', tls: { mode: 'none' }, autostart: false, mdns: false }));
	const version = spawn(daemonExe, ['--version']);
	let versionOut = '';
	version.stdout.on('data', (d) => (versionOut += d));
	await new Promise((ok) => version.on('close', ok));
	mkdirSync(resolve(home, 'remote/bin'), { recursive: true });
	copyFileSync(daemonExe, resolve(home, 'remote/bin', `ggs-remote${exe}`));
	writeFileSync(resolve(home, 'remote/bin/VERSION'), (versionOut.match(/[\d.]+/) ?? ['0.1.0'])[0]);

	if (!existsSync(appExe)) throw new Error(`no debug app at ${appExe} — build it first (scripts/build-studio.bat dev)`);
	if (!existsSync(daemonExe)) throw new Error(`no daemon at ${daemonExe} — build it first`);

	await new Promise((ok, fail) => {
		const child = spawn(daemonExe, ['set-password', PASSWORD], { env });
		child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`set-password exited ${code}`))));
	});

	const daemon = spawn(daemonExe, ['run', '--no-tray'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(daemon);
	let daemonLog = '';
	daemon.stderr.on('data', (d) => (daemonLog += d));
	for (let i = 0; i < 50 && !(await portOpen(port)); i++) await sleep(100);
	if (!(await portOpen(port))) throw new Error(`daemon never listened on ${port}\n${daemonLog.slice(-2000)}`);

	if (!(await portOpen(5173))) {
		console.log('starting the Vite dev server for the debug app’s relay.html …');
		const vite = spawn('npm run dev:vite', { cwd: root, shell: true, stdio: 'ignore' });
		children.push(vite);
		for (let i = 0; i < 100 && !(await portOpen(5173)); i++) await sleep(200);
	}

	// §18.7: the PC side is driven by commands and frames, never the mouse.
	const app = spawn(appExe, ['--remote-host', folder], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(app);
	let appLog = '';
	app.stderr.on('data', (d) => (appLog += d));
	app.stdout.on('data', (d) => (appLog += d));

	const base = `http://127.0.0.1:${port}`;
	const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, device: 'lifecycle-check' }) });
	if (!login.ok) throw new Error(`login failed: ${login.status}`);
	const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
	const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
	ws.binaryType = 'arraybuffer';
	const inbox = [];
	const waiters = [];
	ws.onmessage = (event) => {
		for (const f of decode(event.data)) {
			if (process.env.LIFECYCLE_TRACE) console.log(`frame #${f.type} stream ${f.stream}: ${JSON.stringify(f.body)?.slice(0, 160)}`);
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
	ws.send(mp(T.HELLO, { proto: 1, client: 'lifecycle-check', csrf: session.csrf, caps: { deflate: false } }));
	await next((f) => f.type === T.HELLO_ACK);
	let instance = null;
	const deadline = Date.now() + 40000;
	while (!instance && Date.now() < deadline) {
		const windows = await next((f) => f.type === T.WINDOWS, 40000).catch(() => null);
		instance = windows?.body?.instances?.[0];
	}
	if (!instance) throw new Error(`the instance never registered\n${appLog.slice(-2000)}`);

	ws.send(mp(T.ATTACH, { instance: instance.id }));
	const attached = await next((f) => f.type === T.ATTACHED || f.type === T.NOTICE, 40000).catch(() => null);
	if (attached?.type !== T.ATTACHED) throw new Error(`ATTACH failed: ${JSON.stringify(attached?.body)}`);

	let stream = 1;
	const invoke = async (c, a) => {
		const id = (stream += 2);
		ws.send(json(T.INVOKE, { c, a }, id));
		const result = await next((f) => f.type === T.RESULT && f.stream === id);
		if (result.flags & 0x10) throw new Error(result.body?.message ?? 'error');
		return result.body;
	};
	const snapshot = () => invoke('remote_debug_snapshot', {});

	// ---- the harness's own ground rules ----
	const first = await snapshot();
	{
		const shapeOk = Array.isArray(first?.backends) && first?.registrations instanceof Object && Array.isArray(first?.frontends) && first?.main instanceof Object;
		console.log(`${shapeOk ? 'PASS' : 'FAIL'}  the §18.1 snapshot answers over the session's invoke path`);
		console.log(`        frontends ${JSON.stringify(first.frontends)}, main ${JSON.stringify(first.main)}, ${first.backends.length} backend(s), panels ${JSON.stringify(panelsOf(first))}`);
		if (!shapeOk) process.exitCode = 1;
	}
	const offline = await invoke('remote_debug_snapshot', {}).then(() => null, (e) => e);
	// The refusal path cannot be probed from outside (the env is fixed per process); the
	// command's own gate is unit-tested in Rust. What the probe proves is the affirmative.

	// The boot's own transients (backends coming up one by one) must settle before any
	// invariant compares snapshots: wait until two consecutive snapshots agree.
	for (let tries = 0; tries < 20; tries++) {
		const a = backendKeys(await snapshot());
		await sleep(1000);
		const b = backendKeys(await snapshot());
		if (JSON.stringify(a) === JSON.stringify(b)) break;
	}

	const ctx = {
		ws, next, invoke, snapshot, logs: () => appLog,
		/** §18.2 E4/E5: the remote closes / opens the PC window (§17.4's frame). The
		 *  state is the WINDOWS push that CARRIES it — stale pushes already waiting are
		 *  dropped first, so the elapsed time is this flip's own. */
		display: async (visible) => {
			for (let at = inbox.length - 1; at >= 0; at--) if (inbox[at].type === T.WINDOWS) inbox.splice(at, 1);
			const started = Date.now();
			ws.send(mp(T.INSTANCE_DISPLAY, { instance: instance.id, visible }));
			const windows = await next((f) => f.type === T.WINDOWS && f.body?.instances?.some((i) => i.id === instance.id && i.visible === visible), 10000);
			const seen = windows.body.instances.find((i) => i.id === instance.id);
			return { elapsed: Date.now() - started, visible: seen?.visible === true, minimized: seen?.minimized === true };
		}
	};

	// T4 (its core): the remote closing and opening the PC window, alternating — the
	// window must only hide and show (I9), the instance must keep its backends (I1), and
	// the WINDOWS frame must carry each state within a second (I7).
	await runScenario('T4 the remote opens and closes the PC window', { 'I1 backends stable': backendsStable, 'I9 the window was not rebuilt or reloaded': windowStable }, async function* () {
		const flips = Math.max(2, rounds);
		for (let round = 0; round < flips; round++) {
			const visible = round % 2 === 1;
			yield {
				name: `E${visible ? 5 : 4} #${round + 1}: INSTANCE_DISPLAY visible=${visible}`,
				run: async (c) => {
					const answer = await c.display(visible);
					if (answer.visible !== visible) throw new Error(`WINDOWS carried visible=${answer.visible} after ${answer.elapsed} ms`);
					if (answer.elapsed > 1000) throw new Error(`I7: the state took ${answer.elapsed} ms — over the 1 s bound`);
				}
			};
		}
	}, ctx);

	// T7's own precondition walk: the session stays attached through every scenario above
	// (I5) — a 4401 or a closed socket would have failed every invoke since.
	{
		const still = await invoke('remote_host_status', {});
		const ok = still?.connected === true;
		console.log(`${ok ? 'PASS' : 'FAIL'}  I5 the session stayed attached (remote_host_status: ${JSON.stringify(still)})`);
		if (!ok) process.exitCode = 1;
	}

	// ---- the report (§18.7) ----
	const report = {
		at: new Date().toISOString(),
		app: appExe, daemon: daemonExe, rounds,
		scenarios,
		ok: scenarios.every((s) => s.ok)
	};
	writeFileSync(resolve(home, 'remote-lifecycle-report.json'), JSON.stringify(report, null, '\t'));
	const lines = [`# Remote lifecycle check — ${report.at}`, '', `instance ${instance.id} v${instance.version}, ${rounds} display rounds`, ''];
	for (const s of scenarios) {
		lines.push(`## ${s.ok ? '✓' : '✗'} ${s.name}`);
		for (const step of s.steps) {
			lines.push(`- ${step.checks.every((c) => c.ok) ? '✓' : '✗'} ${step.step}`);
			for (const c of step.checks.filter((c) => !c.ok)) lines.push(`  - ${c.check}: ${c.detail}`);
		}
		lines.push('');
	}
	writeFileSync(resolve(home, 'remote-lifecycle-report.md'), lines.join('\n'));
	console.log(`\nreport: ${resolve(home, 'remote-lifecycle-report.md')}`);
	if (!report.ok) process.exitCode = 1;

	if (keep) {
		console.log('--keep: the app and daemon stay up; Ctrl-C to end');
		await new Promise(() => undefined);
	}
	await quit();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
