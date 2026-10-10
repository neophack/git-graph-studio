"use strict";
/* The desktop control panel: the mode and the relay, the pairing QR and link, the
 * password and the paired phones, this PC's online windows, and the official Remote
 * Control of the active conversations. The page renders from state the extension posts
 * and every action round-trips through it — the panel itself holds nothing. */

const makeQr = require("./qrcode.js");

/** A self-contained QR as inline SVG: one rect per dark module, 4-module quiet zone. */
function qrSvg(text, size) {
	const qr = makeQr(0, "M");
	qr.addData(text, "Byte");
	qr.make();
	const count = qr.getModuleCount();
	const quiet = 4;
	const rects = [];
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			if (qr.isDark(row, col)) rects.push(`<rect x="${col}" y="${row}" width="1" height="1"/>`);
		}
	}
	const span = count + quiet * 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-quiet} ${-quiet} ${span} ${span}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="pairing QR"><rect x="${-quiet}" y="${-quiet}" width="${span}" height="${span}" fill="#fff"/><g fill="#111">${rects.join("")}</g></svg>`;
}

const STRINGS = {
	zh: {
		title: "Claude Remote", subtitle: "从手机继续本机的 Claude Code 对话",
		relay: "中继服务器", mode: "模式", connected: "已连接", offline: "未连接", connecting: "连接中…",
		transport: "传输", connect: "连接", disconnect: "断开",
		modeAuto: "自动（官方优先，第三方走自建）", modeOfficial: "官方 Remote Control", modeSelf: "自建服务器",
		serverUrl: "服务器地址", serverUrlPh: "https://relay.example.com:8787",
		save: "保存", saved: "已保存",
		scanTitle: "扫码配对", scanSub: "用手机相机扫描 —— 密钥只存在于链接的 # 片段中",
		noServer: "填入中继服务器地址后开始配对", copyLink: "复制链接", copied: "已复制",
		userId: "用户 ID", epoch: "密钥纪元", created: "注册于",
		reset: "重置配对密钥", resetSub: "生成新密钥：所有已配对手机立即断开，需要重新扫码。",
		password: "登录密码", passwordSub: "配对与设备登录时额外要求（仅服务器侧门禁，不参与端到端密钥）。",
		setPassword: "设置密码", clearPassword: "清除密码", passwordSet: "密码已设置", passwordNone: "未设置",
		devices: "已配对手机", noDevices: "还没有手机配对", online: "在线", revoke: "撤销",
		windows: "本机在线窗口", noWindows: "没有窗口连接到中继", thisWindow: "（本窗口）",
		official: "官方 Remote Control", officialOff: "当前会话未开启", officialUnavailable: "CLI 报告不可用（第三方模型只能使用自建服务器）",
		officialToggle: "开启 / 关闭", officialAll: "所有会话启动即开（Claude 设置）", officialOpen: "在 claude.ai 中打开",
		mirror: "官方会话镜像", mirrorOff: "关闭", mirrorWhen: "已连接时镜像", mirrorAlways: "始终镜像",
		activity: "远程活动", noActivity: "暂无远程活动", running: "运行中", queued: "排队中",
		env: "运行环境", cli: "Claude CLI", roots: "会话存储", folders: "工作区", tab: "桌面标签页驱动",
		secTitle: "安全说明",
		sec1: "配对密钥只出现在链接的 # 片段（浏览器从不发送片段）、电脑的机密存储和手机的本地存储中；所有内容以 AES-256-GCM 端到端加密，服务器（包括自建服务器的运维者）只能看到路由元数据。",
		sec2: "重置密钥使所有已配对手机立即失效；撤销单台手机在下方设备列表。旁路读取需要你在弹窗中一次性授权。",
		sec3: "官方 Remote Control 走 Claude 自己的通道；自建镜像只读旁路，不影响官方开关。",
		now: "刚刚", minAgo: "{0} 分钟前", hourAgo: "{0} 小时前"
	},
	en: {
		title: "Claude Remote", subtitle: "Continue this machine's Claude Code conversations from a phone",
		relay: "Relay server", mode: "Mode", connected: "Connected", offline: "Offline", connecting: "Connecting…",
		transport: "Transport", connect: "Connect", disconnect: "Disconnect",
		modeAuto: "Auto (official first, self-hosted on third-party)", modeOfficial: "Official Remote Control", modeSelf: "Self-hosted server",
		serverUrl: "Server address", serverUrlPh: "https://relay.example.com:8787",
		save: "Save", saved: "Saved",
		scanTitle: "Scan to pair", scanSub: "Scan with the phone camera — the key lives only in the link's # fragment",
		noServer: "Enter the relay address to start pairing", copyLink: "Copy link", copied: "Copied",
		userId: "User ID", epoch: "Key epoch", created: "Registered",
		reset: "Reset pairing key", resetSub: "A new key: every paired phone is disconnected at once and must scan again.",
		password: "Login password", passwordSub: "Asked in addition when pairing and on device login (a server-side gate only; not part of the end-to-end key).",
		setPassword: "Set password", clearPassword: "Clear password", passwordSet: "Password set", passwordNone: "Not set",
		devices: "Paired phones", noDevices: "No phone has paired yet", online: "online", revoke: "Revoke",
		windows: "This PC's online windows", noWindows: "No window is connected to the relay", thisWindow: " (this window)",
		official: "Official Remote Control", officialOff: "Off for the current conversation", officialUnavailable: "The CLI reports it unavailable (third-party models can only use the self-hosted server)",
		officialToggle: "Toggle", officialAll: "On for all sessions at startup (Claude's setting)", officialOpen: "Open on claude.ai",
		mirror: "Official-session mirror", mirrorOff: "Off", mirrorWhen: "While connected", mirrorAlways: "Always",
		activity: "Remote activity", noActivity: "No remote activity yet", running: "running", queued: "queued",
		env: "Environment", cli: "Claude CLI", roots: "Session store", folders: "Workspace", tab: "Desktop-tab driving",
		secTitle: "Security",
		sec1: "The pairing key lives only in the link's # fragment (browsers never send fragments), this PC's secret storage and the phone's local storage; every payload is AES-256-GCM end-to-end encrypted — the relay (including a self-hosted one's operator) sees routing metadata only.",
		sec2: "Resetting the key invalidates every paired phone at once; one phone is revoked in the device list below. The conversation tap asks for your one-time consent.",
		sec3: "The official Remote Control rides Claude's own channel; the self-hosted mirror is a read-only bypass that never touches the official switch.",
		now: "just now", minAgo: "{0}m ago", hourAgo: "{0}h ago"
	}
};

function panelHtml(language, initialState) {
	const zh = /^zh/i.test(language || "");
	const T = zh ? STRINGS.zh : STRINGS.en;
	const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
:root {
	--bg: var(--vscode-editor-background, #1e1e1e); --fg: var(--vscode-foreground, #cccccc);
	--muted: var(--vscode-descriptionForeground, #8b8b8b); --card: var(--vscode-sideBar-background, #252526);
	--border: var(--vscode-panel-border, var(--vscode-widget-border, #3a3a3a));
	--accent: var(--vscode-button-background, #0e639c); --accent-fg: var(--vscode-button-foreground, #ffffff);
	--accent-hover: var(--vscode-button-hoverBackground, #1177bb);
	--sec-bg: var(--vscode-button-secondaryBackground, #3a3d41); --sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
	--ok: var(--vscode-testing-iconPassed, #3fb984); --err: var(--vscode-errorForeground, #f48771); --link: var(--vscode-textLink-foreground, #3794ff);
	--mono: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.5 var(--vscode-font-family, -apple-system, "Segoe UI", system-ui, sans-serif); }
.wrap { max-width: 980px; margin: 0 auto; padding: 22px 22px 40px; }
header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; flex-wrap: wrap; }
.mark { width: 42px; height: 42px; border-radius: 12px; background: linear-gradient(135deg, #e08a6b, #c25a3c); display: grid; place-items: center; flex: none; }
.mark svg { width: 24px; height: 24px; stroke: #fff; fill: none; stroke-width: 2; stroke-linecap: round; }
.titles { flex: 1; min-width: 220px; }
h1 { margin: 0; font-size: 18px; font-weight: 650; }
.subtitle { color: var(--muted); font-size: 12.5px; }
.pill { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12px; font-weight: 600; border: 1px solid var(--border); }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.pill.on .dot { background: var(--ok); }
.btn { height: 30px; padding: 0 14px; border-radius: 6px; border: 0; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
.btn:hover { background: var(--accent-hover); }
.btn.sec { background: var(--sec-bg); color: var(--sec-fg); }
.btn.danger { background: transparent; color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 50%, transparent); }
.btn.small { height: 26px; padding: 0 10px; font-size: 12px; font-weight: 500; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; min-width: 0; }
.card h2 { margin: 0 0 2px; font-size: 13.5px; font-weight: 650; }
.card .sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
select, input[type=text] { width: 100%; height: 30px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; }
.qr-box { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.qr { background: #fff; border-radius: 12px; padding: 8px; line-height: 0; }
.urlrow { display: flex; align-items: center; gap: 8px; width: 100%; }
.url { flex: 1; min-width: 0; font: 12px var(--mono); color: var(--link); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.placeholder { width: 236px; height: 236px; border: 1px dashed var(--border); border-radius: 12px; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 20px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin-top: 12px; font-size: 12px; }
.kv dt { color: var(--muted); } .kv dd { margin: 0; font-family: var(--mono); word-break: break-all; }
.danger-zone { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.danger-zone p { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.list { display: grid; gap: 2px; }
.item { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.item:last-child { border-bottom: 0; }
.item .grow { flex: 1; min-width: 0; }
.item .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .m { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.d { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.d.on { background: var(--ok); }
.empty { color: var(--muted); padding: 14px 0; text-align: center; font-size: 12.5px; }
.sec ul { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
.sec li { margin: 4px 0; }
.full { grid-column: 1 / -1; }
.hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
	<header>
		<div class="mark"><svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.9 2.9M15.5 15.5l2.9 2.9M5.6 18.4l2.9-2.9M15.5 8.5l2.9-2.9"/></svg></div>
		<div class="titles"><h1>${T.title}</h1><div class="subtitle">${T.subtitle}</div></div>
		<span class="pill" id="status"><span class="dot"></span><span id="statusText"></span></span>
	</header>
	<div class="grid">
		<section class="card">
			<h2>${T.relay}</h2>
			<div class="sub">${T.serverUrl}</div>
			<div class="row" style="margin-top:0">
				<input type="text" id="serverUrl" placeholder="${T.serverUrlPh}">
				<button class="btn small" id="saveServer">${T.save}</button>
			</div>
			<div class="row">
				<select id="mode" style="width:auto; flex:1">
					<option value="auto">${T.modeAuto}</option>
					<option value="official">${T.modeOfficial}</option>
					<option value="selfHosted">${T.modeSelf}</option>
				</select>
				<button class="btn small" id="toggleRelay"></button>
			</div>
			<dl class="kv">
				<dt>${T.transport}</dt><dd id="transport"></dd>
				<dt>${T.userId}</dt><dd id="userId"></dd>
				<dt>${T.epoch}</dt><dd id="epoch"></dd>
				<dt>${T.tab}</dt><dd id="tabDriving"></dd>
			</dl>
		</section>
		<section class="card">
			<h2>${T.scanTitle}</h2>
			<div class="sub">${T.scanSub}</div>
			<div class="qr-box" id="qrBox"></div>
			<div class="danger-zone">
				<button class="btn danger" id="reset">${T.reset}</button>
				<p>${T.resetSub}</p>
			</div>
		</section>
		<section class="card">
			<h2>${T.password}</h2>
			<div class="sub">${T.passwordSub}</div>
			<div class="row"><span id="pwState"></span></div>
			<div class="row">
				<button class="btn sec small" id="setPw">${T.setPassword}</button>
				<button class="btn sec small" id="clearPw">${T.clearPassword}</button>
			</div>
		</section>
		<section class="card">
			<h2>${T.devices}</h2>
			<div class="list" id="devices"></div>
		</section>
		<section class="card">
			<h2>${T.windows}</h2>
			<div class="list" id="windows"></div>
		</section>
		<section class="card">
			<h2>${T.official}</h2>
			<div class="sub" id="officialSub"></div>
			<div class="qr-box" id="officialQr"></div>
			<div class="row">
				<button class="btn small" id="officialToggle">${T.officialToggle}</button>
			</div>
			<div class="row">
				<label style="display:flex;gap:8px;align-items:center;font-size:12.5px">
					<input type="checkbox" id="officialAll"> ${T.officialAll}
				</label>
			</div>
			<div class="row">
				<span style="font-size:12.5px;color:var(--muted)">${T.mirror}:</span>
				<select id="mirror" style="width:auto">
					<option value="off">${T.mirrorOff}</option>
					<option value="whenConnected">${T.mirrorWhen}</option>
					<option value="always">${T.mirrorAlways}</option>
				</select>
			</div>
		</section>
		<section class="card">
			<h2>${T.activity}</h2>
			<div class="list" id="activity"></div>
		</section>
		<section class="card full">
			<h2>${T.env}</h2>
			<dl class="kv"><dt>${T.folders}</dt><dd id="folders"></dd><dt>${T.cli}</dt><dd id="cli"></dd><dt>${T.roots}</dt><dd id="roots"></dd></dl>
			<div class="sec"><h2>${T.secTitle}</h2><ul><li>${T.sec1}</li><li>${T.sec2}</li><li>${T.sec3}</li></ul></div>
		</section>
	</div>
</div>
<script>
(() => {
	const vscode = acquireVsCodeApi();
	const T = ${json(T)};
	let state = ${json(initialState)};
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const ago = (ms) => {
		const s = (Date.now() - ms) / 1000;
		if (s < 45) return T.now;
		if (s < 3600) return T.minAgo.replace("{0}", Math.round(s / 60));
		if (s < 86400) return T.hourAgo.replace("{0}", Math.round(s / 3600));
		return new Date(ms).toLocaleString();
	};
	const flash = (btn) => { const label = btn.textContent; btn.textContent = T.copied; setTimeout(() => { btn.textContent = label; }, 1200); };

	function render() {
		const s = state;
		$("status").className = "pill" + (s.relay.online ? " on" : "");
		$("statusText").textContent = s.relay.online ? T.connected + " · " + s.relay.transport : s.relay.wanted ? T.connecting : T.offline;
		if (document.activeElement !== $("serverUrl")) $("serverUrl").value = s.relay.serverUrl || "";
		$("mode").value = s.mode;
		$("toggleRelay").textContent = s.relay.wanted ? T.disconnect : T.connect;
		$("transport").textContent = s.relay.transport || "—";
		$("userId").textContent = s.identity.userId || "—";
		$("epoch").textContent = s.identity.epoch ? String(s.identity.epoch) : "—";
		$("tabDriving").textContent = s.tabDriving ? "✓" : "—";
		const box = $("qrBox");
		if (!s.link) box.innerHTML = '<div class="placeholder">' + esc(T.noServer) + "</div>";
		else box.innerHTML = '<div class="qr">' + s.qr + '</div><div class="urlrow"><span class="url" title="' + esc(s.link) + '">' + esc(s.link.replace(/#.*$/, "#…")) + '</span><button class="btn sec small" id="copyLink">' + esc(T.copyLink) + "</button></div>";
		const copy = $("copyLink");
		if (copy) copy.onclick = () => { vscode.postMessage({ type: "copy", text: s.link }); flash(copy); };
		$("pwState").textContent = s.passwordSet ? T.passwordSet : T.passwordNone;
		$("devices").innerHTML = s.devices.length ? s.devices.map((d) =>
			'<div class="item"><span class="d' + (d.online ? " on" : "") + '"></span><div class="grow"><div class="t">' + esc(d.name) + '</div><div class="m">' + (d.online ? esc(T.online) : esc(ago(d.last_seen))) + '</div></div><button class="btn danger small" data-revoke="' + esc(d.id) + '">' + esc(T.revoke) + "</button></div>").join("")
			: '<div class="empty">' + esc(T.noDevices) + "</div>";
		$("windows").innerHTML = s.windows.length ? s.windows.map((w) =>
			'<div class="item"><span class="d' + (w.online ? " on" : "") + '"></span><div class="grow"><div class="t">' + esc(w.name) + (w.self ? esc(T.thisWindow) : "") + '</div><div class="m">' + esc(w.host || "") + " · " + (w.online ? esc(T.online) : esc(ago(w.seen))) + "</div></div></div>").join("")
			: '<div class="empty">' + esc(T.noWindows) + "</div>";
		$("officialSub").textContent = s.official.available === false ? T.officialUnavailable : s.official.status && s.official.status !== "off" ? s.official.status : T.officialOff;
		$("officialQr").innerHTML = s.official.connectUrl ? '<div class="qr">' + s.official.qr + '</div><div class="urlrow"><span class="url" title="' + esc(s.official.connectUrl) + '">' + esc(s.official.connectUrl) + "</span></div>" : "";
		if (document.activeElement !== $("officialAll")) $("officialAll").checked = !!s.officialAll;
		if (document.activeElement !== $("mirror")) $("mirror").value = s.mirror;
		$("activity").innerHTML = s.summary.activity.length ? s.summary.activity.slice(0, 12).map((a) => {
			const detail = a.error || a.text || a.title || "";
			return '<div class="item"><span class="d"></span><div class="grow"><div class="t">' + esc(a.kind) + '</div><div class="m">' + esc(detail) + "</div></div><span>" + esc(ago(a.at)) + "</span></div>";
		}).join("") : '<div class="empty">' + esc(T.noActivity) + "</div>";
		$("folders").textContent = s.folders.join("\\n") || "—";
		$("cli").textContent = s.cli;
		$("roots").textContent = s.roots.join("  ·  ") || "—";
	}

	document.addEventListener("click", (e) => {
		const revoke = e.target.closest("[data-revoke]");
		if (revoke) { vscode.postMessage({ type: "revokeDevice", id: revoke.dataset.revoke }); return; }
		const id = e.target.closest("button") && e.target.closest("button").id;
		if (id === "saveServer") vscode.postMessage({ type: "saveServer", url: $("serverUrl").value });
		else if (id === "toggleRelay") vscode.postMessage({ type: state.relay.wanted ? "disconnect" : "connect" });
		else if (id === "reset") vscode.postMessage({ type: "resetKey" });
		else if (id === "setPw") vscode.postMessage({ type: "setPassword" });
		else if (id === "clearPw") vscode.postMessage({ type: "clearPassword" });
		else if (id === "officialToggle") vscode.postMessage({ type: "officialToggle" });
	});
	$("mode").addEventListener("change", () => vscode.postMessage({ type: "setMode", mode: $("mode").value }));
	$("mirror").addEventListener("change", () => vscode.postMessage({ type: "setMirror", mirror: $("mirror").value }));
	$("officialAll").addEventListener("change", () => vscode.postMessage({ type: "officialAll", on: $("officialAll").checked }));
	window.addEventListener("message", (e) => {
		if (e.data && e.data.type === "state") { state = e.data.state; render(); }
	});
	render();
	setInterval(render, 15000); // relative times
	vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}

module.exports = { panelHtml, qrSvg };
