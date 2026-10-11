"use strict";
/* The self-hosted SDK source: this window runs the desktop's own `claude` CLI as the
 * extension itself would — `--input-format stream-json --output-format stream-json
 * --permission-prompt-tool stdio --include-partial-messages`, the prompt on stdin, the
 * session resumed under the config root it lives in (plan §4.1's `sources/sdkHost.js`).
 * This is VS Code's only source (it cannot reach another extension's webview) and every
 * host's fallback when the conversation has no desktop tab.
 *
 * The stream the child writes is the same SDK message flow the tap mirrors: assistant
 * turns, stream deltas, tool calls, results — and the permission questions arrive as
 * `control_request` lines when `--permission-prompt-tool stdio` is set, answered with a
 * `control_response`. One lane per conversation; a prompt is "now" (interrupt first) or
 * "queue" exactly as the desktop tab's own queue behaves. */

const fs = require("fs");
const path = require("path");
const { claudeCliPath, nodeExecutable } = require("../runner.js");

const TURN_TIMEOUT_MS = 60 * 60 * 1000;
const OPEN_TIMEOUT_MS = 60 * 1000;
const MAX_QUEUE = 20;
const PERMISSION_MODES = ["default", "auto", "acceptEdits", "plan", "bypassPermissions", "manual", "dontAsk"];

/** One stream-json line onto a child's stdin; false when the pipe is gone. */
function writeLine(child, value) {
	try {
		child.stdin.write(JSON.stringify(value) + "\n");
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {{ log, onEvent, onChange, spawn?, cliPath?, defaultRoot?: () => string }} options
 *   `onEvent` receives the same unified shapes the tap source emits:
 *   { kind: "sdk", sessionId, dir: "out", message }      — the CLI's stdout, verbatim
 *   { kind: "permission", sessionId, message }           — a control_request to answer
 *   { kind: "state", sessionId, busy, model, permissionMode }
 */
function createSdkHostSource(options) {
	const log = options.log || (() => {});
	const spawnImpl = options.spawn || require("child_process").spawn;
	const cliPath = options.cliPath || claudeCliPath();
	const lanes = new Map(); // sessionId (or draft) → lane
	// Mode picks made before a conversation's first turn (no lane yet): applied when the
	// lane is created, so the phone's mode picker works from the very first prompt.
	const pendingModes = new Map(); // sessionId → permission mode

	function laneFor(sessionId, draftId) {
		const key = sessionId || `draft:${draftId}`;
		let lane = lanes.get(key);
		if (!lane) {
			lane = { key, sessionId: sessionId || null, cwd: null, root: null, child: null, queue: [], running: false, busy: false, model: null, mode: "default", permission: null, lastError: null };
			lanes.set(key, lane);
		}
		return lane;
	}

	/* ---------- one turn: spawn the CLI, stream its messages, answer permissions ---------- */

	function runTurn(lane, entry) {
		if (lane.running || !lane.queue.length) return;
		const next = lane.queue.shift();
		if (!next) return;
		lane.running = true;
		lane.busy = true;
		emitState(lane);
		const args = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--include-partial-messages"];
		// The lane's PERMISSION mode rides the flag — next.mode is the send mode
		// (queue/now), and passing that here launched every turn as
		// `--permission-mode queue`, which the real CLI refuses outright.
		if (lane.mode && lane.mode !== "default") args.push("--permission-mode", lane.mode);
		if (next.model) args.push("--model", next.model);
		if (lane.sessionId) args.push("--resume", lane.sessionId);
		const env = { ...process.env };
		if (lane.root) env.CLAUDE_CONFIG_DIR = lane.root;
		let command = cliPath;
		let argv = args;
		let shell = false;
		if (/\.(c|m)?js$/i.test(command)) {
			argv = [command, ...args];
			command = nodeExecutable(env);
		} else if (process.platform === "win32" && !path.isAbsolute(command)) {
			shell = true; // `claude` on PATH is an npm .cmd shim
		}
		log(`sdk turn in ${lane.cwd}${lane.sessionId ? " resume " + lane.sessionId : " (new)"} [${next.mode}]`);
		let child;
		try {
			child = spawnImpl(command, argv, { cwd: lane.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell, windowsHide: true });
		} catch (error) {
			lane.running = false;
			lane.busy = false;
			failTurn(lane, `spawn failed: ${error && error.message || error}`);
			emitState(lane);
			options.onChange();
			return;
		}
		lane.child = child;
		let outBuffer = "";
		let inBuffer = "";
		let stderr = "";
		let sawResult = false;
		let timer = setTimeout(() => {
			lane.lastError = "timeout";
			try {
				child.kill();
			} catch { /* the close handler reports */ }
		}, TURN_TIMEOUT_MS);
		const onLine = (line) => {
			if (!line.trim()) return;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.session_id && !lane.sessionId) {
				lane.sessionId = event.session_id;
				lanes.delete(lane.key);
				lane.key = event.session_id;
				lanes.set(lane.key, lane);
				const preset = pendingModes.get(event.session_id) ?? pendingModes.get(lane.key);
				if (preset) {
					lane.mode = preset;
					pendingModes.delete(event.session_id);
					pendingModes.delete(lane.key);
				}
				options.onChange();
			}
			if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
				lane.model = event.model;
			}
			if (event.type === "control_request") {
				const request = event.request && typeof event.request === "object" ? event.request : {};
				if (request.subtype === "can_use_tool") {
					// The CLI asks permission over stdio (`--permission-prompt-tool stdio`):
					// surfaced to the phone, answered by `permission()` below with a
					// control_response carrying the request's own id.
					lane.permission = event;
					options.onEvent({ kind: "permission", sessionId: lane.sessionId, message: event });
					options.onChange();
					return;
				}
				// Nothing else is served here (hooks, MCP, dialogs): an answered error lets
				// the CLI fall through instead of waiting on a response that never comes.
				writeLine(child, { type: "control_response", response: { subtype: "error", request_id: event.request_id, error: `unsupported control request: ${request.subtype || "?"}` } });
				return;
			}
			if (event.type === "control_cancel_request") {
				if (lane.permission && lane.permission.request_id === event.request_id) {
					lane.permission = null;
					options.onEvent({ kind: "permission", sessionId: lane.sessionId, message: event });
					options.onChange();
				}
				return;
			}
			if (event.type === "control_response") return; // answers to our own interrupt
			options.onEvent({ kind: "sdk", sessionId: lane.sessionId, dir: "out", message: event });
			if (event.type === "result") {
				sawResult = true;
				// One prompt per process: the turn is over, EOF lets the CLI exit (stdin
				// stayed open only so permission answers could cross).
				try {
					child.stdin.end();
				} catch { /* already closed */ }
			}
			const interesting = event.type !== "stream_event";
			if (interesting) options.onChange();
		};
		const feed = (chunk, buffer, sink) => {
			buffer += chunk.toString("utf8");
			let nl;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				sink(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
			}
			return buffer;
		};
		child.stdout.on("data", (chunk) => {
			outBuffer = feed(chunk, outBuffer, onLine);
		});
		// stream-json input: the prompt as one user message; stdin stays open for the
		// permission answers and ends at the turn's result.
		child.stdin.on("error", () => undefined);
		// The SDK's own user message (what the claude-code extension writes): the prompt
		// as a MessageParam. The CLI drops a bare {type, content} line without a word.
		writeLine(child, { type: "user", message: { role: "user", content: [{ type: "text", text: next.text }] }, parent_tool_use_id: null, session_id: lane.sessionId || "" });
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		const settle = (code) => {
			clearTimeout(timer);
			if (outBuffer.trim()) onLine(outBuffer);
			lane.child = null;
			// A turn that answered its result is done, whatever the exit code (an interrupt
			// or the EOF exit may report one); one that did not is a failure the phone sees.
			const failed = lane.lastError || (code && code !== 0 && !sawResult ? `claude exited ${code}${stderr.trim() ? ": " + stderr.trim().split("\n").slice(-2).join(" ") : ""}` : null);
			lane.lastError = null;
			lane.running = false;
			lane.busy = false;
			lane.permission = null;
			if (failed) {
				lane.lastErrorNote = failed;
				if (!sawResult) failTurn(lane, failed);
			}
			emitState(lane);
			options.onChange();
			runTurn(lane); // the queued prompt behind this one, if any
		};
		child.on("error", (error) => {
			lane.lastError = `spawn failed: ${error && error.message || error}`;
		});
		child.on("close", settle);
	}

	/** A turn that ended without the CLI's own result: the phone sees it as one — the
	 *  same `result` shape an errored turn carries — so it never waits on a dead turn. */
	function failTurn(lane, reason) {
		log(`sdk turn failed: ${reason}`);
		options.onEvent({ kind: "sdk", sessionId: lane.sessionId, dir: "out", message: { type: "result", subtype: "error_during_execution", is_error: true, result: reason, session_id: lane.sessionId || undefined } });
	}

	function emitState(lane) {
		options.onEvent({ kind: "state", sessionId: lane.sessionId, busy: lane.running, model: lane.model, permissionMode: lane.mode });
	}

	return {
		cliPath,
		lanes,
		/** Submit a prompt like the runner's lanes: "now" interrupts first, "queue" waits. */
		send({ sessionId = null, draftId = null, cwd, root = null, text, mode = "queue", permissionMode = null, model = null }) {
			if (!cwd || !fs.existsSync(cwd)) throw new Error("working directory not found: " + cwd);
			const lane = laneFor(sessionId, draftId);
			lane.cwd = cwd;
			lane.root = root || lane.root || (options.defaultRoot ? options.defaultRoot() : null);
			// An explicit pick wins; without one, the remembered preset (keyed by the
			// session id or the draft lane the phone named) applies — a null
			// permissionMode is "no choice this turn", not "default".
			if (permissionMode && PERMISSION_MODES.includes(permissionMode)) lane.mode = permissionMode;
			else {
				const preset = pendingModes.get(sessionId) ?? pendingModes.get(lane.key);
				if (preset) lane.mode = preset;
			}
			if (lane.queue.length >= MAX_QUEUE) throw new Error("queue is full");
			const entry = { text: String(text ?? "").trim(), mode: mode === "now" ? "now" : "queue", model: typeof model === "string" && /^[\w.\-[\]:/]{1,80}$/.test(model) ? model : null };
			if (!entry.text) throw new Error("empty prompt");
			if (entry.mode === "now" && lane.running) {
				this.interrupt(lane.sessionId);
			}
			lane.queue.push(entry);
			if (!lane.running) runTurn(lane, entry);
			return { lane: lane.key, sessionId: lane.sessionId };
		},
		interrupt(sessionId) {
			for (const lane of lanes.values()) {
				if (lane.key === sessionId || lane.sessionId === sessionId) {
					const child = lane.child;
					if (!child) return true;
					try {
						if (process.platform === "win32" && child.pid) {
							spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
						} else child.kill();
					} catch { /* the close handler settles */ }
					return true;
				}
			}
			return false;
		},
		/** Answer a `can_use_tool` request with the remote's own control_response — the
		 *  `/remote-control` protocol verbatim: `{subtype, request_id, response:
		 *  PermissionResult}` onto the CLI's stdin. False when no such request is pending. */
		respond(sessionId, response) {
			const answer = response && typeof response === "object" ? response : {};
			for (const lane of lanes.values()) {
				if ((lane.key === sessionId || lane.sessionId === sessionId) && lane.permission && lane.child) {
					if (answer.request_id && answer.request_id !== lane.permission.request_id) return false;
					const line = { type: "control_response", response: { subtype: answer.subtype || "success", request_id: lane.permission.request_id, response: answer.response } };
					if (!writeLine(lane.child, line)) return false;
					lane.permission = null;
					options.onEvent({ kind: "permission", sessionId: lane.sessionId, message: line });
					return true;
				}
			}
			return false;
		},
		/** Answer the lane's pending permission question (the phone's card). */
		permission(sessionId, { decision, message } = {}) {
			for (const lane of lanes.values()) {
				if ((lane.key === sessionId || lane.sessionId === sessionId) && lane.permission && lane.child) {
					const request = lane.permission;
					const asked = request.request || {};
					// The SDK's PermissionResult: allow carries the input it runs with (the
					// CLI requires it) and, for "always", the suggestions it offered as the
					// rules to remember; deny carries the reason Claude reads.
					const result = decision === "deny"
						? { behavior: "deny", message: message || "The user denied this from the phone." }
						: { behavior: "allow", updatedInput: asked.input || {}, ...(decision === "allowAlways" && Array.isArray(asked.permission_suggestions) ? { updatedPermissions: asked.permission_suggestions } : {}) };
					if (!writeLine(lane.child, { type: "control_response", response: { subtype: "success", request_id: request.request_id, response: result } })) return false;
					lane.permission = null;
					return true;
				}
			}
			return false;
		},
		setMode(sessionId, mode) {
			if (!PERMISSION_MODES.includes(mode)) return false;
			for (const lane of lanes.values()) {
				if (lane.key === sessionId || lane.sessionId === sessionId) {
					lane.mode = mode;
					emitState(lane);
					pendingModes.delete(lane.key);
					pendingModes.delete(lane.sessionId);
					return true;
				}
			}
			pendingModes.set(sessionId, mode);
			return true;
		},
		busy(sessionId) {
			for (const lane of lanes.values()) {
				if (lane.key === sessionId || lane.sessionId === sessionId) return lane.running;
			}
			return false;
		},
		dispose() {
			for (const lane of lanes.values()) {
				if (lane.child) {
					try {
						lane.child.kill();
					} catch { /* the close handler settles */ }
				}
			}
		}
	};
}

module.exports = { createSdkHostSource, PERMISSION_MODES, OPEN_TIMEOUT_MS };
