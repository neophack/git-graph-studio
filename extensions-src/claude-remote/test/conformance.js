"use strict";
/* Claude Remote's host-conformance probe: the same Node surface VS Code (real Node) and
 * Git Graph Studio (ggs-node) must answer identically, one report, two runtimes — the
 * vitest suite checks the real-Node half, src-tauri/tests/node_runtime.rs the ggs-node
 * half, against the same test/conformance.expected.json.
 *
 *   crypto  the plugin core's E2E layer on this host: the HMAC and HKDF natives, the
 *           frame codec (round trip, tamper rejection, a 256 KB sealed body — the size
 *           that once exposed the base64-string hop), and the sjcl fallback's interop.
 *   e2e     the relay round trip on this host: a mini relay served from THIS process
 *           (node's http / the runtime's http), the identity registering on it, the
 *           long-poll window exchanging one frame each way (through wire.js — the plain
 *           codec today), and one sdk-host turn through a fake `claude` script speaking
 *           the SDK's stream-json user message (the nodeExecutable rule pinned).
 *   debug   the local debug page's long-poll pair: a parked poll woken by the reply. */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const core = require("../crypto.js");
const cryptojs = require("../cryptojs.js");
const identity = require("../identity.js");
const relayFactory = require("../relay.js");
const { createSdkHostSource } = require("../sources/sdkHost.js");

async function cryptoSection() {
	const K = Buffer.alloc(32, 7);
	const kAuth = core.deriveAuth(K);
	const kE2E = core.deriveE2E(K);
	const envelope = { userId: "u_c0nf0rm1ty5pec1", epoch: 1, from: "w_c0nf0rm1ty5pec1", to: "d_c0nf0rm1ty5pec1", seq: 1 };

	// A large sealed body: the 256 KB tool-result class message that once never finished
	// crossing the interpreter's old string codec.
	const large = "y".repeat(256 * 1024);
	const largeSealed = core.sealFrame(kE2E, envelope, { text: large });
	const largeBack = core.openFrame(kE2E, envelope, largeSealed);

	let tamper = "opened";
	try {
		// Flip the FIRST character — always fully significant. (Two earlier attempts
		// flipped the tail: a fixed "AA" overwrite no-opped whenever the tag ended in
		// AA, and even a last-char flip decodes to the SAME bytes whenever the char sits
		// in the same 4-bit group, because base64url's trailing bits are padding — the
		// report flapped on 1/16 of runs.)
		const alt = largeSealed.c[0] === "A" ? "B" : "A";
		core.openFrame(kE2E, envelope, { ...largeSealed, c: alt + largeSealed.c.slice(1) });
	} catch {
		tamper = "rejected";
	}

	// The sjcl fallback seals what the native path opens (one wire, both phones): the
	// same envelope-derived AAD, the same key.
	const fallbackEnvelope = { userId: "u_c0nf0rm1ty5pec1", epoch: 1, from: "w_abcdefghijklmnop", to: "d_1234567890abcdef", seq: 0 };
	const fallbackAad = Buffer.from(`crr1|${fallbackEnvelope.userId}|${fallbackEnvelope.epoch}|${fallbackEnvelope.from}|${fallbackEnvelope.to}|${fallbackEnvelope.seq}`, "utf8");
	const fallbackSealed = cryptojs.gcmSealJs(kE2E, Buffer.alloc(12, 3), fallbackAad, { from: "phone" });
	const fallbackOpened = core.openFrame(kE2E, fallbackEnvelope, fallbackSealed);

	return {
		"hmac.vector": core.hmacSha256(Buffer.alloc(20, 0x0b), [Buffer.from("Hi There")]).toString("hex"),
		"hkdf.e2eHead": kE2E.toString("hex").slice(0, 32),
		"hkdf.matchesNative": kE2E.equals(Buffer.from(crypto.hkdfSync("sha256", K, Buffer.alloc(0), Buffer.from("crr1/e2e"), 32))),
		"frame.roundTrip": core.openFrame(kE2E, envelope, core.sealFrame(kE2E, envelope, { hello: "conformance" })),
		"frame.tamperRejected": tamper,
		"frame.large": { len: largeBack.text.length, head: largeBack.text.slice(0, 3) },
		"fallback.sjclInterop": fallbackOpened,
		"pairProof": core.pairProof(kAuth, "c-nonce", "u_c0nf0rm1ty5pec1", 1)
	};
}

/** A mini relay served from this process: register, and the long-poll pair with one
 *  reflected frame — the contract's transport, not the real server's whole surface. */
function miniRelay() {
	return new Promise((resolve) => {
		const banked = [];
		let cursor = 0;
		const state = { sent: [], userId: null, agentSecret: null };
		const server = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
				const url = req.url.split("?")[0];
				const send = (status, json) => {
					res.statusCode = status;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify(json));
				};
				if (url === "/api/v1/register" && req.method === "POST") {
					state.userId = "u_m1n1relay000001";
					state.agentSecret = crypto.randomBytes(32).toString("hex");
					send(201, { user_id: state.userId, agent_secret: state.agentSecret, epoch: 1 });
					return;
				}
				if (url === "/api/v1/agent/send" && req.method === "POST") {
					for (const frame of body.frames ?? []) {
						state.sent.push(frame);
						// Echo the frame back through the poll ring: the sealed body and
						// its envelope stay exactly as sent (the AAD binds them), so the
						// client opens what it sealed — the transport round trip pinned.
						cursor += 1;
						banked.push({ ...frame, c: cursor });
					}
					send(200, { ok: true, accepted: (body.frames ?? []).length, cursor });
					return;
				}
				if (url === "/api/v1/agent/poll" && req.method === "GET") {
					const since = Number(new URL(req.url, "http://x").searchParams.get("cursor") ?? 0);
					send(200, { v: 1, frames: banked.filter((item) => item.c > since), cursor, epoch: 1, user: state.userId });
					return;
				}
				send(404, { error: "no such path" });
			});
		});
		Object.assign(server, state);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

const fakeCli = [
	"const crypto = require('crypto');",
	"const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
	"const id = crypto.randomUUID();",
	"write({ type: 'system', subtype: 'init', session_id: id, model: 'conformance-1' });",
	"let buffer = '';",
	"process.stdin.on('data', (c) => {",
	"	buffer += c;",
	"	const nl = buffer.indexOf('\\n');",
	"	if (nl < 0) return;",
	"	const request = JSON.parse(buffer.slice(0, nl));",
	"	buffer = '';",
	"	const prompt = ((request.message && request.message.content) ?? []).map((b) => b.text ?? '').join('');",
	"	write({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + prompt, session_id: id });",
	"});"
].join("\n");

async function e2eSection(workDir) {
	const server = await miniRelay();
	const registered = await identity.register(`http://127.0.0.1:${server.address().port}`);
	const frames = [];
	const relay = relayFactory.createRelay(registered, {
		windowId: "w_c0nf0rm1ty5pec1",
		transport: "long-poll", // the mini relay is plain HTTP; both hosts run this pair
		meta: () => ({ name: "conformance" }),
		getIdentity: () => registered,
		onFrame: (plain) => frames.push(plain),
		onEpoch: () => undefined,
		onOnline: () => undefined,
		log: () => undefined
	});
	relay.start();
	await new Promise((resolve) => setTimeout(resolve, 400));
	relay.send("d_m1n1relay000001", { t: "conformance", text: "ping" });
	await new Promise((resolve) => setTimeout(resolve, 900));
	const reflected = frames.find((plain) => plain.t === "conformance") ?? null;
	const wire = server.sent.find((frame) => frame.kind === "frame") ?? null;

	// One sdk-host turn through the fake CLI: the nodeExecutable rule (a .js CLI runs on
	// each host's own Node) is what this pins.
	const cli = path.join(workDir, "fake-claude.js");
	fs.writeFileSync(cli, fakeCli);
	fs.mkdirSync(path.join(workDir, "workspace"), { recursive: true });
	const events = [];
	const source = createSdkHostSource({
		log: () => undefined,
		cliPath: cli,
		defaultRoot: () => path.join(workDir, "root"),
		onEvent: (event) => events.push(event),
		onChange: () => undefined,
		spawn: require("child_process").spawn
	});
	source.send({ cwd: path.join(workDir, "workspace"), text: "ping from probe", mode: "now" });
	for (let i = 0; i < 150 && !events.some((event) => event.kind === "sdk" && event.message.type === "result"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const lane = [...source.lanes.values()].find((l) => l.sessionId) ?? {};
	const result = events.find((event) => event.kind === "sdk" && event.message.type === "result") ?? null;
	source.dispose();
	relay.stop();
	await new Promise((resolve) => server.close(resolve));

	return {
		"relay.registered": { userId: registered.userId, epoch: registered.epoch, keySpelling: /^[A-Za-z0-9_-]{43}$/.test(registered.K) },
		"relay.frameReflected": reflected,
		"relay.wireSealed": wire ? { kind: wire.kind, to: wire.to, ctShape: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(wire.ct) } : null,
		"sdk.turn": { done: !!result, lastText: result ? result.message.result : null, sessionId: lane.sessionId ? "adopted" : null }
	};
}

/** The local debug page's transport on this host, in the browser's order: a poll is
 *  already PARKED when the page's request arrives, and the reply must wake it. Under
 *  ggs-node a request's `close` fires once it has been read — the first cut treated that
 *  as "the page left" and every parked poll hung, so the page never saw a reply. */
async function debugSection() {
	const { createLocalDebug } = require("../localDebug.js");
	const wire = require("../wire.js");
	let local;
	local = createLocalDebug({
		windowId: "w_c0nf0rm1ty5pec1",
		meta: () => ({ name: "conformance" }),
		onFrame: (plain, meta) => {
			setTimeout(() => local.send(meta.from, { t: "reply", rid: plain.rid, ok: true, r: { echoed: plain.t } }), 50);
		}
	});
	const url = await local.start();
	const api = url + "/api";
	try {
		const first = await (await fetch(api + "/poll?cursor=0")).json();
		const started = Date.now();
		const parked = fetch(api + "/poll?cursor=" + first.cursor).then((r) => r.json());
		await new Promise((resolve) => setTimeout(resolve, 300));
		await fetch(api + "/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ frames: [{ v: 1, kind: "frame", from: local.deviceId, to: "w_c0nf0rm1ty5pec1", seq: 1, ct: wire.encode({ rid: "c1", t: "hello" }) }] })
		});
		const woke = await parked;
		const frame = (woke.messages || []).find((m) => m.kind === "frame");
		return {
			"debug.firstPoll": first.messages.map((m) => m.kind),
			"debug.parkedPollWoke": Date.now() - started < 10000,
			"debug.reply": frame ? wire.decode(frame.ct) : null
		};
	} finally {
		local.stop();
	}
}

function run(section, workDir) {
	if (section === "crypto") return cryptoSection();
	if (section === "debug") return debugSection();
	if (section === "e2e") return e2eSection(String(workDir || "."));
	throw new Error("unknown section " + section);
}

module.exports = {
	run,
	expected: () => JSON.parse(fs.readFileSync(path.join(__dirname, "conformance.expected.json"), "utf8"))
};

// Under ggs-node the probe is the package entry: `runCommand("conformance", [{ section, workDir }])`.
if (typeof ggs !== "undefined" && ggs.onRequest) {
	ggs.onRequest(async (command, raw) => {
		const args = (Array.isArray(raw) ? raw[0] : raw) || {};
		return command === "conformance" ? run(args.section, args.workDir) : null;
	});
}
