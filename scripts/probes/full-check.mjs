// The full-app automated check: launches the built exe with a WebView2 CDP port, then drives
// the workbench the way a user does — the Help menu's Module Self-Tests (every module's
// declared checks, the same suites CI mirrors), the Git Graph view (the extension package's
// own page over the engine .node — the new single-binary architecture's live proof), and the
// Extensions view — while collecting every console entry and exception from every frame.
//
// Everything it observed lands in one log, target/studio/full-check.log: the console stream,
// per-stage verdicts, and the self-test report's failing checks. Exit code 0 only when every
// stage passed and no error-level console entry was seen.
//
//   node scripts/probes/full-check.mjs [--port 9225] [--exe <path>] [--folder <repo>]

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9225');
const releaseDir = join(appDir, 'target', 'studio', 'cargo', 'release');
// cargo names the binary git-graph-studio.exe; tauri build renames its bundle to the
// mainBinaryName (ggs.exe) — whichever this tree last produced is the one to drive.
const exe = flag('--exe', [join(releaseDir, 'git-graph-studio.exe'), join(releaseDir, 'ggs.exe')].find((p) => existsSync(p)));
const folder = flag('--folder', appDir);
if (!existsSync(exe)) {
	console.error(`usage: node scripts/probes/full-check.mjs [--exe <git-graph-studio.exe>] (not found: ${exe})`);
	process.exit(2);
}

import { PNG } from 'pngjs';
/** Count a screenshot's saturated pixels (a graph's dots and branch colours). */
function saturatedPixelsSync(path) {
	const png = PNG.sync.read(readFileSync(path));
	let saturated = 0;
	for (let i = 0; i < png.data.length; i += 4) {
		const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
		if (Math.max(r, g, b) - Math.min(r, g, b) > 60) saturated++;
	}
	return saturated;
}

const logFile = join(appDir, 'target', 'studio', 'full-check.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `GGS full check — ${new Date().toISOString()}\nexe: ${exe}\nfolder: ${folder}\n\n`);
const log = (line) => {
	console.log(line);
	appendFileSync(logFile, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Launch + attach ---------- */

const child = spawn(exe, [folder], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'pipe'],
	env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
});
// The app's own stderr — boot stages, the extension request log, backend start failures — is part
// of the check's evidence; tee it into the log as it arrives.
child.stderr.on('data', (chunk) => {
	for (const line of chunk.toString().split('\n').filter(Boolean)) log('[exe] ' + line.trimEnd());
});
log(`[launch] pid ${child.pid}, CDP port ${port}`);

let page = null;
for (let i = 0; i < 40 && !page; i++) {
	try {
		const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
		page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
	} catch {
		await sleep(500);
	}
}
if (!page) {
	log('[fatal] no CDP page target; the window never came up');
	child.kill();
	process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleEntries = [];
const contexts = new Map(); // contextId -> { url }
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		return;
	}
	if (msg.method === 'Runtime.consoleAPICalled') {
		const text = msg.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map((p) => p.value)) ?? a.type).join(' ');
		consoleEntries.push({ level: msg.params.type, text, contextId: msg.params.executionContextId });
	} else if (msg.method === 'Runtime.exceptionThrown') {
		const d = msg.params.exceptionDetails;
		consoleEntries.push({ level: 'exception', text: `${d.text} ${d.exception?.description ?? ''}`.trim(), contextId: d.executionContextId });
	} else if (msg.method === 'Runtime.executionContextCreated') {
		const ctx = msg.params.context;
		contexts.set(ctx.id, { url: ctx.auxData?.frameId ? ctx.origin + ctx.name : ctx.origin, name: ctx.name, origin: ctx.origin });
	}
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send('Runtime.enable');
await send('Log.enable');

/** Evaluate in the main page (or a named frame's context), returning the value or null. */
async function evaluate(expression, frameName = null) {
	let contextId;
	if (frameName !== null) {
		for (const [id, ctx] of contexts) if ((ctx.name ?? '').includes(frameName) || (ctx.url ?? '').includes(frameName)) { contextId = id; break; }
		if (contextId === undefined) return null;
	}
	const result = await send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
		...(contextId !== undefined ? { contextId } : {})
	});
	return result?.result?.value ?? null;
}

/** Click through the DOM like a pointer would: mousedown/click with bubbles. */
const click = (selector, via = 'click') => `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.dispatchEvent(new MouseEvent('${via}',{bubbles:true,cancelable:true,view:window}));return true})()`;

/** Close whatever the workbench popped open — notifications and the confirmation toasts
 * they double as (their Clear button cancels the confirmation too). Popups stack over the
 * surfaces the stages drive; an automated run must leave none behind. Returns how many. */
async function dismissDialogs() {
	return (await evaluate(`(function(){
		let closed = 0;
		for (const button of document.querySelectorAll('#notifications [title="Clear Notification"]')) {
			button.click();
			closed++;
		}
		// The Settings dialog (the module self-tests open it; its close control is its own
		// class): close it, then an Escape for anything that opens without one.
		const settings = document.querySelector('.settings-dialog');
		if (settings) {
			const closer = settings.querySelector('.settings-close, [title*="Close"], .codicon-close');
			if (closer) closer.click();
			else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			closed++;
		}
		return closed;
	})()`)) ?? 0;
}

/** One poll loop with a deadline; resolves the first non-null predicate answer. */
async function poll(description, fn, timeoutMs, intervalMs = 400) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const answer = await fn();
		if (answer !== null && answer !== undefined && answer !== false) return answer;
		if (Date.now() > deadline) {
			log(`[timeout] ${description} (${timeoutMs} ms)`);
			return null;
		}
		await sleep(intervalMs);
	}
}

/* ---------- Stage 1: boot ---------- */

log('\n== stage 1: boot ==');
const booted = await poll('workbench activity bar', () => evaluate(`document.querySelectorAll('.activity-item').length`), 30000);
log(`[boot] activity items: ${booted}`);
await sleep(3000); // let the boot pass (bundled forward-upgrade, backend starts) settle

/* ---------- Stage 2: the module self-tests ---------- */

log('\n== stage 2: module self-tests (Help menu → Run Module Self-Tests) ==');
const helpOpened = await evaluate(`(function(){
	const item = [...document.querySelectorAll('.menubar-item')].find(m => /^(Help|帮助)$/.test(m.textContent.trim()));
	if (!item) return 'no Help menu';
	item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
	return 'ok';
})()`);
log(`[selftest] Help menu: ${helpOpened}`);
const menuClicked = await poll('self-test menu entry', () => evaluate(`(function(){
	const item = [...document.querySelectorAll('.context-menu .item .label')].find(l => /Self-Test|自测试/.test(l.textContent));
	if (!item) return null;
	item.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
	item.parentElement.click();
	return 'ok';
})()`), 5000);
log(`[selftest] menu entry: ${menuClicked}`);
if (menuClicked) {
	const settled = await poll('self-test report settled', () => evaluate(`(function(){
		const summary = document.querySelector('.selftest-summary');
		if (!summary || /idle|running/i.test(summary.textContent)) return null;
		if (document.querySelectorAll('.selftest-row.pending').length > 0) return null;
		return summary.textContent;
	})()`), 180000, 800);
	log(`[selftest] summary: ${settled}`);
	const failures = await evaluate(`[...document.querySelectorAll('.selftest-row.fail')].map(r => r.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 30)`) ?? [];
	if (failures.length) log(`[selftest] FAILING CHECKS:\n${failures.map((f) => '  ' + f).join('\n')}`);
	else log('[selftest] no failing checks');
	const groups = await evaluate(`[...document.querySelectorAll('.selftest-group')].map(g => g.querySelector('.selftest-group-header')?.textContent.trim().replace(/\\s+/g,' ')).filter(Boolean)`) ?? [];
	log(`[selftest] groups: ${groups.join(' | ')}`);
} else {
	log('[selftest] SKIPPED (menu entry not found)');
}
await dismissDialogs();

/* ---------- Stage 3: install git-graph-rs, then exercise the plugin's functions ---------- */

log('\n== stage 3: install the git-graph-rs VSIX, then its view\'s functions ==');
const failures = [];

// 3a. Already installed? The activity launcher is the tell. If not, the bundled one-click
//     Install is the ask — polled, not slept past: the panel's rows render async.
let launcher = await evaluate(`!!document.querySelector('.activity-item[aria-label="Git Graph"]')`);
if (!launcher) {
	await evaluate(click('.activity-item[aria-label^="Extensions"]'));
	const offer = await poll('the bundled offer\'s Install button', () => evaluate(`(function(){
		const button = [...document.querySelectorAll('.ext-list button')].find(b => /Install|安装/.test((b.title || '') + ' ' + (b.textContent || '')));
		if (!button) return null;
		button.click();
		return button.title || button.textContent.trim();
	})()`), 25000, 700);
	log(`[install] bundled offer clicked: ${offer ?? 'NOT FOUND'}`);
	if (!offer) failures.push('install: the bundled offer never rendered an Install button');
	launcher = await poll('the Git Graph activity launcher after install', () => evaluate(`!!document.querySelector('.activity-item[aria-label="Git Graph"]')`), 45000, 800);
	log(`[install] activity launcher: ${launcher ? 'present' : 'MISSING'}`);
	if (!launcher) failures.push('install: the launcher never appeared after the one-click install');
} else {
	log('[install] already installed (the boot pass or a previous run installed it)');
}

// 3b. The installed row's version and running backend are asserted in stage 4, where the
//     panel has reliably rendered.
// 3c. The view: open it and let its own boot sequence run. The engine's answers cross the
//     host's backend.run channel — the [ggs] console trail — which is what the assertions
//     below are made of (the view itself is an out-of-process frame its DOM cannot be
//     probed into; the channel it drives can).
if (launcher) {
	const consoleMark = consoleEntries.length;
	// The view is a singleton page: if a restored session already has it (or its comparison
	// pages) open, a launcher click merely focuses it and no boot sequence fires inside the
	// watch window. Close every Git Graph tab first, then open fresh from the launcher.
	const closed = await evaluate(`(async function(){
		let closedCount = 0;
		for (let round = 0; round < 5; round++) {
			const tab = [...document.querySelectorAll('.tab')].find((t) => /Git Graph|Commit Comparison/i.test(t.textContent));
			if (!tab) break;
			const closer = tab.querySelector('.tab-close, [title*="Close"], .codicon-close');
			if (!closer) break;
			closer.click();
			closedCount++;
			await new Promise((r) => setTimeout(r, 400));
		}
		return closedCount;
	})()`);
	log(`[view] pre-closed restored tabs: ${closed}`);
	await sleep(600);
	await evaluate(click('.activity-item[aria-label="Git Graph"]'));
	const viewSession = await poll('the ggs view target', async () => {
		const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
		return list.find((t) => t.type === 'iframe' && t.url.includes('ggs.') && t.webSocketDebuggerUrl) ?? null;
	}, 25000, 500);
	log(`[view] page target: ${viewSession ? viewSession.url.slice(0, 90) : 'NOT FOUND — the page never opened'}`);
	if (!viewSession) failures.push('view: the page never opened');

	// 3d. The functional sequence: every verb the view's first load drives must be answered
	//     (and none may error).
	const REQUIRED = ['submodules', 'engineVersion', 'loadRepoInfo', 'loadCommits', 'countUncommittedChanges', 'loadConfig'];
	const answered = new Set();
	const errored = [];
	const deadline = Date.now() + 45000;
	while (Date.now() < deadline) {
		for (const entry of consoleEntries.slice(consoleMark)) {
			let m = /\[ggs\] backend\.run (\S+) answered/.exec(entry.text);
			if (m) answered.add(m[1]);
			m = /\[ggs\] backend\.run (\S+) errored/.exec(entry.text);
			if (m && !errored.includes(m[1])) errored.push(m[1]);
		}
		if (REQUIRED.every((x) => answered.has(x))) break;
		await sleep(500);
	}
	log(`[view] answered: ${[...answered].join(', ') || '(none)'}`);
	if (errored.length) log(`[view] ERRORED: ${errored.join(', ')}`);
	for (const method of REQUIRED) {
		if (!answered.has(method)) failures.push(`view: ${method} never answered`);
	}
	for (const method of errored) failures.push(`view: ${method} errored`);

	try {
		await send('Page.enable').catch(() => {});
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(appDir, 'target', 'studio', 'full-check.png'), Buffer.from(shot.data, 'base64'));
		log('[view] screenshot: target/studio/full-check.png');
	} catch (error) {
		log(`[view] screenshot failed: ${error}`);
	}
}

/* ---------- Stage 4: the Extensions view ---------- */

log('\n== stage 4: Extensions view ==');
const extOpened = await evaluate(click(`.activity-item[aria-label^="Extensions"]`));
log(`[ext] panel: ${extOpened ? 'opened' : 'NOT FOUND'}`);
if (extOpened) {
	await sleep(2500);
	const rows = await evaluate(`[...document.querySelectorAll('.ext-row')].map(r => r.textContent.trim().replace(/\\s+/g, ' ').slice(-160))`) ?? [];
	for (const row of rows) log(`[ext] …${row}`);
	if (!rows.length) log('[ext] (no rows rendered)');
	// The install assertions: the git-graph-rs row settles with its version and a RUNNING
	// backend once the status refresh lands — polled, not assumed on first paint.
	const graphRow = await poll('the git-graph-rs row with version and backend running', () => evaluate(`(function(){
		const row = [...document.querySelectorAll('.ext-row')].find(r => /Git Graph/i.test(r.textContent));
		if (!row) return null;
		const text = row.textContent.trim();
		// includes(), not regex: the expression crosses a JS template literal, whose escape
		// layer eats backslashes — a regex here worked or broke depending on who last wrote
		// the file. Plain substrings cannot be corrupted.
		const versioned = text.indexOf('v1.') !== -1 && text.indexOf('.0.') !== -1;
		const running = text.indexOf('运行中') !== -1 || text.indexOf('running') !== -1 || text.indexOf('pid') !== -1;
		return versioned && running ? text.slice(0, 60) + ' … ' + text.slice(-60) : null;
	})()`), 30000, 800);
	if (!graphRow) {
		failures.push('install: the row never showed its version');
		failures.push('install: the backend never showed as running');
	}
}
await dismissDialogs();

/* ---------- Stage 5: the graph itself renders (a git repository under test) ---------- */

log('\n== stage 5: the graph renders (repository under test) ==');
if (existsSync(join(folder, '.git'))) {
	// The engine answered (stage 3) AND the page says what it drew (the __viewRendered
	// report) AND the picture carries a graph's colours — three independent witnesses.
	const rendered = consoleEntries
		.filter((e) => /\[ggs\] view rendered: (\d+) commits/.test(e.text))
		.map((e) => Number(/(\d+)/.exec(e.text)[1]));
	const commits = rendered.length ? Math.max(...rendered) : 0;
	log(`[graph] view rendered: ${rendered.length ? commits + ' commits (reported ' + rendered.length + 'x)' : 'NEVER reported'}`);
	if (!rendered.length) failures.push('graph: the page never reported a rendered graph');
	else if (commits < 1) failures.push('graph: the reported graph has no commits');
	// The Open Changes diff, warmed and reported by the page: the header names the file
	// pair and the +/- counts are real content, not just a non-empty answer.
	const diffReports = consoleEntries.filter((e) => /\[ggs\] view diff ready:/.test(e.text));
	if (diffReports.length) {
		const text = diffReports[diffReports.length - 1].text;
		log(`[graph] open changes: ${text.slice(0, 140)}`);
		if (!/diff --git a\//.test(text)) failures.push('graph: the open-changes diff header is not a git diff');
		if (!/\+\d+/.test(text) || !/-\d+/.test(text)) failures.push('graph: the open-changes diff carries no +/- counts');
	} else {
		failures.push('graph: the open-changes diff never became ready');
	}
	try {
		const pixels = saturatedPixelsSync(join(appDir, 'target', 'studio', 'full-check.png'));
		log(`[graph] screenshot saturated pixels: ${pixels}`);
		if (pixels < 20000) failures.push(`graph: the screenshot looks empty (${pixels} saturated pixels)`);
	} catch (error) {
		log(`[graph] pixel check unavailable: ${error}`);
	}

	/* ---------- Stage 5b: Open Changes — the Commit Comparison page really renders ----------
	 *
	 * The view's warmed diff (above) proves the engine answers; this stage clicks the button a
	 * user clicks and asserts the page it opens draws its file list. The compare page runs in
	 * its own out-of-process frame like the view, so the click is driven over a second CDP
	 * session into the view's target and the rendering is asserted in the compare target's own
	 * context; the host's backend.run trail (in the main console) names the verbs either way. */
	log('\n== stage 5b: Open Changes opens a Commit Comparison page with content ==');
	const consoleMark2 = consoleEntries.length;
	async function attach(url) {
		const session = new WebSocket(url);
		const calls = new Map();
		let callId = 1;
		session.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id && calls.has(msg.id)) {
				const { resolve, reject } = calls.get(msg.id);
				calls.delete(msg.id);
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
			}
		};
		await new Promise((resolve, reject) => { session.onopen = resolve; session.onerror = reject; });
		const call = (method, params = {}) => new Promise((resolve, reject) => {
			const id = callId++;
			calls.set(id, { resolve, reject });
			session.send(JSON.stringify({ id, method, params }));
		});
		await call('Runtime.enable');
		return {
			evaluate: async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value ?? null,
			close: () => session.close()
		};
	}
	const viewTarget = await (async () => {
		for (let i = 0; i < 20; i++) {
			const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
			const found = list.find((t) => t.type === 'iframe' && t.url.includes('ggs.') && !t.url.includes('compare') && t.webSocketDebuggerUrl);
			if (found) return found;
			await sleep(500);
		}
		return null;
	})();
	if (!viewTarget || !launcher) {
		log('[compare] SKIPPED (the view page target is not reachable)');
	} else {
		let viewSession = null;
		try {
			viewSession = await attach(viewTarget.webSocketDebuggerUrl);
			const clicked = await viewSession.evaluate(`(function(){
				const button = document.querySelector('.commit .openChangesBtn');
				if (!button) return 'no Open Changes button (no commit with a parent rendered?)';
				button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				return 'clicked';
			})()`);
			log(`[compare] open-changes click: ${clicked}`);
			if (clicked !== 'clicked') failures.push('compare: the Open Changes button was not there to click');

			// The compare page the click opens: its own iframe target, then its own DOM.
			const compareTarget = await poll('the compare page target', async () => {
				const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
				return list.find((t) => t.type === 'iframe' && t.url.includes('compare') && t.webSocketDebuggerUrl) ?? null;
			}, 25000, 500);
			log(`[compare] page target: ${compareTarget ? compareTarget.url.slice(0, 90) : 'NOT FOUND — the page never opened'}`);
			if (!compareTarget) failures.push('compare: the Commit Comparison page never opened');

			if (compareTarget) {
				const compareSession = await attach(compareTarget.webSocketDebuggerUrl);
				const rows = await poll('the compare page file rows', () => compareSession.evaluate(`(function(){
					const rows = document.querySelectorAll('.treeRow.file').length;
					if (rows > 0) return rows;
					const body = document.body ? document.body.textContent.trim().slice(0, 200) : '(no body)';
					return body === '' ? null : 'NO ROWS — ' + body;
				})()`), 30000, 700);
				if (typeof rows === 'number') log(`[compare] file rows rendered: ${rows}`);
				else {
					log(`[compare] the page never rendered its file list: ${rows ?? '(the page stayed empty)'}`);
					failures.push('compare: the Commit Comparison page rendered no file rows');
				}
				compareSession.close();
			}

			// The engine trail in the main console: the comparison's reads answered, none errored.
			await sleep(1200);
			const answered2 = new Set();
			const errored2 = [];
			for (const entry of consoleEntries.slice(consoleMark2)) {
				let m = /\[ggs\] backend\.run (\S+) answered/.exec(entry.text);
				if (m) answered2.add(m[1]);
				m = /\[ggs\] backend\.run (\S+) errored/.exec(entry.text);
				if (m && !errored2.includes(m[1])) errored2.push(m[1]);
			}
			log(`[compare] answered: ${[...answered2].join(', ') || '(none)'}`);
			if (!answered2.has('compareCommits')) failures.push('compare: the comparison never loaded (compareCommits unanswered)');
			for (const method of errored2) failures.push(`compare: ${method} errored`);
		} catch (error) {
			log(`[compare] driving the page failed: ${error}`);
			failures.push(`compare: ${String(error).slice(0, 120)}`);
		} finally {
			if (viewSession) viewSession.close();
		}
	}
} else {
	log('[graph] (the folder under test is not a git repository — rendering skipped)');
}

/* ---------- Report ---------- */

log('\n== console stream (all frames) ==');
const interesting = consoleEntries.filter((e) => ['error', 'exception', 'warning'].includes(e.level));
for (const entry of consoleEntries) log(`[${entry.level}] ${entry.text.slice(0, 400)}`);
const errors = interesting.filter((e) => e.level !== 'warning');
log(`\n== verdict: ${errors.length} error-level console entr${errors.length === 1 ? 'y' : 'ies'}, ${failures.length} stage failure${failures.length === 1 ? '' : 's'} ==`);
if (failures.length) for (const failure of failures) log(`[fail] ${failure}`);
const ok = errors.length === 0 && failures.length === 0;
log(ok ? 'FULL CHECK PASSED' : 'FULL CHECK FAILED — the entries above say where');
log(`(full log: ${logFile})`);

ws.close();
child.kill();
process.exit(ok ? 0 : 1);