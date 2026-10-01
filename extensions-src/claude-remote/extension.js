"use strict";
/* Claude Remote (LAN) — use this workspace's Claude Code from a phone.
 *
 * One CommonJS package (no build step) that runs unchanged in VS Code (real Node) and in
 * Git Graph Studio's ggs-node runtime:
 *   sessions.js  the read-only conversation store (workspace-scoped list, live transcript)
 *   runner.js    remote turns, per-session queue: typed into the Claude Code tab (Git
 *                Graph Studio's `ggs.claudeChat.*`), else the desktop's own `claude` CLI
 *   desktop.js   the conversation's tab around a headless (CLI) turn
 *   server.js    the LAN server: phone app + one AES-256-GCM sealed RPC endpoint
 *   panel.js     the desktop control panel (QR, pairing code, reset, devices, activity)
 *   web/         the phone app (served as static files; sjcl.js is its crypto)
 *
 * The pairing secret lives in the editor's secret storage and survives restarts;
 * "Reset pairing key" replaces it and locks every paired device out at once. */

const os = require("os");
const path = require("path");

// The frame-program marker: ggs-node's bootstrap greps the entry for this literal to
// route the package through the vscode-shim activation job; headless loaders (tests)
// have no vscode, and activate() re-requires it once the shim exists.
let vscode = null;
try { vscode = require("vscode"); } catch { /* headless or pre-activation */ }

const sessions = require("./sessions.js");
const { Runner, claudeCliPath } = require("./runner.js");
const server = require("./server.js");
const { panelHtml, qrSvg } = require("./panel.js");
const { createDesktopTabs } = require("./desktop.js");

const SECRET_KEY = "claude-remote.pairing";
const PORT_KEY = "claude-remote.lastPort";

function activate(context) {
	vscode = require("vscode");
	// One session store, the host's own: Git Graph Studio's Claude Code lives in
	// ~/.ggs/claude, VS Code's in ~/.claude (CLAUDE_CONFIG_DIR overrides either).
	sessions.setHost(vscode.env.uriScheme === "ggs" || /git graph studio/i.test(vscode.env.appName || "") ? "ggs" : "claude");
	const zh = /^zh/i.test(vscode.env.language || "");
	const L = (zhText, enText) => (zh ? zhText : enText);
	const log = (line) => console.log(`[claude-remote] ${line}`);

	let pairing = null;
	let live = null; // the running server handle
	let panel = null;
	let starting = null;

	const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
	const tabs = createDesktopTabs(vscode, {
		log,
		mode: () => {
			const mode = vscode.workspace.getConfiguration("claudeRemote").get("desktopTab");
			return mode === "open" || mode === "off" ? mode : "reload";
		},
		busy: (sessionId) => sessions.desktopBusy(sessions.findSession(sessionId))
	});
	const runner = new Runner({
		onTurn: (phase, info) => { void tabs.onTurn(phase, info); },
		injector: null, // set once the host answers the probe below
		log,
		// a new conversation lives where this workspace's sessions already live
		defaultRoot: () => sessions.claudeRoot(),
		externalBusy: (sessionId) => sessions.desktopBusy(sessions.findSession(sessionId)),
		onChange: () => schedulePush()
	});

	/* ---------- the injected backend ---------- */
	// Git Graph Studio types a phone prompt into the conversation's Claude Code tab and
	// sends it from there (see runner.js); VS Code has no such command and keeps the CLI.
	const exec = (id, arg) => Promise.resolve(vscode.commands.executeCommand(id, arg));
	const hostInjector = {
		send: (arg) => exec("ggs.claudeChat.send", arg),
		state: (arg) => exec("ggs.claudeChat.state", arg),
		stop: (arg) => exec("ggs.claudeChat.stop", arg),
		open: (arg) => exec("ggs.claudeChat.open", arg),
		answer: (arg) => exec("ggs.claudeChat.answer", arg)
	};
	// The phone's answer to a pending AskUserQuestion: the host answers a ticket at once
	// (a process-backed caller's thread is parked otherwise) and this loop polls it to a
	// settled phase — the clicks themselves run detached in the host.
	const answerQuestion = async ({ sessionId, answers }) => {
		await injection;
		if (!runner.injector) throw new Error("answering questions needs the desktop's Claude Code tab");
		const { ticket } = await hostInjector.answer({ sessionId, answers });
		const deadline = Date.now() + 45_000;
		for (;;) {
			const state = await hostInjector.state({ ticket });
			if (state.phase === "error") throw new Error(state.error || "the desktop tab did not take the answer");
			if (state.phase === "sent") return { ok: true };
			if (Date.now() > deadline) throw new Error("the desktop tab did not answer in time");
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	};
	const injection = (async () => {
		if (vscode.workspace.getConfiguration("claudeRemote").get("backend") === "headless") return false;
		try {
			const probe = await exec("ggs.claudeChat.state", {});
			return !!probe && typeof probe === "object" && "phase" in probe;
		} catch {
			return false;
		}
	})().then((available) => {
		runner.injector = available ? hostInjector : null;
		log(available ? "remote prompts are typed into the Claude Code tab" : "remote prompts run through the claude CLI");
		return available;
	});

	/* ---------- pairing secret ---------- */
	async function loadPairing() {
		let raw = null;
		try { raw = await context.secrets.get(SECRET_KEY); } catch { /* no secret storage */ }
		if (!raw) raw = context.globalState.get(SECRET_KEY) || null;
		let parsed = null;
		try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { parsed = null; }
		if (server.validPairing(parsed)) return parsed;
		const fresh = server.newPairing();
		await savePairing(fresh);
		return fresh;
	}
	async function savePairing(p) {
		try {
			await context.secrets.store(SECRET_KEY, JSON.stringify(p));
			await context.globalState.update(SECRET_KEY, undefined);
		} catch {
			// hosts without secret storage — the fallback keeps the extension usable, loudly
			log("secret storage failed — the pairing code is stored unencrypted in global state");
			await context.globalState.update(SECRET_KEY, p);
		}
	}

	/* ---------- status bar ---------- */
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	status.command = "claude-remote.reveal";
	const paintStatus = () => {
		if (!live) {
			status.text = "$(radio-tower) Remote";
			status.tooltip = L("Claude Remote 未启动 —— 点击打开面板并扫码配对", "Claude Remote is off — click to open the panel and pair a phone");
		} else {
			const online = live.devices().filter((d) => d.online).length;
			const { running } = runner.summary();
			status.text = `$(radio-tower) Remote${online ? " · " + online : ""}${running ? " $(sync~spin)" : ""}`;
			status.tooltip = L(`Claude Remote 运行中 · 端口 ${live.port} · ${online} 台设备在线`, `Claude Remote on port ${live.port} · ${online} device(s) online`);
		}
	};
	paintStatus();
	status.show();

	/* ---------- panel ---------- */
	function panelState() {
		const p = pairing || { code: "", kid: "", createdAt: Date.now() };
		const urls = live ? server.lanIps().map(({ ip, name }) => {
			const url = server.pairingUrl(ip, live.port, p.code);
			return { ip, name, url, qr: qrSvg(url, 220) };
		}) : [];
		return {
			running: !!live,
			port: live ? live.port : null,
			urls,
			code: p.code,
			kid: p.kid,
			createdAt: p.createdAt,
			devices: live ? live.devices() : [],
			summary: runner.summary(),
			folders: folders().map((f) => f.path),
			cli: runner.cliPath,
			roots: sessions.claudeRoots()
		};
	}
	let pushTimer = null;
	function schedulePush() {
		if (pushTimer) return;
		pushTimer = setTimeout(() => {
			pushTimer = null;
			paintStatus();
			if (panel) panel.webview.postMessage({ type: "state", state: panelState() });
		}, 150);
	}
	const heartbeat = setInterval(() => {
		if (!live) return;
		schedulePush(); // online/offline flips
		void tabs.refresh(); // which conversations the desktop has open
	}, 5_000);

	async function reveal() {
		if (!pairing) pairing = await loadPairing();
		if (panel) {
			panel.reveal();
			schedulePush();
			return;
		}
		panel = vscode.window.createWebviewPanel("claude-remote.panel", "Claude Remote", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		panel.webview.html = panelHtml(vscode.env.language, panelState());
		panel.webview.onDidReceiveMessage(async (message) => {
			if (!message || typeof message.type !== "string") return;
			switch (message.type) {
				case "ready": schedulePush(); break;
				case "copy": if (typeof message.text === "string") await vscode.env.clipboard.writeText(message.text); break;
				case "start": await start(false); break;
				case "stop": await stop(); break;
				case "resetKey": await resetKey(); break;
			}
		});
		panel.onDidDispose(() => { panel = null; });
	}

	/* ---------- lifecycle ---------- */
	async function start(show = true) {
		if (live) { if (show) await reveal(); return; }
		if (starting) return starting;
		starting = (async () => {
			try {
				if (!pairing) pairing = await loadPairing();
				await injection;
				const configured = Number(vscode.workspace.getConfiguration("claudeRemote").get("port")) || 0;
				const port = configured || Number(context.globalState.get(PORT_KEY)) || 0;
				live = await server.startServer({
					pairing,
					port,
					runner,
					folders,
					log,
					baseDir: __dirname,
					desktopTabs: () => tabs.list(),
					// never parks this thread on a tab opening (the host answers a ticket at once)
					openDesktopTab: async (sessionId) => {
						if (runner.injector) await hostInjector.open({ sessionId });
						else await tabs.openTab(sessionId);
						setTimeout(() => void tabs.refresh(), 1500);
					},
					injection: () => !!runner.injector,
					answerQuestion,
					info: () => ({ app: vscode.env.appName, cli: path.basename(runner.cliPath) }),
					onDevice: (device) => {
						if (device) runner.changed({ kind: "device", device: device.label });
						schedulePush();
					}
				});
				// The same port next time keeps phones' bookmarks working.
				await context.globalState.update(PORT_KEY, live.port);
				vscode.commands.executeCommand("setContext", "claude-remote.running", true);
				schedulePush();
			} catch (error) {
				live = null;
				vscode.window.showErrorMessage(L("Claude Remote 启动失败：", "Claude Remote failed to start: ") + (error && error.message || error));
			} finally {
				starting = null;
			}
		})();
		await starting;
		if (show && live) await reveal();
	}

	async function stop() {
		if (!live) return;
		const handle = live;
		live = null;
		await handle.stop();
		vscode.commands.executeCommand("setContext", "claude-remote.running", false);
		schedulePush();
	}

	async function resetKey() {
		const confirm = L("重置", "Reset");
		const answer = await vscode.window.showWarningMessage(
			L("重置配对密钥？所有已配对设备将立即断开，需要重新扫码配对。", "Reset the pairing key? Every paired device is disconnected immediately and must scan the new QR."),
			{ modal: true },
			confirm
		);
		if (answer !== confirm) return;
		const next = server.newPairing();
		await savePairing(next);
		pairing = next;
		if (live) live.rekey(next);
		runner.changed({ kind: "stop", title: L("配对密钥已重置", "Pairing key reset") });
		schedulePush();
		vscode.window.showInformationMessage(L("配对密钥已重置，请用新的二维码重新配对。", "Pairing key reset — pair again with the new QR."));
	}

	context.subscriptions.push(
		status,
		vscode.commands.registerCommand("claude-remote.start", () => start(true)),
		vscode.commands.registerCommand("claude-remote.stop", stop),
		vscode.commands.registerCommand("claude-remote.reveal", async () => { if (!live) await start(true); else await reveal(); }),
		vscode.commands.registerCommand("claude-remote.resetKey", resetKey),
		{ dispose: () => { clearInterval(heartbeat); runner.dispose(); if (live) void live.stop(); live = null; } }
	);

	if (vscode.workspace.getConfiguration("claudeRemote").get("autoStart")) void start(false);
}

function deactivate() {
	return undefined;
}

module.exports = {
	activate,
	deactivate,
	__core: { sessions, Runner, claudeCliPath, server, qrSvg, panelHtml, createDesktopTabs, hostname: () => os.hostname() }
};
