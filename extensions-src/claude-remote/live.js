"use strict";
/* The live stream: the conversation's own SDK messages — exactly the content the CLI's
 * /remote-control bridge carries (assistant / user / stream_event / result / system,
 * verbatim) — forwarded to the phones that are watching that conversation.
 *
 * Both sources feed it the same unified events (sources/tap.js on Git Graph Studio, the
 * webview's io_message traffic; sources/sdkHost.js elsewhere, the CLI's stdout). A phone
 * says what it watches (`watch {sessionId}`, renewed while the conversation is open); a
 * phone that just started a NEW conversation watches a draft, and the first event of a
 * conversation id it did not know before adopts it (`{t: "adopt", draft, sessionId}`).
 *
 * Delivery is coalesced per watcher (one frame per FLUSH_MS, a burst of stream deltas
 * crossing together) and bounded: an oversized message crosses as a stub the phone
 * answers with a transcript pull, and a backlog past MAX_PENDING drops its stream deltas
 * first and marks a gap — the JSONL transcript is the backfill for anything lost. */

const FLUSH_MS = 60;
const WATCH_TTL_MS = 90 * 1000;
const NEW_TTL_MS = 3 * 60 * 1000;
const MAX_PENDING = 400;
const MAX_MESSAGE_CHARS = 200 * 1024;
const MAX_BATCH_CHARS = 480 * 1024;

/** The SDK message a unified event carries, or null: the tap hands the webview envelope
 *  (`{type: "io_message", message}`), the sdk host the CLI's line itself. */
function sdkMessageOf(event) {
	const message = event && event.message;
	if (!message || typeof message !== "object") return null;
	if (message.type === "io_message") return message.message && typeof message.message === "object" ? message.message : null;
	if (message.type === "interrupt_claude") return { type: "system", subtype: "interrupt_requested" };
	if (typeof message.type === "string" && !message.channelId) return message;
	return null;
}

/**
 * A permission event as the `/remote-control` protocol carries it — the SDK's own
 * `control_request {subtype: "can_use_tool"}`, `control_cancel_request` and
 * `control_response`. The sdk host's lines already are that; the GGS tap's are the chat
 * page's envelopes (`{type: "request", requestId, request: {type: "tool_permission_request",
 * toolName, inputs, suggestions}}`, `{type: "cancel_request", targetRequestId}`, the page's
 * `{type: "response", requestId, response: {type: "tool_permission_response", result}}`),
 * mapped field for field. Null for anything else.
 */
function rcPermissionOf(message) {
	const m = message && typeof message === "object" ? message : null;
	if (!m) return null;
	if (m.type === "control_request" || m.type === "control_cancel_request" || m.type === "control_response") return m;
	if (m.type === "request" && m.request && m.request.type === "tool_permission_request" && typeof m.requestId === "string") {
		const r = m.request;
		return {
			type: "control_request",
			request_id: m.requestId,
			request: {
				subtype: "can_use_tool",
				tool_name: r.toolName,
				input: r.inputs || {},
				permission_suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
				...(r.toolUseId ? { tool_use_id: r.toolUseId } : {}),
				...(r.defaultToNo ? { default_to_no: true } : {})
			}
		};
	}
	if (m.type === "cancel_request" && typeof m.targetRequestId === "string") return { type: "control_cancel_request", request_id: m.targetRequestId };
	if (m.type === "response" && m.response && m.response.type === "tool_permission_response" && typeof m.requestId === "string") {
		return { type: "control_response", response: { subtype: "success", request_id: m.requestId, response: m.response.result } };
	}
	return null;
}

/** The conversation an event belongs to: the host's own tag, else the SDK's session_id. */
function sessionOf(event, sdk) {
	if (event && typeof event.sessionId === "string" && event.sessionId) return event.sessionId;
	if (sdk && typeof sdk.session_id === "string" && sdk.session_id) return sdk.session_id;
	return null;
}

/** One message as it may cross: verbatim unless it is huge (a giant tool result) — then
 *  its identity and a `truncated` mark, and the phone reads the transcript for the body. */
function bounded(message) {
	let text;
	try {
		text = JSON.stringify(message);
	} catch {
		return null;
	}
	if (text.length <= MAX_MESSAGE_CHARS) return { message, size: text.length };
	const stub = { type: message.type, subtype: message.subtype, uuid: message.uuid, session_id: message.session_id, truncated: true };
	return { message: stub, size: 200 };
}

/**
 * @param {{ send: (to: string, payload: object) => void, log?: (line: string) => void,
 *           knownSessions?: () => Iterable<string> }} options
 *   `send` carries one payload to one phone (the relay); `knownSessions` lists the
 *   conversation ids that already exist (a new conversation adopts an id outside it).
 */
function createLive(options) {
	const log = options.log || (() => {});
	const watchers = new Map(); // deviceId → { sessionId, draft, until, known, pending: [], size, gap, timer }

	function watcher(deviceId) {
		let entry = watchers.get(deviceId);
		if (!entry) {
			entry = { sessionId: null, draft: null, until: 0, known: null, pending: [], size: 0, gap: false, timer: null };
			watchers.set(deviceId, entry);
		}
		return entry;
	}

	/** A phone watches a conversation (or, with `draft`, the one it is starting). */
	function watch(deviceId, { sessionId = null, draft = null } = {}) {
		if (!deviceId) return { ok: false };
		const entry = watcher(deviceId);
		if (sessionId) {
			if (entry.sessionId !== sessionId) dropPending(entry);
			entry.sessionId = String(sessionId);
			entry.draft = null;
			entry.known = null;
			entry.until = Date.now() + WATCH_TTL_MS;
		} else if (draft) {
			if (entry.draft !== draft) {
				dropPending(entry);
				entry.sessionId = null;
				entry.draft = String(draft);
				entry.known = new Set(knownNow());
			}
			entry.until = Date.now() + NEW_TTL_MS;
		} else {
			unwatch(deviceId);
		}
		return { ok: true, sessionId: entry.sessionId, draft: entry.draft };
	}

	function unwatch(deviceId) {
		const entry = watchers.get(deviceId);
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		watchers.delete(deviceId);
	}

	function knownNow() {
		try {
			return [...(options.knownSessions ? options.knownSessions() || [] : [])];
		} catch {
			return [];
		}
	}

	function dropPending(entry) {
		entry.pending = [];
		entry.size = 0;
		entry.gap = false;
	}

	/** One unified source event in (sdk / permission / state / gap). */
	function offer(event) {
		if (!event || !watchers.size) return;
		const now = Date.now();
		for (const [deviceId, entry] of watchers) {
			if (entry.until < now) unwatch(deviceId);
		}
		if (event.kind === "gap") {
			for (const entry of watchers.values()) {
				entry.gap = true;
				schedule(entry);
			}
			return;
		}
		const sdk = event.kind === "sdk" ? sdkMessageOf(event) : null;
		if (event.kind === "sdk" && !sdk) return;
		const sessionId = sessionOf(event, sdk);
		if (!sessionId && event.kind !== "permission") return;
		const rc = event.kind === "permission" ? rcPermissionOf(event.message) : null;
		if (event.kind === "permission" && !rc) return;
		const item = event.kind === "sdk"
			? bounded(sdk)
			: rc ? bounded(rc)
				: event.kind === "state" ? { message: { type: "ggs_state", busy: !!event.busy, model: event.model || null, permissionMode: event.permissionMode || null }, size: 80 }
					: null;
		if (!item) return;
		for (const [deviceId, entry] of watchers) {
			if (sessionId && !entry.sessionId && entry.draft && entry.known && !entry.known.has(sessionId)) {
				// The first event of a conversation this phone did not know: the one it
				// just started. Adopt it, tell the phone, and stream from here on.
				entry.sessionId = sessionId;
				entry.until = Date.now() + WATCH_TTL_MS;
				const draft = entry.draft;
				entry.draft = null;
				entry.known = null;
				log(`a phone's new conversation is ${sessionId}`);
				flush(deviceId, entry);
				options.send(deviceId, { t: "adopt", draft, sessionId });
			}
			// A withdrawal the page could not tag (its request id is unique anyway) reaches
			// every phone watching a conversation; everything else only its own.
			if (sessionId ? entry.sessionId !== sessionId : !entry.sessionId) continue;
			if (entry.pending.length >= MAX_PENDING) {
				// The backlog sheds its stream deltas first (the full messages carry the
				// same text), and whatever still overflows is a gap the transcript fills.
				entry.pending = entry.pending.filter((m) => m.type !== "stream_event");
				entry.size = entry.pending.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
				if (entry.pending.length >= MAX_PENDING) {
					entry.gap = true;
					continue;
				}
			}
			entry.pending.push(item.message);
			entry.size += item.size;
			schedule(entry, deviceId);
		}
	}

	function schedule(entry, deviceId) {
		if (entry.timer) return;
		const id = deviceId || [...watchers.entries()].find(([, value]) => value === entry)?.[0];
		if (!id) return;
		entry.timer = setTimeout(() => {
			entry.timer = null;
			flush(id, entry);
		}, FLUSH_MS);
		entry.timer.unref?.();
	}

	function flush(deviceId, entry) {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		if (!entry.pending.length && !entry.gap) return;
		const sessionId = entry.sessionId;
		const gap = entry.gap;
		let batch = [];
		let size = 0;
		const out = () => {
			if (!batch.length && !gap) return;
			try {
				options.send(deviceId, { t: "live", sessionId, msgs: batch, ...(gap ? { gap: true } : {}) });
			} catch (error) {
				log(`a live frame did not send: ${error && error.message}`);
			}
			batch = [];
			size = 0;
		};
		for (const message of entry.pending) {
			const length = JSON.stringify(message).length;
			if (batch.length && size + length > MAX_BATCH_CHARS) out();
			batch.push(message);
			size += length;
		}
		out();
		entry.pending = [];
		entry.size = 0;
		entry.gap = false;
	}

	return {
		watch,
		unwatch,
		offer,
		watchers,
		/** Who watches what — for the panel and the tests. */
		snapshot: () => [...watchers.entries()].map(([deviceId, entry]) => ({ deviceId, sessionId: entry.sessionId, draft: entry.draft })),
		dispose() {
			for (const deviceId of [...watchers.keys()]) unwatch(deviceId);
		}
	};
}

module.exports = { createLive, sdkMessageOf, sessionOf, rcPermissionOf, FLUSH_MS, WATCH_TTL_MS, MAX_MESSAGE_CHARS };
