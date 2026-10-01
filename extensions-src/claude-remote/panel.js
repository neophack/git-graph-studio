"use strict";
/* The desktop control panel (a webview): server state, the pairing QR per LAN address,
 * the pairing code (masked until revealed), "Reset pairing key", paired devices and the
 * remote activity feed. The page renders from state the extension posts; it never holds
 * more than the panel shows, and every action round-trips through the extension. */

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
		title: "Claude Remote", subtitle: "在手机上查看并继续本工作区的 Claude Code 对话",
		running: "服务运行中", stopped: "服务已停止", port: "端口", start: "启动服务", stop: "停止服务",
		scanTitle: "扫码配对", scanSub: "用手机相机或浏览器扫描，手机需与电脑处于同一局域网",
		notRunning: "启动服务后显示配对二维码", noLan: "未检测到局域网地址 —— 请连接 Wi-Fi 或有线网络",
		copyLink: "复制链接", codeTitle: "配对码", codeSub: "无法扫码时，在手机上打开链接并输入此配对码",
		show: "显示", hide: "隐藏", copy: "复制", copied: "已复制", keyId: "密钥 ID", created: "创建于",
		reset: "重置配对密钥", resetSub: "立即生成新密钥：所有已配对设备将断开，需要重新扫码。配对码泄露时请立即重置。",
		devices: "已配对设备", noDevices: "还没有设备连接", online: "在线", lastSeen: "最近活动",
		activity: "远程活动", noActivity: "暂无远程活动", turnsRunning: "运行中", turnsQueued: "排队中",
		env: "运行环境", cli: "Claude CLI", roots: "会话存储", folders: "工作区",
		secTitle: "安全说明",
		sec1: "二维码与配对码就是访问密钥：任何获得它的人都能读取并操控本机的 Claude Code 对话。只向信任的设备展示。",
		sec2: "配对码只出现在链接的 # 片段中（浏览器从不发送片段）；之后所有请求与应答均以 AES-256-GCM 加密，密钥由配对码经 PBKDF2-SHA256（15 万轮）派生，并通过 AAD 绑定请求与应答，防重放、防篡改。",
		sec3: "仅限局域网，无任何云端中继；错误尝试会触发按地址的锁定。需跨网使用请走 VPN，不要把端口暴露到公网。",
		ev_send: "发送指令", ev_start: "开始运行", ev_done: "运行完成", ev_error: "运行失败", ev_interrupted: "已中断", ev_stop: "停止运行", ev_session: "创建会话", ev_device: "设备已配对", ev_answer: "回答提问",
		now: "刚刚", minAgo: "{0} 分钟前", hourAgo: "{0} 小时前"
	},
	en: {
		title: "Claude Remote", subtitle: "Read and continue this workspace's Claude Code conversations from your phone",
		running: "Server running", stopped: "Server stopped", port: "Port", start: "Start server", stop: "Stop server",
		scanTitle: "Scan to pair", scanSub: "Scan with the phone camera or browser — the phone must be on the same network",
		notRunning: "Start the server to show the pairing QR", noLan: "No LAN address found — connect to Wi-Fi or Ethernet",
		copyLink: "Copy link", codeTitle: "Pairing code", codeSub: "Can't scan? Open the link on the phone and type this code",
		show: "Show", hide: "Hide", copy: "Copy", copied: "Copied", keyId: "Key ID", created: "Created",
		reset: "Reset pairing key", resetSub: "Generates a new key now: every paired device is disconnected and must scan again. Reset immediately if the code leaked.",
		devices: "Paired devices", noDevices: "No device has connected yet", online: "Online", lastSeen: "Last seen",
		activity: "Remote activity", noActivity: "No remote activity yet", turnsRunning: "running", turnsQueued: "queued",
		env: "Environment", cli: "Claude CLI", roots: "Session store", folders: "Workspace",
		secTitle: "Security",
		sec1: "The QR and the pairing code are the access key: anyone holding them can read and drive this machine's Claude Code conversations. Show them only to devices you trust.",
		sec2: "The code travels only in the link's # fragment (browsers never send fragments); afterwards every request and response is AES-256-GCM encrypted under a key derived from it (PBKDF2-SHA256, 150k rounds), with AAD binding each answer to its request — replayed or altered messages are rejected.",
		sec3: "LAN only, no cloud relay; repeated failures lock the sending address out. To use it across networks, go through a VPN — never expose the port to the internet.",
		ev_send: "Prompt sent", ev_start: "Turn started", ev_done: "Turn finished", ev_error: "Turn failed", ev_interrupted: "Interrupted", ev_stop: "Stopped", ev_session: "Session created", ev_device: "Device paired", ev_answer: "Question answered",
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
<!-- The panel is deliberately one inline document, and both hosts inject inline code into it
     (VS Code's acquireVsCodeApi bootstrap, Git Graph Studio's boot script and theme style
     attributes), so script/style stay 'unsafe-inline' — but nothing else can load or connect. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
:root {
	--bg: var(--vscode-editor-background, #1e1e1e);
	--fg: var(--vscode-foreground, #cccccc);
	--muted: var(--vscode-descriptionForeground, #8b8b8b);
	--card: var(--vscode-sideBar-background, #252526);
	--border: var(--vscode-panel-border, var(--vscode-widget-border, #3a3a3a));
	--accent: var(--vscode-button-background, #0e639c);
	--accent-fg: var(--vscode-button-foreground, #ffffff);
	--accent-hover: var(--vscode-button-hoverBackground, #1177bb);
	--sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
	--sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
	--sec-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
	--ok: var(--vscode-testing-iconPassed, #3fb984);
	--err: var(--vscode-errorForeground, #f48771);
	--warn: var(--vscode-editorWarning-foreground, #cca700);
	--link: var(--vscode-textLink-foreground, #3794ff);
	--mono: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
	--brand: #d97757;
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
.pill.on .dot { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
.btn { height: 30px; padding: 0 14px; border-radius: 6px; border: 0; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.btn:hover { background: var(--accent-hover); }
.btn.sec { background: var(--sec-bg); color: var(--sec-fg); }
.btn.sec:hover { background: var(--sec-hover); }
.btn.danger { background: transparent; color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 50%, transparent); }
.btn.danger:hover { background: color-mix(in srgb, var(--err) 12%, transparent); }
.btn.small { height: 26px; padding: 0 10px; font-size: 12px; font-weight: 500; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; min-width: 0; }
.card h2 { margin: 0 0 2px; font-size: 13.5px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.card .sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
.qr-box { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.qr { background: #fff; border-radius: 12px; padding: 8px; line-height: 0; }
.ips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.ip { height: 24px; padding: 0 9px; border-radius: 12px; border: 1px solid var(--border); background: transparent; color: var(--muted); font: 11.5px var(--mono); cursor: pointer; }
.ip.on { color: var(--fg); border-color: var(--link); }
.urlrow { display: flex; align-items: center; gap: 8px; width: 100%; }
.mono { font-family: var(--mono); }
.url { flex: 1; min-width: 0; font: 12px var(--mono); color: var(--link); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.placeholder { width: 236px; height: 236px; border: 1px dashed var(--border); border-radius: 12px; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 20px; }
.code { font: 600 19px/1.3 var(--mono); letter-spacing: .06em; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); word-break: break-all; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin-top: 12px; font-size: 12px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-family: var(--mono); word-break: break-all; }
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
.d.err { background: var(--err); }
.d.run { background: var(--link); }
.empty { color: var(--muted); padding: 14px 0; text-align: center; font-size: 12.5px; }
.stats { display: flex; gap: 10px; margin-bottom: 10px; }
.stat { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.stat b { font-size: 18px; display: block; }
.stat span { color: var(--muted); font-size: 11.5px; }
.sec { margin-top: 14px; }
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
		<button class="btn" id="toggle"></button>
	</header>
	<div class="grid">
		<section class="card">
			<h2>${T.scanTitle}</h2>
			<div class="sub">${T.scanSub}</div>
			<div class="qr-box" id="qrBox"></div>
		</section>
		<section class="card">
			<h2>${T.codeTitle}</h2>
			<div class="sub">${T.codeSub}</div>
			<div class="code" id="code"></div>
			<div class="row">
				<button class="btn sec small" id="reveal"></button>
				<button class="btn sec small" id="copyCode">${T.copy}</button>
			</div>
			<dl class="kv"><dt>${T.keyId}</dt><dd id="kid"></dd><dt>${T.created}</dt><dd id="created"></dd></dl>
			<div class="danger-zone">
				<button class="btn danger" id="reset">${T.reset}</button>
				<p>${T.resetSub}</p>
			</div>
		</section>
		<section class="card">
			<h2>${T.devices}</h2>
			<div class="list" id="devices"></div>
		</section>
		<section class="card">
			<h2>${T.activity}</h2>
			<div class="stats"><div class="stat"><b id="nRun">0</b><span>${T.turnsRunning}</span></div><div class="stat"><b id="nQueue">0</b><span>${T.turnsQueued}</span></div></div>
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
	let revealed = false;
	let ipIndex = 0;
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
		$("status").className = "pill" + (s.running ? " on" : "");
		$("statusText").textContent = s.running ? T.running + " · " + T.port + " " + s.port : T.stopped;
		$("toggle").textContent = s.running ? T.stop : T.start;
		$("toggle").className = s.running ? "btn sec" : "btn";
		const box = $("qrBox");
		if (!s.running) box.innerHTML = '<div class="placeholder">' + esc(T.notRunning) + "</div>";
		else if (!s.urls.length) box.innerHTML = '<div class="placeholder">' + esc(T.noLan) + "</div>";
		else {
			if (ipIndex >= s.urls.length) ipIndex = 0;
			const u = s.urls[ipIndex];
			box.innerHTML = '<div class="qr">' + u.qr + "</div>" +
				(s.urls.length > 1 ? '<div class="ips">' + s.urls.map((x, i) => '<button class="ip' + (i === ipIndex ? " on" : "") + '" data-ip="' + i + '" title="' + esc(x.name) + '">' + esc(x.ip) + "</button>").join("") + "</div>" : "") +
				'<div class="urlrow"><span class="url" title="' + esc(u.url) + '">' + esc(revealed ? u.url : u.url.replace(/#.*/, "#p=••••")) + '</span><button class="btn sec small" data-copy-url>' + esc(T.copyLink) + "</button></div>";
		}
		$("code").textContent = revealed ? s.code : s.code.replace(/[0-9A-Z]/g, "•");
		$("reveal").textContent = revealed ? T.hide : T.show;
		$("kid").textContent = s.kid;
		$("created").textContent = new Date(s.createdAt).toLocaleString();
		$("devices").innerHTML = s.devices.length ? s.devices.map((d) =>
			'<div class="item"><span class="d' + (d.online ? " on" : "") + '"></span><div class="grow"><div class="t">' + esc(d.label) + '</div><div class="m">' + esc(d.ip) + " · " + (d.online ? esc(T.online) : esc(T.lastSeen) + " " + esc(ago(d.lastSeen))) + "</div></div></div>").join("")
			: '<div class="empty">' + esc(T.noDevices) + "</div>";
		$("nRun").textContent = s.summary.running;
		$("nQueue").textContent = s.summary.queued;
		$("activity").innerHTML = s.summary.activity.length ? s.summary.activity.slice(0, 12).map((a) => {
			const cls = a.kind === "error" ? "err" : a.kind === "start" || a.kind === "send" ? "run" : a.kind === "done" ? "on" : "";
			const detail = a.error || a.text || a.title || "";
			return '<div class="item"><span class="d ' + cls + '"></span><div class="grow"><div class="t">' + esc(T["ev_" + a.kind] || a.kind) + (a.device ? " · " + esc(a.device) : "") + '</div><div class="m">' + esc(detail) + '</div></div><span class="m">' + esc(ago(a.at)) + "</span></div>";
		}).join("") : '<div class="empty">' + esc(T.noActivity) + "</div>";
		$("folders").textContent = s.folders.join("\\n") || "—";
		$("cli").textContent = s.cli;
		$("roots").textContent = s.roots.join("  ·  ") || "—";
	}

	document.addEventListener("click", (e) => {
		const ip = e.target.closest("[data-ip]");
		if (ip) { ipIndex = Number(ip.dataset.ip); render(); return; }
		if (e.target.closest("[data-copy-url]")) { vscode.postMessage({ type: "copy", text: state.urls[ipIndex].url }); flash(e.target.closest("button")); return; }
		const id = e.target.closest("button") && e.target.closest("button").id;
		if (id === "reveal") { revealed = !revealed; render(); }
		else if (id === "copyCode") { vscode.postMessage({ type: "copy", text: state.code }); flash($("copyCode")); }
		else if (id === "reset") vscode.postMessage({ type: "resetKey" });
		else if (id === "toggle") vscode.postMessage({ type: state.running ? "stop" : "start" });
	});
	window.addEventListener("message", (e) => {
		if (e.data && e.data.type === "state") { const rekeyed = e.data.state.kid !== state.kid; state = e.data.state; if (rekeyed) revealed = false; render(); }
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
