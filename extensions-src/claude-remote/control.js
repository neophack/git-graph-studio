"use strict";
/* The phone's commands answered in this window (plan §4.3): every inner-protocol
 * request a paired phone sends lands here, and every answer rides the relay back.
 * Control always travels the extension's own UI path where there is one — on Git Graph
 * Studio the prompts are typed into the conversation's Claude Code tab (the desktop and
 * the phone never diverge); where there is no tab to drive (VS Code, or a conversation
 * the desktop has not opened), the sdkHost source runs the turn itself.
 *
 * The read side is the conversation store (sessions.js, unchanged): the session list,
 * the tail-first transcript windows and the lazy tool fetches the old LAN server served
 * over its sealed RPC — the same shapes, over the relay's frames now. */

const path = require("path");
const sessions = require("./sessions.js");

const MAX_PROMPT_CHARS = 100_000;

/**
 * @param {{ log, onChange, folders: () => {name: string, path: string}[],
 *           runner: import('./runner.js').Runner, sdkHost, tap: { send, open, stopTurn, state, answer, permission, mode } | null,
 *           desktopTabs: () => Iterable<string>, openDesktopTab?: (sessionId: string) => Promise<void>,
 *           answerQuestion?: (arg) => Promise<unknown>, official }} options
 */
function createControl(options) {
	const log = options.log || (() => {});
	const runner = options.runner;
	const sdkHost = options.sdkHost;
	const tap = options.tap;

	const workspaceFolders = () => (options.folders() || []).filter((f) => f && f.path);
	const folderPaths = () => workspaceFolders().map((f) => f.path);

	const shownModel = (id, cwd) => (id == null ? null : sessions.resolveModelName(id, { cwd: cwd || undefined }));

	const currentModel = (cwd, root, sessionModel) => {
		const recent = sessions.listSessions({ folders: cwd ? [cwd] : folderPaths() })[0];
		const info = sessions.modelInfo({ root: root || sessions.claudeRoot(), cwd, fallback: recent && recent.model });
		return { ...info, session: sessionModel || null };
	};

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

	const desktopTabs = () => {
		try {
			return new Set(options.desktopTabs ? options.desktopTabs() || [] : []);
		} catch {
			return new Set();
		}
	};

	const laneView = (key) => {
		const lane = runner.laneState(key);
		if (!lane) return lane;
		return {
			...lane,
			running: lane.running ? { ...lane.running, model: shownModel(lane.running.model, lane.cwd) } : null,
			last: lane.last ? { ...lane.last, model: shownModel(lane.last.model, lane.cwd) } : null
		};
	};

	/** A tool row as it syncs: the summary line only (the body and result text ride the
	 *  lazy `tool` fetch), except a question — its options must already be on the phone. */
	const lazyTool = (item) => item.k !== "tool" ? item : {
		...item,
		body: !item.body ? item.body : item.body.kind === "question" ? item.body : { kind: item.body.kind },
		res: item.res ? { more: item.res.more || undefined, err: item.res.err || undefined, imgs: item.res.imgs && item.res.imgs.length ? item.res.imgs : undefined } : item.res
	};

	/* ---------- where a prompt runs: the tab where there is one, the sdkHost else ---------- */

	/** Whether the conversation's tab is up on the desktop — informational (the panel
	 *  and the phone's "on desktop" marker); routing itself is tap-first. */
	function hasTab(sessionId) {
		return !!tap && !!sessionId && desktopTabs().has(sessionId);
	}

	function sendPrompt(p) {
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
			cwd = laneState.cwd;
		} else {
			const wanted = p.cwd ? String(p.cwd) : folderPaths()[0];
			const allowed = folderPaths();
			if (!wanted || (allowed.length && !allowed.some((f) => sessions.samePathKey(f) === sessions.samePathKey(wanted)))) {
				throw Object.assign(new Error("choose an open workspace folder"), { status: 400 });
			}
			cwd = wanted;
			title = text.trim().split("\n")[0].slice(0, 60);
		}
		if (text.trim().length > MAX_PROMPT_CHARS) throw Object.assign(new Error("prompt too long"), { status: 400 });

		// Git Graph Studio: the turn ALWAYS runs in the conversation's Claude Code tab —
		// the host's send opens (or reveals) the session's tab when it is not up, a new
		// conversation opens a fresh one — so the desktop shows the turn as its own and
		// the session file the phone reads is the one that tab writes. A second CLI here
		// would branch the conversation history under the desktop's feet.
		if (tap) {
			const arg = { sessionId: sessionId || undefined, text, interrupt: p.mode === "now", model: p.model || null };
			void tap.send(arg).catch((error) => log(`the desktop tab turn failed: ${error && error.message}`));
			return { lane: sessionId || `tab:${text.trim().slice(0, 24)}`, sessionId, started: true, via: "tab" };
		}
		// No tab surface to drive (VS Code, or the headless backend): this window runs
		// the turn itself, and the queue lane is the last resort.
		const result = sdkHost ? sdkHost.send({
			sessionId, draftId: laneState ? String(p.lane).replace(/^draft:/, "") : p.draftId,
			cwd, root, text, mode: p.mode, permissionMode: p.permissionMode, model: p.model
		}) : null;
		if (result) return { ...result, via: "sdk" };
		return runner.send({ sessionId, draftId: laneState ? String(p.lane).replace(/^draft:/, "") : p.draftId, cwd, root, title, text, mode: p.mode, permissionMode: p.permissionMode, model: p.model });
	}

	/* ---------- the request table the phone speaks ---------- */

	const methods = {
		hello() {
			return {
				t: "hello",
				host: tap ? "ggs" : "vscode",
				capabilities: {
					tab: !!tap,
					sdk: !!sdkHost,
					official: options.official ? options.official.supported() : false
				},
				folders: workspaceFolders(),
				roots: sessions.claudeRoots(),
				permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"]
			};
		},
		sessions(p) {
			const scope = p.scope === "all" || !folderPaths().length ? null : folderPaths();
			const list = sessions.listSessions({ folders: scope, query: p.q });
			const limit = Math.max(10, Math.min(500, Number(p.limit) || 200));
			const drafts = [];
			for (const lane of runner.lanes.values()) {
				if (lane.key.startsWith("draft:") && (!lane.sessionId || !list.some((s) => s.id === lane.sessionId))) {
					drafts.push({ id: lane.sessionId || lane.key, lane: lane.key, draft: true, title: lane.title || "New conversation", cwd: lane.cwd, project: lane.cwd ? path.basename(lane.cwd) : "", preview: "", mtimeMs: Date.now(), running: !!lane.running, queued: lane.queue.length, desktopBusy: false });
				}
			}
			return { t: "sessions", scope: scope ? "workspace" : "all", sessions: [...drafts, ...list.slice(0, limit).map(sessionView)], total: list.length, version: runner.version };
		},
		session(p) {
			const laneKey = String(p.lane || p.id || "");
			const laneState = runner.laneState(laneKey);
			const sessionId = laneState && laneState.sessionId ? laneState.sessionId : laneKey.startsWith("draft:") ? null : laneKey;
			const s = sessionId ? sessions.findSession(sessionId) : null;
			if (!s) {
				if (laneState) return { t: "session", draft: true, id: laneKey, lane: laneView(laneKey), items: [], rev: "draft:" + runner.version, total: 0, hasMore: false };
				throw Object.assign(new Error("no such conversation"), { status: 404 });
			}
			const state = sessions.readTranscript(s.file);
			const before = p.before != null && Number.isFinite(Number(p.before)) ? Number(p.before) : null;
			const rev = `${state.size}:${state.mtimeMs}:${runner.version}:${Number(p.limit) || 0}:${before || 0}`;
			const lane = laneView(s.id);
			const meta = { ...sessionView(s), midTurn: undefined, model: shownModel(state.model || s.model, s.cwd), pendingPermission: options.pendingPermission ? options.pendingPermission(s.id) : null };
			if (p.rev === rev) return { t: "session", same: true, rev, lane, session: meta, cur: { gen: state.gen, since: state.seq } };
			const since = p.cur && p.cur.gen === state.gen && Number.isFinite(Number(p.cur.since)) ? Number(p.cur.since) : null;
			const window = sessions.transcriptWindow(state, { limit: p.limit, since, before });
			const sent = new Set(runner.sentTexts(s.id).map((t) => t.trim()));
			const items = window.items.map((item) => (item.k === "user" && sent.has(item.text.trim()) ? { ...item, remote: true } : item)).map(lazyTool);
			return {
				t: "session", id: s.id, session: meta, items, total: window.total, hasMore: window.hasMore,
				desktopBusy: sessions.desktopBusy({ ...s, midTurn: window.midTurn, mtimeMs: state.mtimeMs }),
				lane, rev, cur: window.cur, delta: window.delta
			};
		},
		models(p) {
			const s = p.id ? sessions.findSession(p.id) : null;
			const model = s ? sessions.readTranscript(s.file).model || s.model : null;
			return { t: "models", ...currentModel(s ? s.cwd : p.cwd || null, s ? s.root : null, model) };
		},
		tool(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const state = sessions.readTranscript(s.file);
			const item = state.items.find((it) => it.id === String(p.item || "") && it.k === "tool");
			if (!item) throw Object.assign(new Error("no such item"), { status: 404 });
			return { t: "tool", body: item.body || null, res: item.res || null };
		},
		detail(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const text = sessions.readTranscript(s.file).fullResults.get(String(p.item || ""));
			if (text === undefined) throw Object.assign(new Error("no such item"), { status: 404 });
			return { t: "detail", text };
		},
		image(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			const img = sessions.readTranscript(s.file).images.get(String(p.ref || ""));
			if (!img) throw Object.assign(new Error("no such image"), { status: 404 });
			return { t: "image", ...img };
		},
		send(p) {
			const result = sendPrompt(p);
			return { t: "send", ...result, state: laneView(result.lane) };
		},
		stop(p) {
			const key = String(p.lane || "");
			const lane = runner.laneState(key);
			const sessionId = p.sessionId && typeof p.sessionId === "string" ? p.sessionId : (lane && lane.sessionId) || (!key.startsWith("draft:") && !key.startsWith("tab:") ? key : null);
			if (tap) {
				// The turn lives in the conversation's tab: its own Stop is what
				// interrupts it, exactly as the desktop user's Esc would.
				void tap.stopTurn({ sessionId: sessionId || undefined }).catch(() => undefined);
				return { t: "stop", ok: true, state: laneView(key) };
			}
			const stopped = sdkHost ? sdkHost.interrupt(lane ? lane.sessionId : sessionId) : false;
			return { t: "stop", ok: stopped || runner.stop(key), state: laneView(key) };
		},
		resume(p) {
			return { t: "resume", ok: runner.resume(String(p.lane || "")), state: laneView(String(p.lane || "")) };
		},
		cancel(p) {
			return { t: "cancel", ok: runner.cancel(String(p.lane || ""), String(p.entry || "")), state: laneView(String(p.lane || "")) };
		},
		promote(p) {
			return { t: "promote", ok: runner.promote(String(p.lane || ""), String(p.entry || "")), state: laneView(String(p.lane || "")) };
		},
		async openOnDesktop(p) {
			const s = sessions.findSession(p.id);
			if (!s) throw Object.assign(new Error("no such conversation"), { status: 404 });
			if (!options.openDesktopTab) throw new Error("not available on this host");
			await options.openDesktopTab(s.id);
			return { t: "openOnDesktop", ok: true };
		},
		async answer(p) {
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
				return { question: question.q, header: question.header, multi: question.multi, picks, other: picks.includes("Other") ? other : undefined };
			});
			if (!options.answerQuestion) throw new Error("answering questions needs the desktop's Claude Code tab");
			await options.answerQuestion({ sessionId: s.id, item: item.id, answers });
			runner.changed({ kind: "answer", title: s.title, text: answers.map((a) => a.picks.join(", ")).join(" · ").slice(0, 80) });
			return { t: "answer", ok: true };
		},
		/** The phone's permission card: the tab's own card where there is one, the SDK
		 *  control_response where this window runs the turn. */
		async permission(p) {
			const decision = p.decision === "allowAlways" ? "allowAlways" : p.decision === "allow" ? "allow" : p.decision === "deny" ? "deny" : null;
			if (!decision) throw Object.assign(new Error("the decision must be allow, allowAlways or deny"), { status: 400 });
			if (!tap && sdkHost) {
				const ok = sdkHost.permission(p.sessionId, { decision, message: p.message });
				if (ok) options.onPermissionAnswered?.(p.sessionId);
				return { t: "permission", ok };
			}
			if (!tap) throw new Error("answering permissions needs the desktop's Claude Code tab");
			await tap.permission({ sessionId: p.sessionId, decision, message: p.message });
			options.onPermissionAnswered?.(p.sessionId);
			return { t: "permission", ok: true };
		},
		async mode(p) {
			const mode = String(p.mode || "");
			// The tab's own mode selector where there is one; the sdk host's next-turn
			// mode where this window runs the turns (a lane-less conversation's pick is
			// remembered for its first turn).
			if (tap) {
				await tap.mode({ sessionId: p.sessionId, mode });
				return { t: "mode", ok: true };
			}
			if (sdkHost) return { t: "mode", ok: sdkHost.setMode(p.sessionId, mode) };
			throw new Error("switching the permission mode needs the desktop's Claude Code tab");
		},
		async model(p) {
			// The model pick rides the prompt (pickChatModel in the tab's own picker).
			return { t: "model", ok: true, note: "the model pick rides the next prompt" };
		},
		/** The conversation's official Remote Control, read or toggled (GGS only). */
		async official(p) {
			if (!options.official) throw new Error("no official remote control on this host");
			if (p.enable === undefined) return { t: "official", ...(await options.official.state(p.sessionId)) };
			return { t: "official", ...(await options.official.toggle(p.sessionId, p.enable === true)) };
		},
		forget() {
			return { t: "forget", ok: true };
		}
	};

	// The methods that act on the desktop. Everything else (sessions, transcripts, the
	// lazy fetches, the official reads) is exactly what a read-only mirror serves.
	const CONTROL_METHODS = new Set(["send", "stop", "resume", "cancel", "promote", "answer", "permission", "mode", "model", "openOnDesktop"]);

	/** Answer one inner-protocol request; `{t:…}` answers, throws carry {status,message}. */
	async function dispatch(plain) {
		const name = plain && typeof plain.t === "string" ? plain.t : "";
		const method = Object.prototype.hasOwnProperty.call(methods, name) ? methods[name] : null;
		if (!method) throw Object.assign(new Error("unknown method"), { status: 404 });
		if (CONTROL_METHODS.has(name) && options.controlAllowed && !options.controlAllowed()) {
			throw Object.assign(new Error("the self-hosted phone is read-only while the official Remote Control carries this PC (claudeRemote.mirrorControl lets it drive)"), { status: 403 });
		}
		return method.call(methods, plain && typeof plain === "object" ? plain : {});
	}

	return { dispatch, methods, sessionView, laneView, sendPrompt, hasTab };
}

module.exports = { createControl, MAX_PROMPT_CHARS };
