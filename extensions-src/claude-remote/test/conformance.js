"use strict";
/* The host-conformance probe: Claude Remote's whole Node surface, run the same way under
 * every runtime the package ships to — real Node (VS Code's extension host) and Git Graph
 * Studio's ggs-node. Every value it reports is deterministic, so each runtime's report must
 * equal `conformance.expected.json` exactly:
 *   crypto   the KDF and the GCM cipher against fixed vectors — Buffer and string inputs,
 *            pooled-buffer AAD, update/final encodings, a 600 KB message, tamper rejection,
 *            the phone's sjcl interoperating — plus base64url and the loopback interface;
 *   e2e      the LAN server over a fixture session store, driven by a phone that speaks
 *            sjcl: the sealed RPCs, a 256 KB answer, replay / tamper / stale-key rejection,
 *            the static page, and one headless turn through a fake `claude` script.
 * vitest runs it under Node (tests/claudeRemote.test.ts), src-tauri/tests/node_runtime.rs
 * under ggs-node. Not packed into the VSIX (build.mjs packs a fixed file list). */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sjcl = require("../sjcl.js");

const PACKAGE_DIR = path.join(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (o) => JSON.stringify(o) + "\n";
const munge = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const utf8 = (s) => sjcl.codec.utf8String.toBits(s);
const fromB64u = (s) => sjcl.codec.base64.toBits(s.replace(/-/g, "+").replace(/_/g, "/"));
const toB64u = (b) => sjcl.codec.base64.fromBits(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Key order is not part of the contract (a JSON wire may sort it). */
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
	return value;
}

async function step(report, name, fn) {
	try { report[name] = await fn(); } catch (error) { report[name] = "THREW: " + (error && error.message || error); }
}

// A fake `claude`: the prompt on stdin, the turn appended to the session file the real CLI
// would write, stream-json on stdout.
const FAKE_CLAUDE = `
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
	const id = at('--resume') || 'new-session-1';
	const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, id + '.jsonl');
	process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: at('--model') || 'fake-model-1' }) + '\\n');
	fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\\n');
	fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'fake-model-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'echo: ' + prompt }] } }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + prompt, session_id: id }) + '\\n');
});
`;

async function cryptoSection() {
	const report = {};
	const key = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
	const iv = Buffer.from("cafebabefacedbaddecaf888", "hex");
	await step(report, "pbkdf2", () => crypto.pbkdf2Sync("ABCD-EFGH", Buffer.from("salt-bytes"), 1000, 32, "sha256").toString("hex"));
	await step(report, "pbkdf2.bufferPassword", () => crypto.pbkdf2Sync(Buffer.from("ABCD-EFGH"), "salt-bytes", 1000, 32, "sha256").toString("hex"));
	await step(report, "gcm.pooledAad", () => {
		// a view into a larger buffer (Node's pool makes every small Buffer.from one)
		const aad = Buffer.from("PREFIX-cr2:req:abc").subarray(7);
		const c = crypto.createCipheriv("aes-256-gcm", key, iv);
		c.setAAD(aad);
		const ct = Buffer.concat([c.update(Buffer.from("hello", "utf8")), c.final()]);
		const tag = c.getAuthTag();
		const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
		d.setAAD(Buffer.from("cr2:req:abc"));
		d.setAuthTag(tag);
		const pt = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
		return { ct: ct.toString("hex"), tag: tag.toString("hex"), pt };
	});
	await step(report, "gcm.encodings", () => {
		const c = crypto.createCipheriv("aes-256-gcm", key, iv);
		const hex = c.update("hello world", "utf8", "hex") + c.final("hex");
		const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
		d.setAuthTag(c.getAuthTag());
		return { hex, back: d.update(hex, "hex", "utf8") + d.final("utf8") };
	});
	await step(report, "gcm.tamperRejected", () => {
		const c = crypto.createCipheriv("aes-256-gcm", key, iv);
		const ct = Buffer.concat([c.update(Buffer.from("secret")), c.final()]);
		const tag = c.getAuthTag();
		ct[0] ^= 1;
		const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
		d.setAuthTag(tag);
		try { d.update(ct); d.final(); return "accepted"; } catch { return "rejected"; }
	});
	await step(report, "gcm.large", () => {
		const plain = Buffer.alloc(600 * 1024, 7);
		const c = crypto.createCipheriv("aes-256-gcm", key, iv);
		const ct = Buffer.concat([c.update(plain), c.final()]);
		const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
		d.setAuthTag(c.getAuthTag());
		const back = Buffer.concat([d.update(ct), d.final()]);
		return { len: ct.length, same: back.equals(plain), digest: crypto.createHash("sha256").update(ct).digest("hex") };
	});
	await step(report, "gcm.sjclInterop", () => {
		// what the phone (sjcl) seals, the desktop (node crypto) opens
		const prp = new sjcl.cipher.aes(sjcl.codec.hex.toBits(key.toString("hex")));
		const sealed = sjcl.mode.gcm.encrypt(prp, utf8("from phone"), sjcl.codec.hex.toBits(iv.toString("hex")), utf8("aad"), 128);
		const bytes = Buffer.from(toB64u(sealed), "base64url");
		const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
		d.setAAD(Buffer.from("aad"));
		d.setAuthTag(bytes.subarray(bytes.length - 16));
		return Buffer.concat([d.update(bytes.subarray(0, bytes.length - 16)), d.final()]).toString("utf8");
	});
	await step(report, "buffer.base64url", () => {
		const b = Buffer.from([0xfb, 0xff, 0x00, 0x10]);
		return { enc: b.toString("base64url"), dec: Buffer.from("-_8AEA", "base64url").toString("hex"), hex: b.toString("hex") };
	});
	await step(report, "os.loopback", () => {
		const lo = Object.values(os.networkInterfaces()).flat().find((e) => e && e.address === "127.0.0.1");
		return lo ? { family: lo.family, internal: lo.internal, cidr: lo.cidr, netmask: lo.netmask } : "missing";
	});
	return report;
}

async function e2eSection(workDir) {
	const report = {};
	const home = path.join(workDir, "home");
	fs.rmSync(home, { recursive: true, force: true });
	const root = path.join(home, ".claude");
	const workspace = path.join(home, "work", "my-app");
	fs.mkdirSync(workspace, { recursive: true });
	const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = root;
	const wsDir = path.join(root, "projects", munge(workspace));
	fs.mkdirSync(wsDir, { recursive: true });
	fs.writeFileSync(path.join(wsDir, "conv-a.jsonl"), [
		line({ type: "user", uuid: "a1", cwd: workspace, gitBranch: "main", timestamp: "2026-01-01T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "first question" }] } }),
		line({ type: "assistant", uuid: "a2", cwd: workspace, timestamp: "2026-01-01T10:00:05Z", message: { role: "assistant", model: "m-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } }),
		line({ type: "user", uuid: "a3", cwd: workspace, timestamp: "2026-01-01T10:00:06Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "y".repeat(400 * 1024) }] } }),
		line({ type: "assistant", uuid: "a4", cwd: workspace, timestamp: "2026-01-01T10:00:07Z", message: { role: "assistant", model: "m-1", stop_reason: "end_turn", content: [{ type: "text", text: "first **answer** 你好" }] } }),
		line({ type: "ai-title", aiTitle: "Fixture conversation A" })
	].join(""));
	const cli = path.join(home, "fake-claude.js");
	fs.writeFileSync(cli, FAKE_CLAUDE);

	const core = require("../extension.js").__core;
	const runner = new core.Runner({ cliPath: cli, defaultRoot: () => root, externalBusy: () => false });
	let live = null;
	try {
		live = await core.server.startServer({
			pairing: core.server.newPairing(), port: 0, host: "127.0.0.1", runner,
			folders: () => [{ name: "my-app", path: workspace }], baseDir: PACKAGE_DIR
		});
		const base = `http://127.0.0.1:${live.port}`;
		const hello = await (await fetch(base + "/api/hello")).json();
		report["wire.hello"] = { protocol: hello.protocol, iterations: hello.iterations, kidOk: hello.kid === live.pairing.kid };
		// the phone's key, derived natively (sjcl's own PBKDF2 at 150 000 rounds is minutes on
		// an interpreter; its GCM is what the wire exercises, and gcm.sjclInterop pins it)
		const prp = new sjcl.cipher.aes(sjcl.codec.hex.toBits(crypto.pbkdf2Sync(live.pairing.code, Buffer.from(hello.salt, "base64url"), hello.iterations, 32, "sha256").toString("hex")));
		const post = async (envelope) => {
			const res = await fetch(base + "/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
			return { status: res.status, env: await res.json() };
		};
		const seal = (m, p, n) => {
			const ivBits = sjcl.codec.hex.toBits(crypto.randomBytes(12).toString("hex"));
			const body = { m, p, ts: Date.now(), n, dev: { id: "probe-device-01", label: "Probe" } };
			return { kid: hello.kid, i: toB64u(ivBits), d: toB64u(sjcl.mode.gcm.encrypt(prp, utf8(JSON.stringify(body)), ivBits, utf8("cr2:req:" + hello.kid), 128)) };
		};
		const nonce = () => crypto.randomBytes(16).toString("hex");
		const call = async (m, p = {}) => {
			const n = nonce();
			const { status, env } = await post(seal(m, p, n));
			if (!env.d) throw new Error(`HTTP ${status}: ${JSON.stringify(env)}`);
			const out = JSON.parse(sjcl.codec.utf8String.fromBits(sjcl.mode.gcm.decrypt(prp, fromB64u(env.d), fromB64u(env.i), utf8("cr2:res:" + n), 128)));
			if (!out.ok) throw new Error(out.error);
			return out.r;
		};
		await step(report, "rpc.hello", async () => { const r = await call("hello"); return { protocol: r.protocol, workspace: r.workspace.map((f) => f.name), injection: r.injection }; });
		await step(report, "rpc.sessions", async () => (await call("sessions")).sessions.map((s) => ({ id: s.id, title: s.title, project: s.project, branch: s.branch })));
		await step(report, "rpc.session", async () => (await call("session", { id: "conv-a" })).items.map((it) => ({ k: it.k, text: it.text, name: it.name, st: it.st, more: it.res && it.res.more })));
		await step(report, "rpc.detailLarge", async () => {
			const tool = (await call("session", { id: "conv-a" })).items.find((it) => it.k === "tool");
			const d = await call("detail", { id: "conv-a", item: tool.id });
			return { len: d.text.length, head: d.text.slice(0, 3) };
		});
		await step(report, "rpc.replay", async () => {
			const envelope = seal("hello", {}, nonce());
			const first = await post(envelope);
			const again = await post(envelope);
			return [first.status, again.status, again.env.error];
		});
		await step(report, "rpc.tamper", async () => {
			const envelope = seal("hello", {}, nonce());
			const bytes = Buffer.from(envelope.d, "base64url");
			bytes[3] ^= 1;
			const r = await post({ ...envelope, d: bytes.toString("base64url") });
			return [r.status, r.env.error];
		});
		await step(report, "rpc.wrongKid", async () => { const r = await post({ ...seal("hello", {}, nonce()), kid: "000000000000" }); return [r.status, r.env.error]; });
		await step(report, "http.static", async () => {
			const res = await fetch(base + "/");
			const html = await res.text();
			return { status: res.status, csp: !!res.headers.get("content-security-policy"), sjcl: html.includes("/sjcl.js"), missing: (await fetch(base + "/nope")).status };
		});
		await step(report, "runner.headlessTurn", async () => {
			const sent = await call("send", { sessionId: "conv-a", text: "ping from probe", mode: "queue" });
			const until = Date.now() + 15000;
			let lane = null;
			while (Date.now() < until) {
				lane = runner.laneState(sent.lane);
				if (lane && lane.last) break;
				await sleep(100);
			}
			const last = (await call("session", { id: "conv-a" })).items.filter((it) => it.k === "assistant").pop();
			return { status: lane && lane.last && lane.last.status, error: lane && lane.last && lane.last.error && lane.last.error.slice(0, 120), lastText: last && last.text };
		});
	} catch (error) {
		report.fatal = String(error && error.stack || error);
	} finally {
		runner.dispose();
		if (live) await live.stop();
		if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
	}
	return report;
}

/** One section's canonical report: "crypto" or "e2e" (e2e writes under `workDir`). */
async function run(section, workDir) {
	return canonical(section === "e2e" ? await e2eSection(workDir) : await cryptoSection());
}

module.exports = { run, canonical, expected: () => JSON.parse(fs.readFileSync(path.join(__dirname, "conformance.expected.json"), "utf8")) };

// Under ggs-node the probe is the package entry: `runCommand("conformance", [{ section, workDir }])`.
if (typeof ggs !== "undefined" && ggs.onRequest) {
	ggs.onRequest(async (command, raw) => {
		const args = (Array.isArray(raw) ? raw[0] : raw) || {};
		return command === "conformance" ? run(args.section, args.workDir) : null;
	});
}
