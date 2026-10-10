"use strict";
/* The official-RC mirror (plan §2.2/P5b): while the CLI's own Remote Control carries a
 * conversation over Anthropic's bridge, this module forwards a read-only copy of the
 * same SDK stream to the self-hosted relay — the phone's own app renders it beside the
 * official one. Orthogonal to the mode switch: the official path keeps working whether
 * or not the mirror runs.
 *
 * The hard rules (tested):
 *   1. Read-only. Nothing here synthesizes a webview request, writes the CLI's stdin or
 *      touches Claude's settings — `official.js` owns every write; the mirror imports
 *      none of it.
 *   2. Cleansed. Only SDK messages, permission requests/cancels and the RC state's
 *      status/sessionUrl/bridgeEpoch cross; `connectUrl` (a live session key) stays
 *      behind unless the user opted in (`claudeRemote.mirrorConnectUrl`).
 *   3. Control off by default (`claudeRemote.mirrorControl`): a phone's instructions
 *      ride the desktop tab's own UI (the same commands a user at the keyboard could
 *      press), so the official client sees nothing but the local user's hands.
 *   4. `whenConnected`: per-conversation, keyed on the RC state the CLI pushes — the
 *      mirror starts when a conversation's bridge is up and stops when it is not. */

const RC_STATES = new Set(["connecting", "connected", "disconnected", "error"]);

/** Whether a tap event is worth mirroring, and what of it. */
function cleanse(event, { mirrorConnectUrl } = {}) {
	if (event.kind === "sdk") return event;
	if (event.kind === "permission") return event;
	if (event.kind === "rc") {
		// The state the phone shows: status, sessionUrl, bridgeEpoch. connectUrl is a
		// live key into the official session — it stays behind unless asked for.
		const rc = pickRc(event.message);
		if (!rc || typeof rc !== "object") return null;
		const clean = { status: typeof rc.status === "string" ? rc.status : "unknown" };
		if (typeof rc.sessionUrl === "string") clean.sessionUrl = rc.sessionUrl;
		if (typeof rc.bridgeEpoch === "number") clean.bridgeEpoch = rc.bridgeEpoch;
		if (mirrorConnectUrl && typeof rc.connectUrl === "string") clean.connectUrl = rc.connectUrl;
		return { kind: "rc", sessionId: event.sessionId, message: clean };
	}
	return null;
}

/** The RC status a state event carries, when it carries one. */
/** The RC payload a state message carries, in either spelling the versions shipped. */
function pickRc(message) {
	const scan = (node, depth = 0) => {
		if (!node || typeof node !== "object" || depth > 3) return null;
		for (const key of ["channelRemoteControlState", "remoteControlState"]) {
			if (node[key] && typeof node[key] === "object") return node[key];
		}
		for (const nested of ["state", "request"]) {
			if (nested in node) {
				const found = scan(node[nested], depth + 1);
				if (found) return found;
			}
		}
		return null;
	};
	return scan(message);
}

/** The RC status a state event carries, when it carries one. */
function rcStatusOf(event) {
	if (event.kind !== "rc") return null;
	const rc = pickRc(event.message);
	if (!rc || typeof rc.status !== "string" || !RC_STATES.has(rc.status)) return null;
	return rc.status;
}

/**
 * @param {{ config: () => { mirrorOfficial: "off"|"whenConnected"|"always", mirrorConnectUrl: boolean },
 *           log, forward: (payload: object, sessionId: string | null) => void }} options
 *         `forward` carries one mirrored event to the relay (the caller seals it).
 */
function createMirror(options) {
	const log = options.log || (() => {});
	const mirrored = new Set(); // the conversations whose RC bridge is up (whenConnected)

	function shouldMirror(event) {
		const { mirrorOfficial } = options.config();
		if (mirrorOfficial === "off") return false;
		if (mirrorOfficial === "always") return true;
		// whenConnected: the conversation's own state gates it — and the state event
		// that ends a mirror crosses once (the phone's mirror UI needs the stop), after
		// which the gate is closed.
		const status = rcStatusOf(event);
		if (status === "connected") {
			mirrored.add(event.sessionId);
			return true;
		}
		// Only a TERMINAL state closes the gate — 'connecting' keeps it open (it is
		// not "no longer connected", it is not-yet-again-connected). The closing event
		// itself crosses once, so the phone's mirror UI learns the stop.
		if ((status === "disconnected" || status === "error") && mirrored.delete(event.sessionId)) return true;
		return mirrored.has(event.sessionId);
	}

	return {
		/** One tap event in; true when a cleansed copy crossed to the relay. */
		offer(event) {
			const { mirrorConnectUrl } = options.config();
			if (!shouldMirror(event)) return false;
			const clean = cleanse(event, { mirrorConnectUrl });
			if (!clean) return false;
			try {
				options.forward({ t: "tap", sessionId: clean.sessionId, event: { kind: clean.kind, dir: clean.dir, message: clean.message } }, clean.sessionId);
				return true;
			} catch (error) {
				log(`mirroring one event failed: ${error && error.message}`);
				return false;
			}
		},
		reset() {
			mirrored.clear();
		}
	};
}

module.exports = { createMirror, cleanse, rcStatusOf, RC_STATES };
