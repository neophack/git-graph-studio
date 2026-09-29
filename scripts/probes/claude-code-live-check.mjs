// The Claude Code live check: drives the real app (release exe + WebView2 CDP) and proves
// the Anthropic claude-code extension runs on the chosen extension host — the default
// ggs-node (the bundled Boa runtime, what every install gets), or the real-Node opt-in
// (`--host real-node`, GGS_REAL_NODE=1):
//   1. the extension's backend is running, and its process image is that host
//      (ggs-node.exe, or node.exe running node-host.cjs);
//   2. the extension's commands land in the workbench palette ("Claude Code: …");
//   3. running "Claude Code: Open in New Tab" opens the chat webview, claude's own
//      webview bundle (webview/index.js, served over ggs://) loads in it, and the chat UI
//      mounts inside the frame;
//   4. the extension's MCP server (the IDE link the Claude CLI connects to) is running;
//   5. the layout is VS Code 1.106's: the activity bar carries one Claude Code entry (the
//      sessions list — the chat never pins into the narrow sidebar) and every webview view
//      resolved without an error in the extension host log;
//   6. no exception-level console entry in the workbench during all of it.
//
//   node scripts/probes/claude-code-live-check.mjs [--port 9233] [--exe <path>] [--host ggs-node|real-node]
//     [--screenshot <file.png>]  (the workbench with the chat tab open, for a human to look at)
//
// Login (the OAuth browser round) and a real conversation stay interactive steps — the
// probe proves the extension runs, not that the user's account is signed in.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9233');
const exe = flag('--exe', [
	join(appDir, 'target', 'studio', 'cargo', 'release', 'ggs.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'debug', 'git-graph-studio.exe')
].find((p) => existsSync(p)));
if (!exe || !existsSync(exe)) {
	console.error('usage: node scripts/probes/claude-code-live-check.mjs [--exe <exe>] (no built exe found)');
	process.exit(2);
}
const EXT_ID = 'Anthropic.claude-code';
const host = flag('--host', 'ggs-node');
const screenshot = flag('--screenshot', null);
if (host !== 'ggs-node' && host !== 'real-node') {
	console.error('--host is ggs-node or real-node');
	process.exit(2);
}

const workspace = join(tmpdir(), 'ggs-claude-live-check');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

const logFile = join(appDir, 'target', 'studio', 'claude-code-live-check.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `Claude Code live check — ${new Date().toISOString()}\nexe: ${exe}\n\n`);
const log = (line) => {
	console.log(line);
	appendFileSync(logFile, line + '\n');
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The extension host log's own local timestamp format: only this run's lines are judged.
const startedAt = (() => {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
})();

let failures = 0;
const check = (name, ok, detail = '') => {
	log(`[${ok ? 'pass' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

/* ---------- CDP: one session on the page target, with per-frame child sessions ---------- */
async function session(target) {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const consoleEntries = [];
	const frames = [];
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		} else if (msg.method === 'Runtime.consoleAPICalled') {
			const text = msg.params.args.map((a) => String(a.value ?? a.description ?? a.type ?? '')).join(' ');
			consoleEntries.push({ level: msg.params.type, text });
		} else if (msg.method === 'Runtime.exceptionThrown') {
			const details = msg.params.exceptionDetails;
			consoleEntries.push({ level: 'exception', text: `${details.text} ${details.exception?.description ?? ''}`.trim() });
		} else if (msg.method === 'Target.attachedToTarget') {
			frames.push({ sessionId: msg.params.sessionId, url: msg.params.targetInfo.url });
		} else if (msg.method === 'Runtime.executionContextCreated') {
			const ctx = msg.params.context;
			frames.push({ sessionId: null, contextId: ctx.id, name: ctx.name, origin: ctx.origin });
		}
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params: sessionId ? { ...params, sessionId } : params }));
	});
	await send('Runtime.enable');
	// Frame targets attach as flattened child sessions (out-of-process iframes included).
	await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	const evaluate = async (expression, sessionId) => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
		if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result?.result?.value ?? null;
	};
	return { evaluate, send, frames, consoleEntries, close: () => ws.close() };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

function killTree(pid) {
	spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8' });
}

/* ---------- launch (the real-Node host only under its opt-in) ---------- */
const child = spawn(exe, [workspace], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'pipe'],
	env: {
		...process.env,
		...(host === 'real-node' ? { GGS_REAL_NODE: '1' } : {}),
		WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
	}
});
child.stderr.on('data', (chunk) => {
	for (const line of chunk.toString().split('\n').filter(Boolean)) appendFileSync(logFile, '[exe] ' + line.trimEnd() + '\n');
});

let page = null;
for (let attempt = 0; attempt < 60 && !page; attempt++) {
	try {
		page = (await targets()).find((target) => target.type === 'page' && !target.url.startsWith('devtools'));
	} catch { /* not up yet */ }
	if (!page) await sleep(500);
}
if (!page) {
	log('[fatal] no CDP page target');
	killTree(child.pid);
	process.exit(1);
}
const workbench = await session(page);

// Capture the extension's host requests for the whole run (activation → webview): the
// release workbench resolves the Tauri event API through its own bundled modules.
for (let attempt = 0; attempt < 3; attempt++) {
	const attached = await workbench.evaluate(`(async () => {
		// Tauri's own IPC surface: present in dev and release builds alike (the Vite module
		// paths exist only under the dev server).
		const tauri = window.__TAURI_INTERNALS__;
		window.__probeRequests = window.__probeRequests ?? [];
		const listen = (name, handler) => tauri.invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler: tauri.transformCallback(handler) });
		await listen('ext-host-request', (event) => {
			if (event.payload.extId === 'Anthropic.claude-code') {
				window.__probeRequests.push(event.payload.method + ' ' + JSON.stringify(event.payload.args ?? []).slice(0, 100));
		if (event.payload.method === 'webview.setHtml') { window.__setHtmlPayload = String(event.payload.args[1] ?? ''); }
			}
		});
		return true;
	})()`).catch(() => false);
	if (attached) { log('[capture] the host-request capture attached'); break; }
	await sleep(1000);
}

try {
	/* 1. The backend: running, on the chosen host. */
	let status = null;
	for (let attempt = 0; attempt < 60; attempt++) {
		await sleep(500);
		const tauriImport = `window.__TAURI_INTERNALS__.invoke('ext_process_status')`;
		const all = await workbench.evaluate(tauriImport).catch(() => null);
		status = (all ?? []).find((entry) => entry.extensionId === EXT_ID) ?? null;
		if (status && status.pid > 0) break;
	}
	check('the claude-code backend is running', Boolean(status && status.pid > 0), JSON.stringify(status));
	if (status && status.pid > 0) {
		const image = spawnSync('tasklist', ['/FI', `PID eq ${status.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.trim();
		const imageName = image.split(',')[0]?.replace(/"/g, '') ?? '';
		if (host === 'real-node') check('the backend process is node.exe (the real-Node host)', /^node(.exe)?$/i.test(imageName), imageName);
		else check('the backend process is ggs-node (the bundled runtime)', /^ggs-node/i.test(imageName), imageName);
	}

	/* 2. The extension's commands land in the palette. */
	await sleep(2500);
	const rows = await workbench.evaluate(`(async () => {
		document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 400));
		const input = document.querySelector('#overlays .quick-input input');
		if (!input) return [];
		input.value = '> Claude Code';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 400));
		return [...document.querySelectorAll('#overlays .quick-input .row')].map((r) => r.textContent.trim());
	})()`) ?? [];
	check('claude-code commands land in the palette', rows.some((text) => /Claude Code/.test(text)), rows.slice(0, 3).join(' | '));

	/* 2½. The layout: the sessions list alone in the activity bar, every view resolved. */
	// The container lands once the activation's setContext names the sessions list: wait
	// for it, then let any stray rebuild settle before counting.
	const countClaudeEntries = () => workbench.evaluate(`[...document.querySelectorAll('#activitybar .activity-item')].filter((item) => item.getAttribute('aria-label') === 'Claude Code').length`);
	for (let attempt = 0; attempt < 40 && (await countClaudeEntries()) === 0; attempt++) await sleep(500);
	await sleep(2000);
	const claudeEntries = await countClaudeEntries();
	check('one Claude Code activity-bar entry (the sessions list, no chat in the sidebar)', claudeEntries === 1, `entries=${claudeEntries}`);
	await workbench.evaluate(`[...document.querySelectorAll('#activitybar .activity-item')].find((item) => item.getAttribute('aria-label') === 'Claude Code')?.click()`);
	await sleep(3000);
	const heights = await workbench.evaluate(`(() => {
		const pane = [...document.querySelectorAll('.ext-webview-view-pane')].find((p) => p.offsetParent !== null);
		return { pane: pane ? pane.getBoundingClientRect().height : 0, sidebar: document.getElementById('sidebar').getBoundingClientRect().height };
	})()`);
	check('the sessions list fills the sidebar height', heights.pane >= heights.sidebar * 0.8, JSON.stringify(heights));
	const hostLog = join(homedir(), '.ggs', 'logs', 'ext-host.log');
	const failedResolves = existsSync(hostLog)
		? readFileSync(hostLog, 'utf8').split('\n').filter((line) => line >= startedAt && /\[Anthropic\.claude-code\] resolveWebviewView\(.*failed/.test(line))
		: [];
	check('every Claude Code webview view resolved', failedResolves.length === 0, failedResolves.slice(0, 1).join(''));

	/* 3. Open the chat webview from the palette. */
	const opened = await workbench.evaluate(`(async () => {
		const open = document.querySelector('#overlays .quick-input input');
		open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 400));
		const input = document.querySelector('#overlays .quick-input input');
		if (!input) return false;
		input.value = '> Claude Code: Open in New Tab';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			const row = [...document.querySelectorAll('#overlays .quick-input .row')].find((r) => /Open in New Tab/.test(r.textContent));
			if (row) {
				row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				return true;
			}
		}
		return false;
	})()`);
	check('the Open in New Tab command ran from the palette', opened === true);
	await sleep(8000);

	/* 4. The chat webview rendered: the workbench has a "Claude Code" tab with webview
	 * iframes, and the extension's own machinery is alive (its Output channel logs the
	 * OAuth/MCP state — captured from the ext-host-request event stream by the run
	 * below through the DOM-visible tab). The iframe itself is sandboxed cross-origin:
	 * CDP content probing of it is unreliable, so the tab + assets + extension logs are
	 * the evidence. */
	const setHtmlPayload = await workbench.evaluate('window.__setHtmlPayload ?? ""');
	if (setHtmlPayload) { writeFileSync('target/studio/claude-sethtml.html', setHtmlPayload); log('[setHtml] saved ' + setHtmlPayload.length + ' chars'); }
	const tabState = await workbench.evaluate(`(() => ({
		tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
		iframes: document.querySelectorAll('iframe').length
	}))()`);
	check('the chat webview tab exists ("Claude Code")', tabState.tabs.some((t) => /Claude Code/i.test(t)), JSON.stringify(tabState));

	/* 4½. Probe inside the webview frame: the sandboxed srcdoc iframe's own execution
	 * context (flat-attached sessions or same-process contexts) — root mounted + content
	 * means the chat UI actually booted; a blank frame means it crashed on load. */
	let webviewOk = false;
	let webviewDetail = String.fromCharCode(45,45);
	const frameProbeExpression = `(() => ({ root: Boolean(document.querySelector('#root, #app')), children: document.body ? document.body.childElementCount : 0, text: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 60) : '' }))()`;
	let frameReport = [];
	for (const frame of workbench.frames) {
		try {
			const probe = frame.sessionId !== null
				? await workbench.send('Runtime.evaluate', { expression: frameProbeExpression, returnByValue: true }, frame.sessionId).then((r) => r?.result?.value ?? { root: false, children: 0 })
				: await workbench.send('Runtime.evaluate', { expression: frameProbeExpression, returnByValue: true, contextId: frame.contextId }).then((r) => r?.result?.value ?? { root: false, children: 0 });
			frameReport.push(probe);
			if (probe.root && probe.children > 0) { webviewOk = true; webviewDetail = JSON.stringify(probe); }
			log(String.fromCharCode(91,102,114,97,109,101,93) + " " + JSON.stringify(probe));
		} catch { /* a frame whose context is gone skips */ }
	}

	if (screenshot) {
		const shot = await workbench.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
		if (shot?.data) {
			writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
			log(`[screenshot] ${screenshot}`);
		}
	}
	check('the chat UI mounted inside the webview frame', webviewOk, webviewOk ? webviewDetail : JSON.stringify(frameReport.slice(0, 4)));

	/* 4¾. "New session" in the chat tab opens another editor tab (the tab-hosted chat's
	 * openNewInTab path: new_conversation_tab → claude-vscode.editor.open → a new panel). */
	const tabsBefore = await workbench.evaluate(`[...document.querySelectorAll('.tab')].filter((t) => /Claude Code/i.test(t.textContent)).length`);
	const framesBefore = workbench.frames.length; // the new panel's own frame session lands after this
	const clickedNew = await workbench.evaluate(`(() => {
		for (const frame of document.querySelectorAll('iframe')) {
			let doc = null;
			try { doc = frame.contentDocument; } catch { continue; }
			const button = doc?.querySelector('[aria-label="New session"]');
			if (button) { button.click(); return true; }
		}
		return false;
	})()`);
	let tabsAfter = tabsBefore;
	for (let attempt = 0; attempt < 30 && tabsAfter <= tabsBefore; attempt++) {
		await sleep(500);
		tabsAfter = await workbench.evaluate(`[...document.querySelectorAll('.tab')].filter((t) => /Claude Code/i.test(t.textContent)).length`);
	}
	check('"New session" in the chat tab opens a new editor tab', clickedNew === true && tabsAfter === tabsBefore + 1, `clicked=${clickedNew} tabs ${tabsBefore} -> ${tabsAfter}`);

	/* 4⅞. The new session's own page rendered — a tab that opened but stayed empty was
	 * exactly the mount race (the extension's initial postMessage crossed before the tab
	 * mounted, and the old host dropped it). The tab-count check above cannot see it:
	 * this probes the frame that attached since the click for real content — root
	 * mounted, children, and non-empty text (a blank-but-loaded page has none). */
	let newSessionOk = false;
	let newSessionDetail = String.fromCharCode(45, 45);
	for (let attempt = 0; attempt < 30 && !newSessionOk; attempt++) {
		await sleep(500);
		for (const frame of workbench.frames.slice(framesBefore)) {
			if (frame.sessionId === null) continue;
			try {
				const probe = await workbench.send('Runtime.evaluate', { expression: frameProbeExpression, returnByValue: true }, frame.sessionId)
					.then((r) => r?.result?.value ?? { root: false, children: 0, text: '' });
				if (probe.root && probe.children > 0 && (probe.text || '').trim().length > 0) {
					newSessionOk = true;
					newSessionDetail = JSON.stringify(probe);
					break;
				}
			} catch { /* a frame whose context is gone skips */ }
		}
	}
	check('the new session page rendered inside its frame (not the blank mount race)', newSessionOk, newSessionDetail);

	/* 5. The extension's host requests prove the webview lifecycle (create + setHtml +
	 * postMessage flowing), and its Output channel + the served assets show the machinery
	 * running. The app log ([exe] lines) carries the ggs:// asset serves. */
	const probeRequests = await workbench.evaluate('window.__probeRequests ?? []');
	const captureAttached = probeRequests.length > 0;
	if (!captureAttached) log('[skip] the request capture never attached - the lifecycle checks below are informational only');
	const appLog = readFileSync(logFile, 'utf8');
	const created = probeRequests.some((r) => r.startsWith('webview.create'));
	const htmlSet = probeRequests.some((r) => r.startsWith('webview.setHtml'));
	const posted = probeRequests.some((r) => r.startsWith('webview.postMessage'));
	const assetsServed = /ext-asset\] 200 ggs:\/\/localhost\/Anthropic\.claude-code.*webview\/index\.(js|css)/.test(appLog);
	check('the chat webview lifecycle ran (create + setHtml + postMessage)', created && htmlSet && posted, JSON.stringify(probeRequests.slice(-6)));
	check('the chat UI assets were served over ggs://', assetsServed);
	const machinery = probeRequests.filter((r) => /OAuth tokens|AuthManager|MCP Server/.test(r));
	check("the extension's OAuth/MCP machinery is alive", machinery.length > 0, JSON.stringify(machinery.slice(0, 2)));
	const mcp = probeRequests.find((r) => /MCP Server running on port/.test(r));
	check('the IDE MCP server is running (the Claude CLI link)', Boolean(mcp), mcp ?? 'no "MCP Server running" line');

	/* 7. No exception-level console entries in the workbench. */
	const exceptions = workbench.consoleEntries.filter((entry) => entry.level === 'exception');
	check('no exception-level console entries', exceptions.length === 0, exceptions.slice(0, 2).map((e) => e.text.slice(0, 400)).join(' | '));
} finally {
	log(`[done] failures=${failures}`);
	killTree(child.pid);
}
process.exit(failures === 0 ? 0 : 1);
