/* Claude Remote — the phone app. Pairing by the QR's link fragment, one WebSocket to the
 * relay, and the PC's windows answering the request table the extension's control.js
 * serves: the window list → a window's conversations (this workspace or all, searchable)
 * → one conversation, its history read from the PC's session store (tail first, earlier
 * pages on demand, tool bodies lazily) and its turns watched LIVE as the CLI's own SDK
 * messages — the same content the /remote-control bridge carries (stream deltas typing
 * in place, tool calls, results). A new conversation starts from the list: the PC adopts
 * the conversation id the turn creates and the stream follows it.
 *
 * Frame bodies cross through `codec` — plain today (`p.` + base64url JSON); encryption
 * returns there and nowhere else.
 *
 * Storage: the paired device token lives in localStorage scoped to the relay's origin;
 * "Forget this PC" (⋯) clears it.
 *
 * Local debug mode: the extension serves this same page on 127.0.0.1 (the panel's debug
 * link) with `window.CRR_LOCAL = {base, device}` — no pairing, and the relay's messages
 * arrive over the window's own long-poll pair instead of the WebSocket. */
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
	const LOCAL = window.CRR_LOCAL && typeof window.CRR_LOCAL.base === "string" ? window.CRR_LOCAL : null;

	/* ---------- strings ---------- */

	const zh = /^zh/i.test(navigator.language || "");
	const STRINGS = {
		en: {
			thisPc: "This PC", windowsOnline: "{0} window(s) online", offline: "offline — reconnecting", connecting: "connecting…",
			noWindows: "No window of this PC is online. Open Git Graph Studio or VS Code on the desktop (with Claude Remote connected).",
			conversations: "Conversations", workspace: "This workspace", all: "All", search: "Search conversations",
			newConv: "New conversation", noConvs: "No conversations here yet.", untitled: "Untitled",
			loadEarlier: "Load earlier messages", working: "Claude is working…", starting: "Starting a new conversation…",
			message: "Message Claude…", firstMessage: "What should Claude do?", send: "Send", queue: "Queue", now: "Send now", stop: "Stop",
			mode: "Mode", model: "Model", currentModel: "{0} (current)", noModels: "No model list — the next turn uses the current model",
			permAsks: "{0} wants to run", allow: "Allow", always: "Always allow", deny: "Deny", denyWhy: "Tell Claude what to do instead (optional)",
			answerDesktop: "answer on the desktop instead", submit: "Submit", other: "Other…",
			showFull: "Show the full result", bodyFailed: "The body did not load.",
			refresh: "Refresh", switchWindow: "Switch window", openDesktop: "Open on the desktop", forget: "Forget this PC", cancel: "Cancel",
			openedDesktop: "Opened on the desktop", sent: "Sent", failed: "Failed: {0}", runningTag: "running", desktopTag: "on desktop",
			pairOpen: "Open the pairing link from this PC's Claude Remote panel (or scan its QR) to pair this phone.",
			pairOldQr: "This QR code comes from an older Claude Remote", pairOldQrHint: "Update the Claude Remote extension on the desktop, then scan the QR its panel shows now.",
			pairInvalid: "This QR code is no longer valid", pairInvalidHint: "The PC's pairing key changed after this code was made (a reset, or the relay re-registered this PC). Scan the QR the desktop panel shows now.",
			pairRekeyed: "This QR code was replaced", pairRekeyedHint: "The pairing key was reset on the desktop — scan the new QR.",
			pairUnknown: "This PC is not registered on this relay", pairUnknownHint: "The relay may have been reset. Open the desktop panel; it registers again and shows a fresh QR.",
			pairLocked: "Too many attempts", pairLockedHint: "The relay paused pairing from this address for {0} s.",
			pairFailed: "Pairing failed", tryAgain: "Try again", pwTitle: "This PC set a login password", pwHint: "Enter it to finish pairing.", pwPh: "Login password", pair: "Pair",
			pairingLost: "This phone is no longer paired (the key was reset or the phone revoked). Scan the QR on the desktop panel to pair again.",
			notConnected: "not connected", timeout: "the window did not answer in time", interrupted: "interrupted", justNow: "just now",
			pickFolder: "Start in which folder?", idle: "idle", windowGone: "That window went offline.",
			localDebug: "local debug — this PC, no relay",
			claudeAsks: "Claude asks", decline: "Decline", pickAnswer: "Pick an answer for every question", approvePlan: "Approve the plan", keepPlanning: "Keep planning", planTitle: "Claude finished planning", answered: "Answered", fullInput: "Full input",
			oldHost: "This Git Graph Studio does not forward tool-permission prompts — answer those on the desktop (questions work here). Update Git Graph Studio to answer them from this page."
		},
		zh: {
			thisPc: "这台电脑", windowsOnline: "{0} 个窗口在线", offline: "离线 —— 正在重连", connecting: "连接中…",
			noWindows: "这台电脑没有在线窗口。请在电脑上打开 Git Graph Studio 或 VS Code（并连接 Claude Remote）。",
			conversations: "对话", workspace: "本工作区", all: "全部", search: "搜索对话",
			newConv: "新对话", noConvs: "这里还没有对话。", untitled: "未命名",
			loadEarlier: "加载更早的消息", working: "Claude 正在处理…", starting: "正在开启新对话…",
			message: "给 Claude 发消息…", firstMessage: "要 Claude 做什么？", send: "发送", queue: "排队", now: "立即发送", stop: "停止",
			mode: "模式", model: "模型", currentModel: "{0}（当前）", noModels: "没有模型列表 —— 下一回合使用当前模型",
			permAsks: "{0} 请求运行", allow: "允许", always: "始终允许", deny: "拒绝", denyWhy: "告诉 Claude 改做什么（可选）",
			answerDesktop: "改在电脑上回答", submit: "提交", other: "其他…",
			showFull: "显示完整结果", bodyFailed: "内容加载失败。",
			refresh: "刷新", switchWindow: "切换窗口", openDesktop: "在电脑上打开", forget: "忘记这台电脑", cancel: "取消",
			openedDesktop: "已在电脑上打开", sent: "已发送", failed: "失败：{0}", runningTag: "运行中", desktopTag: "电脑上已打开",
			pairOpen: "请打开电脑上 Claude Remote 面板里的配对链接（或扫描二维码）来配对这台手机。",
			pairOldQr: "这是旧版 Claude Remote 的二维码", pairOldQrHint: "请先更新电脑上的 Claude Remote 扩展，再扫描面板上现在显示的二维码。",
			pairInvalid: "这个二维码已失效", pairInvalidHint: "电脑的配对密钥在生成此码之后变了（重置过，或中继重新注册了这台电脑）。请扫描电脑面板上现在显示的二维码。",
			pairRekeyed: "这个二维码已被替换", pairRekeyedHint: "电脑上重置了配对密钥 —— 请扫描新的二维码。",
			pairUnknown: "这台电脑没有在此中继上注册", pairUnknownHint: "中继可能被重置过。打开电脑上的面板，它会重新注册并显示新的二维码。",
			pairLocked: "尝试次数过多", pairLockedHint: "中继暂停了来自此地址的配对 {0} 秒。",
			pairFailed: "配对失败", tryAgain: "重试", pwTitle: "这台电脑设置了登录密码", pwHint: "输入密码完成配对。", pwPh: "登录密码", pair: "配对",
			pairingLost: "这台手机已不再配对（密钥被重置或手机被撤销）。请扫描电脑面板上的二维码重新配对。",
			notConnected: "未连接", timeout: "窗口没有及时响应", interrupted: "已中断", justNow: "刚刚",
			pickFolder: "在哪个文件夹开始？", idle: "空闲", windowGone: "该窗口已离线。",
			localDebug: "本地调试 —— 本机直连，不经中继",
			claudeAsks: "Claude \u63d0\u95ee", decline: "\u4e0d\u56de\u7b54", pickAnswer: "\u6bcf\u4e2a\u95ee\u9898\u90fd\u8981\u9009\u4e00\u4e2a\u7b54\u6848", approvePlan: "\u6279\u51c6\u8ba1\u5212", keepPlanning: "\u7ee7\u7eed\u8ba1\u5212", planTitle: "Claude \u5b8c\u6210\u4e86\u8ba1\u5212", answered: "\u5df2\u56de\u7b54", fullInput: "\u5b8c\u6574\u8f93\u5165",
			oldHost: "这个版本的 Git Graph Studio 不转发工具权限弹窗——权限请在电脑上回答（选择题可以在这里回答）。更新 Git Graph Studio 后即可在本页回答。"
		}
	};
	const T = zh ? STRINGS.zh : STRINGS.en;
	const t = (key, ...args) => String(T[key] ?? STRINGS.en[key] ?? key).replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? ""));

	function relTime(ms) {
		if (!ms) return "";
		const diff = Date.now() - ms;
		if (diff < 60_000) return t("justNow");
		if (diff < 3_600_000) return zh ? `${Math.floor(diff / 60_000)} 分钟前` : `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return zh ? `${Math.floor(diff / 3_600_000)} 小时前` : `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(ms).toLocaleDateString();
	}

	let toastTimer = null;
	function toast(message, isError) {
		const node = $("toast");
		node.textContent = message;
		node.className = "toast" + (isError ? " err" : "");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => node.classList.add("hidden"), isError ? 4500 : 1800);
	}

	/* ---------- the frame body codec (plain; encryption returns here) ---------- */

	const codec = {
		encode(plain) {
			const bytes = new TextEncoder().encode(JSON.stringify(plain));
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			return "p." + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		},
		decode(ct) {
			const value = String(ct ?? "");
			if (!value.startsWith("p.")) throw new Error("not a plain frame body");
			const normal = value.slice(2).replace(/-/g, "+").replace(/_/g, "/");
			const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return JSON.parse(new TextDecoder().decode(bytes));
		}
	};

	/* ---------- state ---------- */

	// What arrived over the live stream, by SDK message type — read by the e2e probe
	// (and handy from a remote devtools console); nothing in the app reads it.
	const stats = (window.__crrStats = { live: {}, adopted: 0 });

	const state = {
		userId: location.pathname.split("/").pop() || "",
		device: null, // {id, token}
		epoch: null,
		windows: [], // [{id, online, seen, host, meta}]
		windowId: null,
		windowPicked: false,
		hello: null, // the chosen window's hello answer
		socket: null,
		online: null,
		backoff: 1000,
		rid: 0,
		seq: Date.now(), // increasing per sender; a reload starts above the last run
		pending: new Map(), // rid → {resolve, reject, timer}
		view: "windows", // windows | sessions | conversation
		scope: "workspace",
		query: "",
		list: null, // the last sessions answer
		conv: null,
		permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
		pairingLost: false
	};

	const store = {
		key: () => "crr.device." + state.userId,
		load() {
			try {
				const raw = localStorage.getItem(store.key());
				return raw ? JSON.parse(raw) : null;
			} catch { return null; }
		},
		save(value) {
			try { localStorage.setItem(store.key(), JSON.stringify(value)); } catch { /* private mode */ }
		},
		clear() {
			try { localStorage.removeItem(store.key()); } catch { /* nothing */ }
		}
	};

	/* ---------- pairing ---------- */

	async function api(path, body) {
		const response = await fetch(path, {
			method: body !== undefined ? "POST" : "GET",
			headers: body !== undefined ? { "Content-Type": "application/json" } : {},
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		const json = await response.json().catch(() => null);
		return { status: response.status, ok: response.ok, json, retryAfter: Number(response.headers.get("retry-after") || 0) };
	}

	const deviceName = () => {
		const ua = navigator.userAgent;
		return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : "Phone";
	};

	/** Pair under the link's credential; the relay's words turn into the right screen. */
	async function pair(link) {
		let password = "";
		for (let attempt = 0; attempt < 4; attempt++) {
			let answer;
			try {
				answer = await api("/api/v1/pair", { user_id: state.userId, epoch: link.epoch, secret: link.auth, password, device_name: deviceName() });
			} catch (error) {
				return card(t("pairFailed"), String(error && error.message || error), t("tryAgain"), () => location.reload());
			}
			if (answer.ok) {
				state.device = { id: answer.json.device_id, token: answer.json.device_token };
				state.epoch = answer.json.epoch;
				store.save({ ...state.device, epoch: state.epoch });
				return true;
			}
			const reason = String(answer.json && answer.json.error || `HTTP ${answer.status}`);
			if (answer.status === 401 && /bad password/.test(reason)) {
				const typed = await askPassword(attempt > 0);
				if (typed == null) return card(t("pwTitle"), t("pwHint"), t("tryAgain"), () => location.reload());
				password = typed;
				continue;
			}
			if (answer.status === 401 && /bad proof/.test(reason)) return card(t("pairInvalid"), t("pairInvalidHint"));
			if (answer.status === 409) return card(t("pairRekeyed"), t("pairRekeyedHint"));
			if (answer.status === 404) return card(t("pairUnknown"), t("pairUnknownHint"));
			if (answer.status === 429) return card(t("pairLocked"), t("pairLockedHint", answer.retryAfter || 60), t("tryAgain"), () => location.reload());
			return card(t("pairFailed"), reason, t("tryAgain"), () => location.reload());
		}
		return card(t("pairFailed"), "bad password", t("tryAgain"), () => location.reload());
	}

	/** A centered full-screen card: a message, a hint, and an optional way forward. */
	function card(title, hint, actionLabel, action) {
		$("boot").classList.add("hidden");
		$("app").classList.add("hidden");
		let wrap = $("pairCard");
		if (!wrap) {
			wrap = el("div", "pair-wrap");
			wrap.id = "pairCard";
			document.body.append(wrap);
		}
		const button = actionLabel ? el("button", "btn", [text(actionLabel)]) : null;
		if (button) button.onclick = action;
		wrap.replaceChildren(el("div", "qcard pair-card", [el("div", "q-title", [text(title)]), hint ? el("div", "row-sub wrap", [text(hint)]) : null, button]));
		return false;
	}

	function askPassword(again) {
		return new Promise((resolve) => {
			const input = el("input", "q-other");
			input.type = "password";
			input.placeholder = t("pwPh");
			input.autocomplete = "current-password";
			const go = el("button", "btn", [text(t("pair"))]);
			const cancel = el("button", "btn sec", [text(t("cancel"))]);
			go.onclick = () => resolve(input.value || null);
			cancel.onclick = () => resolve(null);
			input.addEventListener("keydown", (event) => { if (event.key === "Enter") go.click(); });
			card(t("pwTitle"), again ? "✗ " + t("pwHint") : t("pwHint"));
			$("pairCard").firstChild.append(input, el("div", "composer-actions", [cancel, go]));
			input.focus();
		});
	}

	/* ---------- the relay connection ---------- */

	/** Local debug mode's transport: the debug server's long-poll pair dressed as the
	 *  socket the rest of the app writes to (same messages, same frames). */
	function connectLocal() {
		let cursor = 0;
		let stopped = false;
		const socket = {
			readyState: 1,
			send(textBody) {
				void fetch(LOCAL.base + "/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frames: [JSON.parse(textBody)] }) })
					.catch((error) => console.warn("the local send failed", error));
			},
			close() { stopped = true; socket.readyState = 3; }
		};
		state.socket = socket;
		void (async () => {
			let backoff = 1000;
			while (!stopped) {
				try {
					// The server parks a poll for 20 s; one that outlives that is lost, and
					// aborting it is how the loop recovers instead of waiting forever.
					const abort = new AbortController();
					const timer = setTimeout(() => abort.abort(), 30000);
					const response = await fetch(`${LOCAL.base}/poll?cursor=${cursor}`, { cache: "no-store", signal: abort.signal }).finally(() => clearTimeout(timer));
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const answer = await response.json();
					if (stopped) return;
					if (!state.online) {
						setOnline(true);
						schedulePull(50);
					}
					backoff = 1000;
					cursor = Number(answer.cursor) || 0;
					for (const message of answer.messages || []) {
						try { ingest(message); } catch (error) { console.warn("a local message did not process", error); }
					}
				} catch (error) {
					if (stopped) return;
					setOnline(false);
					await new Promise((r) => setTimeout(r, backoff));
					backoff = Math.min(backoff * 2, 10000);
				}
			}
		})();
	}

	async function connect() {
		if (!state.device) return;
		if (LOCAL) return connectLocal();
		if (state.socket) {
			const old = state.socket;
			state.socket = null;
			try { old.close(); } catch { /* already gone */ }
		}
		// Probe the stored token first: the browser never shows a failed handshake's
		// status, so a dead token would otherwise be an invisible reconnect loop.
		const probe = await api("/api/v1/device/verify", { device_token: state.device.token }).catch(() => null);
		if (probe && probe.status === 401) return markPairingLost();
		if (probe && probe.status === 429) {
			setTimeout(connect, Math.max(1000, (probe.retryAfter || 30) * 1000));
			setOnline(false);
			return;
		}
		const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/device?token=${encodeURIComponent(state.device.token)}`);
		state.socket = socket;
		socket.onopen = () => {
			if (state.socket !== socket) return;
			state.backoff = 1000;
			setOnline(true);
			// Back online: re-pull whatever is on screen (it renews the live watch too).
			schedulePull(50);
		};
		socket.onmessage = (event) => {
			try {
				ingest(JSON.parse(event.data));
			} catch (error) {
				console.warn("a relay message did not process", error);
			}
		};
		socket.onclose = (event) => {
			if (state.socket !== socket) return;
			state.socket = null;
			setOnline(false);
			for (const [rid, waiter] of state.pending) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(t("notConnected")));
				state.pending.delete(rid);
			}
			if (event.code === 4401) return markPairingLost();
			setTimeout(() => { if (state.device && !state.socket) void connect(); }, state.backoff);
			state.backoff = Math.min(state.backoff * 2, 30000);
		};
		socket.onerror = () => { try { socket.close(); } catch { /* onclose follows */ } };
	}

	function setOnline(value) {
		state.online = value;
		$("netDot").className = "dot" + (value ? " on" : "");
		$("netDot").title = value ? "online" : t("offline");
		paintHeader();
	}

	function markPairingLost() {
		state.device = null;
		state.pairingLost = true;
		store.clear();
		card(t("pairFailed"), t("pairingLost"));
	}

	function ingest(wire) {
		if (!wire || wire.v !== 1) return;
		if (wire.kind === "gap") return schedulePull(100);
		if (wire.kind === "hello") {
			state.epoch = Number(wire.epoch) || state.epoch;
			if (wire.you && state.device) state.device.id = wire.you;
			return;
		}
		if (wire.kind === "windows") {
			state.windows = (wire.list ?? []).map((entry) => {
				let meta = {};
				try { meta = codec.decode(entry.meta_ct) || {}; } catch { /* not published yet */ }
				return { ...entry, meta };
			});
			onWindows();
			return;
		}
		if (wire.kind === "frame") {
			let plain;
			try {
				plain = codec.decode(wire.ct);
			} catch (error) {
				console.warn("a frame did not decode", error);
				return;
			}
			onPlain(plain, wire.from);
		}
	}

	function onPlain(plain, from) {
		if (!plain || typeof plain !== "object") return;
		if (plain.t === "reply") {
			const waiter = state.pending.get(plain.rid);
			if (!waiter) return;
			state.pending.delete(plain.rid);
			clearTimeout(waiter.timer);
			if (plain.ok) waiter.resolve(plain.r);
			else waiter.reject(new Error(plain.e || "the window refused the request"));
			return;
		}
		if (from !== state.windowId) return; // another window's broadcast
		if (plain.t === "nudge") return schedulePull(250);
		const conv = state.conv;
		if (plain.t === "live") {
			if (conv && plain.sessionId && plain.sessionId === conv.sessionId) applyLive(conv, plain.msgs || [], !!plain.gap);
			return;
		}
		if (plain.t === "adopt") {
			if (conv && conv.draft && conv.draft === plain.draft) {
				conv.sessionId = plain.sessionId;
				conv.draft = null;
				stats.adopted++;
				if (conv.adoptTimer) clearTimeout(conv.adoptTimer);
				renderConv();
				schedulePull(100);
			}
			return;
		}
		if (plain.t === "sendError") {
			if (conv && ((plain.draft && plain.draft === conv.draft) || (plain.sessionId && plain.sessionId === conv.sessionId))) {
				conv.live.busy = false;
				for (const entry of conv.live.list) if (entry.k === "pending") entry.failed = true;
				pushLive(conv, { k: "notice", lvl: "error", id: "err" + Date.now(), text: t("failed", plain.error) });
				renderConv();
			}
			toast(t("failed", plain.error), true);
		}
	}

	/** One request to the chosen window. */
	function call(method, params = {}, timeoutMs = 45000) {
		if (!state.online || !state.socket || state.socket.readyState !== 1) return Promise.reject(new Error(t("notConnected")));
		if (!state.windowId) return Promise.reject(new Error(t("windowGone")));
		const rid = `r${++state.rid}`;
		const wire = { v: 1, kind: "frame", from: state.device.id, to: state.windowId, seq: ++state.seq, ct: codec.encode({ ...params, rid, t: method }) };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (state.pending.delete(rid)) reject(new Error(t("timeout")));
			}, timeoutMs);
			state.pending.set(rid, { resolve, reject, timer });
			try {
				state.socket.send(JSON.stringify(wire));
			} catch (error) {
				clearTimeout(timer);
				state.pending.delete(rid);
				reject(error);
			}
		});
	}

	let pullTimer = null;
	function schedulePull(delay = 300) {
		if (pullTimer) return;
		pullTimer = setTimeout(() => {
			pullTimer = null;
			if (state.view === "sessions") void loadSessions();
			else if (state.view === "conversation") void pullConv();
		}, delay);
	}

	/* ---------- chrome ---------- */

	const view = $("view");
	const dock = $("dock");

	function paintHeader() {
		const title = $("titleText");
		const sub = $("subText");
		$("backBtn").classList.toggle("hidden", state.view === "windows");
		if (state.view === "windows") {
			title.textContent = t("thisPc");
			sub.textContent = state.online ? (LOCAL ? t("localDebug") : t("windowsOnline", state.windows.filter((w) => w.online).length)) : state.online === false ? t("offline") : t("connecting");
		} else if (state.view === "sessions") {
			const w = currentWindow();
			title.textContent = (w && w.meta && w.meta.name) || t("conversations");
			sub.textContent = state.online === false ? t("offline") : LOCAL ? t("localDebug") : `${t("conversations")}${w && w.meta && w.meta.host ? " · " + w.meta.host : ""}`;
		} else if (state.view === "conversation" && state.conv) {
			const conv = state.conv;
			const meta = conv.meta || {};
			title.textContent = conv.title || meta.title || (conv.draft ? t("newConv") : t("untitled"));
			const busy = convBusy(conv);
			const bits = [meta.project || (conv.cwd ? conv.cwd.split(/[\\/]/).pop() : ""), meta.model || conv.live.model || "", busy ? t("runningTag") : ""].filter(Boolean);
			sub.textContent = state.online === false ? t("offline") : bits.join(" · ");
		}
	}

	const currentWindow = () => state.windows.find((w) => w.id === state.windowId) || null;

	function show(viewName) {
		state.view = viewName;
		$("boot").classList.add("hidden");
		$("app").classList.remove("hidden");
		dock.classList.toggle("hidden", viewName !== "conversation");
		view.className = "view " + viewName;
		paintHeader();
	}

	/* ---------- windows ---------- */

	function onWindows() {
		if (state.windowId && !state.windows.some((w) => w.id === state.windowId && w.online)) {
			// The chosen window went away (closed, reloaded): fall back to the list.
			if (state.view !== "windows") toast(t("windowGone"), true);
			state.windowId = null;
			state.hello = null;
			if (state.view !== "windows") { state.conv = null; show("windows"); }
		}
		const online = state.windows.filter((w) => w.online);
		if (state.view === "windows" && !state.windowPicked && online.length === 1) {
			openWindow(online[0].id);
			return;
		}
		if (state.view === "windows") renderWindows();
		else paintHeader();
	}

	function renderWindows() {
		show("windows");
		const list = el("div", "list");
		const windows = [...state.windows].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || (b.seen || 0) - (a.seen || 0));
		if (!windows.some((w) => w.online)) list.append(el("div", "empty", [text(t("noWindows"))]));
		for (const entry of windows) {
			const meta = entry.meta || {};
			const row = el("button", "row-card" + (entry.online ? "" : " dim"), [
				el("div", "row-main", [
					el("div", "row-title", [text(meta.name || entry.id)]),
					el("div", "row-sub", [text(`${meta.host || entry.host || ""}${(meta.folders || []).length ? " · " + meta.folders[0] : ""}${entry.online ? "" : " · " + relTime(entry.seen)}`)])
				]),
				el("span", "dot" + (entry.online ? " on" : ""), [])
			]);
			row.onclick = () => {
				if (!entry.online) return;
				state.windowPicked = true;
				openWindow(entry.id);
			};
			list.append(row);
		}
		view.replaceChildren(list);
	}

	function openWindow(id) {
		state.windowId = id;
		state.hello = null;
		state.list = null;
		show("sessions");
		renderSessions();
		void call("hello", {}).then((hello) => {
			state.hello = hello;
			if (Array.isArray(hello.permissionModes)) state.permissionModes = hello.permissionModes;
		}).catch(() => undefined);
		void loadSessions();
	}

	/* ---------- the conversation list ---------- */

	async function loadSessions() {
		if (state.view !== "sessions") return;
		try {
			const answer = await call("sessions", { scope: state.scope, q: state.query || undefined, limit: 200 });
			if (state.view !== "sessions") return;
			state.list = answer;
			renderSessionRows();
		} catch (error) {
			if (state.view === "sessions" && !state.list) {
				const rows = view.querySelector(".rows");
				if (rows) rows.replaceChildren(el("div", "empty", [text(String(error.message || error))]));
			}
		}
	}

	function renderSessions() {
		const workspace = el("button", "seg" + (state.scope === "workspace" ? " on" : ""), [text(t("workspace"))]);
		const all = el("button", "seg" + (state.scope === "all" ? " on" : ""), [text(t("all"))]);
		workspace.onclick = () => { state.scope = "workspace"; state.list = null; renderSessions(); void loadSessions(); };
		all.onclick = () => { state.scope = "all"; state.list = null; renderSessions(); void loadSessions(); };
		const search = el("input", "search");
		search.type = "search";
		search.placeholder = t("search");
		search.value = state.query;
		let searchTimer = null;
		search.oninput = () => {
			clearTimeout(searchTimer);
			searchTimer = setTimeout(() => { state.query = search.value.trim(); void loadSessions(); }, 300);
		};
		const fresh = el("button", "btn new-btn", [text("+ " + t("newConv"))]);
		fresh.onclick = () => startDraft();
		const rows = el("div", "list rows", [el("div", "empty", [text("…")])]);
		view.replaceChildren(el("div", "toolbar", [el("div", "segs", [workspace, all]), search]), fresh, rows);
		if (state.list) renderSessionRows();
	}

	function renderSessionRows() {
		const rows = view.querySelector(".rows");
		if (!rows || !state.list) return;
		const sessions = state.list.sessions || [];
		if (!sessions.length) {
			rows.replaceChildren(el("div", "empty", [text(t("noConvs"))]));
			return;
		}
		rows.replaceChildren(...sessions.map((session) => {
			const busy = session.running || session.desktopBusy;
			const tags = [busy ? el("span", "tag run", [text(t("runningTag"))]) : null, session.onDesktop ? el("span", "tag", [text(t("desktopTag"))]) : null];
			const row = el("button", "row-card session", [
				el("div", "row-main", [
					el("div", "row-head", [el("div", "row-title", [text(session.title || t("untitled"))]), el("span", "row-time", [text(relTime(session.mtimeMs))])]),
					el("div", "row-sub", [text(`${session.previewRole === "user" ? "› " : ""}${session.preview || ""}`)]),
					el("div", "row-meta", [text([state.scope === "all" ? session.project : "", session.branch, session.model].filter(Boolean).join(" · ")), ...tags])
				])
			]);
			row.onclick = () => openConversation(session);
			return row;
		}));
	}

	/* ---------- one conversation ---------- */

	function newConv(fields) {
		return {
			sessionId: null, draft: null, cwd: null, title: "",
			items: [], cur: null, rev: null, hasMore: false, meta: null,
			live: { list: [], partial: null, busy: false, model: null, tools: new Map(), seq: 0 },
			clearLiveOnPull: false, pulling: false, pullAgain: false,
			nodes: new Map(), modelChoice: null, modelsInfo: null,
			requests: new Map(), // request_id → the open control_request (can_use_tool)
			answered: new Set(), // request ids this page answered or set aside
			...fields
		};
	}

	function openConversation(session) {
		state.conv = newConv({ sessionId: session.id, title: session.title, cwd: session.cwd, meta: session });
		show("conversation");
		renderConv();
		renderDock();
		void pullConv(true);
		void loadModels();
	}

	function startDraft() {
		const folders = (state.hello && state.hello.folders) || [];
		const begin = (cwd) => {
			const draft = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			state.conv = newConv({ draft: null, pendingDraft: draft, cwd: cwd || null });
			show("conversation");
			renderConv();
			renderDock();
			void loadModels();
			setTimeout(() => dock.querySelector("textarea")?.focus(), 50);
		};
		if (folders.length > 1) {
			sheet([
				{ label: t("pickFolder"), header: true },
				...folders.map((f) => ({ label: f.name || f.path, sub: f.path, run: () => begin(f.path) }))
			]);
		} else begin(folders[0] ? folders[0].path : null);
	}

	async function pullConv(fresh = false) {
		const conv = state.conv;
		if (!conv || !conv.sessionId || state.view !== "conversation") return;
		if (conv.pulling) { conv.pullAgain = true; return; }
		conv.pulling = true;
		try {
			const params = { id: conv.sessionId, limit: 120 };
			if (!fresh && conv.rev) params.rev = conv.rev;
			if (!fresh && conv.cur) params.cur = conv.cur;
			const answer = await call("session", params);
			if (state.conv !== conv) return;
			if (answer.session) {
				conv.meta = { ...(conv.meta || {}), ...answer.session };
				if (Array.isArray(answer.session.openRequests)) {
					const open = new Map(answer.session.openRequests.filter((r) => r && r.request_id).map((r) => [r.request_id, r]));
					// The meta is the window's truth: drop what it no longer holds open, add
					// what this page missed (it opened the conversation mid-prompt).
					for (const id of [...conv.requests.keys()]) if (!open.has(id)) conv.requests.delete(id);
					for (const [id, r] of open) conv.requests.set(id, r);
				}
			}
			if (!answer.same) {
				if (!answer.delta) conv.items = answer.items || [];
				else if ((answer.items || []).length) {
					const byId = new Map(conv.items.map((item) => [item.id, item]));
					for (const item of answer.items) byId.set(item.id, { ...byId.get(item.id), ...item });
					conv.items = [...byId.values()].sort((a, b) => (a.q || 0) - (b.q || 0));
				}
				conv.cur = answer.cur || conv.cur;
				conv.rev = answer.rev;
				conv.hasMore = !!answer.hasMore;
				if (conv.clearLiveOnPull) {
					// The turn ended and the transcript now carries it: the live layer has
					// done its job (only error notices stay — the store has no record of them).
					conv.clearLiveOnPull = false;
					conv.live.list = conv.live.list.filter((entry) => entry.k === "notice" && entry.lvl === "error");
					conv.live.partial = null;
				}
			}
			renderConv();
		} catch (error) {
			console.warn("the conversation pull failed", error);
		} finally {
			conv.pulling = false;
			if (conv.pullAgain) {
				conv.pullAgain = false;
				schedulePull(200);
			}
		}
	}

	async function loadEarlier() {
		const conv = state.conv;
		const oldest = conv && conv.items.find((item) => item.q != null);
		if (!oldest) return;
		const answer = await call("session", { id: conv.sessionId, limit: 120, before: oldest.q, watch: false });
		const known = new Set(conv.items.map((item) => item.id));
		conv.items = [...(answer.items || []).filter((item) => !known.has(item.id)), ...conv.items];
		conv.hasMore = !!answer.hasMore;
		const scroller = view;
		const fromBottom = scroller.scrollHeight - scroller.scrollTop;
		renderConv();
		scroller.scrollTop = scroller.scrollHeight - fromBottom;
	}

	async function loadModels() {
		const conv = state.conv;
		if (!conv) return;
		try {
			conv.modelsInfo = await call("models", conv.sessionId ? { id: conv.sessionId } : { cwd: conv.cwd });
		} catch { /* the pick falls back to the current model */ }
	}

	const convBusy = (conv) => !!(conv.live.busy || (conv.meta && (conv.meta.running || conv.meta.desktopBusy)));

	/* ---------- the live layer: the CLI's own SDK messages ---------- */

	function pushLive(conv, entry) {
		entry.n = ++conv.live.seq;
		conv.live.list.push(entry);
		if (conv.live.list.length > 400) conv.live.list.splice(0, conv.live.list.length - 400);
	}

	function toolSummaryOf(name, input) {
		const value = input && typeof input === "object" ? input : {};
		const pick = value.command || value.file_path || value.path || value.pattern || value.url || value.description || value.prompt || value.query;
		if (pick) return String(pick).split("\n")[0].slice(0, 160);
		try { return JSON.stringify(value).slice(0, 160); } catch { return ""; }
	}

	function resultTextOf(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map((b) => (b && b.type === "text" ? b.text : b && b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
	}

	/**
	 * One batch of SDK messages into the conversation's live layer. The item ids follow
	 * the PC's transcript reader exactly (`<uuid>:<block index>`; the SDK's uuid IS the
	 * session file's record uuid), so the moment the transcript carries a message the
	 * live copy is the same row and simply yields to it.
	 */
	function applyLive(conv, msgs, gap) {
		const live = conv.live;
		let structural = false;
		for (const m of msgs) {
			if (!m || typeof m !== "object") continue;
			stats.live[m.type] = (stats.live[m.type] || 0) + 1;
			if (m.truncated) { structural = true; schedulePull(150); continue; }
			switch (m.type) {
				case "stream_event": {
					const e = m.event || {};
					if (e.type === "message_start") {
						live.partial = { msgId: e.message && e.message.id, blocks: [] };
						live.busy = true;
					} else if (e.type === "content_block_start") {
						if (!live.partial) live.partial = { msgId: null, blocks: [] };
						const b = e.content_block || {};
						live.partial.blocks[e.index] = { type: b.type, text: b.text || b.thinking || "", name: b.name || "", json: "", done: false };
					} else if (e.type === "content_block_delta") {
						if (!live.partial) live.partial = { msgId: null, blocks: [] };
						const block = live.partial.blocks[e.index] || (live.partial.blocks[e.index] = { type: "text", text: "", name: "", json: "", done: false });
						const d = e.delta || {};
						if (d.type === "text_delta") block.text += d.text || "";
						else if (d.type === "thinking_delta") block.text += d.thinking || "";
						else if (d.type === "input_json_delta") block.json += d.partial_json || "";
					}
					break;
				}
				case "assistant": {
					live.busy = true;
					const message = m.message || {};
					if (message.model && message.model !== "<synthetic>") live.model = message.model;
					const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
					const uuid = m.uuid || "a" + live.seq;
					content.forEach((block, i) => {
						if (!block) return;
						const id = `${uuid}:${i}`;
						if (block.type === "text" && block.text && block.text.trim()) pushLive(conv, { k: "assistant", id, text: block.text });
						else if (block.type === "thinking" && block.thinking && block.thinking.trim()) pushLive(conv, { k: "thinking", id, text: block.thinking });
						else if (block.type === "tool_use") {
							const item = { k: "tool", id, name: String(block.name || "tool"), sum: toolSummaryOf(block.name, block.input), input: block.input, st: "run", res: null, live: true };
							pushLive(conv, item);
							if (block.id) live.tools.set(block.id, item);
						}
						// The streamed copy of this block is now final: retire the first
						// still-open partial block of the same kind.
						if (live.partial) {
							const open = live.partial.blocks.find((b) => b && !b.done && (b.type === block.type || (b.type === "server_tool_use" && block.type === "tool_use")));
							if (open) open.done = true;
							if (live.partial.blocks.every((b) => !b || b.done)) live.partial = null;
						}
					});
					structural = true;
					break;
				}
				case "user": {
					const message = m.message || {};
					const content = message.content;
					if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
						for (const block of content) {
							if (!block || block.type !== "tool_result") continue;
							const item = live.tools.get(block.tool_use_id);
							if (!item) continue;
							const full = resultTextOf(block.content);
							item.st = block.is_error ? "err" : "ok";
							item.res = { text: full.slice(0, 3000), more: full.length > 3000, err: !!block.is_error };
						}
						// The transcript's own copy of a tool row turns "done" on the next pull.
						schedulePull(400);
					} else if (!m.isMeta && !m.isSynthetic && !m.isReplay) {
						const said = (typeof content === "string" ? content : resultTextOf(content)).trim();
						if (said && !/^<[\w-]+>/.test(said)) {
							// A prompt typed on the desktop (or our own, echoed through the tab):
							// the phone's pending bubble already says it.
							const mine = live.list.find((entry) => entry.k === "pending" && !entry.echoed && entry.text.trim() === said);
							if (mine) mine.echoed = true;
							else pushLive(conv, { k: "user", id: m.uuid || "lu" + live.seq, text: said });
						}
					}
					live.busy = true;
					structural = true;
					break;
				}
				case "result": {
					live.busy = false;
					live.partial = null;
					if (m.is_error && m.result) pushLive(conv, { k: "notice", lvl: "error", id: "res" + (m.uuid || live.seq), text: String(m.result).slice(0, 600) });
					else if (m.subtype === "error_during_execution" && !m.result) pushLive(conv, { k: "notice", lvl: "warn", id: "res" + (m.uuid || live.seq), text: t("interrupted") });
					conv.clearLiveOnPull = true;
					structural = true;
					schedulePull(150);
					break;
				}
				case "system": {
					if (m.subtype === "init") {
						live.busy = true;
						if (m.model) live.model = m.model;
					} else if (m.subtype === "compact_boundary") {
						pushLive(conv, { k: "notice", lvl: "info", id: m.uuid || "cb" + live.seq, text: "compacted" });
					} else if (m.subtype === "permission_denied") {
						// A tool the CLI refused on its own (a rule, auto mode's classifier):
						// the phone says so instead of the tool silently not running.
						pushLive(conv, { k: "notice", lvl: "warn", id: "pd" + (m.tool_use_id || live.seq), text: `${m.tool_name || "tool"}: ${String(m.message || m.decision_reason || "denied").slice(0, 300)}` });
					}
					structural = true;
					break;
				}
				case "ggs_state":
					live.busy = !!m.busy;
					if (m.model) live.model = m.model;
					if (!m.busy) schedulePull(200);
					structural = true;
					break;
				case "control_request":
					// The /remote-control prompt: a tool asks permission (AskUserQuestion and
					// ExitPlanMode ask this way too) — the page's pop-up answers it.
					if (m.request && m.request.subtype === "can_use_tool" && m.request_id) conv.requests.set(m.request_id, m);
					break;
				case "control_cancel_request":
					conv.requests.delete(m.request_id);
					break;
				case "control_response":
					// Answered — here, on the desktop, or by another phone.
					if (m.response && m.response.request_id) conv.requests.delete(m.response.request_id);
					break;
				default:
					break; // a message type this app does not know yet: the transcript shows it
			}
		}
		if (gap) schedulePull(100);
		renderConv(!structural);
	}

	/* ---------- rendering the conversation (keyed, so open rows and scroll survive) ---------- */

	const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

	/** Transcript items, then the live layer's rows the transcript does not carry yet. */
	function displayRows(conv) {
		const rows = conv.items.slice();
		const ids = new Set(rows.map((item) => item.id));
		const userTexts = rows.filter((item) => item.k === "user").map((item) => ({ q: item.q || 0, text: norm(item.text) }));
		for (const entry of conv.live.list) {
			if (entry.k === "pending") {
				if (userTexts.some((u) => u.q > entry.afterQ && u.text === norm(entry.text))) continue;
				rows.push(entry);
				continue;
			}
			if (ids.has(entry.id)) continue;
			if (entry.k === "user" && userTexts.some((u) => u.text === norm(entry.text) && u.q > (entry.afterQ ?? -Infinity))) continue;
			rows.push(entry);
		}
		return rows;
	}

	function nearBottom() {
		return view.scrollHeight - view.scrollTop - view.clientHeight < 120;
	}

	function renderConv() {
		const conv = state.conv;
		if (!conv || state.view !== "conversation") return;
		const stick = nearBottom();
		const used = new Map();
		const keyed = (key, sig, make) => {
			const prev = conv.nodes.get(key);
			const node = prev && prev.sig === sig ? prev.node : make();
			used.set(key, { sig, node });
			return node;
		};
		const nodes = [];
		if (conv.hasMore) {
			nodes.push(keyed("more", "more", () => {
				const more = el("button", "linkish more", [text(t("loadEarlier"))]);
				more.onclick = () => void loadEarlier().catch((error) => toast(error.message, true));
				return more;
			}));
		}
		const caps = state.hello && state.hello.capabilities;
		if (caps && caps.tab && caps.prompts === false) {
			nodes.push(keyed("old-host", "old-host", () => el("div", "msg notice", [el("div", "notice-inner warn", [text(t("oldHost"))])])));
		}
		for (const row of displayRows(conv)) {
			const sig = JSON.stringify([row.k, row.text, row.st, row.res && row.res.text, row.failed, row.body && row.body.kind, row.sum]);
			nodes.push(keyed(row.id || "p" + row.n, sig, () => rowNode(row)));
		}
		const partial = conv.live.partial;
		if (partial) {
			partial.blocks.forEach((block, i) => {
				if (!block || block.done) return;
				const sig = block.type + ":" + block.text.length + ":" + block.json.length;
				nodes.push(keyed("partial:" + i + ":" + block.type, sig, () => partialNode(block)));
			});
		}
		const busy = convBusy(conv);
		const streaming = partial && partial.blocks.some((b) => b && !b.done);
		if (conv.draft || (busy && !streaming)) {
			nodes.push(keyed("working", conv.draft ? "draft" : "busy", () => el("div", "msg working", [el("span", "dots", [el("i"), el("i"), el("i")]), text(conv.draft ? t("starting") : t("working"))])));
		}
		if (!nodes.length) nodes.push(keyed("empty", "e", () => el("div", "empty", [text(conv.sessionId ? "…" : t("firstMessage"))])));
		let host = view.querySelector(".msgs");
		if (!host) {
			host = el("div", "msgs");
			view.replaceChildren(host);
		}
		host.replaceChildren(...nodes);
		conv.nodes = used;
		paintHeader();
		paintDockState();
		paintRequestModal();
		if (stick) view.scrollTop = view.scrollHeight;
	}

	function rowNode(row) {
		if (row.k === "pending") {
			return el("div", "msg user" + (row.failed ? " failed" : " pending"), [el("div", "bubble", [text(row.text)])]);
		}
		if (row.k === "user") {
			return el("div", "msg user", [el("div", "bubble", [
				row.chips && row.chips.length ? el("div", "chips", row.chips.map((chip) => el("span", "chip", [text(chip)]))) : null,
				text(row.text),
				...(row.imgs || []).map((ref) => imageNode(ref))
			])]);
		}
		if (row.k === "assistant") return el("div", "msg assistant", [markdownNode(row.text)]);
		if (row.k === "thinking") {
			const node = el("details", "msg thinking", [el("summary", null, [text("thinking")]), el("div", "bubble", [text(row.text)])]);
			return node;
		}
		if (row.k === "notice") return el("div", "msg notice", [el("div", "notice-inner " + (row.lvl || ""), [text(row.text)])]);
		if (row.k === "tool") {
			return toolNode(row);
		}
		return el("div", "msg notice", [el("div", "notice-inner", [text(row.k)])]);
	}

	function partialNode(block) {
		if (block.type === "thinking") {
			const node = el("details", "msg thinking streaming", [el("summary", null, [text("thinking…")]), el("div", "bubble", [text(block.text)])]);
			return node;
		}
		if (block.type === "tool_use" || block.type === "server_tool_use") {
			return el("div", "msg tool streaming", [el("div", "tool-line", [el("span", "tool-name", [text(block.name || "tool")]), el("span", "row-sub", [text("…")])])]);
		}
		const body = markdownNode(block.text);
		// The caret rides the end of the last paragraph, not a line of its own.
		const last = body.lastElementChild && /^(P|LI|H\d)$/.test(body.lastElementChild.tagName) ? body.lastElementChild : body;
		last.append(el("span", "caret"));
		return el("div", "msg assistant streaming", [body]);
	}

	function toolNode(item) {
		const status = item.st === "run" ? el("span", "spin", []) : item.st === "err" ? el("span", "tool-st err", [text("✕")]) : el("span", "tool-st ok", [text("✓")]);
		const summary = el("summary", null, [el("span", "tool-name", [text(item.name)]), el("span", "row-sub", [text(item.sum || "")]), status]);
		const body = el("div", "tool-body", [text("…")]);
		const node = el("details", "msg tool", [summary, body]);
		node.addEventListener("toggle", () => {
			if (!node.open || node.dataset.loaded) return;
			node.dataset.loaded = "1";
			if (item.live) {
				body.replaceChildren(el("pre", "code", [text(JSON.stringify(item.input ?? {}, null, 2))]));
				if (item.res) body.append(el("div", "tool-res" + (item.res.err ? " err" : ""), [text(item.res.text)]));
				return;
			}
			void call("tool", { id: state.conv.sessionId, item: item.id }).then((answer) => {
				body.replaceChildren();
				if (answer.body && answer.body.kind === "question") body.append(questionSummary(answer.body));
				else if (answer.body && answer.body.kind === "todos") body.append(todosNode(answer.body.todos));
				else if (answer.body) body.append(el("pre", "code", [text(answer.body.text ?? answer.body.diff ?? JSON.stringify(answer.body, null, 2))]));
				if (answer.res && answer.res.text) {
					const result = el("div", "tool-res" + (answer.res.err ? " err" : ""), [text(answer.res.text)]);
					body.append(result);
					if (answer.res.more) {
						const more = el("button", "linkish", [text(t("showFull"))]);
						more.onclick = () => void call("detail", { id: state.conv.sessionId, item: item.id }).then((full) => {
							result.replaceChildren(text(String(full.text).slice(0, 200_000)));
							more.remove();
						}).catch((error) => toast(error.message, true));
						body.append(more);
					}
				}
				for (const ref of (answer.res && answer.res.imgs) || []) body.append(imageNode(ref));
			}).catch(() => {
				node.dataset.loaded = "";
				body.replaceChildren(text(t("bodyFailed")));
			});
		});
		return node;
	}

	const imageCache = new Map();
	function imageNode(ref) {
		const img = el("img", "result-img");
		img.alt = "image";
		const cached = imageCache.get(ref);
		if (cached) img.src = cached;
		else if (state.conv && state.conv.sessionId) {
			void call("image", { id: state.conv.sessionId, ref }).then((answer) => {
				const url = `data:${answer.mime || "image/png"};base64,${answer.data}`;
				imageCache.set(ref, url);
				if (imageCache.size > 32) imageCache.delete(imageCache.keys().next().value);
				img.src = url;
			}).catch(() => img.remove());
		}
		return img;
	}

	function todosNode(todos) {
		const wrap = el("div", "todos");
		for (const todo of todos ?? []) wrap.append(el("div", "todo " + (todo.s || ""), [text(`${({ completed: "☑", in_progress: "◐", pending: "☐" })[todo.s] || "☐"} ${todo.t}`)]));
		return wrap;
	}

	/** A past AskUserQuestion in the history, read-only: the questions and their options
	 *  (a waiting one is answered in the pop-up its can_use_tool request opens). */
	function questionSummary(body) {
		const wrap = el("div", "todos");
		for (const question of body.questions ?? []) {
			wrap.append(el("div", "q-title", [text(question.q)]));
			for (const option of question.opts ?? []) wrap.append(el("div", "todo", [text("• " + option.label + (option.desc ? " — " + option.desc : ""))]));
		}
		return wrap;
	}

	/* ---------- the /remote-control prompt: a pop-up over the conversation ---------- */

	/** One inbound /remote-control message for the open conversation (or the draft). */
	function rc(msg, extra = {}) {
		const conv = state.conv;
		const target = conv && conv.sessionId ? { sessionId: conv.sessionId } : { draft: conv && (conv.draft || conv.pendingDraft), cwd: conv && conv.cwd || undefined };
		return call("rc", { ...target, ...extra, msg });
	}

	function paintRequestModal() {
		const conv = state.conv;
		const open = conv && state.view === "conversation" ? [...conv.requests.values()].find((r) => !conv.answered.has(r.request_id)) : null;
		let host = $("rcModal");
		if (!open) {
			if (host) host.remove();
			return;
		}
		if (host && host.dataset.rid === open.request_id) return;
		if (host) host.remove();
		host = el("div", "modal-overlay", [requestCard(conv, open)]);
		host.id = "rcModal";
		host.dataset.rid = open.request_id;
		document.body.append(host);
	}

	/** The pop-up for one `control_request {subtype: "can_use_tool"}`; its answer is the
	 *  protocol's `control_response {request_id, response: PermissionResult}`. */
	function requestCard(conv, req) {
		const r = req.request || {};
		const tool = String(r.tool_name || "tool");
		const input = r.input && typeof r.input === "object" ? r.input : {};
		const node = el("div", "qcard perm-card modal-card");
		const buttons = [];
		const answer = (response) => {
			buttons.forEach((b) => { b.disabled = true; });
			void rc({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } })
				.then(() => {
					conv.answered.add(req.request_id);
					conv.requests.delete(req.request_id);
					paintRequestModal();
					schedulePull(300);
				})
				.catch((error) => {
					buttons.forEach((b) => { b.disabled = false; });
					toast(error.message, true);
				});
		};
		const button = (label, cls, run) => {
			const b = el("button", cls, [text(label)]);
			b.onclick = run;
			buttons.push(b);
			return b;
		};
		const setAside = el("button", "linkish dismiss", [text(t("answerDesktop"))]);
		setAside.onclick = () => {
			conv.answered.add(req.request_id);
			paintRequestModal();
		};

		if (tool === "AskUserQuestion" && Array.isArray(input.questions)) {
			// AskUserQuestion: the picks ride the allow's updatedInput as `answers`, keyed by
			// the question text (multi-select labels joined) — what the tool reads back.
			node.append(el("div", "q-title", [text(t("claudeAsks"))]));
			const picks = input.questions.map(() => new Set());
			const others = [];
			input.questions.forEach((question, qi) => {
				node.append(el("div", "q-sub", [question.header ? el("span", "chip", [text(question.header)]) : null, text(" " + (question.question || ""))]));
				const group = el("div", "q-group");
				for (const option of question.options || []) {
					const row = el("button", "q-opt", [el("div", "row-main", [el("div", "row-title", [text(option.label)]), option.description ? el("div", "row-sub wrap", [text(option.description)]) : null])]);
					row.onclick = () => {
						if (question.multiSelect) {
							if (row.classList.toggle("on")) picks[qi].add(option.label);
							else picks[qi].delete(option.label);
						} else {
							group.querySelectorAll(".q-opt").forEach((n) => n.classList.remove("on"));
							picks[qi].clear();
							picks[qi].add(option.label);
							row.classList.add("on");
						}
					};
					group.append(row);
				}
				const other = el("input", "q-other");
				other.placeholder = t("other");
				others.push(other);
				node.append(group, other);
			});
			const submit = button(t("submit"), "btn", () => {
				const answers = {};
				for (const [qi, question] of input.questions.entries()) {
					const chosen = [...picks[qi]];
					const typed = others[qi].value.trim();
					if (typed) chosen.push(typed);
					if (!chosen.length) return toast(t("pickAnswer"), true);
					answers[question.question] = chosen.join(", ");
				}
				answer({ behavior: "allow", updatedInput: { ...input, answers } });
			});
			const decline = button(t("decline"), "btn sec", () => answer({ behavior: "deny", message: "The user declined to answer." }));
			node.append(el("div", "composer-actions", [decline, submit]), setAside);
			return node;
		}

		if (tool === "ExitPlanMode" && typeof input.plan === "string") {
			node.append(el("div", "q-title", [text(t("planTitle"))]), el("div", "plan", [markdownNode(input.plan)]));
			const reason = el("input", "q-other");
			reason.placeholder = t("denyWhy");
			const keep = button(t("keepPlanning"), "btn sec", () => answer({ behavior: "deny", message: reason.value.trim() || "The user wants to keep planning." }));
			const approve = button(t("approvePlan"), "btn", () => answer({ behavior: "allow", updatedInput: input }));
			node.append(reason, el("div", "composer-actions", [keep, approve]), setAside);
			return node;
		}

		node.append(el("div", "q-title", [text(t("permAsks", tool))]));
		node.append(el("pre", "code", [text(toolSummaryOf(tool, input))]));
		const full = el("details", "full-input", [el("summary", null, [text(t("fullInput"))]), el("pre", "code", [text(JSON.stringify(input, null, 2))])]);
		const reason = el("input", "q-other");
		reason.placeholder = t("denyWhy");
		const suggestions = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [];
		const row = el("div", "composer-actions", [
			button(t("deny"), "btn sec", () => answer({ behavior: "deny", message: reason.value.trim() || "The user denied this from the remote." })),
			suggestions.length ? button(t("always"), "btn sec", () => answer({ behavior: "allow", updatedInput: input, updatedPermissions: suggestions })) : null,
			button(t("allow"), "btn", () => answer({ behavior: "allow", updatedInput: input }))
		]);
		node.append(full, reason, row, setAside);
		return node;
	}

	/* ---------- markdown (fences, headings, lists, quotes, tables, inline) ---------- */

	const ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
	const SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
	const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;
	const blockStart = (l) => /^\s*(```|~~~|#{1,6}\s|>)/.test(l) || ITEM.test(l);

	function inline(src) {
		const slots = [];
		const hold = (html) => "\u0000" + (slots.push(html) - 1) + "\u0000";
		let s = String(src).replace(/\u0000/g, "").replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
		s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, (_, label, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`));
		s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, url) => pre + hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
		s = esc(s);
		s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
		s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>");
		s = s.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
		return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
	}

	function md(src) {
		const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
		const out = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
			if (fence) {
				const buf = [];
				i++;
				while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
				i++;
				out.push(`<pre class="code"><code>${esc(buf.join("\n"))}</code></pre>`);
				continue;
			}
			if (!line.trim()) { i++; continue; }
			const h = line.match(/^(#{1,6})\s+(.*)$/);
			if (h) { const lv = Math.min(4, h[1].length); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }
			if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
			if (line.includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1])) {
				const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
				const head = cells(line);
				i += 2;
				const rows = [];
				while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
				out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
				continue;
			}
			if (/^\s*>/.test(line)) {
				const buf = [];
				while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
				out.push(`<blockquote>${md(buf.join("\n"))}</blockquote>`);
				continue;
			}
			if (ITEM.test(line)) {
				const [html, next] = list(lines, i);
				out.push(html);
				i = next;
				continue;
			}
			const buf = [line];
			i++;
			while (i < lines.length && lines[i].trim() && !blockStart(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1]))) buf.push(lines[i++]);
			out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
		}
		return out.join("");
	}

	function list(lines, start) {
		const base = indentOf(lines[start]);
		const ordered = /^\s*\d/.test(lines[start]);
		const first = Number((lines[start].match(/^\s*(\d+)/) || [])[1] || 1);
		const items = [];
		let i = start;
		while (i < lines.length) {
			const l = lines[i];
			if (!l.trim()) {
				if (i + 1 < lines.length && (indentOf(lines[i + 1]) > base || (ITEM.test(lines[i + 1]) && indentOf(lines[i + 1]) === base))) { i++; continue; }
				break;
			}
			const ind = indentOf(l);
			if (ITEM.test(l) && ind === base) { items.push([l.replace(ITEM, "")]); i++; continue; }
			if (ind > base && items.length) { items[items.length - 1].push(l); i++; continue; }
			if (ind <= base && (ITEM.test(l) || blockStart(l))) break;
			if (items.length && ind <= base) { items[items.length - 1][0] += "\n" + l.trim(); i++; continue; }
			break;
		}
		const html = items.map(([head, ...rest]) => {
			let body = head;
			let box = "";
			const task = body.match(/^\[([ xX])\]\s+/);
			if (task) { box = task[1] === " " ? "☐ " : "☑ "; body = body.slice(task[0].length); }
			const nested = rest.length ? (() => { const min = Math.min(...rest.filter((r) => r.trim()).map(indentOf)); return md(rest.map((r) => r.slice(Math.min(min, indentOf(r)))).join("\n")); })() : "";
			return `<li>${box}${body.split("\n").map(inline).join("<br>")}${nested}</li>`;
		}).join("");
		return [ordered ? `<ol${first !== 1 ? ` start="${first}"` : ""}>${html}</ol>` : `<ul>${html}</ul>`, i];
	}

	function markdownNode(source) {
		const wrap = el("div", "md");
		wrap.innerHTML = md(source);
		return wrap;
	}

	/* ---------- the composer (the dock under the conversation) ---------- */

	function renderDock() {
		const conv = state.conv;
		if (!conv) return;
		const input = el("textarea", "compose-input");
		input.rows = 1;
		input.placeholder = conv.sessionId ? t("message") : t("firstMessage");
		input.oninput = () => {
			input.style.height = "auto";
			input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.32) + "px";
		};
		const send = el("button", "btn", [text(t("send"))]);
		const nowBtn = el("button", "btn sec", [text(t("now"))]);
		const stopBtn = el("button", "btn sec", [text(t("stop"))]);
		const modeBtn = el("button", "chip-btn", [text(t("mode"))]);
		const modelBtn = el("button", "chip-btn", [text(conv.modelChoice ? conv.modelChoice.label : t("model"))]);
		send.onclick = () => submit(convBusy(conv) ? "queue" : "now");
		nowBtn.onclick = () => submit("now");
		stopBtn.onclick = () => {
			if (!conv.sessionId) return;
			void rc({ type: "control_request", request: { subtype: "interrupt" } }).then(() => schedulePull(300)).catch((error) => toast(error.message, true));
		};
		modeBtn.onclick = () => sheet(state.permissionModes.map((mode) => ({
			label: mode,
			// Before the first send the window remembers the pick under the draft's lane.
			run: () => void rc({ type: "control_request", request: { subtype: "set_permission_mode", mode } }).then(() => { modeBtn.textContent = mode; toast(`${t("mode")}: ${mode}`); }).catch((error) => toast(error.message, true))
		})));
		modelBtn.onclick = () => {
			const info = conv.modelsInfo;
			const entries = [];
			const pick = (model, label) => {
				conv.modelChoice = model ? { id: model, label } : null;
				modelBtn.textContent = model ? label : t("model");
				void rc({ type: "control_request", request: { subtype: "set_model", model: model || undefined } }).catch((error) => toast(error.message, true));
			};
			if (info && info.current) entries.push({ label: t("currentModel", info.current), run: () => pick(null) });
			for (const tier of (info && info.tiers) || []) {
				entries.push({ label: tier.resolved ? `${tier.id} → ${tier.resolved}` : tier.id, run: () => pick(tier.id, tier.id) });
			}
			if (!entries.length) entries.push({ label: t("noModels"), run: () => undefined });
			sheet(entries);
		};
		const submit = (mode) => {
			const value = input.value.trim();
			if (!value || conv.draft) return;
			input.value = "";
			input.style.height = "";
			const afterQ = conv.items.length ? conv.items[conv.items.length - 1].q || 0 : 0;
			const entry = { k: "pending", text: value, afterQ, failed: false };
			pushLive(conv, entry);
			if (!conv.sessionId) {
				conv.draft = conv.pendingDraft;
				conv.title = value.split("\n")[0].slice(0, 60);
				// The window adopts the new conversation id from the turn's first event;
				// if none arrives the turn never started — say so instead of spinning.
				conv.adoptTimer = setTimeout(() => {
					if (state.conv === conv && conv.draft) {
						entry.failed = true;
						conv.draft = null;
						pushLive(conv, { k: "notice", lvl: "error", id: "adopt" + Date.now(), text: t("failed", t("timeout")) });
						renderConv();
					}
				}, 120_000);
			}
			conv.live.busy = true;
			renderConv();
			view.scrollTop = view.scrollHeight;
			// The /remote-control user message; `mode` says interrupt-and-send or queue.
			void rc({ type: "user", message: { role: "user", content: [{ type: "text", text: value }] } }, { mode, ...(conv.modelChoice ? { model: conv.modelChoice.id } : {}) }).then((answer) => {
				if (answer && answer.sessionId && !conv.sessionId && state.conv === conv) {
					conv.sessionId = answer.sessionId;
					conv.draft = null;
				}
				schedulePull(400);
			}).catch((error) => {
				entry.failed = true;
				conv.live.busy = false;
				if (conv.draft) conv.draft = null;
				toast(t("failed", error.message), true);
				renderConv();
			});
		};
		input.addEventListener("keydown", (event) => {
			// Desktop keyboards: Enter sends, Shift+Enter breaks the line; a phone's
			// on-screen Enter is a newline (the Send button sends).
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(pointer: fine)").matches) {
				event.preventDefault();
				send.click();
			}
		});
		dock.replaceChildren(el("div", "composer", [
			el("div", "pick-row", [modeBtn, modelBtn]),
			input,
			el("div", "composer-actions", [stopBtn, nowBtn, send])
		]));
		dock.dataset.for = conv.sessionId || conv.pendingDraft || "";
		paintDockState();
	}

	function paintDockState() {
		const conv = state.conv;
		if (!conv || dock.classList.contains("hidden")) return;
		const busy = convBusy(conv);
		const buttons = dock.querySelectorAll(".composer-actions .btn");
		const [stopBtn, nowBtn, send] = buttons;
		if (!send) return;
		stopBtn.classList.toggle("hidden", !busy || !conv.sessionId);
		nowBtn.classList.toggle("hidden", !busy || !conv.sessionId);
		send.textContent = busy && conv.sessionId ? t("queue") : t("send");
		send.disabled = !!conv.draft;
		const input = dock.querySelector("textarea");
		if (input) input.placeholder = conv.draft ? t("starting") : conv.sessionId ? t("message") : t("firstMessage");
	}

	/* ---------- sheets and the menu ---------- */

	function sheet(entries) {
		const overlay = el("div", "menu-overlay");
		const panel = el("div", "menu-sheet");
		for (const entry of entries) {
			if (entry.header) {
				panel.append(el("div", "menu-head", [text(entry.label)]));
				continue;
			}
			const row = el("button", "menu-item" + (entry.danger ? " danger" : ""), [text(entry.label), entry.sub ? el("div", "row-sub", [text(entry.sub)]) : null]);
			row.onclick = () => { overlay.remove(); entry.run(); };
			panel.append(row);
		}
		const cancel = el("button", "menu-item", [text(t("cancel"))]);
		cancel.onclick = () => overlay.remove();
		panel.append(cancel);
		overlay.append(panel);
		overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
		document.body.append(overlay);
	}

	$("dotsBtn").onclick = () => {
		const entries = [{ label: t("refresh"), run: () => { if (state.view === "windows") { requestWindows(); renderWindows(); } else schedulePull(10); } }];
		if (state.windows.filter((w) => w.online).length > 1 || state.view !== "windows") {
			entries.push({ label: t("switchWindow"), run: () => { state.windowPicked = true; state.conv = null; renderWindows(); } });
		}
		if (state.view === "conversation" && state.conv && state.conv.sessionId) {
			entries.push({ label: t("openDesktop"), run: () => void call("openOnDesktop", { id: state.conv.sessionId }).then(() => toast(t("openedDesktop"))).catch((error) => toast(error.message, true)) });
		}
		if (!LOCAL) entries.push({ label: t("forget"), danger: true, run: () => { store.clear(); state.device = null; if (state.socket) state.socket.close(); card(t("forget"), t("pairOpen")); } });
		sheet(entries);
	};

	$("backBtn").onclick = () => {
		if (state.view === "conversation") {
			if (state.conv && state.conv.sessionId) void call("watch", {}).catch(() => undefined);
			state.conv = null;
			show("sessions");
			renderSessions();
			void loadSessions();
		} else if (state.view === "sessions") {
			state.windowPicked = true;
			renderWindows();
		}
	};

	function requestWindows() {
		if (state.socket && state.socket.readyState === 1) state.socket.send(JSON.stringify({ v: 1, kind: "windows" }));
	}

	/* ---------- boot ---------- */

	async function boot() {
		if (LOCAL) {
			document.title = "Claude Remote · local debug";
			state.device = { id: LOCAL.device, token: "" };
		}
		const hash = location.hash.replace(/^#/, "");
		const plainLink = hash.match(/^p\.([0-9a-f]{64})\.(\d+)$/);
		const oldLink = !plainLink && /^[A-Za-z0-9_-]{43}\.\d+$/.test(hash);
		if (hash) history.replaceState(null, "", location.pathname); // the credential leaves the address bar at once
		const stored = store.load();
		if (LOCAL) {
			/* no pairing: the page is the window's own */
		} else if (plainLink) {
			const link = { auth: plainLink[1], epoch: Number(plainLink[2]) };
			if (stored && stored.token && stored.epoch === link.epoch) {
				state.device = { id: stored.id, token: stored.token };
				state.epoch = stored.epoch;
			} else if (!(await pair(link))) {
				return;
			}
		} else if (oldLink && !(stored && stored.token)) {
			card(t("pairOldQr"), t("pairOldQrHint"));
			return;
		} else if (stored && stored.token) {
			state.device = { id: stored.id, token: stored.token };
			state.epoch = stored.epoch;
		} else {
			card("Claude Remote", t("pairOpen"));
			return;
		}
		show("windows");
		renderWindows();
		await connect();
		// Presence and the live cadence: the window list refreshes now and then; an open
		// conversation re-pulls (cheaply — an unchanged transcript answers "same") and so
		// renews its live watch; the list re-pulls more slowly. Window nudges and the live
		// stream wake both in between.
		setInterval(() => requestWindows(), 30000);
		setInterval(() => { if (document.visibilityState === "visible" && state.view === "conversation") schedulePull(0); }, 5000);
		setInterval(() => { if (document.visibilityState === "visible" && state.view === "sessions") schedulePull(0); }, 15000);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState !== "visible") return;
			if (!state.socket && state.device) void connect();
			else schedulePull(50);
		});
	}

	void boot();
})();
