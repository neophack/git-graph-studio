"use strict";
/* The LAN server: static phone app + one sealed RPC endpoint.
 *
 * Pairing. The desktop keeps one pairing secret (a 120-bit code, a salt and a random key
 * id) in the editor's secret storage; it survives restarts, so a paired phone stays
 * paired, and "Reset pairing key" replaces it — every device holding the old key is
 * locked out on its next request. The QR carries `http://<lan-ip>:<port>/#p=<code>`:
 * the code rides the URL fragment, which browsers never send to a server, and the
 * phone strips it from the address bar after reading it.
 *
 * Wire format. Both sides derive K = PBKDF2-SHA256(code, salt, 150 000, 256 bits).
 * A request is POST /api/rpc {kid, i, d}: AES-256-GCM over
 * {m: method, p: params, ts, n: nonce, dev}, with AAD "cr2:req:<kid>". The answer is
 * sealed under K with AAD "cr2:res:<n>", binding it to the request that asked. The
 * method name never crosses in the clear; a passive LAN observer sees sizes and timing.
 *   - replay: ts must be within ±5 min of the desktop clock (the phone corrects its skew
 *     from /api/hello) and each nonce is accepted once;
 *   - brute force: per-address failure counting locks an address out for a minute;
 *   - a stale key id answers 401 {error:"rekeyed"} so the phone can ask to re-pair. */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sessions = require("./sessions.js");

// 3: the session sync went incremental — items carry version stamps (a cursor returns only
// what changed), and a tool's input body and result text ride a separate `tool` fetch the
// phone makes when the row is opened, not every sync.
// 4: questions are answerable from the phone — an AskUserQuestion row now syncs its
// question body (options included) instead of stripping it, and a new `answer` method
// drives the conversation's desktop tab.
const PROTOCOL = 4;
const KDF_ITERATIONS = 150_000;
const CLOCK_WINDOW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 2 * CLOCK_WINDOW_MS;
const MAX_BODY = 2 * 1024 * 1024;
const FAIL_WINDOW_MS = 60_000;
const FAILS_PER_ADDRESS = 10;
const LOCKOUT_MS = 60_000;
const ONLINE_MS = 30_000;
const MAX_DEVICES = 50;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/* ---------- pairing material ---------- */

function newPairing() {
	const bytes = crypto.randomBytes(15); // 120 bits → 24 base32 symbols
	let bits = 0, value = 0, code = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			code += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return {
		v: 1,
		code: code.match(/.{4}/g).join("-"),
		salt: crypto.randomBytes(16).toString("base64url"),
		kid: crypto.randomBytes(6).toString("hex"),
		createdAt: Date.now()
	};
}

function validPairing(p) {
	return !!p && typeof p === "object" && /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(p.code) && typeof p.salt === "string" && /^[0-9a-f]{12}$/.test(p.kid);
}

/** The code a pairing link carries (`#p=CODE`, or a bare code), normalized; null otherwise. */
function codeFromHash(hash) {
	const raw = String(hash || "").replace(/^#/, "").replace(/^p=/, "").trim().toUpperCase();
	return /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(raw) ? raw : null;
}

function pairingUrl(ip, port, code) {
	return "http://" + ip + ":" + port + "/#p=" + code;
}

function deriveKey(pairing) {
	return crypto.pbkdf2Sync(pairing.code, Buffer.from(pairing.salt, "base64url"), KDF_ITERATIONS, 32, "sha256");
}

function seal(key, aad, obj) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad, "utf8"));
	const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), "utf8")), cipher.final()]);
	return { i: iv.toString("base64url"), d: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64url") };
}

function open(key, aad, envelope) {
	const iv = Buffer.from(String(envelope.i || ""), "base64url");
	const sealed = Buffer.from(String(envelope.d || ""), "base64url");
	if (iv.length !== 12 || sealed.length < 17) throw new Error("malformed");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(Buffer.from(aad, "utf8"));
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	return JSON.parse(plain.toString("utf8"));
}

/* ---------- LAN addresses ---------- */

function lanIps() {
	const ips = [];
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		for (const entry of list || []) {
			if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal) ips.push({ ip: entry.address, name });
		}
	}
	const virtual = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier|loopback|utun|tap|tun/i;
	const rank = ({ ip, name }) =>
		(virtual.test(name) ? 10 : 0) +
		(ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : ip.startsWith("169.254.") ? 8 : 3);
	return ips.sort((a, b) => rank(a) - rank(b));
}

/* ---------- static files ---------- */

const STATIC = {
	"/": ["web/index.html", "text/html; charset=utf-8"],
	"/index.html": ["web/index.html", "text/html; charset=utf-8"],
	"/app.js": ["web/app.js", "application/javascript; charset=utf-8"],
	"/app.css": ["web/app.css", "text/css; charset=utf-8"],
	"/icon.svg": ["web/icon.svg", "image/svg+xml"],
	"/manifest.webmanifest": ["web/manifest.webmanifest", "application/manifest+json"],
	"/sjcl.js": ["sjcl.js", "application/javascript; charset=utf-8"]
};

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/* ---------- the server ---------- */

/**
 * @param {{
 *   pairing: object, port?: number, host?: string,
 *   folders?: () => {name: string, path: string}[],
 *   runner: import('./runner.js').Runner,
 *   info?: () => object,
 *   log?: (line: string) => void,
 *   onDevice?: () => void,
 *   baseDir?: string
 * }} options
 */
function startServer(options) {
	const log = options.log || (() => {});
	const baseDir = options.baseDir || __dirname;
	const runner = options.runner;
	const folders = options.folders || (() => []);
	let pairing = options.pairing;
	let key = deriveKey(pairing);
	const nonces = new Map();
	const failures = new Map(); // address → { times: number[], lockedUntil }
	const devices = new Map();
	const staticCache = new Map();

	const readStatic = (file) => {
		if (!staticCache.has(file)) {
			try { staticCache.set(file, fs.readFileSync(path.join(baseDir, file))); } catch { staticCache.set(file, null); }
		}
		return staticCache.get(file);
	};

	const remember = (n, ts) => {
		const now = Date.now();
		if (nonces.size > 5000 || nonces.size % 64 === 0) {
			for (const [k, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(k);
		}
		if (nonces.has(n)) return false;
		nonces.set(n, ts);
		return true;
	};

	const lockedOut = (address) => {
		const entry = failures.get(address);
		return !!entry && entry.lockedUntil > Date.now();
	};
	const fail = (address) => {
		const now = Date.now();
		const entry = failures.get(address) || { times: [], lockedUntil: 0 };
		entry.times = entry.times.filter((t) => now - t < FAIL_WINDOW_MS);
		entry.times.push(now);
		if (entry.times.length >= FAILS_PER_ADDRESS) {
			entry.lockedUntil = now + LOCKOUT_MS;
			entry.times = [];
			log(`locked out ${address} for ${LOCKOUT_MS / 1000}s after repeated decryption failures`);
		}
		failures.set(address, entry);
	};

	const workspaceFolders = () => folders().filter((f) => f && f.path);
	const folderPaths = () => workspaceFolders().map((f) => f.path);

	const sessionView = (s) => {
		const lane = runner.laneState(s.id);
		return {
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			project: s.cwd ? path.basename(s.cwd) : "",
			branch: s.branch || null,
			preview: s.preview,
			previewRole: s.previewRole,
			mtimeMs: s.mtimeMs,
			desktopBusy: sessions.desktopBusy(s),
			running: !!(lane && lane.running),
			queued: lane ? lane.queue.length : 0,
			model: shownModel(s.model, s.cwd),
			onDesktop: desktopTabs().has(s.id)
		};
	};

	/** The sessions with a Claude Code tab open on the desktop (empty where unknown). */
	const desktopTabs = () => {
		try { return new Set(options.desktopTabs ? options.desktopTabs() || [] : []); } catch { return new Set(); }
	};

	/** The desktop's current model for a folder: its settings, else what it last answered with. */
	const currentModel = (cwd, root, sessionModel) => {
		const recent = sessions.listSessions({ folders: cwd ? [cwd] : folderPaths() })[0];
		const info = sessions.modelInfo({ root: root || sessions.claudeRoot(), cwd, fallback: recent && recent.model });
		return { ...info, session: sessionModel || null };
	};

	/** A model name as the phone shows it: the tier alias a pick or an in-flight run still
	 *  carries becomes the third-party model the run itself resolves it to. */
	const shownModel = (id, cwd) => (id == null ? null : sessions.resolveModelName(id, { cwd: cwd || undefined }));

	/** A lane as the phone sees it: its model names resolved by `shownModel`, so a
	 *  third-party provider's banner names the model actually answering, not the alias. */
	const laneView = (key) => {
		const lane = runner.laneState(key);
		if (!lane) return lane;
		return {
			...lane,
			running: lane.running ? { ...lane.running, model: shownModel(lane.running.model, lane.cwd) } : null,
			last: lane.last ? { ...lane.last, model: shownModel(lane.last.model, lane.cwd) } : null
		};
	};

	/** A tool row as it syncs: the summary line only. The input body and the result text
	 *  ride a separate `tool` fetch the phone makes when the row is opened — except a
	 *  question, whose options the phone must already hold to answer it. */
	const lazyTool = (item) => item.k !== "tool" ? item : {
		...item,
		body: !item.body ? item.body : item.body.kind === "question" ? item.body : { kind: item.body.kind },
		res: item.res ? { more: item.res.more || undefined, err: item.res.err || undefined, imgs: item.res.imgs && item.res.imgs.length ? item.res.imgs : undefined } : item.res
	};

	const methods = {
		hello() {
			return {
				protocol: PROTOCOL,
				host: os.hostname(),
				platform: process.platform,
				workspace: workspaceFolders(),
				permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"],
				keyCreatedAt: pairing.createdAt,
				model: currentModel(folderPaths()[0] || null, null, null),
				// prompts typed into the desktop tab run with that tab's model and permission mode
				injection: !!(options.injection && options.injection()),
				...(options.info ? options.info() : {})
			};
		},
		sessions(p) {
			const scope = p.scope === "all" || !folderPaths().length ? null : folderPaths();
			const list = sessions.listSessions({ folders: scope, query: p.q });
			const limit = Math.max(10, Math.min(500, Number(p.limit) || 200));
			// Drafts whose first turn has not produced a session file yet.
			const drafts = [];
			for (const lane of runner.lanes.values()) {
				if (lane.key.startsWith("draft:") && (!lane.sessionId || !list.some((s) => s.id === lane.sessionId))) {
					drafts.push({ id: lane.sessionId || lane.key, lane: lane.key, draft: true, title: lane.title || "New conversation", cwd: lane.cwd, project: lane.cwd ? path.basename(lane.cwd) : "", preview: "", mtimeMs: Date.now(), running: !!lane.running, queued: lane.queue.length, desktopBusy: false });
				}
			}
			return { scope: scope ? "workspace" : "all", sessions: [...drafts, ...list.slice(0, limit).map(sessionView)], total: list.length, version: runner.version };
		},
		session(p) {
			const laneKey = String(p.lane || p.id || "");
			const laneState = runner.laneState(laneKey);
			const sessionId = laneState && laneState.sessionId ? laneState.sessionId : laneKey.startsWith("draft:") ? null : laneKey;
			const s = sessionId ? sessions.findSession(sessionId) : null;
			if (!s) {
				if (laneState) return { draft: true, id: laneKey, lane: laneView(laneKey), items: [], rev: "draft:" + runner.version, total: 0, hasMore: false };
				throw Object.assign(new Error("no such conversation"), { status: 404 });
			}
			const state = sessions.readTranscript(s.file);
			const before = p.before != null && Number.isFinite(Number(p.before)) ? Number(p.before) : null;
			const rev = state.size + ":" + state.mtimeMs + ":" + runner.version + ":" + (Number(p.limit) || 0) + ":" + (before || 0);
			const lane = laneView(s.id);
			const meta = { ...sessionView(s), midTurn: undefined, model: shownModel(state.model || s.model, s.cwd) };
			if (p.rev === rev) return { same: true, rev, lane, session: meta, cur: { gen: state.gen, since: state.seq } };
			// A cursor from this same parse asks for the delta; anything else (a first read, a
			// rebuilt state, a wider window) gets the full window back. A `before` stamp asks
			// for one page of older history — prepended client-side, never disturbing the
			// delta cursor the phone polls with.
			const since = p.cur && p.cur.gen === state.gen && Number.isFinite(Number(p.cur.since)) ? Number(p.cur.since) : null;
			const window = sessions.transcriptWindow(state, { limit: p.limit, since, before });
			const sent = new Set(runner.sentTexts(s.id).map((t) => t.trim()));
			const items = window.items.map((item) => (item.k === "user" && sent.has(item.text.trim()) ? { ...item, remote: true } : item)).map(lazyTool);
			return { id: s.id, session: meta, items, total: window.total, hasMore: window.hasMore, desktopBusy: sessions.desktopBusy({ ...s, midTurn: window.midTurn, mtimeMs: state.mtimeMs }), lane, rev, cur: window.cur, delta: window.delta };
		},
		/** The models a prompt may run with: the desktop's current one, this session's own, the tiers. */
		models(p) {
			const s = p.id ? sessions.findSession(p.id) : null;
			const model = s ? sessions.readTranscript(s.file).model || s.model : null;
			return currentModel(s ? s.cwd : p.cwd || null, s ? s.root : null, model);
		},
		/** A tool row's input body and result — what an opened row fetches. */
		tool(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const state = sessions.readTranscript(s.file);
			const item = state.items.find((it) => it.id === String(p.item || "") && it.k === "tool");
			if (!item) throw Object.assign(new Error("no such item"), { status: 404 });
			return { body: item.body || null, res: item.res || null };
		},
		detail(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const state = sessions.readTranscript(s.file);
			const text = state.fullResults.get(String(p.item || ""));
			if (text === undefined) throw Object.assign(new Error("no such item"), { status: 404 });
			return { text };
		},
		image(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const img = sessions.readTranscript(s.file).images.get(String(p.ref || ""));
			if (!img) throw Object.assign(new Error("no such image"), { status: 404 });
			return img;
		},
		send(p, device) {
			const text = String(p.text ?? "");
			let cwd, root = null, title = null, sessionId = null;
			const laneState = p.lane ? runner.laneState(String(p.lane)) : null;
			const id = laneState && laneState.sessionId ? laneState.sessionId : p.sessionId;
			if (id && !String(id).startsWith("draft:")) {
				const s = sessions.findSession(id);
				if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
				sessionId = s.id;
				cwd = s.cwd;
				root = s.root;
				title = s.title;
			} else if (laneState && laneState.cwd) {
				// A follow-up to a new conversation whose session has not shown yet: the folder
				// it started in (a phone sends no folder after the first prompt — falling back to
				// the first workspace folder sent it elsewhere, where --resume finds nothing).
				cwd = laneState.cwd;
			} else {
				// A new conversation runs in an open workspace folder — never an arbitrary path.
				const wanted = p.cwd ? String(p.cwd) : folderPaths()[0];
				const allowed = folderPaths();
				if (!wanted || (allowed.length && !allowed.some((f) => sessions.samePathKey(f) === sessions.samePathKey(wanted)))) {
					throw Object.assign(new Error("choose an open workspace folder"), { status: 400 });
				}
				cwd = wanted;
				title = text.trim().split("\n")[0].slice(0, 60);
			}
			const draftId = laneState ? String(p.lane).replace(/^draft:/, "") : p.draftId;
			const result = runner.send({ sessionId, draftId, cwd, root, title, text, mode: p.mode, permissionMode: p.permissionMode, model: p.model, device: device && device.label });
			return { ...result, state: laneView(result.lane) };
		},
		stop(p) { return { ok: runner.stop(String(p.lane || "")), state: laneView(String(p.lane || "")) }; },
		resume(p) { return { ok: runner.resume(String(p.lane || "")), state: laneView(String(p.lane || "")) }; },
		cancel(p) { return { ok: runner.cancel(String(p.lane || ""), String(p.entry || "")), state: laneView(String(p.lane || "")) }; },
		promote(p) { return { ok: runner.promote(String(p.lane || ""), String(p.entry || "")), state: laneView(String(p.lane || "")) }; },
		/** Bring the conversation up in its Claude Code tab on the desktop. */
		async openOnDesktop(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			if (!options.openDesktopTab) throw new Error("not available on this host");
			await options.openDesktopTab(s.id);
			return { ok: true };
		},
		/** Answer a pending AskUserQuestion: the picks are validated against the question
		 *  body the transcript parsed (the phone echoes labels it was given), then handed
		 *  to the conversation's desktop tab, which clicks its own option card. */
		async answer(p, device) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const state = sessions.readTranscript(s.file);
			const item = state.items.find((it) => it.id === String(p.item || "") && it.k === "tool" && it.name === "AskUserQuestion");
			if (!item) throw Object.assign(new Error("no such item"), { status: 404 });
			if (item.st !== "run") throw Object.assign(new Error("the question is no longer waiting"), { status: 409 });
			const questions = item.body && item.body.kind === "question" ? item.body.questions : null;
			if (!questions || !questions.length) throw Object.assign(new Error("the question has no options to pick"), { status: 400 });
			if (!Array.isArray(p.answers) || p.answers.length !== questions.length) {
				throw Object.assign(new Error("answers must pick options for every question"), { status: 400 });
			}
			// One pick set per question, each pick one of the labels the phone was shown
			// ("Other" is always offerable — Claude Code's own card appends it).
			const answers = questions.map((question, i) => {
				const a = p.answers[i] || {};
				const picks = (Array.isArray(a.picks) ? a.picks : []).map((x) => String(x)).filter(Boolean).slice(0, 8);
				const other = String(a.other || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500);
				if (!picks.length || (!question.multi && picks.length > 1)) {
					throw Object.assign(new Error(question.multi ? "pick at least one option" : "pick exactly one option"), { status: 400 });
				}
				for (const pick of picks) {
					if (pick !== "Other" && !question.opts.some((o) => o.label === pick)) {
						throw Object.assign(new Error("not one of the offered options: " + pick), { status: 400 });
					}
				}
				if (picks.includes("Other") && !other) throw Object.assign(new Error("an “Other” pick needs its text"), { status: 400 });
				return { q: question.q, header: question.header, multi: question.multi, picks, other: picks.includes("Other") ? other : undefined };
			});
			if (!options.answerQuestion) throw new Error("answering questions needs the desktop's Claude Code tab");
			await options.answerQuestion({ sessionId: s.id, item: item.id, answers });
			runner.changed({ kind: "answer", title: s.title, text: answers.map((a) => a.picks.join(", ")).join(" · ").slice(0, 80), device: device && device.label });
			return { ok: true };
		},
		forget(_p, device) {
			if (device) devices.delete(device.id);
			options.onDevice && options.onDevice();
			return { ok: true };
		}
	};

	const handleRpc = (req, res, body, address) => {
		const plainError = (status, error) => {
			res.statusCode = status;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({ error }));
		};
		if (lockedOut(address)) { plainError(429, "locked"); return; }
		let envelope;
		try { envelope = JSON.parse(body); } catch { fail(address); plainError(400, "bad envelope"); return; }
		if (!envelope || envelope.kid !== pairing.kid) { fail(address); plainError(401, "rekeyed"); return; }
		let call;
		try { call = open(key, "cr2:req:" + pairing.kid, envelope); } catch { fail(address); plainError(401, "auth"); return; }
		const now = Date.now();
		if (!call || typeof call.n !== "string" || call.n.length < 16 || call.n.length > 64 || typeof call.ts !== "number") { plainError(400, "bad call"); return; }
		if (Math.abs(now - call.ts) > CLOCK_WINDOW_MS) { plainError(401, "clock"); return; }
		if (!remember(call.n, now)) { plainError(401, "replay"); return; }
		const answer = (status, obj) => {
			res.statusCode = status;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify(seal(key, "cr2:res:" + call.n, obj)));
		};
		let device = null;
		if (call.dev && typeof call.dev.id === "string" && /^[\w-]{8,64}$/.test(call.dev.id)) {
			const known = devices.get(call.dev.id);
			device = known || { id: call.dev.id, firstSeen: now, requests: 0 };
			// control characters out: a label never forges log lines
			device.label = String(call.dev.label || "Phone").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 60) || "Phone";
			device.ip = address;
			device.lastSeen = now;
			device.requests++;
			devices.set(device.id, device);
			// a paired device can claim ids without end; the panel stays bounded (the
			// current caller is never the one evicted)
			while (devices.size > MAX_DEVICES) {
				const oldest = [...devices.entries()].filter(([id]) => id !== device.id).sort((a, b) => a[1].firstSeen - b[1].firstSeen)[0];
				if (!oldest) break;
				devices.delete(oldest[0]);
			}
			if (!known) {
				log(`paired device "${device.label}" from ${address}`);
				options.onDevice && options.onDevice(device);
			}
		}
		const method = Object.prototype.hasOwnProperty.call(methods, call.m) ? methods[call.m] : null;
		if (!method) { answer(404, { ok: false, error: "unknown method" }); return; }
		Promise.resolve()
			.then(() => method(call.p && typeof call.p === "object" ? call.p : {}, device))
			.then((result) => answer(200, { ok: true, r: result }))
			.catch((error) => answer(error && error.status || 500, { ok: false, error: String(error && error.message || error) }));
	};

	const server = http.createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		const address = String(req.socket && req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
		const url = String(req.url || "/").split("?")[0];
		if (req.method === "GET" && url === "/api/hello") {
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify({ protocol: PROTOCOL, kid: pairing.kid, salt: pairing.salt, iterations: KDF_ITERATIONS, now: Date.now() }));
			return;
		}
		if (req.method === "POST" && url === "/api/rpc") {
			const chunks = [];
			let size = 0;
			let aborted = false;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY) { aborted = true; res.statusCode = 413; res.end("{}"); req.destroy && req.destroy(); return; }
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (aborted) return;
				handleRpc(req, res, Buffer.concat(chunks).toString("utf8"), address);
			});
			return;
		}
		if (req.method === "GET" && STATIC[url]) {
			const [file, type] = STATIC[url];
			const body = readStatic(file);
			if (!body) { res.statusCode = 404; res.end("missing from the package: " + file); return; }
			res.setHeader("Content-Type", type);
			if (type.startsWith("text/html")) res.setHeader("Content-Security-Policy", PAGE_CSP);
			res.end(body);
			return;
		}
		res.statusCode = 404;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("not found");
	});

	const listen = (port) => new Promise((resolve, reject) => {
		const onError = (error) => { server.removeListener("listening", onListening); reject(error); };
		const onListening = () => { server.removeListener("error", onError); resolve(); };
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, options.host || "0.0.0.0");
	});

	const wanted = Number(options.port) || 0;
	return listen(wanted)
		.catch((error) => {
			if (!wanted) throw error;
			log(`port ${wanted} unavailable (${error && error.code || error}); picking a free one`);
			return listen(0);
		})
		.then(() => {
			const port = server.address().port;
			log(`listening on 0.0.0.0:${port}`);
			return {
				port,
				get pairing() { return pairing; },
				/** Swap the pairing secret: every holder of the old key is locked out. */
				rekey(next) {
					pairing = next;
					key = deriveKey(next);
					nonces.clear();
					devices.clear();
					failures.clear();
				},
				devices() {
					const now = Date.now();
					return [...devices.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((d) => ({ ...d, online: now - d.lastSeen < ONLINE_MS }));
				},
				stop: () => new Promise((done) => {
					server.close(() => done());
					// keep-alive phones would otherwise hold close() open
					if (typeof server.closeAllConnections === "function") server.closeAllConnections();
				})
			};
		});
}

module.exports = { startServer, newPairing, validPairing, codeFromHash, pairingUrl, deriveKey, seal, open, lanIps, KDF_ITERATIONS, PROTOCOL };
