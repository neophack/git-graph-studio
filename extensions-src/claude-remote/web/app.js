/* Claude Remote — the phone app. Plain script (no build), CSP-clean (no inline code or
 * style attributes), sjcl for every byte of crypto: WebCrypto's subtle API is
 * secure-context-only and this page is served on a plain-HTTP LAN origin.
 *
 * Protocol (see server.js): K = PBKDF2-SHA256(code, salt, iterations); every call is
 * AES-256-GCM sealed with AAD "cr2:req:<kid>", every answer with "cr2:res:<nonce>". */
(() => {
	"use strict";

	/* ---------- i18n ---------- */
	const ZH = /^zh/i.test(navigator.language || "");
	const STRINGS = {
		zh: {
			appName: "Claude Remote", tagline: "在手机上继续桌面端的 Claude Code",
			pairTitle: "连接到桌面", pairLead: "扫描桌面端 Claude Remote 面板中的二维码，或输入配对码。",
			pairCode: "配对码", connect: "连接", deriving: "正在派生加密密钥…", verifying: "正在验证…",
			step1: "在桌面端点击状态栏的 Claude Remote", step2: "手机与电脑连接同一局域网", step3: "扫码或输入 24 位配对码",
			secure: "端到端加密 · AES-256-GCM · 密钥不出设备",
			badCode: "配对码不正确", rekeyed: "桌面端已重置配对密钥，请重新扫码配对", locked: "尝试次数过多，请一分钟后再试",
			netFail: "无法连接到桌面端", offline: "与桌面端的连接已断开，正在重试…",
			workspace: "当前工作区", all: "全部项目", search: "搜索对话", newChat: "新对话",
			today: "今天", yesterday: "昨天", week: "近 7 天", earlier: "更早",
			noSessions: "这里还没有对话", noMatch: "没有匹配的对话", loading: "加载中…",
			running: "运行中", desktopBusy: "桌面端运行中", idle: "空闲", queued: "{0} 条排队",
			loadEarlier: "加载更早的消息", thinking: "思考过程", input: "输入", output: "输出", showAll: "显示全部",
			compacted: "上下文已压缩", interrupted: "已中断", fromPhone: "来自手机",
			working: "Claude 正在工作", starting: "正在启动…",
			welcomeTitle: "开始新对话", welcomeSub: "将在 {0} 中运行 Claude Code",
			placeholder: "给 Claude 发送指令…", placeholderBusy: "输入下一条指令…",
			modeQueue: "完成后发送", modeNow: "立即发送",
			hintQueue: "Claude 正在工作 · 本条将在当前轮次结束后发送", hintNow: "将中断当前轮次并立即发送",
			hintDesktop: "桌面端正在处理此对话 · 「完成后发送」会等待其结束",
			stop: "停止", resume: "继续", paused: "队列已暂停", queueTitle: "待发送 · {0}",
			sendNow: "立即发送", cancel: "取消", sentQueued: "已加入队列", sentNow: "已发送",
			runFailed: "上一轮失败", runInterrupted: "上一轮已中断",
			perm: "权限", permTitle: "工具权限模式", permSub: "远程运行为无头模式，无法在手机上逐条确认权限。",
			perm_default: "默认", perm_default_d: "沿用 Claude 设置中的默认权限；需要确认的工具将被拒绝",
			perm_acceptEdits: "自动接受编辑", perm_acceptEdits_d: "文件修改自动通过，其余遵循设置",
			perm_auto: "自动模式", perm_auto_d: "由 Claude 自动判断并批准安全的操作",
			perm_plan: "计划模式", perm_plan_d: "只分析与规划，不修改任何文件",
			perm_bypassPermissions: "跳过权限确认", perm_bypassPermissions_d: "所有工具直接执行 —— 请谨慎使用",
			folderTitle: "选择工作目录", folderSub: "新对话将在此目录中运行",
			settings: "设置", deviceName: "设备名称", theme: "主题", themeAuto: "自动", themeLight: "浅色", themeDark: "深色",
			security: "连接与加密", host: "桌面主机", address: "地址", cipher: "加密", keyId: "密钥 ID", pairedSince: "密钥创建于",
			unpair: "取消配对", unpaired: "已取消配对", copy: "复制", copied: "已复制", jump: "新消息",
			back: "返回", menu: "菜单", errorPrefix: "出错了：",
			modelViaTab: "将在桌面标签页的模型选择器中选取",
			onDesktopGroup: "桌面已打开", onDesktop: "桌面已打开", openOnDesktop: "在桌面打开", openedOnDesktop: "已在桌面打开",
			model: "模型", modelTitle: "运行模型", modelSub: "此条及之后的远程指令使用的模型",
			followDesktop: "跟随桌面", followDesktop_d: "桌面端当前模型：{0}", unknownModel: "账户默认",
			sessionModel: "本对话模型", sessionModel_d: "此对话上一次回答所用：{0}",
			tier_d: "Claude Code 档位别名", tier_resolved: "→ {0}", tierAlias_d: "Claude Code 的 {0} 档位",
			src_settings: "来自设置", src_env: "来自环境变量", src_recent: "最近使用", src_default: "默认",
			askTitle: "Claude 在提问", asked: "已回答", answering: "正在提交…", askSent: "回答已提交",
			answerBtn: "提交回答", pickNeeded: "每个问题至少选择一项",
			otherOpt: "其他…", otherTitle: "输入自定义回答", otherSend: "发送",
			askDesktopOnly: "此对话以无头模式运行，请到桌面端回答"
		},
		en: {
			appName: "Claude Remote", tagline: "Continue desktop Claude Code from your phone",
			pairTitle: "Connect to your desktop", pairLead: "Scan the QR code in the desktop Claude Remote panel, or enter the pairing code.",
			pairCode: "Pairing code", connect: "Connect", deriving: "Deriving the encryption key…", verifying: "Verifying…",
			step1: "On the desktop, click Claude Remote in the status bar", step2: "Put the phone on the same network", step3: "Scan the QR or type the 24-character code",
			secure: "End-to-end encrypted · AES-256-GCM · keys never leave your devices",
			badCode: "That pairing code is not right", rekeyed: "The desktop reset its pairing key — scan the new QR to pair again", locked: "Too many attempts — try again in a minute",
			netFail: "Cannot reach the desktop", offline: "Lost the connection to the desktop — retrying…",
			workspace: "Workspace", all: "All projects", search: "Search conversations", newChat: "New conversation",
			today: "Today", yesterday: "Yesterday", week: "Previous 7 days", earlier: "Earlier",
			noSessions: "No conversations here yet", noMatch: "No matching conversations", loading: "Loading…",
			running: "Running", desktopBusy: "Desktop busy", idle: "Idle", queued: "{0} queued",
			loadEarlier: "Load earlier messages", thinking: "Thinking", input: "Input", output: "Output", showAll: "Show all",
			compacted: "Context compacted", interrupted: "Interrupted", fromPhone: "from phone",
			working: "Claude is working", starting: "Starting…",
			welcomeTitle: "Start a new conversation", welcomeSub: "Claude Code will run in {0}",
			placeholder: "Message Claude…", placeholderBusy: "Type the next instruction…",
			modeQueue: "After this turn", modeNow: "Send now",
			hintQueue: "Claude is working · this sends when the current turn finishes", hintNow: "Interrupts the current turn and sends right away",
			hintDesktop: "The desktop is working on this conversation · “After this turn” waits for it",
			stop: "Stop", resume: "Resume", paused: "Queue paused", queueTitle: "Queued · {0}",
			sendNow: "Send now", cancel: "Cancel", sentQueued: "Queued", sentNow: "Sent",
			runFailed: "The last turn failed", runInterrupted: "The last turn was interrupted",
			perm: "Permissions", permTitle: "Tool permission mode", permSub: "Remote turns run headless — there is no per-tool prompt on the phone.",
			perm_default: "Default", perm_default_d: "Your Claude settings decide; tools that need approval are denied",
			perm_acceptEdits: "Accept edits", perm_acceptEdits_d: "File edits are approved automatically",
			perm_auto: "Auto mode", perm_auto_d: "Claude approves the safe actions on its own",
			perm_plan: "Plan mode", perm_plan_d: "Analyze and plan only — no file changes",
			perm_bypassPermissions: "Bypass permissions", perm_bypassPermissions_d: "Every tool runs unattended — use with care",
			folderTitle: "Working folder", folderSub: "The new conversation runs here",
			settings: "Settings", deviceName: "Device name", theme: "Theme", themeAuto: "Auto", themeLight: "Light", themeDark: "Dark",
			security: "Connection & encryption", host: "Desktop", address: "Address", cipher: "Cipher", keyId: "Key ID", pairedSince: "Key created",
			unpair: "Unpair this phone", unpaired: "Unpaired", copy: "Copy", copied: "Copied", jump: "New messages",
			back: "Back", menu: "Menu", errorPrefix: "Error: ",
			modelViaTab: "picked in the desktop tab's own model selector",
			onDesktopGroup: "Open on the desktop", onDesktop: "On desktop", openOnDesktop: "Open on desktop", openedOnDesktop: "Opened on the desktop",
			model: "Model", modelTitle: "Model", modelSub: "The model this and later remote prompts run with",
			followDesktop: "Follow the desktop", followDesktop_d: "The desktop's current model: {0}", unknownModel: "account default",
			sessionModel: "This conversation's model", sessionModel_d: "Its last answer came from {0}",
			tier_d: "Claude Code tier alias", tier_resolved: "→ {0}", tierAlias_d: "Claude Code's {0} tier",
			src_settings: "from settings", src_env: "from environment", src_recent: "recently used", src_default: "default",
			askTitle: "Claude has a question", asked: "Answered", answering: "Submitting…", askSent: "Answer submitted",
			answerBtn: "Submit answers", pickNeeded: "Pick at least one option per question",
			otherOpt: "Other…", otherTitle: "Type your answer", otherSend: "Send",
			askDesktopOnly: "This conversation runs headless — answer on the desktop"
		}
	};
	const T = ZH ? STRINGS.zh : STRINGS.en;
	const t = (key, ...args) => String(T[key] ?? key).replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? ""));
	document.documentElement.lang = ZH ? "zh-CN" : "en";

	/* ---------- small helpers ---------- */
	const $ = (sel, root = document) => root.querySelector(sel);
	const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	const store = {
		get(k) { try { return JSON.parse(localStorage.getItem("cr." + k)); } catch { return null; } },
		set(k, v) { try { localStorage.setItem("cr." + k, JSON.stringify(v)); } catch { /* private mode */ } },
		del(k) { try { localStorage.removeItem("cr." + k); } catch { /* private mode */ } }
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
	const coarse = matchMedia("(pointer: coarse)").matches;
	const wide = () => matchMedia("(min-width: 900px)").matches;

	const PATHS = {
		logo: '<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
		search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		back: '<path d="m15 18-6-6 6-6"/>',
		settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
		send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
		stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
		zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
		clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
		file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
		edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
		globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
		bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
		list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
		tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
		sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		minus: '<path d="M5 12h14"/>',
		chev: '<path d="m9 18 6-6-6-6"/>',
		down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
		copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
		lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
		shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
		folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
		branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-10.5 6"/>',
		phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
		spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
		play: '<path d="m6 4 14 8-14 8z"/>',
		chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
		cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
		alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
	};
	const icon = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || PATHS.tool}</svg>`;
	const TOOL_ICONS = { Bash: "terminal", PowerShell: "terminal", BashOutput: "terminal", KillShell: "terminal", Read: "file", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Glob: "search", Grep: "search", WebFetch: "globe", WebSearch: "globe", Task: "bot", Agent: "bot", TodoWrite: "list", AskUserQuestion: "chat" };

	function relTime(ms) {
		if (!ms) return "";
		const d = (Date.now() - ms) / 1000;
		if (d < 45) return ZH ? "刚刚" : "now";
		if (d < 3600) return Math.round(d / 60) + (ZH ? " 分钟前" : "m");
		if (d < 86400) return Math.round(d / 3600) + (ZH ? " 小时前" : "h");
		const date = new Date(ms);
		if (d < 7 * 86400) return date.toLocaleDateString(undefined, { weekday: "short" });
		return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
	}
	const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
	const elapsed = (since) => {
		const s = Math.max(0, Math.round((Date.now() - since) / 1000));
		return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
	};

	function toast(text, isErr) {
		const el = document.createElement("div");
		el.className = "toast" + (isErr ? " err" : "");
		el.textContent = text;
		document.body.appendChild(el);
		setTimeout(() => el.remove(), 2600);
	}

	function copyText(text) {
		const done = () => toast(t("copied"));
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(text).then(done, () => legacyCopy(text) && done());
		} else if (legacyCopy(text)) done();
	}
	function legacyCopy(text) {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.className = "hidden-copy";
		document.body.appendChild(ta);
		ta.select();
		let ok = false;
		try { ok = document.execCommand("copy"); } catch { ok = false; }
		ta.remove();
		return ok;
	}

	/* ---------- crypto (sjcl) ---------- */
	const utf8 = (s) => sjcl.codec.utf8String.toBits(s);
	const bitsFromB64u = (s) => sjcl.codec.base64.toBits(String(s).replace(/-/g, "+").replace(/_/g, "/"));
	const b64uFromBits = (b) => sjcl.codec.base64.fromBits(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	function randHex(bytes) {
		const a = crypto.getRandomValues(new Uint8Array(bytes));
		return Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
	}

	let K = null; // { kid, prp, hex }
	let skew = 0;
	const device = store.get("device") || { id: randHex(12), label: guessDeviceName() };
	store.set("device", device);

	function guessDeviceName() {
		const ua = navigator.userAgent || "";
		const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? ((ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/) || [])[1] || "Android") : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Browser";
		const br = /MicroMessenger/.test(ua) ? "WeChat" : /EdgA?\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
		return (os + (br ? " · " + br : "")).slice(0, 60);
	}

	class AuthError extends Error {}

	async function fetchHello() {
		const res = await fetch("/api/hello", { cache: "no-store" });
		if (!res.ok) throw new Error("HTTP " + res.status);
		const h = await res.json();
		skew = h.now - Date.now();
		return h;
	}

	async function api(method, params = {}, attempt = 0) {
		if (!K) throw new AuthError("not paired");
		const nonce = randHex(16);
		const call = { m: method, p: params, ts: Date.now() + skew, n: nonce, dev: { id: device.id, label: device.label } };
		const iv = sjcl.codec.hex.toBits(randHex(12));
		const ct = sjcl.mode.gcm.encrypt(K.prp, utf8(JSON.stringify(call)), iv, utf8("cr2:req:" + K.kid), 128);
		let res;
		try {
			res = await fetch("/api/rpc", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kid: K.kid, i: b64uFromBits(iv), d: b64uFromBits(ct) }),
				cache: "no-store"
			});
		} catch {
			setOnline(false);
			throw new Error(t("netFail"));
		}
		setOnline(true);
		let env;
		try { env = await res.json(); } catch { throw new Error("HTTP " + res.status); }
		if (!env || !env.d) {
			const error = env && env.error;
			if (error === "clock" && attempt < 1) { await fetchHello(); return api(method, params, attempt + 1); }
			if (error === "rekeyed") { onRekeyed(); throw new AuthError(t("rekeyed")); }
			if (error === "auth") throw new AuthError(t("badCode"));
			if (res.status === 429) throw new Error(t("locked"));
			throw new Error(error || "HTTP " + res.status);
		}
		const plain = sjcl.mode.gcm.decrypt(K.prp, bitsFromB64u(env.d), bitsFromB64u(env.i), utf8("cr2:res:" + nonce), 128);
		const out = JSON.parse(sjcl.codec.utf8String.fromBits(plain));
		if (!out.ok) throw new Error(out.error || "error");
		return out.r;
	}

	/* ---------- state ---------- */
	const S = {
		info: null,
		scope: store.get("scope") || "workspace",
		query: "",
		sessions: null,
		current: null, // { id, lane, draft }
		view: null, // { items, hasMore, total, lane, desktopBusy, session }
		limit: 160,
		rev: null,
		cur: null, // { gen, since }: the server's version-stamp cursor of the last sync
		earlier: null, // one-shot: the stamp to load one page of earlier history before
		expanded: new Set(),
		// item id → the tool row's fetched body/result (the sync carries neither; an opened
		// row fetches them once, and the cache survives later windows)
		lazy: new Map(),
		permissionMode: store.get("perm") || "default",
		sendMode: store.get("sendMode") || "queue",
		modelChoice: store.get("model") || null, // null: follow the desktop
		cwd: null,
		online: true,
		sending: false,
		// a pending question card's local state: which item ids are being submitted, the
		// picks per question (item id → question index → Set of labels), and an "Other"
		// pick's text (item id → question index → text)
		answering: new Set(),
		picks: new Map(),
		otherPicks: new Map()
	};
	const imageCache = new Map();

	/* ---------- theme ---------- */
	function applyTheme() {
		const theme = store.get("theme") || "auto";
		if (theme === "auto") delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = theme;
		const dark = theme === "dark" || (theme === "auto" && !matchMedia("(prefers-color-scheme: light)").matches);
		$('meta[name="theme-color"]').setAttribute("content", dark ? "#0d0f13" : "#f6f7f9");
	}
	applyTheme();

	/* ---------- pairing screen ---------- */
	function showPair(message, isErr) {
		$("#app").classList.add("hidden");
		const pair = $("#pair");
		pair.classList.remove("hidden");
		pair.innerHTML = `
			<div class="pair-card">
				<div class="brand"><div class="brand-mark">${icon("logo")}</div><div><h1>${esc(t("appName"))}</h1><p>${esc(t("tagline"))}</p></div></div>
				<h2>${esc(t("pairTitle"))}</h2>
				<p class="lead">${esc(t("pairLead"))}</p>
				<label class="field-label" for="code">${esc(t("pairCode"))}</label>
				<input id="code" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="29" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX">
				<div class="pair-actions"><button class="btn block" id="connect">${icon("lock", "sm")}${esc(t("connect"))}</button></div>
				<div class="pair-status" id="pairStatus"></div>
				<ol class="pair-steps">
					<li><span class="n">1</span>${esc(t("step1"))}</li>
					<li><span class="n">2</span>${esc(t("step2"))}</li>
					<li><span class="n">3</span>${esc(t("step3"))}</li>
				</ol>
				<div class="secure-note">${icon("shield", "sm")}${esc(t("secure"))}</div>
			</div>`;
		const input = $("#code");
		input.addEventListener("input", () => {
			const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 24);
			input.value = raw.match(/.{1,4}/g)?.join("-") ?? "";
		});
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#connect").click(); });
		$("#connect").addEventListener("click", () => pairWith(input.value));
		if (message) pairStatus(message, isErr);
	}

	function pairStatus(text, isErr, busy) {
		const el = $("#pairStatus");
		if (!el) return;
		el.className = "pair-status" + (isErr ? " err" : "");
		el.innerHTML = (busy ? icon("spinner", "sm spin") : isErr ? icon("alert", "sm") : "") + `<span>${esc(text)}</span>`;
		const btn = $("#connect");
		if (btn) btn.disabled = !!busy;
	}

	async function pairWith(rawCode) {
		const code = String(rawCode || "").toUpperCase().replace(/[^0-9A-Z]/g, "").match(/.{1,4}/g)?.join("-") ?? "";
		if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(code)) { pairStatus(t("badCode"), true); return; }
		try {
			pairStatus(t("deriving"), false, true);
			const hello = await fetchHello();
			await frame();
			const bits = sjcl.misc.pbkdf2(utf8(code), bitsFromB64u(hello.salt), hello.iterations, 256);
			K = { kid: hello.kid, prp: new sjcl.cipher.aes(bits), hex: sjcl.codec.hex.fromBits(bits) };
			pairStatus(t("verifying"), false, true);
			const info = await api("hello", {});
			store.set("key", { kid: K.kid, hex: K.hex, at: Date.now() });
			enterApp(info);
		} catch (error) {
			K = null;
			pairStatus(error instanceof AuthError ? error.message : t("netFail") + (error && error.message ? " (" + error.message + ")" : ""), true);
		}
	}

	function onRekeyed() {
		store.del("key");
		K = null;
		stopLoops();
		showPair(t("rekeyed"), true);
	}

	/* ---------- the app shell ---------- */
	function enterApp(info) {
		S.info = info;
		const folders = info.workspace || [];
		if (!S.cwd || !folders.some((f) => f.path === S.cwd)) S.cwd = folders[0] ? folders[0].path : null;
		if (!folders.length) S.scope = "all";
		$("#pair").classList.add("hidden");
		$("#app").classList.remove("hidden");
		renderSidebarShell();
		renderChatShell();
		if (wide()) newDraft();
		refreshSessions();
		startLoops();
	}

	function setOnline(on) {
		if (S.online === on) return;
		S.online = on;
		document.querySelectorAll(".offline").forEach((el) => el.classList.toggle("hidden", on));
		const dot = $("#hostDot");
		if (dot) dot.className = "dot " + (on ? "on" : "off");
	}

	function renderSidebarShell() {
		const info = S.info || {};
		$("#sidebar").innerHTML = `
			<div class="topbar">
				<div class="host">
					<div class="brand-mark">${icon("logo")}</div>
					<div class="host-text">
						<div class="host-name">${esc(info.host || t("appName"))}</div>
						<div class="host-sub"><span id="hostDot" class="dot on"></span><span>${esc((info.workspace || []).map((f) => f.name).join(", ") || location.host)}</span>${info.model && info.model.current ? `<span class="host-model">${icon("cpu", "xs")}${esc(info.model.current)}</span>` : ""}</div>
					</div>
				</div>
				<button class="icon-btn" id="openSettings" aria-label="${esc(t("settings"))}">${icon("settings")}</button>
			</div>
			<div class="offline hidden">${icon("alert", "sm")}${esc(t("offline"))}</div>
			<div class="side-tools">
				<label class="search">${icon("search", "sm")}<input id="q" type="search" placeholder="${esc(t("search"))}" autocomplete="off"></label>
				<div class="seg" id="scope">
					<button data-scope="workspace">${esc(t("workspace"))}</button>
					<button data-scope="all">${esc(t("all"))}</button>
				</div>
				<button class="btn new-btn" id="newChat">${icon("plus", "sm")}${esc(t("newChat"))}</button>
			</div>
			<div id="sessions"><div class="empty">${esc(t("loading"))}</div></div>`;
		$("#openSettings").addEventListener("click", openSettings);
		$("#newChat").addEventListener("click", () => { newDraft(); });
		let qTimer = null;
		$("#q").addEventListener("input", (e) => {
			S.query = e.target.value;
			clearTimeout(qTimer);
			qTimer = setTimeout(refreshSessions, 250);
		});
		$("#scope").addEventListener("click", (e) => {
			const b = e.target.closest("[data-scope]");
			if (!b) return;
			S.scope = b.dataset.scope;
			store.set("scope", S.scope);
			paintScope();
			S.sessions = null;
			renderSessions();
			refreshSessions();
		});
		$("#sessions").addEventListener("click", (e) => {
			const row = e.target.closest("[data-sid]");
			if (!row) return;
			const s = (S.sessions || []).find((x) => (x.lane || x.id) === row.dataset.sid);
			if (s) openSession(s);
		});
		paintScope();
	}

	function paintScope() {
		document.querySelectorAll("#scope [data-scope]").forEach((b) => b.classList.toggle("on", b.dataset.scope === S.scope));
		const ws = $('#scope [data-scope="workspace"]');
		if (ws) ws.disabled = !(S.info && S.info.workspace && S.info.workspace.length);
	}

	async function refreshSessions() {
		try {
			const r = await api("sessions", { scope: S.scope, q: S.query });
			S.sessions = r.sessions;
			renderSessions();
		} catch (error) {
			if (!(error instanceof AuthError) && !S.sessions) $("#sessions").innerHTML = `<div class="empty">${esc(error.message)}</div>`;
		}
	}

	function renderSessions() {
		const box = $("#sessions");
		if (!box) return;
		if (!S.sessions) { box.innerHTML = `<div class="empty">${esc(t("loading"))}</div>`; return; }
		if (!S.sessions.length) {
			box.innerHTML = `<div class="empty">${icon("chat")}<div>${esc(S.query ? t("noMatch") : t("noSessions"))}</div></div>`;
			return;
		}
		const now = new Date();
		const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const groupOf = (ms) => (ms >= startOfDay ? "today" : ms >= startOfDay - 86400000 ? "yesterday" : ms >= startOfDay - 6 * 86400000 ? "week" : "earlier");
		const curKey = S.current && (S.current.id || S.current.lane);
		let html = "";
		let last = null;
		const ordered = [...S.sessions.filter((s) => s.onDesktop), ...S.sessions.filter((s) => !s.onDesktop)];
		for (const s of ordered) {
			const g = s.onDesktop ? "onDesktopGroup" : groupOf(s.mtimeMs);
			if (g !== last) { html += `<div class="group-label">${esc(t(g))}</div>`; last = g; }
			const key = s.lane || s.id;
			const active = curKey && (curKey === s.id || curKey === s.lane || (S.current.lane && S.current.lane === s.lane));
			const tags = [];
			if (s.running) tags.push(`<span class="tag run">${icon("spinner", "xs spin")}${esc(t("running"))}</span>`);
			else if (s.desktopBusy) tags.push(`<span class="tag busy">${icon("clock", "xs")}${esc(t("desktopBusy"))}</span>`);
			if (s.queued) tags.push(`<span class="tag q">${esc(t("queued", s.queued))}</span>`);
			if (S.scope === "all" || (S.info.workspace || []).length > 1) if (s.project) tags.push(`<span class="tag">${icon("folder", "xs")}${esc(s.project)}</span>`);
			if (s.branch) tags.push(`<span class="tag">${icon("branch", "xs")}${esc(s.branch)}</span>`);
			if (s.model) tags.push(`<span class="tag">${icon("cpu", "xs")}${esc(s.model)}</span>`);
			html += `<button class="session${active ? " active" : ""}" data-sid="${esc(key)}">
				<div class="row1"><span class="title">${esc(s.title)}</span><span class="time">${esc(relTime(s.mtimeMs))}</span></div>
				${s.preview ? `<div class="preview">${s.previewRole === "user" ? (ZH ? "你：" : "You: ") : ""}${esc(s.preview)}</div>` : ""}
				${tags.length ? `<div class="meta">${tags.join("")}</div>` : ""}
			</button>`;
		}
		box.innerHTML = html;
	}

	/* ---------- chat ---------- */
	function renderChatShell() {
		$("#chat").innerHTML = `
			<div class="topbar">
				<button class="icon-btn only-mobile" id="back" aria-label="${esc(t("back"))}">${icon("back")}</button>
				<div class="chat-title"><div class="t" id="chatTitle"></div><div class="s" id="chatSub"></div></div>
				<span class="status-chip" id="chatStatus"></span>
				<button class="icon-btn hidden" id="deskBtn" title="${esc(t("openOnDesktop"))}" aria-label="${esc(t("openOnDesktop"))}">${icon("monitor")}</button>
			</div>
			<div class="offline hidden">${icon("alert", "sm")}${esc(t("offline"))}</div>
			<div class="chat-main">
				<div id="scroller"><div id="messages"></div></div>
				<button class="jump hidden" id="jump">${icon("down", "sm")}${esc(t("jump"))}</button>
			</div>
			<div id="dock"><div class="dock-inner">
				<div id="banners"></div>
				<div id="queue"></div>
				<div class="composer">
					<textarea id="input" rows="1" placeholder="${esc(t("placeholder"))}"></textarea>
					<div class="comp-bar">
						<button class="pill hidden" id="folderPill"></button>
						<button class="pill" id="modelPill"></button>
						<button class="pill" id="permPill"></button>
						<button class="pill" id="modePill"></button>
						<span class="grow"></span>
						<button class="send" id="sendBtn" aria-label="send" disabled>${icon("send")}</button>
					</div>
				</div>
				<div class="hint hidden" id="hint"></div>
			</div></div>`;
		const input = $("#input");
		input.addEventListener("input", () => { autosize(); paintComposer(); });
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (!coarse || e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				send();
			}
		});
		$("#sendBtn").addEventListener("click", send);
		$("#back").addEventListener("click", () => history.back());
		$("#permPill").addEventListener("click", openPermSheet);
		$("#modelPill").addEventListener("click", openModelSheet);
		$("#deskBtn").addEventListener("click", async () => {
			const id = S.current && S.current.id;
			if (!id) return;
			try { await api("openOnDesktop", { id }); toast(t("openedOnDesktop")); setTimeout(refreshSessions, 1500); }
			catch (error) { toast(t("errorPrefix") + error.message, true); }
		});
		$("#folderPill").addEventListener("click", openFolderSheet);
		$("#modePill").addEventListener("click", () => {
			S.sendMode = S.sendMode === "now" ? "queue" : "now";
			store.set("sendMode", S.sendMode);
			paintComposer();
		});
		$("#jump").addEventListener("click", () => scrollToBottom(true));
		const scroller = $("#scroller");
		scroller.addEventListener("scroll", () => { if (nearBottom()) $("#jump").classList.add("hidden"); }, { passive: true });
		$("#messages").addEventListener("click", onMessagesClick);
		$("#dock").addEventListener("click", onDockClick);
		paintChat();
	}

	function autosize() {
		const input = $("#input");
		input.style.height = "auto";
		input.style.height = Math.min(input.scrollHeight, Math.round(innerHeight * 0.4)) + "px";
	}

	function newDraft() {
		S.current = { id: null, lane: null, draft: true };
		S.view = { items: [], hasMore: false, total: 0, lane: null, desktopBusy: false, session: null };
		S.rev = null;
		S.cur = null;
		S.expanded.clear();
		S.lazy.clear();
		S.answering.clear();
		S.picks.clear();
		S.otherPicks.clear();
		showChat();
		paintChat();
		renderSessions();
		if (!coarse) $("#input").focus();
	}

	function openSession(s) {
		S.current = { id: s.draft ? null : s.id, lane: s.lane || null, draft: !!s.draft, title: s.title };
		S.view = { items: null, hasMore: false, total: 0, lane: null, desktopBusy: s.desktopBusy, session: s };
		S.limit = 160;
		S.rev = null;
		S.cur = null;
		S.earlier = null;
		S.expanded.clear();
		S.lazy.clear();
		S.answering.clear();
		S.picks.clear();
		S.otherPicks.clear();
		S.firstPaint = true;
		showChat();
		paintChat();
		renderSessions();
		pollSession();
	}

	function showChat() {
		const app = $("#app");
		if (!app.classList.contains("in-chat")) {
			app.classList.add("in-chat");
			if (!wide()) history.pushState({ chat: 1 }, "");
		}
	}
	addEventListener("popstate", () => {
		if (wide()) return;
		$("#app").classList.remove("in-chat");
		S.current = null;
		refreshSessions();
	});

	function laneOf() { return S.view && S.view.lane; }
	function isRunning() { const l = laneOf(); return !!(l && l.running); }
	function desktopBusy() { return !!(S.view && (S.view.desktopBusy || (S.view.session && S.view.session.desktopBusy))); }

	function paintChat() {
		paintHeader();
		renderMessages();
		paintDock();
		paintComposer();
	}

	function paintHeader() {
		const cur = S.current;
		const sess = S.view && S.view.session;
		const title = cur ? (sess && sess.title) || cur.title || t("newChat") : "";
		$("#chatTitle").textContent = title || t("newChat");
		const sub = [];
		const cwd = (sess && sess.cwd) || (cur && cur.draft ? S.cwd : null);
		if (cwd) sub.push(`${icon("folder", "xs")}<span>${esc(cwd.split(/[\\/]/).pop())}</span>`);
		if (sess && sess.branch) sub.push(`${icon("branch", "xs")}<span>${esc(sess.branch)}</span>`);
		const runningModel = isRunning() && laneOf().running.model;
		const shownModel = runningModel || (sess && sess.model);
		if (shownModel) sub.push(`${icon("cpu", "xs")}<span>${esc(shownModel)}</span>`);
		if (sess && sess.onDesktop) sub.push(`${icon("monitor", "xs")}<span>${esc(t("onDesktop"))}</span>`);
		$("#chatSub").innerHTML = sub.join("");
		const chip = $("#chatStatus");
		if (isRunning()) { chip.className = "status-chip run"; chip.innerHTML = icon("spinner", "xs spin") + esc(t("running")); }
		else if (desktopBusy()) { chip.className = "status-chip busy"; chip.innerHTML = icon("clock", "xs") + esc(t("desktopBusy")); }
		else { chip.className = "status-chip"; chip.innerHTML = `<span class="dot on"></span>${esc(t("idle"))}`; }
		chip.classList.toggle("hidden", !cur || (cur.draft && !cur.lane));
		$("#deskBtn").classList.toggle("hidden", !(cur && cur.id));
	}

	/* ---------- markdown (safe subset: everything is escaped first) ---------- */
	const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
	const ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
	const indentOf = (l) => (l.match(/^\s*/)[0].replace(/\t/g, "    ").length);
	const blockStart = (l) => /^\s*(```|~~~|#{1,6}\s|>)/.test(l) || ITEM.test(l);

	function inline(src) {
		const slots = [];
		const hold = (html) => "\u0000" + (slots.push(html) - 1) + "\u0000";
		// NULs are the slot delimiters: one in the source text would resolve to a bogus slot
		let s = String(src).replace(/\u0000/g, "").replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
		s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, (_, text, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`));
		s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, url) => pre + hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
		s = esc(s);
		s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
		s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
		s = s.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
		return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
	}

	function codeBlock(code, lang) {
		return `<div class="codeblock"><div class="bar"><span>${esc(lang || "code")}</span><button data-copy>${icon("copy", "xs")}${esc(t("copy"))}</button></div><pre><code>${esc(code)}</code></pre></div>`;
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
				out.push(codeBlock(buf.join("\n"), fence[2]));
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
				out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
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

	/* ---------- transcript rendering (keyed, so open rows and scroll survive polls) ---------- */
	function displayItems() {
		const v = S.view;
		if (!v || !v.items) return null;
		const items = v.items.slice();
		const lane = v.lane;
		if (lane && lane.running) {
			const since = lane.running.startedAt - 15000;
			const shown = items.some((it) => it.k === "user" && it.text.trim() === lane.running.text.trim() && (!it.t || it.t >= since));
			if (!shown) items.push({ id: "~pending", k: "user", text: lane.running.text, pending: true, remote: true });
		}
		if ((lane && lane.running) || desktopBusy()) items.push({ id: "~working", k: "working" });
		return items;
	}

	function toolStatus(item) {
		if (item.st === "ok") return `<span class="st ok">${icon("check", "sm")}</span>`;
		if (item.st === "err") return `<span class="st err">${icon("x", "sm")}</span>`;
		if (isRunning() || desktopBusy()) return `<span class="st">${icon("spinner", "sm spin")}</span>`;
		return `<span class="st">${icon("minus", "sm")}</span>`;
	}

	function imgs(refs) {
		return (refs || []).map((ref) => `<img data-img="${esc(ref)}" alt="">`).join("");
	}

	function toolBodyHtml(body) {
		if (!body) return "";
		if (body.text === undefined && !body.todos) return `<pre class="lazy">…</pre>`; // not fetched yet
		if (body.kind === "diff") {
			return `<div class="diff">${body.text.split("\n").map((l) => `<div class="${l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : ""}">${esc(l) || " "}</div>`).join("")}</div>`;
		}
		if (body.kind === "todos") {
			const mark = { completed: "check", in_progress: "play", pending: "minus" };
			return `<ul class="todos">${body.todos.map((x) => `<li class="${esc(x.s)}">${icon(mark[x.s] || "minus", "xs")}<span>${esc(x.t)}</span></li>`).join("")}</ul>`;
		}
		return `<pre>${esc(body.text)}${body.clipped ? "\n…" : ""}</pre>`;
	}

	/* ---------- the question card (AskUserQuestion) ---------- */

	/** A pending AskUserQuestion is a live card, not a collapsed tool row: its options
	 *  ride the sync, so the phone can answer without opening anything. */
	function questionBodyOf(item) {
		if (!item || item.k !== "tool" || item.name !== "AskUserQuestion") return null;
		const lazy = S.lazy.get(item.id);
		const body = (lazy && lazy.body) || item.body;
		return body && body.kind === "question" && Array.isArray(body.questions) && body.questions.length ? body : null;
	}

	/** The picks each question landed, from the result's `"question"="answer, answer"`
	 *  summary — best effort; a question that does not match keeps null. */
	function parseAnswered(text, questions) {
		const head = String(text || "").split(/You can now continue/)[0];
		const out = questions.map(() => null);
		const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
		let match;
		while ((match = re.exec(head))) {
			const qi = questions.findIndex((q) => q.q === match[1] || (q.q.length > 24 && (q.q.startsWith(match[1]) || match[1].startsWith(q.q))));
			if (qi >= 0) out[qi] = new Set(String(match[2]).split(", ").filter(Boolean));
		}
		return out;
	}

	function questionHtml(item, questions) {
		const answered = item.st !== "run";
		const submitting = S.answering.has(item.id);
		const res = (S.lazy.get(item.id) || {}).res || item.res;
		const chosen = answered && res && typeof res.text === "string" ? parseAnswered(res.text, questions) : null;
		// answering works through the conversation's desktop tab — the injected backend
		const canAnswer = !answered && !submitting && injection() && !!(S.current && S.current.id);
		const perItem = S.picks.get(item.id) || new Map();
		const texts = S.otherPicks.get(item.id) || {};
		const state = answered
			? `<span class="q-st done">${icon("check", "xs")}${esc(t("asked"))}</span>`
			: submitting
				? `<span class="q-st">${icon("spinner", "xs spin")}${esc(t("answering"))}</span>`
				: `<span class="q-st">${icon("clock", "xs")}</span>`;
		const blocks = questions.map((q, qi) => {
			const picks = perItem.get(qi) || new Set();
			const landed = answered && chosen ? chosen[qi] : null;
			const opts = q.opts.map((o) => {
				const on = answered ? !!landed && landed.has(o.label) : picks.has(o.label);
				const inner = `<div class="q-txt"><div class="ot">${esc(o.label)}</div>${o.desc ? `<div class="od">${esc(o.desc)}</div>` : ""}</div>`;
				const mark = on ? icon("check", "xs") : `<span class="q-bullet"></span>`;
				if (answered || !canAnswer) return `<div class="qopt${on ? " on" : ""} passive">${mark}${inner}</div>`;
				return `<button class="qopt${on ? " on" : ""}" data-answer="${esc(item.id)}" data-q="${qi}" data-pick="${esc(o.label)}">${mark}${inner}</button>`;
			});
			let landedLine = "";
			if (landed && landed.size) {
				// picks that are no offered option — a custom "Other" answer, chiefly
				const extra = [...landed].filter((v) => !q.opts.some((o) => o.label === v));
				if (extra.length) landedLine = `<div class="q-landed">${icon("check", "xs")}<span>${esc(extra.join(", "))}</span></div>`;
			}
			const other = !answered && canAnswer
				? `<button class="qopt other${picks.has("Other") ? " on" : ""}" data-other="${esc(item.id)}" data-q="${qi}">${picks.has("Other") ? icon("check", "xs") : icon("chev", "xs")}<div class="q-txt"><div class="ot">${esc(t("otherOpt"))}${picks.has("Other") && texts[qi] ? " " + esc(texts[qi]) : ""}</div></div></button>`
				: "";
			return `<div class="q-block${q.multi ? " multi" : ""}">${q.header ? `<div class="q-tag">${esc(q.header)}</div>` : ""}<div class="q-text">${esc(q.q)}</div><div class="q-opts">${opts.join("")}${other}</div>${landedLine}</div>`;
		}).join("");
		let actions = "";
		if (!answered && !submitting) {
			if (!injection()) actions = `<div class="q-hint">${icon("monitor", "xs")}<span>${esc(t("askDesktopOnly"))}</span></div>`;
			else if (canAnswer) {
				const ready = questions.every((q, qi) => (perItem.get(qi) || new Set()).size > 0);
				actions = `<div class="q-actions">${ready
					? `<button class="btn block" data-confirm-answer="${esc(item.id)}">${icon("send", "xs")}${esc(t("answerBtn"))}</button>`
					: `<span class="q-hint">${esc(t("pickNeeded"))}</span>`}</div>`;
			}
		} else if (answered && res && typeof res.text === "string" && (!chosen || chosen.every((set) => !set))) {
			// the summary line did not parse: the raw result is the answer shown
			actions = `<pre class="q-res">${esc(res.text.split("\n")[0].slice(0, 300))}</pre>`;
		}
		return `<div class="qcard${answered ? " done" : ""}"><div class="q-head"><span class="ico">${icon("chat", "sm")}</span><span class="name">${esc(t("askTitle"))}</span>${state}</div>${blocks}${actions}</div>`;
	}

	/** A tap toggles one option of one question: radios keep a single pick, checkboxes
	 *  toggle; the card submits only when every question holds a pick. */
	function onQuestionPick(btn) {
		const id = btn.dataset.answer;
		const qi = Number(btn.dataset.q);
		const label = String(btn.dataset.pick || "");
		const item = (S.view && S.view.items || []).find((it) => it.id === id);
		const body = questionBodyOf(item);
		if (!body || !body.questions[qi] || item.st !== "run" || S.answering.has(id) || !injection()) return;
		let perItem = S.picks.get(id);
		if (!perItem) { perItem = new Map(); S.picks.set(id, perItem); }
		let picks = perItem.get(qi);
		if (!picks) { picks = new Set(); perItem.set(qi, picks); }
		if (picks.has(label)) picks.delete(label);
		else {
			if (!body.questions[qi].multi) picks.clear();
			picks.add(label);
		}
		rerenderItem(id);
	}

	/** "Other…" opens its own sheet: the text rides the pick as its label's payload. */
	function openOtherSheet(btn) {
		const id = btn.dataset.other;
		const qi = Number(btn.dataset.q);
		const { el, close } = sheet(`<h3>${esc(t("otherTitle"))}</h3><textarea id="otherText" rows="3" maxlength="500" placeholder="${esc(t("otherTitle"))}"></textarea><button class="btn block" id="otherSend">${esc(t("otherSend"))}</button>`, () => { /* the button owns the sheet */ });
		const send = () => {
			const text = $("#otherText", el).value.trim();
			if (!text) return;
			const item = (S.view && S.view.items || []).find((it) => it.id === id);
			const body = questionBodyOf(item);
			if (!body || !body.questions[qi] || item.st !== "run" || S.answering.has(id)) { close(); return; }
			let perItem = S.picks.get(id);
			if (!perItem) { perItem = new Map(); S.picks.set(id, perItem); }
			let picks = perItem.get(qi);
			if (!picks) { picks = new Set(); perItem.set(qi, picks); }
			if (!body.questions[qi].multi) picks.clear();
			picks.add("Other");
			const texts = S.otherPicks.get(id) || {};
			texts[qi] = text;
			S.otherPicks.set(id, texts);
			close();
			rerenderItem(id);
		};
		$("#otherSend", el).addEventListener("click", send);
		$("#otherText", el).addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); });
		setTimeout(() => $("#otherText", el).focus(), 60);
	}

	/** Submit the card: the conversation's desktop tab clicks its own question card with
	 *  these picks (server.js `answer`), and the next poll flips the card to answered. */
	async function submitAnswer(id) {
		const item = (S.view && S.view.items || []).find((it) => it.id === id);
		const body = questionBodyOf(item);
		if (!body || item.st !== "run" || S.answering.has(id) || !injection()) return;
		const perItem = S.picks.get(id) || new Map();
		const texts = S.otherPicks.get(id) || {};
		const answers = body.questions.map((q, qi) => {
			const picks = [...(perItem.get(qi) || new Set())];
			return { question: q.q, header: q.header, picks, other: picks.includes("Other") ? texts[qi] || "" : undefined };
		});
		if (!answers.every((a) => a.picks.length && (!a.picks.includes("Other") || a.other))) return;
		S.answering.add(id);
		rerenderItem(id);
		try {
			await api("answer", { id: S.current.id, item: id, answers });
			toast(t("askSent"));
			setTimeout(pollSession, 400);
		} catch (error) {
			S.answering.delete(id);
			rerenderItem(id);
			toast(t("errorPrefix") + error.message, true);
		}
	}

	function itemHtml(item) {
		const open = S.expanded.has(item.id) ? " open" : "";
		switch (item.k) {
			case "user": {
				const chips = item.chips && item.chips.length ? `<div class="chips">${item.chips.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>` : "";
				const foot = [];
				if (item.remote) foot.push(`${icon("phone", "xs")}<span>${esc(t("fromPhone"))}</span>`);
				if (item.pending) foot.push(`${icon("spinner", "xs spin")}<span>${esc(t("starting"))}</span>`);
				else if (item.t) foot.push(`<span>${esc(clock(item.t))}</span>`);
				return `<div class="msg user">${chips}<div class="bubble${item.pending ? " pending" : ""}">${esc(item.text)}${imgs(item.imgs)}</div><div class="msg-foot">${foot.join("")}</div></div>`;
			}
			case "assistant":
				return `<div class="msg assistant md">${md(item.text)}</div>`;
			case "thinking":
				return `<div class="thinking${open}"><button class="row-head" data-toggle="${esc(item.id)}"><span class="ico">${icon("sparkle", "sm")}</span><span class="name">${esc(t("thinking"))}</span><span class="sum">${esc(item.text.split("\n").find((l) => l.trim()) || "")}</span><span class="chev">${icon("chev", "sm")}</span></button><div class="row-body">${esc(item.text)}</div></div>`;
			case "tool": {
				// the sync carries neither the input body nor the result text: an opened row
				// fetches them (ensureToolContent) and renders from the cache afterwards
				// (a question card is the exception — its options ride the sync itself)
				if (item.name === "AskUserQuestion") {
					const body = questionBodyOf(item);
					if (body) return questionHtml(item, body.questions);
				}
				const lazy = S.lazy.get(item.id);
				const res = (lazy && lazy.res) || item.res;
				const result = res
					? res.text === undefined
						? `<div class="label">${esc(t("output"))}</div><pre class="lazy">…</pre>`
						: `<div class="label">${esc(t("output"))}</div><pre class="${res.err ? "err" : ""}" data-result="${esc(item.id)}">${esc(res.text || "∅")}</pre>${res.more ? `<button class="more-btn" data-more="${esc(item.id)}">${esc(t("showAll"))}</button>` : ""}${res.imgs && res.imgs.length ? `<div class="result-imgs">${imgs(res.imgs)}</div>` : ""}`
					: "";
				const body = (lazy && lazy.body) || item.body;
				return `<div class="tool${open}"><button class="row-head" data-toggle="${esc(item.id)}"><span class="ico">${icon(TOOL_ICONS[item.name] || "tool", "sm")}</span><span class="name">${esc(item.name)}</span><span class="sum">${esc(item.sum || "")}</span>${toolStatus(item)}<span class="chev">${icon("chev", "sm")}</span></button><div class="row-body"><div class="label">${esc(t("input"))}</div>${toolBodyHtml(body)}${result}</div></div>`;
			}
			case "notice": {
				const text = item.text === "compacted" ? t("compacted") : item.text === "interrupted" ? t("interrupted") : item.text;
				return `<div class="notice ${esc(item.lvl || "info")}"><span>${esc(text)}</span></div>`;
			}
			case "working":
				return `<div class="working"><span class="pulse"><i></i><i></i><i></i></span><span>${esc(t("working"))}</span></div>`;
			default:
				return "";
		}
	}

	const rendered = new Map(); // id → { el, sig }
	function sigOf(item) {
		return JSON.stringify(item) + (item.k === "tool" ? "|" + (isRunning() || desktopBusy()) : "") + (S.expanded.has(item.id) ? "|o" : "");
	}

	/** An opened tool row fetches its input body and result once (a row opened while the
	 *  tool still runs refetches when the result lands). A failure leaves the placeholder;
	 *  the next open retries. */
	function ensureToolContent(item) {
		if (!item || item.k !== "tool" || !S.current || !S.current.id) return;
		let lazy = S.lazy.get(item.id);
		if (!lazy) { lazy = {}; S.lazy.set(item.id, lazy); }
		const needRes = !!item.res && (lazy.res === undefined || lazy.res === null);
		if (lazy.body !== undefined && !needRes) return; // cached complete
		if (lazy.pending) return;
		lazy.pending = true;
		api("tool", { id: S.current.id, item: item.id }).then((r) => {
			lazy.body = r.body || null;
			lazy.res = r.res || null;
			lazy.pending = false;
			rerenderItem(item.id);
		}).catch(() => { lazy.pending = false; });
	}

	/** One row redrawn in place — the keyed renderer's mechanism, for content that arrived
	 *  outside a poll. */
	function rerenderItem(id) {
		const entry = rendered.get(id);
		const item = (S.view && S.view.items || []).find((it) => it.id === id);
		if (!entry || !item) return;
		const holder = document.createElement("div");
		holder.innerHTML = itemHtml(item);
		const el = holder.firstElementChild;
		if (!el) return;
		el.dataset.key = item.id;
		entry.el.replaceWith(el);
		entry.el = el;
		entry.sig = sigOf(item);
		loadImages(el);
	}

	function renderMessages() {
		const box = $("#messages");
		if (!box) return;
		const cur = S.current;
		const items = displayItems();
		if (!cur) { box.innerHTML = ""; rendered.clear(); return; }
		if (cur.draft && !cur.lane && (!items || !items.length)) {
			rendered.clear();
			const folder = S.cwd ? S.cwd.split(/[\\/]/).pop() : location.host;
			box.innerHTML = `<div class="welcome"><div class="brand-mark">${icon("logo")}</div><h3>${esc(t("welcomeTitle"))}</h3><p>${esc(t("welcomeSub", folder))}</p></div>`;
			return;
		}
		if (!items) {
			rendered.clear();
			box.innerHTML = `<div class="empty">${icon("spinner", "spin")}<div>${esc(t("loading"))}</div></div>`;
			return;
		}
		const stick = S.firstPaint || nearBottom();
		const before = $("#scroller").scrollHeight;
		if (box.firstElementChild && !box.firstElementChild.dataset.key && !box.firstElementChild.classList.contains("load-more")) { box.innerHTML = ""; rendered.clear(); }
		// load-more row
		let more = box.querySelector(".load-more");
		if (S.view.hasMore && !more) {
			more = document.createElement("div");
			more.className = "load-more";
			more.innerHTML = `<button data-earlier>${esc(t("loadEarlier"))}</button>`;
			box.prepend(more);
		} else if (!S.view.hasMore && more) more.remove();
		const wanted = new Set();
		let anchor = more || null;
		let appended = false;
		for (const item of items) {
			const sig = sigOf(item);
			wanted.add(item.id);
			let entry = rendered.get(item.id);
			if (!entry || entry.sig !== sig) {
				const holder = document.createElement("div");
				holder.innerHTML = itemHtml(item);
				const el = holder.firstElementChild || document.createElement("div");
				el.dataset.key = item.id;
				if (entry) entry.el.replaceWith(el);
				else appended = true;
				entry = { el, sig };
				rendered.set(item.id, entry);
				loadImages(el);
			}
			if (item.k === "tool" && S.expanded.has(item.id)) ensureToolContent(item);
			if (item.k === "tool" && item.name === "AskUserQuestion" && item.st !== "run") {
				// the card landed: its local picks are spent, and the answered rendering
				// wants the result text — the one thing the sync never carries
				S.answering.delete(item.id);
				S.picks.delete(item.id);
				S.otherPicks.delete(item.id);
				const lazy = S.lazy.get(item.id);
				if (!lazy || !lazy.res || lazy.res.text === undefined) ensureToolContent(item);
			}
			const expectedNext = anchor ? anchor.nextSibling : box.firstChild;
			if (expectedNext !== entry.el) box.insertBefore(entry.el, expectedNext);
			anchor = entry.el;
		}
		for (const [id, entry] of rendered) {
			if (!wanted.has(id)) { entry.el.remove(); rendered.delete(id); }
		}
		if (S.firstPaint) { S.firstPaint = false; scrollToBottom(); }
		else if (S.keepOffset) { $("#scroller").scrollTop += $("#scroller").scrollHeight - before; S.keepOffset = false; }
		else if (stick) scrollToBottom();
		else if (appended) $("#jump").classList.remove("hidden");
	}

	function nearBottom() {
		const s = $("#scroller");
		return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 120;
	}
	function scrollToBottom(smooth) {
		const s = $("#scroller");
		if (!s) return;
		if (smooth && s.scrollTo) s.scrollTo({ top: s.scrollHeight, behavior: "smooth" });
		else s.scrollTop = s.scrollHeight;
		$("#jump").classList.add("hidden");
	}

	function loadImages(root) {
		root.querySelectorAll("img[data-img]").forEach((img) => {
			const tool = img.closest(".tool");
			if (tool && !tool.classList.contains("open")) return; // loads when the row opens
			const ref = img.dataset.img;
			img.removeAttribute("data-img");
			const id = S.current && S.current.id;
			if (!id) return;
			const cached = imageCache.get(id + "|" + ref);
			if (cached) { img.src = cached; return; }
			api("image", { id, ref }).then((r) => {
				const url = "data:" + r.mime + ";base64," + r.data;
				imageCache.set(id + "|" + ref, url);
				img.src = url;
			}).catch(() => { img.alt = "image unavailable"; });
		});
	}

	function onMessagesClick(e) {
		const toggle = e.target.closest("[data-toggle]");
		if (toggle) {
			const id = toggle.dataset.toggle;
			const row = toggle.parentElement;
			if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
			row.classList.toggle("open", S.expanded.has(id));
			const entry = rendered.get(id);
			if (S.expanded.has(id)) {
				// the row's content and its result images ride this fetch, not the sync
				ensureToolContent((S.view && S.view.items || []).find((it) => it.id === id));
				if (entry) loadImages(entry.el);
			}
			if (entry) entry.sig += "|stale"; // re-render with the right open state next poll
			return;
		}
		const pick = e.target.closest("[data-answer]");
		if (pick) { onQuestionPick(pick); return; }
		const otherBtn = e.target.closest("[data-other]");
		if (otherBtn) { openOtherSheet(otherBtn); return; }
		const submit = e.target.closest("[data-confirm-answer]");
		if (submit) { submitAnswer(submit.dataset.confirmAnswer); return; }
		const copy = e.target.closest("[data-copy]");
		if (copy) { copyText(copy.closest(".codeblock").querySelector("code").textContent); return; }
		const more = e.target.closest("[data-more]");
		if (more) {
			const id = more.dataset.more;
			more.disabled = true;
			api("detail", { id: S.current.id, item: id }).then((r) => {
				const pre = $(`[data-result="${CSS.escape(id)}"]`);
				if (pre) pre.textContent = r.text;
				more.remove();
			}).catch((error) => { more.disabled = false; toast(error.message, true); });
			return;
		}
		if (e.target.closest("[data-earlier]")) {
			// One page before the oldest item held: the server parses history backward on
			// demand and only the new page crosses — not the whole window again.
			const items = S.view.items || [];
			const oldest = items.reduce((m, it) => Math.min(m, Number(it.q) || 0), Infinity);
			if (oldest !== Infinity) S.earlier = oldest;
			S.keepOffset = true;
			pollSession();
		}
	}

	/* ---------- the dock: run banner, queue tray, composer ---------- */
	let tickTimer = null;
	function paintDock() {
		const lane = laneOf();
		const banners = [];
		if (lane && lane.running) {
			banners.push(`<div class="banner run">${icon("spinner", "sm spin")}<span class="txt"><b>${esc(t("running"))}</b>${lane.running.model ? " · " + esc(lane.running.model) : ""} · <span data-since="${lane.running.startedAt}">${elapsed(lane.running.startedAt)}</span> · ${esc(lane.running.text)}</span><button class="mini stop" data-act="stop">${icon("stop", "xs")}${esc(t("stop"))}</button></div>`);
		} else if (lane && lane.last && (lane.last.status === "error") && Date.now() - lane.last.endedAt < 10 * 60 * 1000) {
			banners.push(`<div class="banner err">${icon("alert", "sm")}<span class="txt">${esc(t("runFailed"))}${lane.last.error ? "：" + esc(lane.last.error) : ""}</span></div>`);
		}
		$("#banners").innerHTML = banners.join("");
		const queue = lane && lane.queue && lane.queue.length ? lane.queue : [];
		$("#queue").innerHTML = queue.length ? `<div class="queue">
			<div class="queue-head">${icon("clock", "xs")}<span class="grow">${esc(t("queueTitle", queue.length))}${lane.paused ? " · " + esc(t("paused")) : ""}</span>${lane.paused ? `<button data-act="resume">${esc(t("resume"))}</button>` : ""}</div>
			${queue.map((q) => `<div class="q-item">${q.mode === "now" ? icon("zap", "xs") : icon("clock", "xs")}<span class="txt">${esc(q.text)}</span><button class="icon-btn" data-act="promote" data-entry="${esc(q.id)}" title="${esc(t("sendNow"))}">${icon("zap", "sm")}</button><button class="icon-btn" data-act="cancel" data-entry="${esc(q.id)}" title="${esc(t("cancel"))}">${icon("x", "sm")}</button></div>`).join("")}
		</div>` : "";
		clearInterval(tickTimer);
		if (lane && lane.running) {
			tickTimer = setInterval(() => {
				document.querySelectorAll("[data-since]").forEach((el) => { el.textContent = elapsed(Number(el.dataset.since)); });
			}, 1000);
		}
	}

	function paintComposer() {
		const input = $("#input");
		if (!input) return;
		const busy = isRunning() || desktopBusy();
		input.placeholder = busy ? t("placeholderBusy") : t("placeholder");
		$("#sendBtn").disabled = S.sending || !input.value.trim() || !S.current || (S.current.draft && !S.current.lane && !S.cwd);
		$("#sendBtn").innerHTML = busy && S.sendMode === "now" ? icon("zap") : icon("send");
		// The model pill: a phone pick always shows (and rides the next prompt); without
		// one, an injected conversation shows the tab's model (the conversation's own, else
		// the desktop's), a headless one the desktop's.
		const injected = injection();
		const modelPill = $("#modelPill");
		const sessModel = S.view && S.view.session && S.view.session.model;
		modelPill.innerHTML = icon("cpu", "xs") + esc(S.modelChoice ? shownModelName(S.modelChoice) : injected ? sessModel || desktopModelName() : desktopModelName());
		modelPill.classList.toggle("mode-now", !!S.modelChoice);
		const perm = $("#permPill");
		perm.classList.toggle("hidden", injected);
		perm.innerHTML = icon("shield", "xs") + esc(t("perm_" + S.permissionMode));
		perm.classList.toggle("warn", S.permissionMode === "bypassPermissions");
		const mode = $("#modePill");
		mode.innerHTML = (S.sendMode === "now" ? icon("zap", "xs") : icon("clock", "xs")) + esc(S.sendMode === "now" ? t("modeNow") : t("modeQueue"));
		mode.classList.toggle("mode-now", S.sendMode === "now");
		const folders = (S.info && S.info.workspace) || [];
		const folderPill = $("#folderPill");
		const isNew = S.current && S.current.draft && !S.current.lane;
		folderPill.classList.toggle("hidden", !isNew || folders.length < 2);
		if (S.cwd) folderPill.innerHTML = icon("folder", "xs") + esc(S.cwd.split(/[\\/]/).pop());
		const hint = $("#hint");
		let text = "";
		if (isRunning()) text = S.sendMode === "now" ? t("hintNow") : t("hintQueue");
		else if (desktopBusy()) text = t("hintDesktop");
		hint.textContent = text;
		hint.classList.toggle("hidden", !text);
	}

	async function onDockClick(e) {
		const btn = e.target.closest("[data-act]");
		if (!btn) return;
		const lane = laneOf();
		if (!lane) return;
		btn.disabled = true;
		try {
			const r = await api(btn.dataset.act, { lane: lane.lane, entry: btn.dataset.entry });
			if (r && r.state) S.view.lane = r.state;
			paintChat();
			setTimeout(pollSession, 400);
		} catch (error) {
			toast(t("errorPrefix") + error.message, true);
		} finally {
			btn.disabled = false;
		}
	}

	async function send() {
		const input = $("#input");
		const text = input.value.trim();
		const cur = S.current;
		if (!text || S.sending || !cur) return;
		S.sending = true;
		paintComposer();
		const params = { text, mode: S.sendMode, permissionMode: S.permissionMode };
		if (S.modelChoice) params.model = S.modelChoice;
		if (cur.lane) params.lane = cur.lane;
		if (cur.id) params.sessionId = cur.id;
		if (!cur.id && !cur.lane) { params.draftId = randHex(8); params.cwd = S.cwd; }
		try {
			const r = await api("send", params);
			input.value = "";
			autosize();
			if (!cur.lane) cur.lane = r.lane;
			if (!cur.id && r.state && r.state.sessionId) { cur.id = r.state.sessionId; cur.draft = false; }
			if (!S.view.items) S.view.items = [];
			S.view.lane = r.state;
			S.rev = null;
			const queued = r.state && r.state.queue && r.state.queue.some((q) => q.id === r.entry);
			toast(queued ? t("sentQueued") : t("sentNow"));
			paintChat();
			scrollToBottom();
			refreshSessions();
			setTimeout(pollSession, 600);
		} catch (error) {
			toast(t("errorPrefix") + error.message, true);
		} finally {
			S.sending = false;
			paintComposer();
		}
	}

	/** A delta's items merge into what the phone already holds: an id that exists is
	 *  replaced in place, a new one lands where its version stamp says (appended at the
	 *  end, or prepended by an earlier-history page — the stamp is the file's order). */
	function mergeItems(incoming) {
		const prev = S.view.items || (S.view.items = []);
		if (!prev.length) { prev.push(...incoming); return; }
		const map = new Map(prev.map((it) => [it.id, it]));
		const added = [];
		for (const it of incoming) {
			if (map.has(it.id)) map.set(it.id, it);
			else added.push(it);
		}
		S.view.items = [...map.values(), ...added].sort((a, b) => (Number(a.q) || 0) - (Number(b.q) || 0));
	}

	async function pollSession() {
		const cur = S.current;
		if (!cur || (!cur.id && !cur.lane)) return;
		const earlier = S.earlier;
		S.earlier = null;
		try {
			const r = await api("session", { id: cur.id || cur.lane, lane: cur.lane || undefined, limit: S.limit, rev: S.rev, cur: S.cur || undefined, before: earlier != null ? earlier : undefined });
			if (cur !== S.current) return;
			S.rev = r.rev;
			// An earlier-history page must not advance the delta cursor: items appended
			// since the last sync would fall behind its new high-water and never arrive.
			if (r.cur && earlier == null) S.cur = r.cur;
			if (r.draft) {
				S.view.lane = r.lane;
				if (!S.view.items) S.view.items = [];
				paintChat();
				return;
			}
			if (r.id && cur.id !== r.id) { cur.id = r.id; cur.draft = false; refreshSessions(); }
			S.view.lane = r.lane;
			S.view.session = r.session;
			if (!r.same) {
				if (r.delta && S.view.items && S.view.items.length) {
					mergeItems(r.items);
					S.view.hasMore = !!r.hasMore || r.total > S.view.items.length;
				} else {
					S.view.items = r.items;
					S.view.hasMore = r.hasMore;
				}
				S.view.total = r.total;
				S.view.desktopBusy = r.desktopBusy;
			} else if (r.session) {
				S.view.desktopBusy = r.session.desktopBusy;
			}
			paintChat();
		} catch (error) {
			if (earlier != null && cur === S.current && S.earlier == null) S.earlier = earlier; // the click survives a failed poll
			if (cur === S.current && !(error instanceof AuthError) && S.view && !S.view.items) {
				$("#messages").innerHTML = `<div class="empty">${icon("alert")}<div>${esc(error.message)}</div></div>`;
			}
		}
	}

	/* ---------- sheets ---------- */
	function sheet(html, onClick) {
		const layer = $("#layer");
		layer.innerHTML = `<div class="sheet-back"><div class="sheet" role="dialog"><div class="grabber"></div>${html}</div></div>`;
		const back = layer.firstElementChild;
		const close = () => { layer.innerHTML = ""; };
		back.addEventListener("click", (e) => {
			if (e.target === back) { close(); return; }
			onClick && onClick(e, close);
		});
		return { close, el: back };
	}

	function openPermSheet() {
		const modes = (S.info && S.info.permissionModes) || ["default", "auto", "acceptEdits", "plan", "bypassPermissions"];
		const icons = { default: "shield", auto: "sparkle", acceptEdits: "edit", plan: "list", bypassPermissions: "zap" };
		sheet(`<h3>${esc(t("permTitle"))}</h3><p class="sub">${esc(t("permSub"))}</p>${modes.map((m) => `<button class="opt${m === S.permissionMode ? " on" : ""}" data-perm="${esc(m)}">${icon(icons[m] || "shield")}<div><div class="ot">${esc(t("perm_" + m))}</div><div class="od">${esc(t("perm_" + m + "_d"))}</div></div></button>`).join("")}`, (e, close) => {
			const b = e.target.closest("[data-perm]");
			if (!b) return;
			S.permissionMode = b.dataset.perm;
			store.set("perm", S.permissionMode);
			paintComposer();
			close();
		});
	}

	function desktopModelName() {
		const m = S.info && S.info.model;
		return (m && m.current) || t("unknownModel");
	}

	/** A model name as the phone shows it: a tier alias picked here becomes the third-party
	 *  model the desktop resolves it to (the model info's tier remap), so a provider is
	 *  named by its own models; anything else shows as-is. */
	function shownModelName(id) {
		if (!id) return id;
		const base = String(id).replace(/\[1m\]$/i, "");
		const hit = ((S.info && S.info.model && S.info.model.tiers) || []).find((x) => x.id === base && x.resolved);
		return hit ? hit.resolved : id;
	}

	function injection() {
		return !!(S.info && S.info.injection);
	}

	async function openModelSheet() {
		let info = S.info && S.info.model;
		const id = S.current && S.current.id;
		try {
			info = await api("models", id ? { id } : { cwd: S.cwd });
			if (S.info) S.info.model = { ...info, session: undefined };
		} catch { /* the cached answer serves */ }
		info = info || { current: null, tiers: [], source: "default" };
		const options = [{ id: null, title: t("followDesktop"), desc: t("followDesktop_d", (info.current || t("unknownModel")) + (info.source ? " · " + t("src_" + info.source) : "")), icon: "monitor" }];
		if (info.session && info.session !== info.current) options.push({ id: info.session, title: t("sessionModel"), desc: t("sessionModel_d", info.session), icon: "chat" });
		// A third-party provider serves its own models: a tier whose alias the provider env
		// remaps is offered under that model's name (aliases remapping to the same model
		// collapse into one pick); without a remap the alias is the model, as on the official service.
		const seenModels = new Set();
		for (const tier of info.tiers || []) {
			if (tier.resolved) {
				if (seenModels.has(tier.resolved)) continue;
				seenModels.add(tier.resolved);
				options.push({ id: tier.id, title: tier.resolved, desc: t("tierAlias_d", tier.id), icon: "cpu" });
			} else {
				options.push({ id: tier.id, title: tier.id, desc: t("tier_d"), icon: "cpu" });
			}
		}
		if (S.modelChoice && !options.some((o) => o.id === S.modelChoice)) options.push({ id: S.modelChoice, title: shownModelName(S.modelChoice), desc: "", icon: "cpu" });
		const sub = t("modelSub") + (injection() ? " · " + t("modelViaTab") : "") + (info.provider ? " · " + info.provider : "");
		sheet(`<h3>${esc(t("modelTitle"))}</h3><p class="sub">${esc(sub)}</p>${options.map((o) => `<button class="opt${(o.id || null) === (S.modelChoice || null) ? " on" : ""}" data-model="${esc(o.id || "")}">${icon(o.icon)}<div><div class="ot">${esc(o.title)}</div><div class="od">${esc(o.desc)}</div></div></button>`).join("")}`, (e, close) => {
			const b = e.target.closest("[data-model]");
			if (!b) return;
			S.modelChoice = b.dataset.model || null;
			store.set("model", S.modelChoice);
			paintChat();
			close();
		});
	}

	function openFolderSheet() {
		const folders = (S.info && S.info.workspace) || [];
		sheet(`<h3>${esc(t("folderTitle"))}</h3><p class="sub">${esc(t("folderSub"))}</p>${folders.map((f) => `<button class="opt${f.path === S.cwd ? " on" : ""}" data-folder="${esc(f.path)}">${icon("folder")}<div><div class="ot">${esc(f.name)}</div><div class="od">${esc(f.path)}</div></div></button>`).join("")}`, (e, close) => {
			const b = e.target.closest("[data-folder]");
			if (!b) return;
			S.cwd = b.dataset.folder;
			paintChat();
			close();
		});
	}

	function openSettings() {
		const info = S.info || {};
		const theme = store.get("theme") || "auto";
		const since = info.keyCreatedAt ? new Date(info.keyCreatedAt).toLocaleString() : "—";
		const { el, close } = sheet(`
			<h3>${esc(t("settings"))}</h3>
			<div class="set-row"><span>${esc(t("deviceName"))}</span><input id="devName" value="${esc(device.label)}" maxlength="60"></div>
			<div class="set-row"><span>${esc(t("theme"))}</span><div class="seg mini" id="themeSeg">
				<button data-theme="auto" class="${theme === "auto" ? "on" : ""}">${esc(t("themeAuto"))}</button>
				<button data-theme="light" class="${theme === "light" ? "on" : ""}">${esc(t("themeLight"))}</button>
				<button data-theme="dark" class="${theme === "dark" ? "on" : ""}">${esc(t("themeDark"))}</button>
			</div></div>
			<h3 class="sec-title">${esc(t("security"))}</h3>
			<dl class="kv">
				<dt>${esc(t("host"))}</dt><dd>${esc(info.host || "—")}</dd>
				<dt>${esc(t("address"))}</dt><dd>${esc(location.host)}</dd>
				<dt>${esc(t("cipher"))}</dt><dd>AES-256-GCM · PBKDF2-SHA256</dd>
				<dt>${esc(t("keyId"))}</dt><dd>${esc(K ? K.kid : "—")}</dd>
				<dt>${esc(t("pairedSince"))}</dt><dd>${esc(since)}</dd>
			</dl>
			<button class="btn danger block" id="unpair">${esc(t("unpair"))}</button>`, async (e, closeSheet) => {
			const th = e.target.closest("[data-theme]");
			if (th) {
				store.set("theme", th.dataset.theme);
				applyTheme();
				el.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("on", b === th));
				return;
			}
			if (e.target.closest("#unpair")) {
				try { await api("forget", {}); } catch { /* unpair locally regardless */ }
				store.del("key");
				K = null;
				stopLoops();
				closeSheet();
				showPair(t("unpaired"));
			}
		});
		$("#devName", el).addEventListener("change", (e) => {
			const v = e.target.value.trim();
			if (v) { device.label = v.slice(0, 60); store.set("device", device); }
		});
		return close;
	}

	/* ---------- polling ---------- */
	let loopTimer = null;
	let lastList = 0;
	function startLoops() {
		stopLoops();
		const tick = async () => {
			if (!K) return;
			if (!document.hidden) {
				const chatVisible = wide() || $("#app").classList.contains("in-chat");
				if (chatVisible && S.current && (S.current.id || S.current.lane)) await pollSession();
				const listVisible = wide() || !$("#app").classList.contains("in-chat");
				const listEvery = listVisible ? 6000 : 20000;
				if (Date.now() - lastList > listEvery) { lastList = Date.now(); await refreshSessions(); }
			}
			const active = isRunning() || desktopBusy() || (laneOf() && laneOf().queue && laneOf().queue.length);
			// deltas are tiny: an active conversation polls tighter than an idle one
			loopTimer = setTimeout(tick, !S.online ? 3000 : active ? 1200 : 3500);
		};
		loopTimer = setTimeout(tick, 1500);
	}
	function stopLoops() { clearTimeout(loopTimer); loopTimer = null; }
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && K) { lastList = 0; startLoops(); pollSession(); }
	});
	matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", applyTheme);

	/* ---------- boot ---------- */
	async function boot() {
		// Scan-to-pair: the code rides the URL fragment (never sent to any server); read it,
		// then strip it from the address bar so the secret does not linger in history.
		const hash = location.hash.replace(/^#/, "").replace(/^p=/, "").trim().toUpperCase();
		if (/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(hash)) {
			history.replaceState(null, "", location.pathname);
			showPair();
			$("#code").value = hash;
			pairWith(hash);
			return;
		}
		const saved = store.get("key");
		if (saved && saved.kid && saved.hex) {
			try {
				const hello = await fetchHello();
				if (hello.kid !== saved.kid) { store.del("key"); showPair(t("rekeyed"), true); return; }
				K = { kid: saved.kid, hex: saved.hex, prp: new sjcl.cipher.aes(sjcl.codec.hex.toBits(saved.hex)) };
				const info = await api("hello", {});
				enterApp(info);
				return;
			} catch (error) {
				if (error instanceof AuthError) { store.del("key"); K = null; showPair(error.message, true); return; }
				showPair(t("netFail"), true);
				setTimeout(boot, 4000);
				return;
			}
		}
		showPair();
	}
	boot();
})();
