"use strict";
/* The relay client: this window's connection to the PC's relay. Real Node (VS Code)
 * speaks the WebSocket; ggs-node has no WebSocket client, so the same frames cross the
 * long-poll pair (`GET /agent/poll` + `POST /agent/send`) — the relay serves both over
 * one ring with one cursor space, so the transports are interchangeable.
 *
 * Every payload crosses as one `ct` string through wire.js — the plain codec while the
 * remote flows are brought up (encryption returns there, and only there). The window's
 * metadata rides the `window.meta` control in the same codec. `seq` is per sender and
 * increasing; nothing rejects a lower one — a phone that reloads starts its own count
 * again, and the plain codec has no replay window to defend. */

const wire = require("./wire.js");
const { normalizeServer, relayFetch } = require("./identity.js");

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const POLL_WAIT_S = 20;
const OUTBOX_MAX = 512;
const SEND_BATCH = 64; // the relay's per-POST frame cap

function wsSupported() {
	return typeof WebSocket === "function";
}

/**
 * @param {{ userId, agentSecret, K, epoch, serverUrl }} identity
 * @param {{ windowId, host?: string, meta: () => object, log,
 *           onFrame: (plain: object, meta: {from,to,seq}) => void,
 *           onEpoch: (epoch: number) => void, onOnline: (online: boolean) => void,
 *           getIdentity: () => object }} options — `getIdentity` answers the CURRENT
 *         identity (a rekey swaps K and epoch under a live connection).
 */
function createRelay(identity, options) {
	const log = options.log || (() => {});
	const windowId = options.windowId;
	// The caller may pin the transport (the conformance probe serves a plain-HTTP
	// mini relay); the default picks what this host can do.
	const mode = options.transport === "long-poll" || options.transport === "websocket" ? options.transport : wsSupported() ? "websocket" : "long-poll";
	let stopped = true;
	let socket = null;
	let seq = Math.floor(Date.now() / 1000); // per-sender increasing (the relay's envelope wants one)
	let backoff = BACKOFF_MIN_MS;
	let online = false;
	const outbox = [];

	const setOnline = (value) => {
		if (online === value) return;
		online = value;
		try {
			options.onOnline?.(value);
		} catch { /* listener failures never break the connection */ }
	};

	const currentIdentity = () => (options.getIdentity ? options.getIdentity() : identity);

	/** One body as the frame it travels in. */
	function frame(to, plain) {
		return { v: 1, kind: "frame", from: windowId, to, seq: ++seq, ct: wire.encode(plain) };
	}

	/** One message off the wire: a frame for this window, or a control word. */
	function ingest(message) {
		const value = typeof message === "string" ? JSON.parse(message) : message;
		if (!value || value.v !== 1) return;
		if (value.kind === "epoch_changed") {
			log(`the pairing epoch moved to ${value.epoch} — reloading the identity`);
			try {
				options.onEpoch?.(Number(value.epoch) || 0);
			} catch { /* the identity reload reports its own failures */ }
			return;
		}
		if (value.kind === "frame") {
			let plain;
			try {
				plain = wire.decode(value.ct);
			} catch (error) {
				// One undecodable frame is that frame's loss — throwing here would fail the
				// whole poll batch, and the cursor would never move past it.
				log(`a frame from ${value.from} did not decode: ${error && error.message}`);
				return;
			}
			try {
				options.onFrame?.(plain, { from: value.from, to: value.to, seq: value.seq });
			} catch (error) {
				log(`a frame's handler failed: ${error && error.message}`);
			}
			return;
		}
		if (value.kind === "gap") log("the relay dropped frames while this window was away — the transcripts backfill");
	}

	/** The window's metadata control line (workspace name, host, folders) — the phone's
	 *  window list reads it. `ct` is the codec's string: a bare object here read as a
	 *  protocol violation server-side and closed the connection on every publish. */
	function metaControl() {
		return { v: 1, kind: "window.meta", host: options.host || "ggs", ct: wire.encode(options.meta ? options.meta() : {}) };
	}

	async function pollSend(frames) {
		const id = currentIdentity();
		const { ok, status, json } = await relayFetch(id.serverUrl, "POST", "/api/v1/agent/send", {
			agentSecret: id.agentSecret,
			body: { window: windowId, frames },
			timeoutMs: 20000
		});
		if (status === 401) {
			setOnline(false);
			throw new Error("the relay rejected this PC's agent secret");
		}
		if (!ok) throw Object.assign(new Error((json && json.error) || `HTTP ${status}`), { status });
	}

	/** Send one body. The WebSocket writes at once; the poll path queues and pumps — one
	 *  POST in flight at a time, up to SEND_BATCH frames each, so a live stream's frames
	 *  reach the phone in the order they were made (parallel POSTs raced each other). */
	function send(to, plain) {
		const item = frame(to, plain);
		if (mode === "websocket" && socket !== null) {
			try {
				socket.send(JSON.stringify(item));
				return true;
			} catch {
				/* falls through to the outbox */ }
		}
		if (outbox.length >= OUTBOX_MAX) outbox.shift();
		outbox.push(item);
		flushOutbox();
		return online;
	}

	let pumping = false;
	function flushOutbox() {
		if (!online || !outbox.length) return;
		if (mode === "websocket") {
			while (outbox.length && socket !== null) {
				const item = outbox.shift();
				try {
					socket.send(JSON.stringify(item));
				} catch {
					outbox.unshift(item);
					return;
				}
			}
			return;
		}
		if (pumping) return;
		pumping = true;
		void (async () => {
			try {
				while (outbox.length && online && !stopped) {
					const batch = outbox.splice(0, SEND_BATCH);
					try {
						await pollSend(batch);
					} catch (error) {
						if (error && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
							// The relay refused the batch's shape: resending it cannot help.
							log(`the relay refused ${batch.length} frame(s): ${error.message}`);
							continue;
						}
						// Back to the head, in order; the next successful poll pumps again.
						outbox.unshift(...batch);
						while (outbox.length > OUTBOX_MAX) outbox.shift();
						log(`sending to the relay failed: ${error && error.message}`);
						return;
					}
				}
			} finally {
				pumping = false;
			}
		})();
	}

	/* ---------- the WebSocket transport ---------- */

	function connectWs() {
		const id = currentIdentity();
		const base = normalizeServer(id.serverUrl).replace(/^http/, "ws");
		// The WebSocket API carries no Authorization header — the relay takes the token
		// as a query parameter for exactly this shape of client (the phone's browser too).
		const url = `${base}/ws/agent?window=${encodeURIComponent(windowId)}&token=${encodeURIComponent(id.agentSecret)}`;
		let ws;
		try {
			ws = new WebSocket(url);
		} catch {
			scheduleReconnect();
			return;
		}
		socket = ws;
		let opened = false;
		ws.onopen = () => {
			opened = true;
			backoff = BACKOFF_MIN_MS;
			setOnline(true);
			publishMeta();
			flushOutbox();
		};
		ws.onmessage = (event) => {
			try {
				ingest(event.data);
			} catch (error) {
				log(`a relay message did not open: ${error && error.message}`);
			}
		};
		ws.onclose = (event) => {
			socket = null;
			setOnline(false);
			if (event && event.code === 4401) {
				// The agent secret was rotated (or the relay started from empty data):
				// retrying keeps the window reachable the moment the store returns.
				log("the relay rejected this window's agent secret (rotated, or the relay's data was reset) — retrying");
			}
			if (!stopped) scheduleReconnect();
		};
		ws.onerror = () => {
			if (!opened) {
				try {
					ws.close();
				} catch { /* already gone */ }
			}
		};
	}

	/* ---------- the long-poll transport (ggs-node) ---------- */

	async function pollLoop() {
		let cursor = 0; // this poller is a fresh consumer: the ring's history is not ours
		while (!stopped) {
			const id = currentIdentity();
			try {
				const { ok, status, json } = await relayFetch(id.serverUrl, "GET",
					`/api/v1/agent/poll?window=${encodeURIComponent(windowId)}&cursor=${cursor}&wait=${POLL_WAIT_S}`,
					{ agentSecret: id.agentSecret, timeoutMs: (POLL_WAIT_S + 15) * 1000 });
				if (stopped) return;
				if (status === 401) throw new Error("the relay rejected this PC's agent secret");
				if (!ok) throw new Error((json && json.error) || `HTTP ${status}`);
				const wasOffline = !online;
				setOnline(true);
				backoff = BACKOFF_MIN_MS;
				if (wasOffline) {
					// Every (re)attach republishes: a relay that restarted forgot the meta.
					await pollSend([metaControl()]).catch((error) => log(`publishing the window meta failed: ${error && error.message}`));
				}
				const arrived = (json.frames ?? []).length;
				for (const item of Array.isArray(json.frames) ? json.frames : []) ingest(item);
				cursor = Number(json.cursor) || cursor;
				flushOutbox();
				// A relay that answers an empty poll instantly (or a proxy that unwaits it)
				// must not turn this loop into a microtask spin: yield a beat regardless.
				if (!arrived) await new Promise((resolve) => setTimeout(resolve, 250));
			} catch (error) {
				setOnline(false);
				log(`the relay poll failed: ${error && error.message} — retrying`);
				await new Promise((resolve) => setTimeout(resolve, backoff));
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			}
		}
	}

	function scheduleReconnect() {
		if (stopped) return;
		const wait = backoff;
		backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
		const timer = setTimeout(() => {
			if (stopped) return;
			if (mode === "websocket") connectWs();
			else void pollLoop();
		}, wait);
		timer.unref?.();
	}

	function publishMeta() {
		if (!online) return;
		if (socket !== null) {
			try {
				socket.send(JSON.stringify(metaControl()));
			} catch { /* the next reconnect republishes */ }
		} else if (mode === "long-poll") {
			void pollSend([metaControl()]).catch(() => undefined);
		}
	}

	return {
		windowId,
		send,
		online: () => online,
		transport: () => mode,
		start() {
			stopped = false;
			if (mode === "websocket") connectWs();
			else void pollLoop();
		},
		republishMeta: publishMeta,
		stop() {
			stopped = true;
			setOnline(false);
			if (socket) {
				try {
					socket.close();
				} catch { /* already gone */ }
				socket = null;
			}
		}
	};
}

module.exports = { createRelay, wsSupported };
