"use strict";
/* The GGS host tap source: the read-only bypass over the workbench's Claude Code webview
 * relay (`ggs.claudeTap.*`, module 12) plus its driving commands (`ggs.claudeChat.*`).
 * The tap sees the CLI's own SDK stream (both directions), the permission cards and the
 * remote-control state — tagged with the conversation each panel hosts — and nothing
 * else a panel exchanges. It never writes the CLI's stdin and never synthesizes a
 * webview request: the only writes are the same DOM-driving commands a user at the
 * keyboard could press. */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether this host serves the ggs.claudeChat / ggs.claudeTap surface (Git Graph
 *  Studio; VS Code answers nothing and the caller falls back to the sdkHost source). */
async function probe(vscode) {
	try {
		const state = await vscode.commands.executeCommand("ggs.claudeChat.state", {});
		return !!state && typeof state === "object" && "phase" in state;
	} catch {
		return false;
	}
}

/**
 * @param {typeof import('vscode')} vscode
 * @param {{ log, onEvent: (event) => void, onChange: () => void }} options — `onEvent`
 *   receives the unified stream shapes (below); `onChange` fires when a tap event may
 *   have changed what the transcripts show (the phone re-pulls).
 *   { kind: "sdk", sessionId, dir, message }
 *   { kind: "permission", sessionId, dir, message }
 *   { kind: "rc", sessionId, message }
 *   { kind: "gap" }
 */
function createTapSource(vscode, options) {
	const log = options.log || (() => {});
	let subscription = null;
	let listening = false;

	const exec = (id, arg) => Promise.resolve(vscode.commands.executeCommand(id, arg)).catch((error) => {
		throw new Error(`${id}: ${error && error.message}`);
	});

	async function start() {
		if (listening) return true;
		const granted = await vscode.commands.executeCommand("ggs.claudeTap.subscribe");
		if (!granted || !granted.ok) {
			log(`the conversation tap was not granted${granted && granted.reason ? ` (${granted.reason})` : ""}`);
			return false;
		}
		listening = true;
		subscription = vscode.env.onClaudeConversationTap?.((item) => {
			try {
				if (item.kind === "gap") {
					options.onEvent({ kind: "gap" });
					options.onChange();
					return;
				}
				// A `gap` says the host dropped mirror-side events; the transcripts
				// backfill what the tap missed (uuid-deduplicated there).
				if (item.kind === "rc") {
					options.onEvent({ kind: "rc", sessionId: item.sessionId, message: item.message });
					options.onChange();
					return;
				}
				options.onEvent({ kind: item.kind, sessionId: item.sessionId, dir: item.dir, message: item.message });
				// Stream deltas coalesce: the phone re-pulls the transcript on its own
				// tick; anything but chatter wakes it at once.
				const type = messageKind(item.message);
				if (type !== "stream_event") options.onChange();
			} catch (error) {
				log(`a tap event did not process: ${error && error.message}`);
			}
		});
		return true;
	}

	function stop() {
		try {
			subscription?.dispose?.();
		} catch { /* already gone */ }
		subscription = null;
		listening = false;
		void vscode.commands.executeCommand("ggs.claudeTap.unsubscribe").catch(() => undefined);
	}

	/* ---------- the driving half (the desktop tab as the phone's hands) ---------- */

	/** Answer a settled ticket ({phase: sent|error}) or throw its error. */
	async function settle(kind, arg, { timeoutMs = 60000, quietMs = 0 } = {}) {
		const { ticket } = await exec(kind, arg);
		const deadline = Date.now() + timeoutMs;
		let lastQuiet = 0;
		for (;;) {
			const state = await exec("ggs.claudeChat.state", { ticket });
			if (state.phase === "error") throw new Error(state.error || "the desktop tab did not take it");
			if (state.phase === "sent") return state;
			if (quietMs && state.phase === "opening") {
				if (!lastQuiet) lastQuiet = Date.now();
				else if (Date.now() - lastQuiet > quietMs) throw new Error("the Claude Code tab did not open in time");
			}
			if (Date.now() > deadline) throw new Error("the desktop tab did not settle in time");
			await sleep(400);
		}
	}

	return {
		start,
		stop,
		listening: () => listening,
		async send(arg) {
			return settle("ggs.claudeChat.send", arg);
		},
		async open(arg) {
			return settle("ggs.claudeChat.open", arg);
		},
		async stopTurn(arg) {
			return exec("ggs.claudeChat.stop", arg);
		},
		async state(arg) {
			return exec("ggs.claudeChat.state", arg);
		},
		async answer(arg) {
			return settle("ggs.claudeChat.answer", arg);
		},
		async permission(arg) {
			return settle("ggs.claudeChat.permission", arg, { timeoutMs: 30000 });
		},
		async mode(arg) {
			return settle("ggs.claudeChat.mode", arg, { timeoutMs: 30000 });
		},
		async remoteControl(arg) {
			return settle("ggs.claudeChat.remoteControl", arg, { timeoutMs: 40000 });
		},
		async remoteState(arg) {
			return exec("ggs.claudeChat.remoteState", arg);
		}
	};
}

/** The inner message type a webview envelope carries, for the coalescing rules. */
function messageKind(envelope) {
	const value = envelope && typeof envelope === "object" ? envelope : {};
	if (typeof value.message === "object" && value.message && typeof value.message.type === "string") return value.message.type;
	if (typeof value.type === "string") return value.type;
	return "";
}

module.exports = { createTapSource, probe, messageKind };
