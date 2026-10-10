"use strict";
/* Claude Remote 2.0 — continue this machine's Claude Code conversations from a phone,
 * over the PC's own relay (claude-remote-server) with end-to-end encrypted frames, and
 * over the official Remote Control where the CLI serves it.
 *
 * One CommonJS package (no build step) that runs unchanged in VS Code (real Node) and in
 * Git Graph Studio's ggs-node runtime:
 *   identity.js   the PC identity on a relay (one user id + one QR per PC)
 *   crypto.js     HKDF / HMAC / AES-256-GCM — the E2E layer (sjcl fallback for frames)
 *   relay.js      the relay connection: WebSocket, or the long-poll pair on ggs-node
 *   sources/      the two conversation sources: the host tap (GGS) and the sdk host
 *   official.js   the CLI's own Remote Control, toggled through the tab's request channel
 *   mirror.js     the read-only official-session mirror to the relay
 *   control.js    the phone's request table (sessions, transcripts, prompts, cards)
 *   sessions.js   the read-only conversation store (unchanged)
 *   runner.js     the desktop-tab queue and the headless CLI lane (unchanged)
 *   desktop.js    the conversation's tab around an out-of-tab turn (unchanged)
 *   panel.js      the desktop control panel
 */

const os = require("os");
const path = require("path");

// The frame-program marker: ggs-node's bootstrap greps the entry for this literal to
// route the package through the vscode-shim activation job; headless loaders (tests)
// have no vscode, and activate() re-requires it once the shim exists.
let vscode = null;
try { vscode = require("vscode"); } catch { /* headless or pre-activation */ }

const sessions = require("./sessions.js");
const { Runner, claudeCliPath } = require("./runner.js");
const identity = require("./identity.js");
const crypto = require("./crypto.js");
const { createRelay, wsSupported } = require("./relay.js");
const { createTapSource, probe: probeTap } = require("./sources/tap.js");
const { createSdkHostSource } = require("./sources/sdkHost.js");
const { createOfficial } = require("./official.js");
const { createMirror } = require("./mirror.js");
const { createControl } = require("./control.js");
const { panelHtml, qrSvg } = require("./panel.js");
const { createDesktopTabs } = require("./desktop.js");

const CONFIG = "claudeRemote";

function activate(context) {
	vscode = require("vscode");
	// One session store, the host's own: Git Graph Studio's Claude Code lives in
	// ~/.ggs/claude, VS Code's in ~/.claude (CLAUDE_CONFIG_DIR overrides either).
	const onGgs = vscode.env.uriScheme === "ggs" || /git graph studio/i.test(vscode.env.appName || "");
	sessions.setHost(onGgs ? "ggs" : "claude");
	const zh = /^zh/i.test(vscode.env.language || "");
	const L = (zhText, enText) => (zh ? zhText : enText);
	const log = (line) => console.log(`[claude-remote] ${line}`);
	const config = () => vscode.workspace.getConfiguration(CONFIG);
	const configOf = {
		mode: () => { const mode = config().get("mode"); return ["auto", "official", "selfHosted"].includes(mode) ? mode : "auto"; },
		mirrorOfficial: () => { const value = config().get("mirrorOfficial"); return ["off", "whenConnected", "always"].includes(value) ? value : "whenConnected"; },
		mirrorConnectUrl: () => config().get("mirrorConnectUrl") === true,
		mirrorControl: () => config().get("mirrorControl") === true,
		serverUrl: () => identity.normalizeServer(config().get("serverUrl")),
		officialAll: () => config().get("official.allSessions") === true
	};

	const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
	const tabs = createDesktopTabs(vscode, {
		log,
		mode: () => {
			const mode = config().get("desktopTab");
			return mode === "open" || mode === "off" ? mode : "reload";
		},
		busy: (sessionId) => sessions.desktopBusy(sessions.findSession(sessionId))
	});
	const runner = new Runner({
		onTurn: (phase, info) => { void tabs.onTurn(phase, info); },
		injector: null,
		log,
		defaultRoot: () => sessions.claudeRoot(),
		externalBusy: (sessionId) => sessions.desktopBusy(sessions.findSession(sessionId)),
		onChange: () => changed()
	});

	/* ---------- the sources ---------- */
	// The tap (GGS): the read-only bypass over the workbench's Claude Code webview relay,
	// plus its driving commands. VS Code answers nothing — its only source is the sdk host.
	let tap = null;
	const tapInjection = (async () => {
		if (config().get("backend") === "headless") return false;
		try {
			if (!(await probeTap(vscode))) return false;
			const source = createTapSource(vscode, {
				log,
				onEvent: (event) => {
					notePermissionEvent(event);
					mirror.offer(event);
				},
				onChange: () => changed()
			});
			tap = source;
			await source.start().catch((error) => log(`the conversation tap: ${error && error.message}`));
			return true;
		} catch {
			return false;
		}
	})();

	// The pending tool-permission questions, per conversation — what the phone renders
	// as an answerable card. Both sources feed it: the tap's `tool_permission_request`
	// pushes (the desktop tab's own card) and the sdk host's `control_request` lines.
	const pendingPermissions = new Map(); // sessionId → { tool, summary, at }
	const PERMISSION_FRESH_MS = 10 * 60 * 1000;
	function notePermissionEvent(event) {
		if (!event || event.kind !== "permission") return;
		const message = event.message || {};
		const request = message.request && typeof message.request === "object" ? message.request : {};
		const tool = message.toolName || message.tool_name || request.tool || "tool";
		const input = message.inputs || request.input || {};
		const summary = String(input.command || input.description || input.file_path || input.pattern || input.url || JSON.stringify(input)).slice(0, 160);
		pendingPermissions.set(event.sessionId || "(new)", { tool: String(tool), summary, at: Date.now() });
		changed();
	}
	function clearPermission(sessionId) {
		if (pendingPermissions.delete(sessionId)) schedulePush();
	}
	function pendingPermissionOf(sessionId) {
		const pending = pendingPermissions.get(sessionId);
		if (!pending || Date.now() - pending.at >= PERMISSION_FRESH_MS) return null;
		// A card whose conversation went quiet was answered (or died) on the desktop:
		// past the freshness window it never returns, and once the session's turn ended
		// it lingers only briefly — the tap side has no "gone" push of its own.
		if (sessionId && sessionId !== "(new)") {
			const summary = sessions.findSession(sessionId);
			if (summary && !sessions.desktopBusy(summary) && Date.now() - pending.at > 60_000) {
				pendingPermissions.delete(sessionId);
				return null;
			}
		}
		return pending;
	}

	const sdkHost = createSdkHostSource({
		log,
		defaultRoot: () => sessions.claudeRoot(),
		onEvent: (event) => {
			// The sdk host's own turns land in the transcript the phone reads; the stream
			// crosses live for the same deltas the tap would show. A permission question
			// parks the card; the turn's end clears it.
			if (event.kind === "permission") notePermissionEvent(event);
			if (event.kind === "state" && event.busy === false) clearPermission(event.sessionId);
			mirror.offer({ kind: event.kind, sessionId: event.sessionId, dir: "out", message: event.message });
			changed();
		},
		onChange: () => changed()
	});

	const official = createOfficial({ log, tap: null });
	tapInjection.then((available) => {
		official.adoptTap(available ? tap : null);
		schedulePush();
		log(available ? "driving the desktop's Claude Code tabs" : "no desktop tab surface — turns run through the sdk host");
	}).catch(() => undefined);

	// One forwarding path for the tap stream: the mirror's own setting resolves the
	// mode (a self-hosted phone session mirrors always — that IS its primary stream).
	const mirror = createMirror({
		config: () => ({
			mirrorOfficial: configOf.mode() === "selfHosted" ? "always" : configOf.mirrorOfficial(),
			mirrorConnectUrl: configOf.mirrorConnectUrl()
		}),
		log,
		forward: (payload) => relay.send("*", payload)
	});

	/* ---------- the relay ---------- */

	let current = null; // the identity the connection stands on
	let relay = null;
	let relayWanted = false;
	// The relay's window ids are w_ + 16 alphanumeric characters, minted once per window.
	const windowId = "w_" + Array.from({ length: 16 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]).join("");
	let online = false;
	const pendingReplies = new Map(); // rid → {resolve, reject} (the phone's RPC calls that span async work)

	const control = createControl({
		log,
		onChange: () => changed(),
		folders,
		runner,
		sdkHost,
		get tap() { return tap; },
		// Official mode without mirrorControl: the self-hosted phone watches, never
		// drives (plan §2.2's rule 3) — the official client keeps the conversation.
		controlAllowed: () => configOf.mode() !== "official" || configOf.mirrorControl(),
		pendingPermission: pendingPermissionOf,
		onPermissionAnswered: clearPermission,
		desktopTabs: () => tabs.list(),
		openDesktopTab: async (sessionId) => {
			if (tap) await tap.open({ sessionId }).catch(() => undefined);
			else await tabs.openTab(sessionId);
			setTimeout(() => void tabs.refresh(), 1500);
		},
		answerQuestion: async ({ sessionId, answers }) => {
			await tapInjection;
			if (!tap) throw new Error("answering questions needs the desktop's Claude Code tab");
			await tap.answer({ sessionId, answers });
		},
		official
	});

	function relayFrame(plain, meta) {
		// The phone's request table: every {rid, t} gets one answer; pushes (nudge, tap)
		// need nothing back. Answers smaller than a frame go straight back; larger ones
		// (transcript windows) chunk at the sender's side by the phone's own paging.
		if (plain && (typeof plain.rid === "string" || typeof plain.rid === "number")) {
			const rid = plain.rid;
			Promise.resolve()
				.then(() => control.dispatch(plain))
				.then((r) => relay.send(meta.from, { t: "reply", rid, ok: true, r }))
				.catch((error) => relay.send(meta.from, { t: "reply", rid, ok: false, e: String(error && error.message || error) }));
			return;
		}
		if (plain && plain.t === "nudge") changed();
	}

	async function connect({ interactive = false } = {}) {
		await tapInjection;
		const serverUrl = configOf.serverUrl();
		if (!serverUrl) {
			if (interactive) vscode.window.showWarningMessage(L("未配置中继服务器地址 —— 面板里填入后连接。", "No relay address is configured — enter one in the panel."));
			return;
		}
		relayWanted = true;
		try {
			current = await identity.load(context, { serverUrl, log });
		} catch (error) {
			relayWanted = false;
			log(`loading the identity failed: ${error && error.message}`);
			if (interactive) vscode.window.showErrorMessage(L("连接中继失败：", "Connecting to the relay failed: ") + (error && error.message || error));
			schedulePush();
			return;
		}
		if (relay) relay.stop();
		relay = createRelay(current, {
			windowId,
			host: onGgs ? "ggs" : "vscode",
			meta: () => ({ t: "window.meta", name: folders().map((f) => f.name).join(", ") || "workspace", host: onGgs ? "ggs" : "vscode", folders: folders().map((f) => f.path) }),
			log,
			getIdentity: () => current,
			onFrame: relayFrame,
			onEpoch: async () => {
				// Another window of this PC rekeyed: reload the shared identity (it wrote
				// the fresh K there) and reconnect under it.
				await new Promise((resolve) => setTimeout(resolve, 400));
				const reloaded = await identity.readIdentity(context).catch(() => null);
				if (reloaded && reloaded.epoch > current.epoch) {
					current = reloaded;
					if (relay) relay.stop();
					connect();
				}
			},
			onOnline: (value) => {
				online = value;
				schedulePush();
			}
		});
		relay.start();
		schedulePush();
	}

	function disconnect() {
		relayWanted = false;
		online = false;
		if (relay) relay.stop();
		relay = null;
		schedulePush();
	}

	/* ---------- what the phone sees of this window's changes ---------- */

	let nudgeTimer = null;
	function changed() {
		runner.changed();
		if (!relay || !online) return;
		if (nudgeTimer) return;
		nudgeTimer = setTimeout(() => {
			nudgeTimer = null;
			relay.send("*", { t: "nudge" });
		}, 300);
		nudgeTimer.unref?.();
	}

	/* ---------- status bar + panel ---------- */

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	status.command = "claude-remote.reveal";
	const paintStatus = () => {
		const devicesOnline = panelStateCache.devices.filter((d) => d.online).length;
		const { running } = runner.summary();
		status.text = `$(device-mobile) Remote${online ? " · ✓" : ""}${devicesOnline ? " · " + devicesOnline : ""}${running ? " $(sync~spin)" : ""}`;
		status.tooltip = online
			? L(`Claude Remote 已连接（${relay ? relay.transport() : ""}）`, `Claude Remote connected (${relay ? relay.transport() : ""})`)
			: L("Claude Remote 未连接 —— 点击打开面板", "Claude Remote is offline — click to open the panel");
	};

	let panel = null;
	let panelStateCache = { devices: [], windows: [] };
	let pushTimer = null;
	function schedulePush() {
		if (pushTimer) return;
		pushTimer = setTimeout(() => {
			pushTimer = null;
			paintStatus();
			// panelState is async (the relay reads): the panel gets the RESOLVED state —
			// passing the promise itself would hand it an empty object forever.
			if (panel) void panelState().then((state) => panel.webview.postMessage({ type: "state", state })).catch(() => undefined);
		}, 150);
	}

	async function panelState() {
		const read = current ? await identity.devices(current).catch(() => ({ devices: [], passwordSet: false })) : { devices: [], passwordSet: false };
		panelStateCache.devices = read.devices;
		if (current) panelPwState = read.passwordSet;
		const officialState = lastOfficialSession ? await official.state(lastOfficialSession).catch(() => null) : null;
		const identityView = current || {};
		const link = current ? identity.link(current) : null;
		return {
			mode: configOf.mode(),
			mirror: configOf.mirrorOfficial(),
			relay: { wanted: relayWanted, online, transport: relay ? relay.transport() : wsSupported() ? "websocket" : "long-poll", serverUrl: configOf.serverUrl() || "" },
			identity: { userId: identityView.userId || "", epoch: identityView.epoch || 0 },
			link,
			qr: link ? qrSvg(link, 220) : "",
			passwordSet: panelPwState,
			devices: read.devices,
			windows: await relayWindows(),
			official: {
				available: officialState ? officialState.available : null,
				status: officialState ? officialState.status : "off",
				connectUrl: officialState ? officialState.connectUrl : null,
				qr: officialState && officialState.connectUrl ? qrSvg(officialState.connectUrl, 180) : ""
			},
			officialAll: official.allSessions(sessions.claudeRoot),
			tabDriving: !!tap,
			summary: runner.summary(),
			folders: folders().map((f) => f.path),
			cli: path.basename(runner.cliPath),
			roots: sessions.claudeRoots()
		};
	}

	/** This PC's windows as the relay routes them — each sealed `meta_ct` decrypted with
	 *  the frame key (the broadcast AAD, seq 0), the relay never the wiser. Answers the
	 *  local shape when the relay is out of reach. */
	async function relayWindows() {
		const local = { name: folders().map((f) => f.name).join(", ") || "workspace", host: onGgs ? "ggs" : "vscode", online: true, seen: Date.now(), self: true };
		if (!current) return [local];
		const routed = await identity.windows(current).catch(() => []);
		const kE2E = crypto.deriveE2E(current.K);
		const out = [];
		for (const entry of routed) {
			if (!entry || typeof entry.id !== "string") continue;
			let name = "a window";
			try {
				const [n, c] = String(entry.meta_ct || "").split(".");
				const meta = crypto.openFrame(kE2E, { userId: current.userId, epoch: current.epoch, from: entry.id, to: "*", seq: 0 }, { n, c });
				if (meta && typeof meta.name === "string") name = meta.name;
			} catch { /* an older epoch's meta — the name falls back */ }
			out.push({ name, host: entry.host || "", online: entry.online === true, seen: Number(entry.seen) || 0, self: entry.id === windowId });
		}
		// This window first (its own meta rides the relay's list too, but the local name
		// is always current), the rest in the relay's order.
		const self = out.find((entry) => entry.self);
		return self ? [self, ...out.filter((entry) => !entry.self)] : [local, ...out];
	}

	let lastOfficialSession = null;
	let panelPwState = false;

	async function reveal() {
		if (panel) {
			panel.reveal();
			schedulePush();
			return;
		}
		panel = vscode.window.createWebviewPanel("claude-remote.panel", "Claude Remote", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		panel.webview.html = panelHtml(vscode.env.language, await panelState());
		panel.webview.onDidReceiveMessage(async (message) => {
			if (!message || typeof message.type !== "string") return;
			switch (message.type) {
				case "ready": schedulePush(); break;
				case "copy": await vscode.env.clipboard.writeText(String(message.text)); break;
				case "saveServer": await config().update("serverUrl", String(message.url || "").trim(), vscode.ConfigurationTarget.Global); schedulePush(); break;
				case "connect": await connect({ interactive: true }); break;
				case "disconnect": disconnect(); break;
				case "resetKey": await resetKey(); break;
				case "setPassword": await setPassword(); break;
				case "clearPassword": await clearPassword(); break;
				case "revokeDevice": await revokeDevice(String(message.id)); break;
				case "setMode": await config().update("mode", String(message.mode), vscode.ConfigurationTarget.Global); schedulePush(); break;
				case "setMirror": await config().update("mirrorOfficial", String(message.mirror), vscode.ConfigurationTarget.Global); schedulePush(); break;
				case "officialAll": {
					const value = message.on === true;
					await config().update("official.allSessions", value, vscode.ConfigurationTarget.Global);
					official.allSessions(sessions.claudeRoot, { set: value });
					schedulePush();
					break;
				}
				case "officialToggle": await toggleOfficial(); break;
			}
		});
		panel.onDidDispose(() => { panel = null; });
	}

	/* ---------- the management actions ---------- */

	async function ensureConnected() {
		if (relayWanted && online) return true;
		await connect({ interactive: true });
		return relayWanted && online;
	}

	async function resetKey() {
		await ensureConnected();
		if (!current) return;
		const confirm = L("重置", "Reset");
		const answer = await vscode.window.showWarningMessage(
			L("重置配对密钥？所有已配对手机将立即断开，需要重新扫码。", "Reset the pairing key? Every paired phone is disconnected immediately and must scan the new QR."),
			{ modal: true },
			confirm
		);
		if (answer !== confirm) return;
		try {
			const next = await identity.rekey(current);
			current = await identity.adopt(context, next);
			mirror.reset();
			vscode.window.showInformationMessage(L("配对密钥已重置，用新的二维码重新配对。", "Pairing key reset — pair again with the new QR."));
		} catch (error) {
			// Another window rekeyed first: adopt what it published.
			const reloaded = await identity.readIdentity(context).catch(() => null);
			if (reloaded && reloaded.epoch > current.epoch) {
				current = reloaded;
				vscode.window.showInformationMessage(L("另一个窗口已重置密钥，本窗口已同步。", "Another window rekeyed first; this window synced to it."));
			} else {
				vscode.window.showErrorMessage(String(error && error.message || error));
			}
		}
		schedulePush();
	}

	async function setPassword() {
		await ensureConnected();
		if (!current) return;
		const password = await vscode.window.showInputBox({
			prompt: L("配对与设备登录时要求的额外密码（至少 8 个字符）", "An extra password asked when pairing and on device login (8+ characters)"),
			password: true,
			ignoreFocusOut: true
		});
		if (password === undefined) return;
		if (password.length < 8) {
			vscode.window.showErrorMessage(L("密码至少 8 个字符。", "The password needs at least 8 characters."));
			return;
		}
		await identity.setPassword(current, password).catch((error) => vscode.window.showErrorMessage(String(error && error.message || error)));
		panelPwState = true;
		schedulePush();
	}

	async function clearPassword() {
		await ensureConnected();
		if (!current) return;
		await identity.clearPassword(current).catch((error) => vscode.window.showErrorMessage(String(error && error.message || error)));
		panelPwState = false;
		schedulePush();
	}

	async function revokeDevice(deviceId) {
		await ensureConnected();
		if (!current) return;
		await identity.revokeDevice(current, deviceId).catch((error) => vscode.window.showErrorMessage(String(error && error.message || error)));
		schedulePush();
	}

	async function toggleOfficial() {
		const sessionId = lastOfficialSession || (await vscode.commands.executeCommand("ggs.sessionTabs.list").catch(() => []) || [])[0];
		if (!sessionId) {
			vscode.window.showInformationMessage(L("没有打开的 Claude Code 会话标签页。", "No Claude Code conversation tab is open."));
			return;
		}
		const state = await official.state(sessionId).catch(() => null);
		const enable = !(state && (state.status === "connected" || state.status === "connecting"));
		try {
			const answer = await official.toggle(sessionId, enable);
			lastOfficialSession = sessionId;
			if (answer.connectUrl) await vscode.env.clipboard.writeText(answer.connectUrl).catch(() => undefined);
			vscode.window.showInformationMessage(
				answer.connectUrl
					? L(`官方 Remote Control ${enable ? "已开启" : "状态"}：${answer.status}（链接已复制）`, `Official Remote Control: ${answer.status} (link copied)`)
					: L(`官方 Remote Control：${answer.status}`, `Official Remote Control: ${answer.status}`)
			);
		} catch (error) {
			vscode.window.showErrorMessage(String(error && error.message || error));
		}
		schedulePush();
	}

	/* ---------- lifecycle ---------- */

	let heartbeatTicks = 0;
	const heartbeat = setInterval(() => {
		if (!relayWanted) return;
		heartbeatTicks++;
		// The status bar's phone count needs the relay's view; one small read every
		// third tick (≈15 s) keeps it fresh without polling chatter.
		if (online && current && heartbeatTicks % 3 === 0) {
			void identity.devices(current).then((read) => {
				panelStateCache.devices = read.devices;
				paintStatus();
			}).catch(() => undefined);
		}
		schedulePush();
		void tabs.refresh();
		relay?.republishMeta();
	}, 5000);

	async function activateRelayFromSettings() {
		if (config().get("autoConnect") !== false && configOf.serverUrl()) await connect();
	}

	context.subscriptions.push(
		status,
		vscode.commands.registerCommand("claude-remote.reveal", reveal),
		vscode.commands.registerCommand("claude-remote.connect", () => connect({ interactive: true })),
		vscode.commands.registerCommand("claude-remote.disconnect", disconnect),
		vscode.commands.registerCommand("claude-remote.resetKey", resetKey),
		vscode.commands.registerCommand("claude-remote.setPassword", setPassword),
		vscode.commands.registerCommand("claude-remote.clearPassword", clearPassword),
		vscode.commands.registerCommand("claude-remote.copyLink", async () => {
			await ensureConnected();
			if (current) await vscode.env.clipboard.writeText(identity.link(current));
		}),
		vscode.commands.registerCommand("claude-remote.revokeDevice", async () => {
			await ensureConnected();
			if (!current) return;
			const devices = await identity.devices(current).catch(() => []);
			if (!devices.length) {
				vscode.window.showInformationMessage(L("还没有手机配对。", "No phone has paired yet."));
				return;
			}
			const picked = await vscode.window.showQuickPick(devices.map((d) => ({ label: d.name, id: d.id, description: d.online ? "online" : new Date(d.last_seen).toLocaleString() })), { placeHolder: L("撤销哪台手机？", "Which phone to revoke?") });
			if (picked) await revokeDevice(picked.id);
		}),
		vscode.commands.registerCommand("claude-remote.toggleOfficial", toggleOfficial),
		{ dispose: () => { clearInterval(heartbeat); runner.dispose(); sdkHost.dispose(); if (tap) tap.stop(); if (relay) relay.stop(); } }
	);

	paintStatus();
	status.show();
	void activateRelayFromSettings();
}

function deactivate() {
	return undefined;
}

module.exports = {
	activate,
	deactivate,
	__core: {
		sessions, Runner, claudeCliPath, identity, qrSvg, panelHtml, createDesktopTabs,
		createRelay, wsSupported, createTapSource, createSdkHostSource, createOfficial,
		createMirror, createControl, hostname: () => os.hostname()
	}
};
