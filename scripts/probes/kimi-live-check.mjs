// The Kimi Code live check: the moonshot-ai.kimi-code extension, downloaded from Open VSX
// and installed through the app's OWN installer, then exercised feature by feature in the
// real app (release exe + WebView2 CDP) — the installer's derived backend, the palette
// rows, the activity-bar container, the sidebar webview view (timed — the "打开速度快"
// bar), the tab-hosted chat, the remaining commands, the declared settings, the
// keybinding, and a clean extension-host log.
//
//   node scripts/probes/kimi-live-check.mjs [--port 9235] [--exe <path>] [--version x.y.z]
//        [--keep]  (the app stays open after the pass, for interactive poking)
//
// The run is sandboxed: HOME points at target/studio/kimi-sandbox/home, so the install,
// the backend, the bytecode cache and the extension-host log never touch the real
// ~/.ggs. Login ("Sign in with Kimi Account", the OAuth browser round) and a real
// conversation stay account-bound steps — the probe proves the extension runs, not that
// a Kimi account is signed in.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9235');
const version = flag('--version', '');
const keep = args.includes('--keep');
const exe = flag('--exe', [
	join(appDir, 'target', 'studio', 'cargo', 'release', 'ggs.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'debug', 'git-graph-studio.exe')
].find((p) => existsSync(p)));
if (!exe || !existsSync(exe)) {
	console.error('usage: node scripts/probes/kimi-live-check.mjs [--exe <exe>] (no built exe found)');
	process.exit(2);
}

const KIMI = 'moonshot-ai.kimi-code';
const sandbox = join(appDir, 'target/studio/kimi-sandbox');
const home = join(sandbox, 'home');
// The workspace lives OUTSIDE the repository (in TEMP): `ggs <folder>` resolves a folder
// inside a git repository to the repository ROOT by design ("a repository resolves to its
// root"), so a workspace under target/ would open the whole checkout — the nested-repo
// trap the claude-code probes moved to TEMP for the same reason.
const workspace = join(tmpdir(), 'ggs-kimi-live-check');
const reportFile = join(sandbox, 'kimi-report.json');
const screenshotFile = join(sandbox, 'kimi-sidebar.png');
const logFile = join(appDir, 'target', 'studio', 'kimi-live-check.log');

rmSync(sandbox, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
mkdirSync(join(home, '.ggs'), { recursive: true });
mkdirSync(join(workspace, 'src'), { recursive: true });
writeFileSync(join(workspace, 'src', 'main.py'), 'print("kimi sandbox workspace")\n');
writeFileSync(join(workspace, 'README.md'), '# kimi sandbox\n');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `Kimi Code live check — ${new Date().toISOString()}\nexe: ${exe}\n\n`);
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
const rows = [];
const check = (name, ok, detail = '', ms = 0) => {
	log(`[${ok ? 'pass' : 'FAIL'}]${ms ? ` (${ms} ms)` : ''} ${name}${detail ? ` — ${detail}` : ''}`);
	rows.push({ name, status: ok ? 'pass' : 'fail', ms, detail });
	if (!ok) failures++;
};

/* ---------- the VSIX: Open VSX, this machine's platform build, cached ---------- */
const cacheDir = join(appDir, 'target/studio/marketplace-cache/compat');
mkdirSync(cacheDir, { recursive: true });
const [namespace, name] = KIMI.split('.');
const meta = await (await fetch(`https://open-vsx.org/api/${namespace}/${name}${version ? `/${version}` : ''}`)).json();
if (!meta.version) {
	console.error(`[fatal] Open VSX knows no ${KIMI}`);
	process.exit(2);
}
const targetPlatform = `${process.platform}-${process.arch}`;
const vsixPath = join(cacheDir, `${KIMI}-${meta.version}.vsix`);
if (!existsSync(vsixPath)) {
	const url = meta.files?.download;
	if (!url) {
		console.error(`[fatal] no download for ${KIMI} (want ${targetPlatform})`);
		process.exit(2);
	}
	log(`downloading ${KIMI} ${meta.version} (${url.split('/file/')[1] ?? url})`);
	const response = await fetch(url);
	if (!response.ok) {
		console.error(`[fatal] download failed: ${response.status}`);
		process.exit(2);
	}
	writeFileSync(vsixPath, Buffer.from(await response.arrayBuffer()));
} else {
	log(`vsix cached: ${vsixPath}`);
}

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
	await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	const evaluate = async (expression, sessionId) => {
		const result = await Promise.race([
			send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId),
			new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timed out')), 120000))
		]);
		if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result?.result?.value ?? null;
	};
	return { evaluate, send, frames, consoleEntries, close: () => ws.close() };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

function killTree(pid) {
	spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8' });
}

/* ---------- launch (sandbox HOME; CDP on the debug port) ---------- */
const child = spawn(exe, [workspace], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'pipe'],
	env: {
		...process.env,
		HOME: home,
		// A distinct instance id: this run owns its backends and never hands a launch
		// path to (or takes one from) an instance another session left behind.
		GGS_INSTANCE_ID: 'kimi-live-check',
		// `--host real-node`: the explicit opt-in — the package's ESM, workers and
		// node_modules behave natively (the ggs-node runtime is the default host).
		...(args.includes('--host') && flag('--host', '') === 'real-node' ? { GGS_REAL_NODE: '1' } : {}),
		WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
	}
});
child.stderr.on('data', (chunk) => {
	for (const line of chunk.toString().split('\n').filter(Boolean)) appendFileSync(logFile, '[exe] ' + line.trimEnd() + '\n');
});
const stopApp = () => {
	if (child.exitCode === null) killTree(child.pid);
};

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

/** One palette round: close whatever is open, open the palette, type the query, and
 *  return the visible rows — exactly what a user's palette shows. */
const paletteRows = async (query) => workbench.evaluate(`(async () => {
	document.querySelector('#overlays .quick-input input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	await new Promise((resolve) => setTimeout(resolve, 250));
	document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 400));
	const input = document.querySelector('#overlays .quick-input input');
	if (!input) return null;
	input.value = '> ' + ${JSON.stringify(query)};
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 400));
	return [...document.querySelectorAll('#overlays .quick-input .row')].map((r) => r.textContent.trim());
})()`);

/** Type a palette query and click the first row matching the pattern — polling until the
 *  row appears, the way a user waits for the palette's async filter. */
const paletteClick = async (query, pattern, tries = 20) => {
	for (let attempt = 0; attempt < tries; attempt++) {
		const clicked = await workbench.evaluate(`(async () => {
			const open = document.querySelector('#overlays .quick-input input');
			if (!open) {
				document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
			const input = document.querySelector('#overlays .quick-input input');
			if (!input) return false;
			if (input.value !== '> ' + ${JSON.stringify(query)}) {
				input.value = '> ' + ${JSON.stringify(query)};
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
			const row = [...document.querySelectorAll('#overlays .quick-input .row')].find((r) => ${String(pattern)}.test(r.textContent));
			if (!row) return false;
			row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
			return true;
		})()`);
		if (clicked) return true;
		await sleep(500);
	}
	return false;
};

/** The error toasts currently in the notification centre. */
const errorToasts = async () => workbench.evaluate(`[...document.querySelectorAll('#notifications .notification')].filter((t) => t.querySelector('.codicon-error')).map((t) => t.querySelector('.message')?.textContent ?? '')`);
const clearToasts = () => workbench.evaluate(`(() => { for (const button of document.querySelectorAll('#notifications [title="Clear Notification"]')) button.click(); })()`);
/** Run a command from the palette and return the error toasts that appear within 2.5 s. */
const runByPalette = async (query, pattern) => {
	await clearToasts();
	const ok = await paletteClick(query, pattern);
	if (!ok) return { clicked: false, errors: [] };
	await sleep(2500);
	return { clicked: true, errors: (await errorToasts()) ?? [] };
};

try {
	/* 1. Install through the app's own installer — the real path, the real derivation. */
	let ready = false;
	for (let attempt = 0; attempt < 60 && !ready; attempt++) {
		ready = await workbench.evaluate(`Boolean(window.__TAURI_INTERNALS__ && document.querySelector('.command-center'))`).catch(() => false);
		if (!ready) await sleep(1000);
	}
	check('the workbench is up (Tauri IPC + command center present)', ready === true);
	const installed = await workbench.evaluate(`window.__TAURI_INTERNALS__.invoke('ext_install_from_vsix', { path: ${JSON.stringify(vsixPath)} })`);
	check('ext_install_from_vsix accepts the package', installed?.id === KIMI, installed ? `${installed.id} ${installed.version}` : JSON.stringify(installed));
	const backend = installed?.capabilities?.backend ?? null;
	check('the derived backend is the ggs-node kind (the Kimi rule)', backend?.kind === 'node' && /extension\.js$/.test(backend?.command ?? ''), JSON.stringify(backend));
	const listed = await workbench.evaluate(`window.__TAURI_INTERNALS__.invoke('ext_list')`);
	check('ext_list carries the install', (listed ?? []).some((entry) => entry.id === KIMI && entry.version === installed.version), `${(listed ?? []).length} packages installed`);

	/* 1½. The UI install flow ends in the host's reload (`installFromVsix` → `reload(id)`,
	 *     contributions and backend follow). The raw command skips that half, so the probe
	 *     reboots the workbench — the boot pass then picks the install up exactly the way
	 *     every later launch of the app does. */
	await workbench.send('Page.enable', {}).catch(() => null);
	await workbench.send('Page.reload', {}).catch(() => null);
	let readyAgain = false;
	for (let attempt = 0; attempt < 60 && !readyAgain; attempt++) {
		readyAgain = await workbench.evaluate(`Boolean(window.__TAURI_INTERNALS__ && document.querySelector('.command-center'))`).catch(() => false);
		if (!readyAgain) await sleep(1000);
	}
	check('the workbench reboots over the fresh install', readyAgain === true);

	/* 1¾. The launch folder is the sandbox workspace (a launch-path bug would silently
	 *     retarget every editor-dependent check to whatever folder the app picked). */
	let openedFolder = '';
	for (let attempt = 0; attempt < 20 && openedFolder === ''; attempt++) {
		await sleep(500);
		openedFolder = (await workbench.evaluate(`(() => {
			const center = document.querySelector('.command-center');
			const match = center ? /Search\\s+(\\S+)/.exec(center.textContent ?? '') : null;
			return match ? match[1] : (center?.textContent ?? '').trim().slice(0, 60);
		})()`).catch(() => '')) ?? '';
	}
	check('the app opened the sandbox workspace', openedFolder.includes('ggs-kimi-live-check'), `command center shows: ${openedFolder}`);

	/* 2. The derived backend process is up, and its image is ggs-node. */
	let status = null;
	for (let attempt = 0; attempt < 90; attempt++) {
		await sleep(500);
		const all = await workbench.evaluate(`window.__TAURI_INTERNALS__.invoke('ext_process_status')`).catch(() => null);
		status = (all ?? []).find((entry) => entry.extensionId === KIMI) ?? null;
		if (status && status.pid > 0) break;
	}
	check('the kimi-code backend is running', Boolean(status && status.pid > 0), JSON.stringify(status));
	const realNode = args.includes('--host') && flag('--host', '') === 'real-node';
	if (status && status.pid > 0) {
		const image = spawnSync('tasklist', ['/FI', `PID eq ${status.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.trim();
		const imageName = image.split(',')[0]?.replace(/"/g, '') ?? '';
		if (realNode) check('the backend process is node.exe (the real-Node host)', /^node(\.exe)?$/i.test(imageName), imageName);
		else check('the backend process is ggs-node (the bundled runtime)', /^ggs-node/i.test(imageName), imageName);
	}

	/* 3. The palette lists the contributed commands — and hides the debug-only one. */
	await sleep(1500);
	const rows3 = (await paletteRows('Kimi Code')) ?? [];
	const titles3 = rows3.filter((text) => /Kimi Code:/.test(text));
	const expectCommands = ['Open in New Tab', 'Open in Side Panel', 'Focus Input', 'Insert Current File', 'New Conversation', 'Show Logs', 'Reset Kimi', 'Logout', 'Migrate Legacy Data'];
	const missing = expectCommands.filter((title) => !titles3.some((text) => text.includes(title)));
	check('every palette-visible command is listed', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : `${titles3.length} rows`);
	check('the debug-only Clear All State stays out of the palette', !titles3.some((text) => text.includes('Clear All State')), titles3.join(' | '));

	/* 4. The activity bar carries the Kimi Code container. */
	const countKimiEntries = () => workbench.evaluate(`[...document.querySelectorAll('#activitybar .activity-item')].filter((item) => /Kimi Code/.test(item.getAttribute('aria-label') ?? '') || /Kimi Code/.test(item.title ?? '')).length`);
	for (let attempt = 0; attempt < 40 && (await countKimiEntries()) === 0; attempt++) await sleep(500);
	check('one Kimi Code activity-bar entry', (await countKimiEntries()) === 1);

	/* 5. Open in Side Panel: the sidebar webview view mounts (the 打开速度快 bar) and
	 *    shows the extension's own login UI. */
	const sideStarted = Date.now();
	const side = await runByPalette('Kimi Code: Open in Side', /Open in Side Panel/);
	check('the Open in Side Panel command ran from the palette', side.clicked && side.errors.length === 0, side.errors.join(' | '));
	let frame = null;
	for (let attempt = 0; attempt < 60 && !frame; attempt++) {
		await sleep(1000);
		frame = await workbench.evaluate(`(() => {
			const candidates = [...document.querySelectorAll('#sidebar iframe.ext-page-frame')];
			const node = candidates.find((f) => f.contentDocument && f.contentDocument.body && f.contentDocument.body.childElementCount > 0);
			return node ? { width: Math.round(node.getBoundingClientRect().width), text: node.contentDocument.body.innerText.replace(/\\s+/g, ' ').slice(0, 200), kids: node.contentDocument.body.childElementCount } : null;
		})()`).catch(() => null);
	}
	const sideMs = Date.now() - sideStarted;
	check('the kimi.webview sidebar view mounts with content', Boolean(frame), frame ? JSON.stringify(frame).slice(0, 220) : 'no populated #sidebar iframe within 60s', sideMs);
	check('the mount meets the 打开速度快 bar (30 s)', Boolean(frame) && sideMs < 30000, `${sideMs} ms`);
	check('the webview shows the Kimi sign-in UI', Boolean(frame && /Sign in|Kimi/i.test(frame.text ?? '')), frame?.text?.slice(0, 120) ?? '');
	const shot = await workbench.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
	if (shot?.data) writeFileSync(screenshotFile, Buffer.from(shot.data, 'base64'));

	/* 6. Open in New Tab: the chat opens as an editor tab with its own mounted webview. */
	const tabStarted = Date.now();
	const tab = await runByPalette('Kimi Code: Open in New Tab', /Open in New Tab/);
	check('the Open in New Tab command ran from the palette', tab.clicked && tab.errors.length === 0, tab.errors.join(' | '));
	let tabState = null;
	for (let attempt = 0; attempt < 30 && !tabState; attempt++) {
		await sleep(1000);
		tabState = await workbench.evaluate(`(() => {
			const tab = [...document.querySelectorAll('.tab')].find((t) => /Kimi Code/i.test(t.textContent));
			if (!tab) return null;
			const iframe = [...document.querySelectorAll('iframe')].filter((f) => !f.closest('#sidebar')).find((f) => f.getBoundingClientRect().width > 100 && f.contentDocument && f.contentDocument.body && f.contentDocument.body.childElementCount > 0);
			return { tab: tab.textContent.trim(), mounted: Boolean(iframe), iframes: [...document.querySelectorAll('iframe')].filter((f) => !f.closest('#sidebar')).length };
		})()`).catch(() => null);
	}
	check('the chat opens as an editor tab with a mounted webview', Boolean(tabState?.mounted), JSON.stringify(tabState), Date.now() - tabStarted);

	/* 7-10. The remaining commands, each from the palette, each judged by the error toasts. */
	const conversation = await runByPalette('Kimi Code: New Conversation', /New Conversation/);
	check('New Conversation runs clean', conversation.clicked && conversation.errors.length === 0, conversation.errors.join(' | '));

	const focus = await runByPalette('Kimi Code: Focus Input', /Focus Input/);
	let focusDetail = focus.errors.join(' | ');
	let focusOk = focus.clicked && focus.errors.length === 0;
	if (focusOk) {
		const active = await workbench.evaluate(`(() => {
			const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentDocument && f.contentDocument.activeElement && f.contentDocument.activeElement !== f.contentDocument.body);
			const el = frame?.contentDocument.activeElement;
			return el ? { tag: el.tagName, editable: el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' } : null;
		})()`).catch(() => null);
		focusOk = Boolean(active?.editable);
		focusDetail = active ? JSON.stringify(active) : 'focus did not land in the webview';
	}
	check('Focus Input focuses the chat composer', focusOk, focusDetail);

	const logs = await runByPalette('Kimi Code: Show Logs', /Show Logs/);
	const logsEvidence = await workbench.evaluate(`(() => {
		const outputButton = document.querySelector('#panel .panel-actions [title*="Output"], #panel [class*="output"]');
		const visible = document.getElementById('panel')?.getBoundingClientRect().height ?? 0;
		return { panelHeight: Math.round(visible), hasOutput: Boolean(outputButton) };
	})()`).catch(() => null);
	check('Show Logs runs clean', logs.clicked && logs.errors.length === 0, (logs.errors.join(' | ') || JSON.stringify(logsEvidence)));

	const migrate = await runByPalette('Kimi Code: Migrate Legacy Data', /Migrate Legacy Data/);
	check('Migrate Legacy Data runs clean', migrate.clicked && migrate.errors.length === 0, migrate.errors.join(' | '));

	const logout = await runByPalette('Kimi Code: Logout', /Logout/);
	check('Logout without a login degrades cleanly (no error toast)', logout.clicked && logout.errors.length === 0, logout.errors.join(' | ') || 'no toast, no error');

	/* 11. The declared settings reach the Settings dialog (opened by its keybinding — the
	 *     palette rows carry locale titles, the keybinding does not). */
	let settingRows = [];
	let settingsDiag = 'no dialog';
	await clearToasts();
	await workbench.evaluate(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true })); })()`);
	await sleep(900);
	{
		const state11 = await workbench.evaluate(`(async () => {
			const search = document.querySelector('.settings-search');
			if (!search) return { rows: [], labels: [] };
			search.value = 'kimi.';
			search.dispatchEvent(new Event('input', { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 400));
			return {
				rows: [...document.querySelectorAll('.settings-row-label')].map((n) => n.textContent.trim()).filter((id) => id.startsWith('kimi.')),
				labels: [...document.querySelectorAll('.settings-row-label')].map((n) => n.textContent.trim()).slice(0, 8)
			};
		})()`) ?? {};
		settingRows = state11.rows ?? [];
		settingsDiag = JSON.stringify({ otherRows: state11.labels });
		await workbench.evaluate(`(() => { document.querySelector('.settings-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); })()`);
		await sleep(400);
	}
	const expectSettings = ['kimi.yoloMode', 'kimi.autosave', 'kimi.enableNewConversationShortcut', 'kimi.useCtrlEnterToSend', 'kimi.showThinkingContent', 'kimi.showThinkingExpanded', 'kimi.editorContext'];
	const missingSettings = expectSettings.filter((id) => !settingRows.includes(id));
	check('all 7 declared settings appear in the Settings dialog', missingSettings.length === 0, missingSettings.length ? `missing: ${missingSettings.join(', ')} | ${settingsDiag}` : settingRows.join(', '));

	/* 12. The Ctrl+Shift+K keybinding wakes the sidebar input. */
	await clearToasts();
	await workbench.evaluate(`(() => {
		for (const key of ['k', 'K']) {
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'KeyK', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
		}
	})()`);
	await sleep(2500);
	const focusedAfterKey = await workbench.evaluate(`(() => {
		const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentDocument && f.contentDocument.activeElement && f.contentDocument.activeElement !== f.contentDocument.body);
		const el = frame?.contentDocument.activeElement;
		return el ? { tag: el.tagName, editable: el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' } : null;
	})()`).catch(() => null);
	check('Ctrl+Shift+K lands focus in the chat composer', Boolean(focusedAfterKey?.editable), JSON.stringify(focusedAfterKey));

	/* 13. A clean run: no workbench exceptions, no kimi errors in the extension host log. */
	const exceptions = workbench.consoleEntries.filter((entry) => entry.level === 'exception');
	check('no exception-level console entries in the workbench', exceptions.length === 0, exceptions.slice(0, 2).map((e) => e.text.slice(0, 160)).join(' | '));
	const hostLogPath = join(home, '.ggs', 'logs', 'ext-host.log');
	const hostErrors = existsSync(hostLogPath)
		? readFileSync(hostLogPath, 'utf8').split('\n').filter((line) => line >= startedAt && /kimi/i.test(line) && /fail|error|panic|unable|missing/i.test(line))
		: [];
	check('the extension host log carries no kimi failure', hostErrors.length === 0, hostErrors.slice(0, 2).join(' | ').slice(0, 200));
} catch (error) {
	check('the pass crashed', false, String(error).slice(0, 300));
}

/* ---------- the verdict ---------- */
writeFileSync(reportFile, JSON.stringify({ startedAt: startedAt, rows, failures }, null, 1));
log('');
for (const row of rows) log(`${row.status === 'pass' ? '✓' : '✗'} ${row.name}${row.detail ? ' — ' + row.detail.slice(0, 200) : ''}`);
log('');
log(`kimi-code: ${rows.length - failures}/${rows.length} checks passed`);
if (keep) {
	log(`[keep] the app stays up for interactive testing (sandbox HOME: ${home}) — Ctrl-C this probe when done`);
	process.on('SIGINT', () => {
		stopApp();
		process.exit(130);
	});
} else {
	stopApp();
}
process.exit(failures > 0 ? 1 : 0);
