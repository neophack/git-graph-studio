// The UI interaction check: drives the real app (debug or release exe + WebView2 CDP)
// through the interactions a user performs constantly and asserts the state the UI lands
// in matches VS Code's - tab activation across closes, the quick input's open/Escape/reopen
// lifecycle, side-bar and panel toggles - with zero console exceptions along the way.
//
//   node scripts/probes/ui-interaction-check.mjs [--port 9245] [--exe <path>] <folder>

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9245');
const exe = flag('--exe', [
	join(appDir, 'target', 'studio', 'cargo', 'debug', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'ggs.exe')
].find((p) => existsSync(p)));
const target = args.find((a) => !a.startsWith('--')) ?? join(appDir, 'target', 'studio', 'bench-fixture');
if (!exe || !existsSync(exe)) {
	console.error('usage: node scripts/probes/ui-interaction-check.mjs [--exe <exe>] <folder>');
	process.exit(2);
}

const logFile = join(appDir, 'target', 'studio', 'ui-interaction-check.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `UI interaction check — ${new Date().toISOString()}\nexe: ${exe}\n\n`);
const log = (line) => { console.log(line); appendFileSync(logFile, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tauri = `(await import('/@id/@tauri-apps/api/core').catch(() => import('/node_modules/.vite/deps/@tauri-apps_api_core.js')))`;

let failures = 0;
const check = (name, ok, detail = '') => {
	log(`[${ok ? 'pass' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

/* One CDP session: evaluate + console capture. */
function session(target0) {
	const ws = new WebSocket(target0.webSocketDebuggerUrl);
	let id = 1;
	const pend = new Map();
	const entries = [];
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pend.has(msg.id)) {
			const { resolve, reject } = pend.get(msg.id);
			pend.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		} else if (msg.method === 'Runtime.consoleAPICalled') {
			entries.push(`${msg.params.type}: ${msg.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ')}`);
		} else if (msg.method === 'Runtime.exceptionThrown') {
			entries.push(`EXCEPTION: ${String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text).slice(0, 200)}`);
		}
	};
	return new Promise((resolve, reject) => {
		ws.onopen = () => {
			const send = (method, params = {}) => new Promise((res, rej) => {
				const mid = id++;
				pend.set(mid, { resolve: res, reject: rej });
				ws.send(JSON.stringify({ id: mid, method, params }));
			});
			send('Runtime.enable').then(() => resolve({
				send,
				entries,
				evaluate: (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => {
					if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
					return r?.result?.value ?? null;
				}),
				close: () => ws.close()
			}), reject);
		};
		ws.onerror = reject;
	});
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
const kill = (pid) => spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8' });

const child = spawn(exe, [target], {
	cwd: appDir, stdio: ['ignore', 'ignore', 'pipe'],
	env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
});
let page = null;
for (let i = 0; i < 60 && !page; i++) {
	try { page = (await targets()).find((t) => t.type === 'page' && (t.url.includes('localhost:5173') || t.url.includes('tauri'))); } catch {}
	if (!page) await sleep(500);
}
if (!page) { log('[fatal] no CDP page'); kill(child.pid); process.exit(1); }
const wb = await session(page);

/** Press a key on the document: keydown with the given key/modifiers (the app's global
 *  keybinding handler listens on keydown). */
const press = (key, ctrl = false) => wb.evaluate(`(function(){
	document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${ctrl}, bubbles: true, cancelable: true }));
	return true;
})()`);

/** The tabs' state as (label, active) pairs. */
const tabsState = () => wb.evaluate(`JSON.stringify([...document.querySelectorAll('.tabs-container .tab')].map((t) => ({ label: t.querySelector('.label')?.textContent ?? '', active: t.classList.contains('active') })))`);

try {
	// Wait for the workbench shell.
	for (let i = 0; i < 40 && !await wb.evaluate('Boolean(document.querySelector(".tabs-container"))').catch(() => false); i++) await sleep(500);
	log('workbench shell up');

	/* 1. Open two files by clicking their Explorer rows (the user's first flow). The side
	 *    bar restores the last active view, so the Explorer is selected explicitly. */
	await wb.evaluate(`(function(){
		document.querySelector('#activitybar .activity-item')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		return true;
	})()`);
	await sleep(600);
	const openViaExplorer = async (name) => {
		const ok = await wb.evaluate(`(function(){
			const row = [...document.querySelectorAll('#sidebar .row[data-path]')].find((r) => r.dataset.path.endsWith('/' + ${JSON.stringify(name)}) || r.dataset.path.endsWith('\\\\' + ${JSON.stringify(name)}));
			if (row) { row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return true; }
			return false;
		})()`);
		if (ok) await sleep(800);
		return ok;
	};
	check('open big.txt from the Explorer', await openViaExplorer('big.txt'));
	check('open readme.md from the Explorer', await openViaExplorer('readme.md'));

	/* 2. Two tabs; readme active. Close readme (the active tab) via its close button: the
	 *    other tab becomes active (never zero tabs without a welcome). */
	let tabs = JSON.parse(await tabsState());
	check('two tabs after two opens', tabs.length === 2, JSON.stringify(tabs));
	check('readme.md is the active tab', tabs.some((t) => t.active && t.label === 'readme.md'), JSON.stringify(tabs));
	await wb.evaluate(`(function(){
		const active = document.querySelector('.tabs-container .tab.active');
		active.querySelector('.close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return true;
	})()`);
	await sleep(500);
	tabs = JSON.parse(await tabsState());
	check('closing the active tab activates the other', tabs.length === 1 && tabs[0].active === true, JSON.stringify(tabs));

	/* 3. Escape on Go-to-File closes it; reopening shows an empty input (no stale query). */
	await press('p', true);
	await sleep(400);
	await wb.evaluate(`(function(){
		const input = document.querySelector('#overlays .quick-input input');
		input.value = 'stale query text';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`);
	await sleep(400);
	// The quick input listens for keydown on its input (a real user's Escape lands there).
	await wb.evaluate(`(function(){
		const input = document.querySelector('#overlays .quick-input input');
		input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		return true;
	})()`);
	await sleep(300);
	const overlayGone = await wb.evaluate('!document.querySelector("#overlays .quick-input")');
	check('Escape closes Go-to-File', overlayGone);
	await press('p', true);
	await sleep(400);
	const inputState = await wb.evaluate(`(function(){
		const input = document.querySelector('#overlays .quick-input input');
		return JSON.stringify({ reopened: Boolean(input), value: input ? input.value : null });
	})()`);
	const stale = JSON.parse(inputState);
	check('reopened Go-to-File has an empty input', stale.reopened && stale.value === '', inputState);
	await press('Escape');
	await sleep(300);

	/* 4. Side bar toggle: Ctrl+B hides and shows the primary side bar. */
	const sidebarBefore = await wb.evaluate(`JSON.stringify({ hidden: document.getElementById('sidebar').style.display === 'none' || !document.getElementById('sidebar').offsetParent })`);
	await press('b', true);
	await sleep(400);
	const sidebarAfter = await wb.evaluate(`JSON.stringify({ hidden: document.getElementById('sidebar').style.display === 'none' || !document.getElementById('sidebar').offsetParent })`);
	check('Ctrl+B toggles the side bar', sidebarBefore !== sidebarAfter, `${sidebarBefore} -> ${sidebarAfter}`);
	await press('b', true);
	await sleep(400);

	/* 5. Terminal toggle: Ctrl+` shows and hides the panel. */
	await press('\`', true);
	await sleep(1200); // xterm chunk + shell spawn
	const panelShown = await wb.evaluate(`JSON.stringify({ panel: !document.getElementById('panel').hidden, term: Boolean(document.querySelector('.panel .terminal, .panel [class*="terminal"]')) })`);
	await press('\`', true);
	await sleep(500);
	const panelHidden = await wb.evaluate(`JSON.stringify({ panel: document.getElementById('panel').hidden })`);
	const panelState = `${panelShown} -> ${panelHidden}`;
	check('terminal toggle shows and hides the panel', JSON.parse(panelShown).panel && JSON.parse(panelHidden).panel, panelState);

	/* 6. Console hygiene. */
	const exceptions = wb.entries.filter((entry) => entry.startsWith('EXCEPTION'));
	for (const entry of exceptions.slice(0, 8)) log(`[console:exception] ${entry}`);
	check('no exception in the workbench console', exceptions.length === 0, `${exceptions.length} entries`);
} finally {
	wb.close();
	kill(child.pid);
}

log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
