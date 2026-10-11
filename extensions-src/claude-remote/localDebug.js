"use strict";
/* The local debug page: the phone app served by THIS window on 127.0.0.1, talking to it
 * directly — no relay, no pairing — so the remote flows (the conversation list, history,
 * a new conversation, the live SDK stream, the permission cards) can be opened in a
 * desktop browser and debugged against the real window.
 *
 * It plays the relay's part for exactly one device: the page is the relay's own phone app
 * (claude-remote-server/web, packed into the VSIX as web/), handed `window.CRR_LOCAL` so
 * it speaks a long-poll pair instead of the relay's WebSocket, and the messages on that
 * pair are the relay's own wire — `hello`, `windows`, `frame` with `ct` bodies through
 * wire.js. The window answers it with the same request table and live stream a paired
 * phone gets; only the transport differs.
 *
 * Loopback only, and every API path carries a random token (the link IS the credential —
 * a web page elsewhere in the same browser cannot guess it). */

const http = require("http");
const fs = require("fs");
const path = require("path");
const wire = require("./wire.js");

const DEVICE_ID = "d_localdebug0000001";
const POLL_WAIT_MS = 20_000;
const MAX_WAITERS = 16; // parked polls (a page keeps one; reloads leave stale ones until their timer)
const RING_MAX = 2000;
const MAX_BODY = 4 * 1024 * 1024;
const ASSETS = {
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/app.css": ["app.css", "text/css; charset=utf-8"],
	"/icon.svg": ["icon.svg", "image/svg+xml"],
	"/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"]
};

/** Where the phone app's files are: packed beside the extension (the VSIX), or the
 *  relay's source tree (running from the repository). */
function findWebDir(baseDir = __dirname) {
	for (const dir of [path.join(baseDir, "web"), path.join(baseDir, "..", "..", "claude-remote-server", "web")]) {
		if (fs.existsSync(path.join(dir, "app.js")) && fs.existsSync(path.join(dir, "index.html"))) return dir;
	}
	return null;
}

function randomToken() {
	return require("crypto").randomBytes(16).toString("hex");
}

/**
 * @param {{ windowId: string, meta: () => object, host?: string, log?: (line: string) => void,
 *           onFrame: (plain: object, meta: {from, to, seq}) => void, webDir?: string }} options
 */
function createLocalDebug(options) {
	const log = options.log || (() => {});
	const windowId = options.windowId;
	let server = null;
	let port = 0;
	let token = null;
	let seq = Math.floor(Date.now() / 1000);
	let cursor = 1; // never 0 — a page polls with cursor 0 to say "I am fresh"
	const ring = []; // [{c, message}]
	const waiters = new Set(); // parked polls: () => void
	let lastMeta = null;

	function push(message) {
		ring.push({ c: ++cursor, message });
		if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
		for (const wake of [...waiters]) wake();
	}

	const hello = () => ({ v: 1, kind: "hello", you: DEVICE_ID, user: "local", epoch: 0 });
	const windows = () => ({
		v: 1,
		kind: "windows",
		list: [{ id: windowId, online: true, seen: Date.now(), host: options.host || "", meta_ct: wire.encode(options.meta ? options.meta() : {}) }]
	});

	/** One body from the window to the page (`to` is this device or the broadcast). */
	function send(to, plain) {
		if (!server || (to !== DEVICE_ID && to !== "*")) return false;
		push({ v: 1, kind: "frame", from: windowId, to: DEVICE_ID, seq: ++seq, ct: wire.encode(plain) });
		return true;
	}

	function pageHtml(webDir) {
		const raw = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
		const config = `<script>window.CRR_LOCAL = ${JSON.stringify({ base: `/d/${token}/api`, device: DEVICE_ID })};</script>`;
		return raw.replace('<script src="/app.js"></script>', `${config}\n<script src="/app.js"></script>`);
	}

	function json(res, status, value) {
		try {
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(JSON.stringify(value));
		} catch (error) {
			log(`a debug-page response did not write (the page left?): ${error && error.message}`);
		}
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY) reject(new Error("body too large"));
				else chunks.push(chunk);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});
	}

	function poll(req, res, url) {
		const since = Number(url.searchParams.get("cursor") || 0);
		// A fresh page (cursor 0, or one from before a restart) starts at "now": the hello
		// and the window list, never another page's backlog.
		if (!since || since > cursor) {
			json(res, 200, { cursor, messages: [hello(), windows()] });
			return;
		}
		const answer = () => {
			const messages = ring.filter((item) => item.c > since).map((item) => item.message);
			// The ring dropped what this page had not read yet: the page re-pulls on a gap.
			if (ring.length && ring[0].c > since + 1) messages.unshift({ v: 1, kind: "gap" });
			json(res, 200, { cursor, messages });
		};
		if (ring.some((item) => item.c > since)) return answer();
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			waiters.delete(finish);
			clearTimeout(timer);
			answer();
		};
		// No `close` listener: under ggs-node the request's `close` fires as soon as the
		// request has been read — treating it as "the page left" dropped every parked
		// poll unanswered, and the page never heard a reply or a live frame again. A poll
		// whose page really left is answered into the void on its timer (the write fails
		// harmlessly), and the waiter set stays bounded.
		const timer = setTimeout(finish, POLL_WAIT_MS);
		waiters.add(finish);
		if (waiters.size > MAX_WAITERS) [...waiters][0]();
	}

	async function handle(req, res) {
		const url = new URL(req.url, "http://127.0.0.1");
		const webDir = options.webDir || findWebDir();
		if (req.method === "GET" && ASSETS[url.pathname] && webDir) {
			const [file, type] = ASSETS[url.pathname];
			res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
			res.end(fs.readFileSync(path.join(webDir, file)));
			return;
		}
		const match = url.pathname.match(/^\/d\/([0-9a-f]{32})(\/.*)?$/);
		if (!match || match[1] !== token) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("not found");
			return;
		}
		const rest = match[2] || "/";
		if (req.method === "GET" && (rest === "/" || rest === "")) {
			if (!webDir) return json(res, 500, { error: "the phone app's files are missing from this package" });
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
			res.end(pageHtml(webDir));
			return;
		}
		if (req.method === "GET" && rest === "/api/poll") return poll(req, res, url);
		if (req.method === "POST" && rest === "/api/send") {
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch (error) {
				return json(res, 400, { error: String(error && error.message || error) });
			}
			for (const item of Array.isArray(body && body.frames) ? body.frames : []) {
				if (!item || item.v !== 1) continue;
				if (item.kind === "windows") {
					push(windows());
				} else if (item.kind === "frame") {
					let plain;
					try {
						plain = wire.decode(item.ct);
					} catch (error) {
						log(`the debug page sent an undecodable frame: ${error && error.message}`);
						continue;
					}
					try {
						options.onFrame(plain, { from: DEVICE_ID, to: windowId, seq: Number(item.seq) || 0 });
					} catch (error) {
						log(`a debug-page frame's handler failed: ${error && error.message}`);
					}
				}
			}
			return json(res, 200, { ok: true, cursor });
		}
		json(res, 404, { error: "no such path" });
	}

	async function start({ port: wanted = 0 } = {}) {
		if (server) return url();
		token = token || randomToken();
		const created = http.createServer((req, res) => {
			Promise.resolve(handle(req, res)).catch((error) => {
				try {
					json(res, 500, { error: String(error && error.message || error) });
				} catch { /* the response already went */ }
			});
		});
		const listen = (p) => new Promise((resolve, reject) => {
			const onError = (error) => { created.removeListener("listening", onListening); reject(error); };
			const onListening = () => { created.removeListener("error", onError); resolve(); };
			created.once("error", onError);
			created.once("listening", onListening);
			created.listen(p, "127.0.0.1");
		});
		await listen(Number(wanted) || 0).catch((error) => {
			if (!wanted) throw error;
			log(`debug port ${wanted} unavailable (${error && error.code || error}); picking a free one`);
			return listen(0);
		});
		server = created;
		port = server.address().port;
		log(`the local debug page is up at ${url()}`);
		return url();
	}

	function url() {
		return server ? `http://127.0.0.1:${port}/d/${token}` : null;
	}

	function stop() {
		for (const wake of [...waiters]) wake();
		waiters.clear();
		if (server) {
			try {
				server.close();
			} catch { /* already closed */ }
		}
		server = null;
	}

	return {
		deviceId: DEVICE_ID,
		start,
		stop,
		send,
		url,
		running: () => !!server,
		/** Re-announce the window when its meta changed (the heartbeat calls this). */
		republish: () => {
			if (!server) return;
			const now = JSON.stringify(options.meta ? options.meta() : {});
			if (now === lastMeta) return;
			lastMeta = now;
			push(windows());
		}
	};
}

module.exports = { createLocalDebug, findWebDir, DEVICE_ID };
