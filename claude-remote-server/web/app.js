/* Claude Remote — the phone app (plan §5). Pairing by the QR's link fragment, one
 * WebSocket to the relay, every payload an end-to-end encrypted frame; the PC's windows
 * answer the same request table the extension's control.js serves. The transcript
 * renderer is a lean port of the 1.x app: tail-first history, lazy tool bodies, the
 * question and permission cards, queue-now / queue-behind sending, model and permission
 * mode picks.
 *
 * Storage note: the paired credentials (device token, the e2e key, the epoch) live in
 * localStorage scoped to the relay's origin — the same confinement IndexedDB would give,
 * one API fewer; "Forget this PC" (the ⋯ menu) clears it. */
"use strict";
(function () {
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const el = (tag, cls, children) => {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		for (const child of children ?? []) if (child != null) node.append(child);
		return node;
	};
	const text = (t) => document.createTextNode(String(t ?? ""));
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const C = window.crrCrypto;

	/* ---------- the pairing state ---------- */

	const state = {
		origin: location.origin,
		userId: location.pathname.split("/").pop() || "",
		K: null,
		linkEpoch: null,
		device: null, // {id, token} once paired
		keys: null, // {kAuth, kE2E}
		epoch: null,
		windows: [],
		windowId: null,
		socket: null,
		online: false,
		backoff: 1000,
		rid: 0,
		pending: new Map(), // rid → {resolve, reject}
		lastSeqByFrom: new Map(),
		seq: 1,
		view: "windows", // windows | sessions | conversation
		session: null, // the conversation's {id, lane, cur, rev, items, hasMore, meta}
		permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"],
		modelChoice: null, // {label, id} — rides the next prompt
		modelsInfo: null,
		dismissedPermissions: new Set(), // sessionId → at, a card the phone declined to show again
		lastCardKey: "", // the pending card as last rendered — unchanged cards do not re-render
		imageCache: new Map(), // ref → data URL
		pullTimer: null
	};

	const store = {
		load() {
			try {
				const raw = localStorage.getItem("crr.device." + state.userId);
				return raw ? JSON.parse(raw) : null;
			} catch { return null; }
		},
		save(value) {
			try { localStorage.setItem("crr.device." + state.userId, JSON.stringify(value)); } catch { /* private mode */ }
		},
		clear() {
			try { localStorage.removeItem("crr.device." + state.userId); } catch { /* nothing */ }
		}
	};

	function parseFragment() {
		const match = location.hash.replace(/^#/, "").match(/^([A-Za-z0-9_-]+)\.(\d+)$/);
		if (match) {
			state.K = C.b64url.toBytes(match[1]);
			state.linkEpoch = Number(match[2]);
			history.replaceState(null, "", location.pathname); // the key leaves the address bar at once
		}
	}

	/* ---------- the wire ---------- */

	async function api(path, body, auth) {
		const response = await fetch(path, {
			method: body !== undefined ? "POST" : "GET",
			headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		const json = await response.json().catch(() => null);
		if (!response.ok) throw new Error((json && json.error) || `HTTP ${response.status}`);
		return json;
	}

	async function pair(password) {
		const keys = state.keys || (state.keys = await C.deriveKeys(state.K));
		const challenge = await api("/api/v1/pair/challenge", { user_id: state.userId });
		const proof = await C.pairProof(keys.kAuth, challenge.nonce, state.userId, challenge.epoch);
		if (challenge.password_required && password == null) {
			return { needsPassword: true };
		}
		const answer = await api("/api/v1/pair", {
			user_id: state.userId,
			nonce: challenge.nonce,
			epoch: challenge.epoch,
			proof,
			password: password || "",
			device_name: navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("Android") ? "Android" : "Phone"
		});
		state.epoch = answer.epoch;
		state.device = { id: answer.device_id, token: answer.device_token };
		store.save({ ...state.device, epoch: state.epoch, K: C.b64url.fromBytes(state.K) });
		return { ok: true };
	}

	/** The stored pairing is gone (the relay's data was reset, the phone revoked, or the
	 *  key rekeyed): stop reconnecting and show the re-pair screen — the QR is the way back. */
	function markPairingLost() {
		state.device = null;
		state.pairingLost = true;
		state.online = false;
		state.windows = [];
		state.session = null;
		state.view = "windows";
		store.clear();
		paint();
	}

	async function connect() {
		if (state.socket) { try { state.socket.close(); } catch { /* already gone */ } }
		// Probe the stored token BEFORE the WebSocket: the browser never shows a failed
		// handshake's status, so a dead token otherwise becomes an invisible reconnect
		// loop that hammers the relay into its lockout ("Unexpected response code: 429").
		if (state.device) {
			const probe = await fetch("/api/v1/device/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ device_token: state.device.token })
			}).catch(() => null);
			if (probe && probe.status === 401) { markPairingLost(); return; }
			if (probe && probe.status === 429) {
				// Honored to the second the relay names — no guesswork hammering.
				const retryAfter = Math.max(1000, Number(probe.headers.get("retry-after") || 0) * 1000 || 30000);
				setTimeout(() => { if (state.device) void connect(); }, retryAfter);
				state.online = false;
				paint();
				return;
			}
		}
		const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/device?token=${encodeURIComponent(state.device.token)}`);
		state.socket = socket;
		socket.onopen = () => {
			state.online = true;
			state.backoff = 1000;
			paint();
		};
		socket.onmessage = (event) => void ingest(event.data);
		socket.onclose = (event) => {
			state.online = false;
			state.socket = null;
			if (event.code === 4401) { // rekeyed or revoked mid-session: the same screen
				markPairingLost();
				return;
			}
			setTimeout(() => { if (state.device) void connect(); }, state.backoff);
			state.backoff = Math.min(state.backoff * 2, 30000);
			paint();
		};
		socket.onerror = () => { try { socket.close(); } catch { /* onclose follows */ } };
	}

	async function ingest(raw) {
		const wire = JSON.parse(raw);
		if (wire.v !== 1) return;
		if (wire.kind === "hello") {
			state.epoch = Number(wire.epoch) || state.epoch;
			return;
		}
		if (wire.kind === "windows") { state.windows = wire.list ?? []; onWindows(); return; }
		if (wire.kind === "kick") { return; }
		if (wire.kind === "frame") {
			const from = wire.from;
			const last = state.lastSeqByFrom.get(from) ?? 0;
			if (Number(wire.seq) <= last) return; // anti-replay
			state.lastSeqByFrom.set(from, Number(wire.seq));
			let plain;
			try {
				plain = await C.openFrame(state.keys.kE2E, { userId: state.userId, epoch: state.epoch, from, to: state.device.id, seq: Number(wire.seq) }, { n: String(wire.ct).split(".")[0], c: String(wire.ct).split(".")[1] });
			} catch (error) {
				console.warn("a frame did not open", error);
				return;
			}
			onPlain(plain);
		}
	}

	function onPlain(plain) {
		if (plain && plain.t === "reply") {
			const waiter = state.pending.get(plain.rid);
			if (waiter) {
				state.pending.delete(plain.rid);
				if (plain.ok) waiter.resolve(plain.r);
				else waiter.reject(new Error(plain.e || "the window refused the request"));
			}
			return;
		}
		if (plain && plain.t === "nudge") { schedulePull(); return; }
		if (plain && plain.t === "tap") {
			// A live permission question wakes the card at once; anything else re-pulls.
			if (plain.event && plain.event.kind === "permission") state.dismissedPermissions.delete(plain.sessionId);
			schedulePull();
			return;
		}
	}

	/** One request to the PC's window, over a sealed frame. */
	async function call(method, params = {}) {
		if (!state.online || !state.socket) throw new Error("not connected");
		const rid = `r${++state.rid}`;
		const envelope = { userId: state.userId, epoch: state.epoch, from: state.device.id, to: state.windowId, seq: ++state.seq };
		const body = await C.sealFrame(state.keys.kE2E, envelope, { rid, ...params, t: method });
		const wire = JSON.stringify({ v: 1, kind: "frame", from: state.device.id, to: state.windowId, seq: envelope.seq, ct: body.n + "." + body.c });
		return new Promise((resolve, reject) => {
			state.pending.set(rid, { resolve, reject });
			state.socket.send(wire);
			setTimeout(() => {
				if (state.pending.has(rid)) {
					state.pending.delete(rid);
					reject(new Error("the window did not answer in time"));
				}
			}, 45000);
		});
	}

	function schedulePull() {
		if (state.pullTimer) return;
		state.pullTimer = setTimeout(() => {
			state.pullTimer = null;
			if (state.view === "sessions") void loadSessions();
			else if (state.view === "conversation") void loadConversation();
		}, 350);
	}

	/* ---------- the views ---------- */

	const view = $("view");
	const topbar = $("topbar");

	function paint() {
		$("bootText").textContent = state.online ? "Claude Remote" : state.online === false ? "Offline — reconnecting" : "Claude Remote";
		$("app").classList.toggle("boot", false);
		topbar.classList.remove("hidden");
		$("backBtn").classList.toggle("hidden", state.view === "windows");
		if (state.view === "windows") renderWindows();
		else if (state.view === "sessions") renderSessions();
		else if (state.view === "conversation") renderConversation();
	}

	function onWindows() {
		// Pick the first online window when none is chosen, and fall back to any.
		if (!state.windowId || !state.windows.some((w) => w.id === state.windowId)) {
			const pick = state.windows.find((w) => w.online) ?? state.windows[0];
			state.windowId = pick ? pick.id : null;
		}
		if (state.view === "windows") renderWindows();
	}

	async function windowName(entry) {
		// The meta blob is a sealed frame body under the broadcast AAD (seq 0).
		try {
			const [n, c] = String(entry.meta_ct ?? "").split(".");
			return await C.openFrame(state.keys.kE2E, { userId: state.userId, epoch: state.epoch, from: entry.id, to: "*", seq: 0 }, { n, c });
		} catch { return { name: "a window" }; }
	}

	async function renderWindows() {
		$("titleText").textContent = "This PC";
		$("subText").textContent = state.online ? `${state.windows.filter((w) => w.online).length} window(s) online` : "offline — reconnecting";
		view.replaceChildren();
		if (state.pairingLost) {
			view.append(el("div", "empty", [text("This PC reset its pairing key (or revoked this phone) — open the Claude Remote panel on the desktop and scan the new QR to pair again.")]));
			return;
		}
		if (!state.windows.length) {
			view.append(el("div", "empty", [text("No window of this PC is online. Open Git Graph Studio or VS Code on the desktop.")]));
			return;
		}
		for (const entry of [...state.windows].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))) {
			const meta = await windowName(entry);
			const row = el("button", "row-card" + (entry.online ? "" : " dim"), [
				el("div", "row-main", [el("div", "row-title", [text(meta.name || "window")]), el("div", "row-sub", [text(`${meta.host || entry.host || ""} · ${entry.online ? "online" : "last seen " + new Date(entry.seen || 0).toLocaleString()}`)])]),
				el("span", "dot" + (entry.online ? " on" : ""), [])
			]);
			row.onclick = () => {
				state.windowId = entry.id;
				state.view = "sessions";
				paint();
				void loadSessions();
			};
			view.append(row);
		}
	}

	async function loadSessions() {
		try {
			const answer = await call("sessions", {});
			if (answer && Array.isArray(answer.permissionModes)) state.permissionModes = answer.permissionModes;
			renderSessionsList(answer);
		} catch (error) {
			view.replaceChildren(el("div", "empty", [text(String(error.message || error))]));
		}
	}

	function renderSessions() {
		$("titleText").textContent = "Conversations";
		$("subText").textContent = state.online ? "the workspace's sessions" : "offline";
		if (!view.querySelector(".list") && !view.querySelector(".empty")) view.replaceChildren(el("div", "list", [el("div", "empty", [text("…")])]));
	}

	function renderSessionsList(answer) {
		const list = el("div", "list");
		if (!answer.sessions.length) list.append(el("div", "empty", [text("No conversations yet. Type below to start one.")]));
		for (const session of answer.sessions) {
			const row = el("button", "row-card", [
				el("div", "row-main", [
					el("div", "row-title", [text(session.title || "Untitled"), session.running || session.desktopBusy ? el("span", "spin", [text(" ⟳")]) : null]),
					el("div", "row-sub", [text(`${session.project || ""}${session.branch ? " · " + session.branch : ""} · ${session.preview || ""}`)])
				])
			]);
			row.onclick = () => {
				state.view = "conversation";
				state.session = { id: session.id, lane: session.lane || session.id, cur: null, rev: null, items: [], hasMore: false, meta: session };
				paint();
				void loadConversation(true);
				void loadModels();
			};
			list.append(row);
		}
		list.append(composer(false));
		view.replaceChildren(list);
	}

	async function loadConversation(fresh = false) {
		const s = state.session;
		if (!s) return;
		try {
			const params = { id: s.lane.startsWith("draft:") ? s.lane : s.id, lane: s.lane, limit: 120 };
			if (!fresh && s.rev) params.rev = s.rev;
			if (!fresh && s.cur) params.cur = s.cur;
			const answer = await call("session", params);
			if (answer.same) {
				// A same-rev poll still updates the meta (the pending permission card
				// lives beside the transcript); the render itself decides whether
				// anything on screen actually changed.
				if (answer.session) s.meta = answer.session;
				renderConversationItems();
				return;
			}
			if (!answer.delta) { s.items = answer.items; s.cur = answer.cur; }
			else if (answer.items.length) {
				const byId = new Map(s.items.map((item) => [item.id, item]));
				for (const item of answer.items) byId.set(item.id, { ...byId.get(item.id), ...item });
				s.items = [...byId.values()].sort((a, b) => (a.q || 0) - (b.q || 0));
				s.cur = answer.cur;
			}
			s.rev = answer.rev;
			s.hasMore = answer.hasMore;
			if (answer.session) s.meta = answer.session;
			if (answer.lane && answer.lane.sessionId) { s.id = answer.lane.sessionId; s.lane = answer.lane.lane || s.lane; }
			renderConversationItems();
		} catch (error) {
			console.warn("the conversation pull failed", error);
		}
	}

	/** The window's model surface — the tiers the next prompt may name. */
	async function loadModels() {
		const s = state.session;
		if (!s) return;
		try {
			state.modelsInfo = await call("models", { id: s.id });
		} catch { /* the pick falls back to the current model */ }
	}

	function renderConversation() {
		$("titleText").textContent = (state.session && state.session.meta && state.session.meta.title) || "Conversation";
		$("subText").textContent = state.session && state.session.meta ? `${state.session.meta.project || ""}${state.session.meta.running ? " · running" : ""}` : "";
	}

	function renderConversationItems() {
		const s = state.session;
		// A re-render rebuilds the composer too — whatever the user is typing survives it.
		const draft = view.querySelector(".compose-input")?.value ?? "";
		const card = s.meta && s.meta.pendingPermission;
		const cardKey = card ? `${card.tool}@${card.at}` : "";
		if (cardKey && cardKey === state.lastCardKey && draft && !s.hasMore) {
			// only the card's own change re-renders; a live draft stays put
			return;
		}
		state.lastCardKey = cardKey;
		const list = el("div", "list");
		if (s.hasMore) {
			const more = el("button", "row-card dim", [el("div", "row-main", [el("div", "row-sub", [text("Load earlier history")])])]);
			more.onclick = () => void loadConversationBefore();
			list.append(more);
		}
		for (const item of s.items) list.append(itemNode(item));
		const pending = s.meta && s.meta.pendingPermission;
		if (pending && !state.dismissedPermissions.has(s.id)) list.append(permissionCard(pending));
		list.append(composer(true));
		view.replaceChildren(list);
		const input = view.querySelector(".compose-input");
		if (input && draft) input.value = draft;
		view.scrollTop = view.scrollHeight;
	}

	async function loadConversationBefore() {
		const s = state.session;
		const oldest = s.items.find((item) => item.q != null);
		if (!oldest) return;
		const answer = await call("session", { id: s.id, lane: s.lane, limit: 120, before: oldest.q });
		s.items = [...answer.items, ...s.items];
		s.hasMore = answer.hasMore;
		renderConversationItems();
	}

	/** One transcript item: user, assistant, thinking, tool, question card, notice. */
	function itemNode(item) {
		if (item.k === "user") {
			return el("div", "msg user", [
				el("div", "bubble", [
					item.chips && item.chips.length ? el("div", "chips", item.chips.map((chip) => el("span", "chip", [text(chip)]))) : null,
					text(item.text)
				])
			]);
		}
		if (item.k === "assistant") return el("div", "msg assistant", [el("div", "bubble", [markdown(item.text)])]);
		if (item.k === "thinking") return el("details", "msg thinking", [el("summary", [], [text("thinking")]), el("div", "bubble", [text(item.text)])]);
		if (item.k === "notice") return el("div", "msg notice", [el("div", "notice-inner " + (item.lvl || ""), [text(item.text)])]);
		if (item.k === "tool") return toolNode(item);
		return el("div", "msg notice", [el("div", "notice-inner", [text(item.k)])]);
	}

	function toolNode(item) {
		const summary = el("div", "row-sub", [text(`${item.name} · ${item.sum || ""}`)]);
		const node = el("details", "msg tool", [el("summary", [], [summary]), el("div", "tool-body", [text("…")])]);
		node.addEventListener("toggle", () => {
			if (!node.open || node.dataset.loaded) return;
			node.dataset.loaded = "1";
			void call("tool", { id: state.session.id, item: item.id }).then((answer) => {
				const body = node.querySelector(".tool-body");
				body.replaceChildren();
				if (answer.body && answer.body.kind === "question") body.append(questionCard(item, answer.body));
				else if (answer.body && answer.body.kind === "todos") body.append(todosCard(answer.body.todos));
				else if (answer.body) body.append(el("pre", "code", [text(answer.body.text ?? JSON.stringify(answer.body, null, 2))]));
				if (answer.res && answer.res.text) {
					const resultBody = el("div", "tool-res" + (answer.res.err ? " err" : ""), [text(answer.res.text)]);
					body.append(resultBody);
					if (answer.res.more) {
						const more = el("button", "linkish", [text("show full result")]);
						more.onclick = () => void call("detail", { id: state.session.id, item: item.id }).then((full) => {
							resultBody.replaceChildren(text(full.text.slice(0, 100_000)), el("button", "linkish", [text("collapse")]));
						}).catch((error) => alert(error.message));
						body.append(more);
					}
				}
				for (const ref of (answer.res && answer.res.imgs) ?? []) body.append(imageNode(ref));
			}).catch(() => body.replaceChildren(text("the body did not load")));
		});
		if (item.st === "run") summary.append(el("span", "spin", [text(" ⟳")]));
		return node;
	}

	/** A result image, fetched lazily into a data URL and cached per ref. */
	function imageNode(ref) {
		const img = el("img", "result-img");
		img.alt = "result image";
		const cached = state.imageCache.get(ref);
		if (cached) img.src = cached;
		else void call("image", { id: state.session.id, ref }).then((answer) => {
			const url = `data:${answer.mime || "image/png"};base64,${answer.data}`;
			state.imageCache.set(ref, url);
			if (state.imageCache.size > 32) state.imageCache.delete(state.imageCache.keys().next().value);
			img.src = url;
		}).catch(() => img.remove());
		return img;
	}

	function todosCard(todos) {
		const wrap = el("div", "todos");
		for (const todo of todos ?? []) wrap.append(el("div", "todo " + (todo.s || ""), [text(`${({ completed: "☑", in_progress: "◐", pending: "☐" })[todo.s] || "☐"} ${todo.t}`)]));
		return wrap;
	}

	/** The AskUserQuestion card: tappable options, multi-select, Other's text, submit. */
	function questionCard(item, body) {
		const card = el("div", "qcard");
		const picks = new Map(); // question index → Set of labels
		for (const [qi, question] of (body.questions ?? []).entries()) {
			picks.set(qi, new Set());
			card.append(el("div", "q-title", [text(question.q)]));
			for (const option of question.opts ?? []) {
				const row = el("button", "q-opt", [el("div", "row-main", [el("div", "row-title", [text(option.label)]), option.desc ? el("div", "row-sub", [text(option.desc)]) : null])]);
				row.onclick = () => {
					const set = picks.get(qi);
					if (question.multi) row.classList.toggle("on") ? set.add(option.label) : set.delete(option.label);
					else {
						card.querySelectorAll(".q-opt").forEach((n) => n.classList.remove("on"));
						set.clear();
						set.add(option.label);
						row.classList.add("on");
					}
				};
				card.append(row);
			}
		}
		const other = el("input", "q-other", []);
		other.placeholder = "Other…";
		const submit = el("button", "btn", [text("Submit answers")]);
		submit.onclick = () => {
			const answers = (body.questions ?? []).map((question, qi) => {
				const labels = [...picks.get(qi)];
				if (other.value.trim()) labels.push("Other");
				return { question: question.q, header: question.header, picks: labels, other: labels.includes("Other") ? other.value.trim() : undefined };
			});
			void call("answer", { id: state.session.id, item: item.id, answers }).then(() => loadConversation(true)).catch((error) => alert(error.message));
		};
		card.append(other, submit);
		return card;
	}

	/** The pending tool-permission card: what the desktop tab is holding the turn for. */
	function permissionCard(pending) {
		const card = el("div", "qcard perm-card");
		card.append(el("div", "q-title", [text(`${pending.tool || "A tool"} asks to run`)]));
		if (pending.summary) card.append(el("pre", "code", [text(pending.summary)]));
		const denyReason = el("input", "q-other", []);
		denyReason.placeholder = "Tell Claude what to do differently (optional)";
		const answer = (decision) => {
			submit.disabled = always.disabled = deny.disabled = true;
			void call("permission", { sessionId: state.session.id, decision, message: decision === "deny" ? denyReason.value.trim() || undefined : undefined })
				.then(() => { state.dismissedPermissions.delete(state.session.id); loadConversation(true); })
				.catch((error) => {
					alert(error.message);
					submit.disabled = always.disabled = deny.disabled = false;
				});
		};
		const row = el("div", "composer-actions");
		const deny = el("button", "btn sec", [text("Deny")]);
		const always = el("button", "btn sec", [text("Always allow")]);
		const submit = el("button", "btn", [text("Allow")]);
		deny.onclick = () => answer("deny");
		always.onclick = () => answer("allowAlways");
		submit.onclick = () => answer("allow");
		row.append(deny, always, submit);
		const dismiss = el("button", "linkish dismiss", [text("answer on the desktop instead")]);
		dismiss.onclick = () => {
			state.dismissedPermissions.add(state.session.id);
			renderConversationItems();
		};
		card.append(denyReason, row, dismiss);
		return card;
	}

	/** A tiny markdown subset: paragraphs, `code`, **bold**, *italic*, links. */
	function markdown(source) {
		const wrap = el("div", "md");
		for (const paragraph of String(source ?? "").split(/\n{2,}/)) {
			const p = el("p", []);
			let rest = esc(paragraph).replace(/\n/g, "<br>");
			rest = rest.replace(/`([^`]+)`/g, "<code>$1</code>")
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				.replace(/\*([^*]+)\*/g, "<em>$1</em>")
				.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
			p.innerHTML = rest;
			wrap.append(p);
		}
		return wrap;
	}

	/** The composer: send now (interrupts) / queue behind, model and mode picks, stop. */
	function composer(forConversation) {
		const input = el("textarea", "compose-input", []);
		input.rows = 1;
		input.placeholder = forConversation ? "Message Claude…" : "Start a conversation…";
		const now = el("button", "btn", [text("Send")]);
		const queue = el("button", "btn sec", [text("Queue")]);
		const stop = el("button", "btn sec", [text("Stop")]);
		const pickRow = el("div", "pick-row");
		const send = (mode) => {
			const textValue = input.value.trim();
			if (!textValue) return;
			input.value = "";
			const params = forConversation
				? { lane: state.session.lane, sessionId: state.session.id, text: textValue, mode }
				: { text: textValue, mode };
			if (state.modelChoice) params.model = state.modelChoice.id;
			void call("send", params)
				.then(() => { if (!forConversation) { state.view = "sessions"; paint(); } schedulePull(); })
				.catch((error) => alert(error.message));
		};
		now.onclick = () => send("now");
		queue.onclick = () => send("queue");
		stop.onclick = () => void call("stop", forConversation ? { lane: state.session.lane, sessionId: state.session.id } : {}).then(() => schedulePull()).catch(() => undefined);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send("queue"); }
		});

		if (forConversation) {
			// The permission mode and the model pick — the conversation's own controls.
			const modeBtn = el("button", "btn sec small", [text("Mode")]);
			modeBtn.onclick = () => sheet(state.permissionModes.map((mode) => ({
				label: mode,
				run: () => void call("mode", { sessionId: state.session.id, mode }).then(() => schedulePull()).catch((error) => alert(error.message))
			})));
			const modelBtn = el("button", "btn sec small", [text(state.modelChoice ? state.modelChoice.label : "Model")]);
			modelBtn.onclick = () => {
				const info = state.modelsInfo;
				const entries = [];
				if (info && info.current) entries.push({ label: `${info.current} (current)`, run: () => { state.modelChoice = null; modelBtn.replaceChildren(text("Model")); } });
				for (const tier of (info && info.tiers) ?? []) {
					if (!tier.resolved) continue;
					entries.push({ label: `${tier.id} → ${tier.resolved}`, run: () => { state.modelChoice = { id: tier.id, label: tier.id }; modelBtn.replaceChildren(text(tier.id)); } });
				}
				if (!entries.length) entries.push({ label: "no model list — the pick rides the tab's current", run: () => undefined });
				sheet(entries);
			};
			pickRow.append(modeBtn, modelBtn);
		}
		return el("div", "composer", [pickRow.childNodes.length ? pickRow : null, input, el("div", "composer-actions", [queue, now, stop])]);
	}

	/** A bottom sheet of tappable entries (mode and model pickers). */
	function sheet(entries) {
		const overlay = el("div", "menu-overlay");
		const panel = el("div", "menu-sheet");
		for (const entry of entries) {
			const row = el("button", "menu-item", [text(entry.label)]);
			row.onclick = () => { overlay.remove(); entry.run(); };
			panel.append(row);
		}
		const cancel = el("button", "menu-item", [text("Cancel")]);
		cancel.onclick = () => overlay.remove();
		panel.append(cancel);
		overlay.append(panel);
		overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
		document.body.append(overlay);
	}

	/* ---------- the menu ---------- */

	$("dotsBtn").onclick = () => {
		const menu = el("div", "menu-overlay");
		const sheetEl = el("div", "menu-sheet", [
			el("button", "menu-item", [text("Refresh")]),
			el("button", "menu-item", [text("Switch window")]),
			el("button", "menu-item danger", [text("Forget this PC")])
		]);
		const [refresh, switchWindow, forget] = sheetEl.querySelectorAll("button");
		refresh.onclick = () => { menu.remove(); schedulePull(); if (state.view === "windows") renderWindows(); };
		switchWindow.onclick = () => { menu.remove(); state.view = "windows"; state.windowId = null; paint(); };
		forget.onclick = () => {
			store.clear();
			state.device = null;
			state.keys = null;
			menu.remove();
			paint();
		};
		menu.append(sheetEl);
		menu.onclick = (event) => { if (event.target === menu) menu.remove(); };
		document.body.append(menu);
	};

	$("backBtn").onclick = () => {
		state.view = state.view === "conversation" ? "sessions" : "windows";
		paint();
		if (state.view === "sessions") void loadSessions();
	};

	/* ---------- boot ---------- */

	async function boot() {
		parseFragment();
		const stored = store.load();
		if (state.K) {
			// A fresh scan: adopt the new key material, pair under it.
			state.pairingLost = false;
			state.keys = await C.deriveKeys(state.K);
			store.save({ ...((stored && stored.epoch === state.linkEpoch) ? { id: stored.id, token: stored.token } : {}), epoch: state.linkEpoch, K: C.b64url.fromBytes(state.K) });
			state.epoch = state.linkEpoch;
			if (stored && stored.epoch === state.linkEpoch && stored.token) {
				state.device = { id: stored.id, token: stored.token };
			} else {
				const result = await pair().catch((error) => ({ error: error.message }));
				if (result.needsPassword) {
					const password = prompt("This PC set a login password — enter it to pair:");
					if (password == null) { paint(); return; }
					await pair(password).catch((error) => { alert(error.message); });
				} else if (result.error) {
					alert(result.error);
				}
			}
		} else if (stored && stored.K && stored.token) {
			// A returning visit: the stored pairing carries.
			state.K = C.b64url.toBytes(stored.K);
			state.keys = await C.deriveKeys(state.K);
			state.epoch = stored.epoch;
			state.device = { id: stored.id, token: stored.token };
		} else {
			view.replaceChildren(el("div", "empty", [text("Open the pairing link from this PC's Claude Remote panel (or scan its QR) to pair this phone.")]));
			return;
		}
		if (!state.device) {
			view.replaceChildren(el("div", "empty", [text("Pairing did not complete — open the link again.")]));
			return;
		}
		await connect();
		// The windows list rides the socket's hello; a periodic nudge keeps presence fresh.
		setInterval(() => { if (state.online && state.socket) state.socket.send(JSON.stringify({ v: 1, kind: "windows" })); }, 30000);
		// One pull cadence, dense while a conversation is open (live turns), sparse on
		// the lists, never on the picker — nudges from the window wake it in between.
		setInterval(() => { if (state.view === "conversation") schedulePull(); }, 4000);
		setInterval(() => { if (state.view === "sessions") schedulePull(); }, 8000);
		paint();
	}

	void boot();
})();
