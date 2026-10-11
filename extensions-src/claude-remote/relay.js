"use strict";
/* The relay client: this window's connection to the PC's relay. Real Node (VS Code)
 * speaks the WebSocket; ggs-node has no WebSocket client, so the same frames cross the
 * long-poll pair (`GET /agent/poll` + `POST /agent/send`) — the relay serves both over
 * one ring with one cursor space, so the transports are interchangeable.
 *
 * Every payload crosses end-to-end encrypted (crypto.js); the relay only ever sees the
 * routing envelope. The window's sealed metadata rides the `window.meta` control —
 * itself a sealed body under the broadcast AAD with seq 0 (metadata is idempotent and
 * replayable by design; frames that must not replay carry their own increasing seq). */

const crypto = require("./crypto.js");
const { normalizeServer, relayFetch } = require("./identity.js");

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const POLL_WAIT_S = 20;
const OUTBOX_MAX = 256;

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
	let seq = Math.floor(Date.now() / 1000); // per-sender monotonic; receivers reject regressions
	const lastSeqByFrom = new Map(); // anti-replay: the highest seq accepted per peer
	let backoff = BACKOFF_MIN_MS;
	let online = false;
	let metaPublished = false;
	const outbox = [];

	const setOnline = (value) => {
		if (online === value) return;
		online = value;
		try {
			options.onOnline?.(value);
		} catch { /* listener failures never break the connection */ }
	};

	const currentIdentity = () => (options.getIdentity ? options.getIdentity() : identity);

	/** Seal one body under the current key material and the envelope it will travel in.
	 *  The wire's `ct` is the sealed body's two base64url parts joined by a dot. */
	function frame(to, plain) {
		const id = currentIdentity();
		const envelope = { userId: id.userId, epoch: id.epoch, from: windowId, to, seq: ++seq };
		const sealed = crypto.sealFrame(crypto.deriveE2E(id.K), envelope, plain);
		return { v: 1, kind: "frame", from: windowId, to, seq: envelope.seq, ct: sealed.n + "." + sealed.c };
	}

	function open(envelope, body) {
		const id = currentIdentity();
		// AAD binds the receiver's current epoch: a frame sealed under an older one (a
		// rekey raced the delivery) fails authentication — the transcript backfills it.
		const material = { ...envelope, userId: id.userId, epoch: id.epoch };
		const last = lastSeqByFrom.get(envelope.from) ?? 0;
		if (envelope.from !== windowId && envelope.seq <= last) {
			throw new Error(`frame from ${envelope.from} replays seq ${envelope.seq}`);
		}
		const plain = crypto.openFrame(crypto.deriveE2E(id.K), material, body);
		if (envelope.from !== windowId) lastSeqByFrom.set(envelope.from, envelope.seq);
		return plain;
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
			const split = String(value.ct ?? "").split(".");
			const plain = open({ from: value.from, to: value.to, seq: Number(value.seq) }, { n: split[0], c: split[1] });
			try {
				options.onFrame?.(plain, { from: value.from, to: value.to, seq: value.seq });
			} catch (error) {
				log(`a frame's handler failed: ${error && error.message}`);
			}
			return;
		}
		if (value.kind === "gap") log("the relay dropped frames while this window was away — the transcripts backfill");
	}

	/** The window's sealed metadata control line (the seq-0 broadcast body). The wire's
	 *  `ct` is the sealed body's two base64url parts joined by a dot — a bare object
	 *  here read as a protocol violation server-side and closed the connection on every
	 *  publish, flapping the window off the relay for good. */
	function metaControl() {
		const id = currentIdentity();
		const envelope = { userId: id.userId, epoch: id.epoch, from: windowId, to: "*", seq: 0 };
		const sealed = crypto.sealFrame(crypto.deriveE2E(id.K), envelope, options.meta ? options.meta() : {});
		return { v: 1, kind: "window.meta", host: options.host || "ggs", ct: sealed.n + "." + sealed.c };
	}

	async function pollSend(frames) {
		const id = currentIdentity();
		const { ok, status, json } = await relayFetch(id.serverUrl, "POST", "/api/v1/agent/send", {
			agentSecret: id.agentSecret,
			body: { window: windowId, frames: frames.map((wire) => (typeof wire === "string" ? JSON.parse(wire) : wire)) },
			timeoutMs: 20000
		});
		if (status === 401) {
			setOnline(false);
			throw new Error("the relay rejected this PC's agent secret");
		}
		if (!ok) throw new Error((json && json.error) || `HTTP ${status}`);
	}

	/** Send one sealed body — immediately on either transport; a failure banks it. */
	function send(to, plain) {
		const wire = frame(to, plain);
		if (mode === "websocket" && socket !== null) {
			try {
				socket.send(JSON.stringify(wire));
				return true;
			} catch {
				/* falls through to the outbox */ }
		} else if (mode === "long-poll" && online) {
			void pollSend([wire]).catch(() => {
				if (outbox.length >= OUTBOX_MAX) outbox.shift();
				outbox.push(wire);
			});
			return true;
		}
		if (outbox.length >= OUTBOX_MAX) outbox.shift();
		outbox.push(wire);
		return online;
	}

	function flushOutbox() {
		while (outbox.length && online) {
			const wire = outbox.shift();
			try {
				if (socket !== null) socket.send(JSON.stringify(wire));
				else if (mode === "long-poll") {
					void pollSend([wire]).catch(() => outbox.unshift(wire));
					return; // one in-flight send at a time on the poll path
				}
			} catch {
				outbox.unshift(wire);
				return;
			}
		}
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
			metaPublished = false;
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
				if (wasOffline && !metaPublished) {
					metaPublished = true;
					await pollSend([metaControl()]);
				}
				const arrived = (json.frames ?? []).length;
				for (const wire of Array.isArray(json.frames) ? json.frames : []) ingest(wire);
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
