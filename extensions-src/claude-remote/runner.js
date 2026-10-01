"use strict";
/* The remote turns. Two backends:
 *   - injected (Git Graph Studio): the prompt is typed into the conversation's Claude Code
 *     tab and sent from there (the host's `ggs.claudeChat.*`), so the desktop runs the turn
 *     as its own — same tab, model, permission mode — and the session file the phone reads
 *     is the one that tab writes. Desktop and phone never diverge.
 *   - headless (VS Code, which cannot reach another extension's page): the desktop's own
 *     `claude` CLI (`-p --output-format stream-json --verbose`, the prompt on stdin so no
 *     shell ever re-parses it), resuming the session under the config root it lives in.
 *
 * One lane per conversation serializes its turns. A prompt is either
 *   - "now":   starts immediately — a turn this lane is running is interrupted first
 *              (Claude Code's own Esc-then-send), and
 *   - "queue": waits for the current turn to finish — the lane's own run, or a turn the
 *              desktop is visibly in the middle of — then starts, in order.
 * Stopping a lane interrupts its run and pauses its queue (nothing fires behind the
 * user's back); the next send or an explicit resume releases it. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TURN_TIMEOUT_MS = 60 * 60 * 1000;
const TICK_MS = 1000;
const MAX_QUEUE = 20;
const MAX_PROMPT_CHARS = 100_000;
// "default" passes no flag: the CLI then applies the settings' own default mode (this CLI has no
// "default" choice — passing it fails every turn).
const PERMISSION_MODES = ["default", "auto", "acceptEdits", "plan", "bypassPermissions"];
const INJECT_POLL_MS = 1000;
// A sent prompt whose turn never shows (a slash command answered locally) counts as done.
const INJECT_QUIET_MS = 15_000;
const INJECT_OPEN_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `claude` binary the desktop uses: explicit override, the Claude Code extension's
 *  bundled native binary (newest version first, GGS's and VS Code's extension dirs), PATH. */
function claudeCliPath(env = process.env) {
	if (env.CLAUDE_CLI_PATH) return env.CLAUDE_CLI_PATH;
	const home = os.homedir();
	const dirs = [".ggs/extensions", ".vscode/extensions", ".vscode-insiders/extensions", ".cursor/extensions", ".windsurf/extensions"].map((d) => path.join(home, d));
	const exe = process.platform === "win32" ? "claude.exe" : "claude";
	const versionOf = (name) => (name.match(/-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
	const newer = (a, b) => {
		const va = versionOf(a), vb = versionOf(b);
		for (let i = 0; i < 3; i++) if ((va[i] || 0) !== (vb[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
		return 0;
	};
	for (const dir of dirs) {
		let entries = [];
		try { entries = fs.readdirSync(dir).filter((e) => /^anthropic\.claude-code-/i.test(e)).sort(newer); } catch { continue; }
		for (const entry of entries) {
			for (const candidate of [
				path.join(dir, entry, "resources", "native-binary", exe),
				path.join(dir, entry, "resources", exe),
				path.join(dir, entry, exe)
			]) {
				try {
					if (fs.statSync(candidate).isFile()) return candidate;
				} catch { /* next */ }
			}
		}
	}
	return "claude";
}

let serial = 0;
const nextId = (prefix) => prefix + Date.now().toString(36) + (++serial).toString(36);

class Runner {
	/**
	 * @param {{ cliPath?: string, defaultRoot?: () => string | null, externalBusy?: (sessionId: string) => boolean, onChange?: () => void, log?: (line: string) => void, spawn?: Function }} options
	 */
	constructor(options = {}) {
		this.cliPath = options.cliPath || claudeCliPath();
		this.defaultRoot = options.defaultRoot || (() => null);
		this.externalBusy = options.externalBusy || (() => false);
		this.onChange = options.onChange || (() => {});
		// Turn lifecycle for the desktop side (the extension opens and reloads the session's
		// Claude Code tab): ("start" | "session" | "end", { sessionId, status }).
		this.onTurn = options.onTurn || (() => {});
		this.log = options.log || (() => {});
		this.spawnImpl = options.spawn || require("child_process").spawn;
		// { send({ sessionId, text, interrupt }) → { ticket }, state({ ticket }) → { phase, error,
		//   sessionId, open, busy }, stop({ ticket }) } — the injected backend, when the host has it
		this.injector = options.injector || null;
		this.pollMs = options.pollMs || INJECT_POLL_MS;
		this.lanes = new Map(); // lane key → lane
		this.aliases = new Map(); // session id → lane key
		this.activity = []; // recent events for the desktop panel
		this.version = 0;
		this.timer = setInterval(() => this.tick(), TICK_MS);
		if (this.timer && this.timer.unref) this.timer.unref();
	}

	dispose() {
		clearInterval(this.timer);
		this.disposed = true;
		// a turn typed into the desktop tab belongs to the desktop now: it keeps running
		for (const lane of this.lanes.values()) if (lane.running && !lane.running.injected) this.kill(lane.running);
	}

	changed(event) {
		this.version++;
		if (event) {
			this.activity.unshift({ at: Date.now(), ...event });
			this.activity.length = Math.min(this.activity.length, 40);
		}
		try { this.onChange(); } catch { /* listener failures never break a run */ }
	}

	laneFor(sessionId, draftId) {
		const key = sessionId ? this.aliases.get(sessionId) || sessionId : "draft:" + String(draftId || nextId("d"));
		let lane = this.lanes.get(key);
		if (!lane) {
			lane = { key, sessionId: sessionId || null, cwd: null, root: null, title: null, running: null, queue: [], paused: false, last: null, sent: [] };
			this.lanes.set(key, lane);
			if (sessionId) this.aliases.set(sessionId, key);
		}
		return lane;
	}

	findLane(key) {
		if (!key) return null;
		return this.lanes.get(key) || this.lanes.get(this.aliases.get(key)) || null;
	}

	/**
	 * Submit a prompt. `sessionId` continues a conversation (its `cwd`/`root` come from the
	 * store); without it a new conversation starts in `cwd`, tracked under `draftId`.
	 */
	send({ sessionId = null, draftId = null, cwd, root = null, title = null, text, mode = "queue", permissionMode = "default", model = null, device = null }) {
		const prompt = String(text ?? "").trim();
		if (!prompt) throw new Error("empty prompt");
		if (prompt.length > MAX_PROMPT_CHARS) throw new Error("prompt too long");
		if (!cwd || !fs.existsSync(cwd)) throw new Error("working directory not found: " + cwd);
		const lane = this.laneFor(sessionId, draftId);
		lane.cwd = cwd;
		lane.root = root || lane.root || this.defaultRoot();
		if (title) lane.title = title;
		if (lane.queue.length >= MAX_QUEUE) throw new Error("queue is full");
		const entry = {
			id: nextId("q"),
			text: prompt,
			mode: mode === "now" ? "now" : "queue",
			permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : "default",
			model: typeof model === "string" && /^[\w.\-[\]:/]{1,80}$/.test(model) ? model : null,
			device,
			at: Date.now()
		};
		lane.paused = false;
		if (entry.mode === "now") {
			lane.queue.unshift(entry);
			if (lane.running) this.interrupt(lane, "superseded");
			else this.startNext(lane, true);
		} else {
			lane.queue.push(entry);
			this.tickLane(lane);
		}
		this.changed({ kind: "send", mode: entry.mode, device, title: lane.title, text: prompt.slice(0, 80) });
		return { lane: lane.key, entry: entry.id, started: lane.running && lane.running.entry.id === entry.id };
	}

	stop(key) {
		const lane = this.findLane(key);
		if (!lane) return false;
		lane.paused = lane.queue.length > 0;
		if (lane.running) this.interrupt(lane, "stopped");
		this.changed({ kind: "stop", title: lane.title });
		return true;
	}

	resume(key) {
		const lane = this.findLane(key);
		if (!lane) return false;
		lane.paused = false;
		this.tickLane(lane);
		this.changed();
		return true;
	}

	cancel(key, entryId) {
		const lane = this.findLane(key);
		if (!lane) return false;
		const before = lane.queue.length;
		lane.queue = lane.queue.filter((e) => e.id !== entryId);
		if (!lane.queue.length) lane.paused = false;
		this.changed();
		return lane.queue.length !== before;
	}

	/** A queued prompt jumps the line and interrupts the running turn. */
	promote(key, entryId) {
		const lane = this.findLane(key);
		if (!lane) return false;
		const at = lane.queue.findIndex((e) => e.id === entryId);
		if (at < 0) return false;
		const [entry] = lane.queue.splice(at, 1);
		entry.mode = "now";
		lane.queue.unshift(entry);
		lane.paused = false;
		if (lane.running) this.interrupt(lane, "superseded");
		else this.startNext(lane, true);
		this.changed();
		return true;
	}

	tick() {
		for (const lane of this.lanes.values()) this.tickLane(lane);
	}

	tickLane(lane) {
		if (lane.running || lane.paused || !lane.queue.length) return;
		const head = lane.queue[0];
		if (head.mode !== "now" && lane.sessionId && this.externalBusy(lane.sessionId)) return;
		this.startNext(lane, false);
	}

	startNext(lane, force) {
		if (lane.running || !lane.queue.length) return;
		if (!force && lane.paused) return;
		const entry = lane.queue.shift();
		if (this.injector) {
			this.startInjected(lane, entry);
			return;
		}
		const args = ["-p", "--output-format", "stream-json", "--verbose"];
		if (entry.permissionMode !== "default") args.push("--permission-mode", entry.permissionMode);
		if (entry.model) args.push("--model", entry.model);
		if (lane.sessionId) args.push("--resume", lane.sessionId);
		const env = { ...process.env };
		if (lane.root) env.CLAUDE_CONFIG_DIR = lane.root;
		let command = this.cliPath;
		let argv = args;
		let shell = false;
		if (/\.(c|m)?js$/i.test(command)) {
			argv = [command, ...args];
			command = process.execPath;
		} else if (process.platform === "win32" && !path.isAbsolute(command)) {
			shell = true; // `claude` on PATH is an npm .cmd shim
		}
		const run = {
			id: nextId("r"),
			entry,
			startedAt: Date.now(),
			status: "running",
			child: null,
			stopReason: null,
			result: null,
			error: null,
			costUsd: null,
			model: null
		};
		lane.running = run;
		lane.sent.push(entry.text);
		if (lane.sent.length > 100) lane.sent.shift();
		this.log(`run ${run.id} in ${lane.cwd}${lane.sessionId ? " resume " + lane.sessionId : " (new)"} [${entry.permissionMode}]`);
		let child;
		try {
			child = this.spawnImpl(command, argv, { cwd: lane.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell, windowsHide: true });
		} catch (error) {
			this.finish(lane, run, "error", "spawn failed: " + (error && error.message || error));
			return;
		}
		run.child = child;
		let buffer = "";
		let stderr = "";
		const onLine = (line) => {
			if (!line.trim()) return;
			let event;
			try { event = JSON.parse(line); } catch { return; }
			if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
				run.model = event.model;
				this.changed();
			}
			if (event.session_id && !lane.sessionId) {
				lane.sessionId = event.session_id;
				this.aliases.set(event.session_id, lane.key);
				this.changed({ kind: "session", title: lane.title });
				this.turn("session", lane, run);
			}
			if (event.type === "result") {
				run.result = typeof event.result === "string" ? event.result : null;
				run.costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
				if (event.is_error || (event.subtype && event.subtype !== "success")) run.error = run.result || event.subtype || "error";
			}
		};
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let nl;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				onLine(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
			}
		});
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
		child.on("error", (error) => this.finish(lane, run, "error", "spawn failed: " + (error && error.message || error)));
		child.on("close", (code) => {
			if (buffer.trim()) onLine(buffer);
			if (run.stopReason) this.finish(lane, run, "interrupted", null);
			else if (run.error) this.finish(lane, run, "error", run.error);
			else if (code !== 0 && code !== null) this.finish(lane, run, "error", "claude exited " + code + (stderr.trim() ? ": " + stderr.trim().split("\n").slice(-3).join(" ") : ""));
			else this.finish(lane, run, "done", null);
		});
		run.timer = setTimeout(() => this.interrupt(lane, "timeout"), TURN_TIMEOUT_MS);
		try {
			child.stdin.on && child.stdin.on("error", () => {});
			child.stdin.write(entry.text);
			child.stdin.end();
		} catch { /* the close handler reports it */ }
		this.changed({ kind: "start", title: lane.title, text: entry.text.slice(0, 80), device: entry.device });
		if (lane.sessionId) this.turn("start", lane, run);
	}

	/** The injected turn: type it into the desktop tab, then follow the tab until it settles. */
	startInjected(lane, entry) {
		const run = {
			id: nextId("r"),
			entry,
			injected: true,
			startedAt: Date.now(),
			status: "running",
			child: null,
			stopReason: null,
			result: null,
			error: null,
			costUsd: null,
			model: null,
			ticket: null
		};
		lane.running = run;
		lane.sent.push(entry.text);
		if (lane.sent.length > 100) lane.sent.shift();
		this.log(`inject ${run.id} into ${lane.sessionId ? "session " + lane.sessionId : "a new conversation"}`);
		this.changed({ kind: "start", title: lane.title, text: entry.text.slice(0, 80), device: entry.device });
		run.timer = setTimeout(() => this.interrupt(lane, "timeout"), TURN_TIMEOUT_MS);
		void this.followInjected(lane, run).catch((error) => this.finish(lane, run, "error", String(error && error.message || error)));
	}

	async followInjected(lane, run) {
		// The phone's model pick rides along: the host picks it in the tab's own model
		// picker before typing (startNext's CLI branch passes the same entry.model as --model).
		const { ticket } = await this.injector.send({ sessionId: lane.sessionId, text: run.entry.text, interrupt: run.entry.mode === "now", model: run.entry.model || null });
		run.ticket = ticket;
		let sentAt = null;
		let seenBusy = false;
		while (run.status === "running" && !this.disposed) {
			await sleep(this.pollMs);
			if (run.status !== "running") return;
			let state;
			try { state = await this.injector.state({ ticket }); } catch { continue; }
			if (state.sessionId && !lane.sessionId) {
				lane.sessionId = state.sessionId;
				this.aliases.set(state.sessionId, lane.key);
				this.changed({ kind: "session", title: lane.title });
				this.turn("session", lane, run);
			}
			if (state.phase === "error") { this.finish(lane, run, "error", state.error || "the desktop chat failed"); return; }
			if (state.phase !== "sent") {
				if (Date.now() - run.startedAt > INJECT_OPEN_MS) this.finish(lane, run, "error", "the Claude Code tab did not take the prompt");
				continue;
			}
			if (sentAt === null) { sentAt = Date.now(); this.changed(); }
			const fileBusy = lane.sessionId ? this.externalBusy(lane.sessionId) : false;
			if (state.busy || fileBusy) seenBusy = true;
			// the tab's own view of the turn, else (tab closed) the session file's
			const tabQuiet = state.busy === false || (state.busy === null && !state.open);
			if (!tabQuiet || fileBusy) continue;
			if (run.stopReason) { this.finish(lane, run, "interrupted", null); return; }
			if (seenBusy || Date.now() - sentAt > INJECT_QUIET_MS) { this.finish(lane, run, "done", null); return; }
		}
	}

	turn(phase, lane, run) {
		// the next queued prompt starting right after must not race the reload of the tab
		const next = phase === "end" && lane.queue.length > 0 && !lane.paused;
		try { this.onTurn(phase, { sessionId: lane.sessionId, status: run.status, moreQueued: next, injected: !!run.injected }); } catch { /* desktop sync is best effort */ }
	}

	interrupt(lane, reason) {
		const run = lane.running;
		if (!run) return;
		run.stopReason = reason;
		this.kill(run);
	}

	kill(run) {
		if (run.injected) {
			// the tab's own stop; the follower settles the run once the tab is quiet
			if (run.ticket && this.injector) Promise.resolve(this.injector.stop({ ticket: run.ticket })).catch(() => {});
			return;
		}
		const child = run.child;
		if (!child) return;
		if (process.platform === "win32" && child.pid) {
			// The CLI's own children (shells, tools) die with it: /T kills the tree.
			try { this.spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch { /* fall through */ }
		}
		try { child.kill(); } catch { /* already gone */ }
	}

	finish(lane, run, status, error) {
		if (run.status !== "running") return;
		clearTimeout(run.timer);
		run.status = status;
		run.error = error;
		run.endedAt = Date.now();
		if (lane.running === run) lane.running = null;
		lane.last = { status, error, endedAt: run.endedAt, costUsd: run.costUsd, reason: run.stopReason, model: run.model };
		if (lane.sessionId) this.turn("end", lane, run);
		this.log(`run ${run.id} ${status}${error ? ": " + error : ""}`);
		this.changed({ kind: status, title: lane.title, error: error ? String(error).slice(0, 200) : undefined });
		// the next queued prompt (a "now" one already sits at the head)
		setTimeout(() => this.tickLane(lane), 0);
	}

	/** What a phone sees of a lane (or null when nothing was ever sent to it). */
	laneState(key) {
		const lane = this.findLane(key);
		if (!lane) return null;
		return {
			lane: lane.key,
			sessionId: lane.sessionId,
			cwd: lane.cwd,
			running: lane.running ? { id: lane.running.id, text: lane.running.entry.text, startedAt: lane.running.startedAt, mode: lane.running.entry.mode, model: lane.running.model || lane.running.entry.model } : null,
			queue: lane.queue.map((e) => ({ id: e.id, text: e.text, mode: e.mode, at: e.at })),
			paused: lane.paused,
			last: lane.last
		};
	}

	sentTexts(key) {
		const lane = this.findLane(key);
		return lane ? lane.sent : [];
	}

	summary() {
		let running = 0, queued = 0;
		for (const lane of this.lanes.values()) {
			if (lane.running) running++;
			queued += lane.queue.length;
		}
		return { running, queued, activity: this.activity.slice(0, 20) };
	}
}

module.exports = { Runner, claudeCliPath, PERMISSION_MODES };
