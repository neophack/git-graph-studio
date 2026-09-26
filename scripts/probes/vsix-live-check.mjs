// The live VSIX check: drives the real app (built exe + WebView2 CDP) against two
// marketplace-shaped packages installed into ~/.ggs/extensions — the owner's
// `git-graph-rs-1.0.25.vsix` (a pure VS Code extension: no ggs key, a NAPI-only engine
// with its own git-CLI fallback) and `ms-python.python-2026.4.0.vsix` (frame-hosted, no
// native parts). Stages:
//   1. both packages are listed in the Extensions view and the derived ggs-node backend
//      of the git-graph-rs package reports running;
//   2. the Git Graph command opens its webview and commits render (the CLI fallback path
//      — extension.js spawns real `git` through the frame host's child_process);
//   3. a .py file opening wakes the Python extension (its commands join the palette);
//   4. no exception-level console entry from any frame along the way.
//
//   node scripts/probes/vsix-live-check.mjs [--port 9229] [--exe <path>] [--folder <repo>]

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9229');
const debugDir = join(appDir, 'target', 'studio', 'cargo', 'debug');
const releaseDir = join(appDir, 'target', 'studio', 'cargo', 'release');
const exe = flag('--exe', [
	join(debugDir, 'git-graph-studio.exe'),
	join(releaseDir, 'git-graph-studio.exe'),
	join(releaseDir, 'ggs.exe')
].find((p) => existsSync(p)));
// The workspace the probe drives. Deliberately OUTSIDE the app's own repository: a folder
// nested inside any known repository makes the extension's repo discovery honestly answer
// the outer repo instead (VS Code's own semantics — a folder inside a repo shows that
// repo), and the probe's marker commits must land in the repo the view actually shows.
const os = await import('node:os');
const probeWorkspace = join(os.tmpdir(), 'ggs-probe-testws');
let folder = flag('--folder', probeWorkspace);
if (folder === join(appDir, 'target', 'studio', 'testws')) folder = probeWorkspace;
if (!existsSync(join(folder, '.git'))) {
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, 'main.py'), 'import sys\n\ndef main():\n    print("hello from python")\n\nif __name__ == "__main__":\n    main()\n');
	// A deliberate misspelling for the Code Spell Checker stage: the squiggle this file
	// must earn is the visible end of cspell's whole language-server chain (fork bridge
	// included) landing as editor diagnostics.
	writeFileSync(join(folder, 'notes.txt'), 'this sentence holds one obviuos mispelled wrd for the checker to find\n');
	const init = spawnSync('git', ['-C', folder, 'init', '-b', 'main'], { encoding: 'utf8' });
	if (init.status !== 0) {
		console.error(`could not init the probe workspace ${folder}: ${init.stderr}`);
		process.exit(2);
	}
	spawnSync('git', ['-C', folder, 'add', 'main.py', 'notes.txt']);
	spawnSync('git', ['-C', folder, '-c', 'user.name=probe', '-c', 'user.email=probe@example.com', 'commit', '-m', 'first']);
}
// The workspace persists across runs: refresh both probe files so the squiggle stage
// always has its misspelling to find (main.py's content is stage 3's expectation).
writeFileSync(join(folder, 'main.py'), 'import sys\n\ndef main():\n    print("hello from python")\n\nif __name__ == "__main__":\n    main()\n');
writeFileSync(join(folder, 'notes.txt'), 'this sentence holds one obviuos mispelled wrd for the checker to find\n');
spawnSync('git', ['-C', folder, 'add', 'notes.txt']);
if (!existsSync(exe)) {
	console.error(`usage: node scripts/probes/vsix-live-check.mjs [--exe <exe>] (not found: ${exe})`);
	process.exit(2);
}

const logFile = join(appDir, 'target', 'studio', 'vsix-live-check.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `VSIX live check — ${new Date().toISOString()}\nexe: ${exe}\nfolder: ${folder}\n\n`);
const log = (line) => {
	console.log(line);
	appendFileSync(logFile, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [folder], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'pipe'],
	env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
});
child.stderr.on('data', (chunk) => {
	for (const line of chunk.toString().split('\n').filter(Boolean)) log('[exe] ' + line.trimEnd());
});

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
	log('[fatal] no CDP page target');
	child.kill();
	process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleEntries = [];
const contexts = new Map();
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
		const text = msg.params.args.map((a) => String(a.value ?? a.description ?? a.type ?? '')).join(' ');
		consoleEntries.push({ level: msg.params.type, text, contextId: msg.params.executionContextId });
	} else if (msg.method === 'Runtime.exceptionThrown') {
		const d = msg.params.exceptionDetails;
		consoleEntries.push({ level: 'exception', text: `${d.text} ${d.exception?.description ?? ''}`.trim(), contextId: d.executionContextId });
	} else if (msg.method === 'Runtime.executionContextCreated') {
		const ctx = msg.params.context;
		contexts.set(ctx.id, { url: ctx.url, name: ctx.name });
	}
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
await send('Runtime.enable');
await send('Page.enable');
await sleep(6000); // boot: extensions list, backend starts

const evaluate = async (expression, awaitPromise = false) => {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
	return result?.result?.value ?? null;
};

// Sanity: does our console capture echo at all?
await evaluate(`console.info('[ggs-debug] capture sanity ok')`);
await sleep(300);

let failures = 0;
const check = (name, ok, detail = '') => {
	log(`[${ok ? 'pass' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

/** Open the command palette (a command-center click) and run the first row matching
 *  `match`, typing `query` first. Returns the row texts seen. */
async function runPaletteCommand(query, match) {
	await evaluate(`(function(){
		const center = document.querySelector('.command-center');
		if (center) center.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		return Boolean(center);
	})()`);
	await sleep(500);
	await evaluate(`(function(){
		const input = document.querySelector('#overlays .quick-input input');
		if (!input) return 'no quick input';
		input.value = ${JSON.stringify(query)};
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return 'typed';
	})()`);
	// Poll for rows: the quick-input renders its list asynchronously after the query.
	let texts = [];
	let picked = 'no rows rendered';
	for (let attempt = 0; attempt < 12; attempt += 1) {
		await sleep(300);
		const probe = await evaluate(`(function(){
			const rows = document.querySelectorAll('#overlays .quick-input .row');
			const texts = [...rows].map((r) => (r.textContent || '').trim().slice(0, 70));
			const needle = ${JSON.stringify(match === null ? '' : match.toLowerCase())};
			const row = needle === '' ? null : [...rows].find((r) => (r.textContent || '').toLowerCase().includes(needle));
			if (row) {
				row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				return JSON.stringify({ picked: 'clicked', rows: texts });
			}
			return JSON.stringify({ picked: texts.length > 0 ? 'no matching row' : 'no rows rendered', rows: texts });
		})()`);
		let parsed = null;
		try { parsed = JSON.parse(String(probe)); } catch { parsed = null; }
		if (parsed && (parsed.picked === 'clicked' || parsed.rows.length > 0)) {
			return parsed;
		}
		texts = parsed?.rows ?? [];
	}
	return { picked, rows: texts };
	let parsed = { picked: String(result), rows: [] };
	try {
		const value = JSON.parse(String(result));
		if (value && typeof value === 'object' && 'picked' in value) parsed = value;
		else parsed = { picked: String(result), rows: value };
	} catch {
		parsed = { picked: String(result), rows: [] };
	}
	return parsed;
}

const closePalette = () => evaluate(`(function(){
	const box = document.querySelector('#overlays .quick-input');
	if (box) box.remove();
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	return true;
})()`);

/* The Git Graph view is a sandboxed srcdoc iframe — an out-of-process CDP target the
 * workbench page can neither read nor evaluate into (the old execution-context sweep saw
 * nothing but the workbench and ext-host frames). Stage 2 attaches to the iframe target
 * directly, the way scripts/probes/git-graph-live-check.mjs drives it, and every view
 * read afterwards goes through this session. */
let view = null;
async function viewSession() {
	if (view) return view;
	const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
	const target = list.find((t) => t.type === 'iframe' && t.url.startsWith('about:srcdoc'));
	if (!target) return null;
	const vws = new WebSocket(target.webSocketDebuggerUrl);
	let vid = 1;
	const vpending = new Map();
	vws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && vpending.has(msg.id)) {
			const { resolve, reject } = vpending.get(msg.id);
			vpending.delete(msg.id);
			msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
		}
	};
	await new Promise((resolve, reject) => {
		vws.onopen = resolve;
		vws.onerror = reject;
	});
	await vws.send(JSON.stringify({ id: vid++, method: 'Runtime.enable', params: {} }));
	view = {
		evaluate: async (expression) => {
			const result = await new Promise((resolve, reject) => {
				const id = vid++;
				vpending.set(id, { resolve, reject });
				vws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
			});
			if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
			return result?.result?.value ?? null;
		},
		close: () => vws.close()
	};
	return view;
}

/* ---------- stage 1: the extensions list + the derived backend ---------- */
// Click the activity bar's Extensions item (a synthetic Ctrl+Shift+X keydown is not a
// trusted event the keybinding layer answers; a real click always switches).
await evaluate(`(function(){
	const item = [...document.querySelectorAll('.activity-item')].find((i) => /扩展|extensions/i.test(i.getAttribute('aria-label') || i.title || ''));
	if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
	return Boolean(item);
})()`);
await sleep(1500);
const ctxDump = await evaluate(`(function(){
	const out = [];
	for (const f of document.querySelectorAll('iframe')) {
		try {
			out.push({ src: (f.getAttribute('src') || '').slice(0, 40), href: f.contentWindow ? String(f.contentWindow.location.href).slice(0, 50) : 'no-access', ready: f.contentDocument ? f.contentDocument.readyState : '?' });
		} catch (e) {
			out.push({ src: (f.getAttribute('src') || '').slice(0, 40), err: String(e).slice(0, 60) });
		}
	}
	return JSON.stringify(out);
})()`);
log(`[ctxdump] ${ctxDump}`);
let extRows = '[]';
for (let attempt = 0; attempt < 12; attempt++) {
	extRows = String(await evaluate(`(function(){
		const rows = document.querySelectorAll('.ext-list .ext-row');
		return JSON.stringify([...rows].map((row) => ({
			name: row.querySelector('.ext-name')?.textContent ?? '',
			version: row.querySelector('.ext-version')?.textContent ?? '',
			process: row.querySelector('.ext-process')?.textContent ?? '',
			running: Boolean(row.querySelector('.ext-process.running'))
		})));
	})()`));
	if (/Git Graph/.test(extRows)) break;
	await sleep(700); // the listing loads over its invoke roundtrip
}
log(`[ext] rows: ${extRows}`);
const listed = extRows;
check('stage 1: git-graph-rs 1.0.25 is listed', /Git Graph \(Rust\)/.test(listed) && /1\.0\.25/.test(listed), listed);
check('stage 1: ms-python.python is listed', /Python v2026/.test(listed), listed);
// A lazily-activated package starts its host on first command, so "running" is asserted
// after stage 2 runs the command; stage 1 pins only that the listing is up.

/* ---------- stage 2: the Git Graph view renders commits ---------- */
const palette = await runPaletteCommand('> 打开 git graph', '打开');
log(`[palette] rows: ${palette.rows} picked: ${palette.picked}`);
check('stage 2: the Git Graph command is in the palette', /graph/i.test(String(palette.rows)), palette.rows);
if (palette.picked === 'clicked') {
	await sleep(10000); // activation, webview creation, the CLI backend's git calls
	const webview = await evaluate(`(function(){
		const frames = [...document.querySelectorAll('iframe')].map((f) => ({
			src: (f.getAttribute('src') || '').slice(0, 50),
			text: (f.contentDocument?.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
			rows: f.contentDocument ? f.contentDocument.querySelectorAll('tr, [class*="commit"], [class*="graph-row"], [class*="row"]').length : 0
		}));
		return JSON.stringify({ tabs: [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim()), frames });
	})()`);
	log(`[graph] ${webview}`);
	const text = String(webview);
	check('stage 2: the Git Graph webview tab opened', /Git Graph RS/.test(text), text.slice(0, 120));
	// The view's own UI mounts inside its sandboxed iframe and loads commits over the
	// extension's CLI backend — give the handshake its time before the attach below.
	await sleep(12000);
	// The extension-host process the command woke: the ggs-node host is up and warm.
	const status = await evaluate(`(async function(){
		const mod = await import('/@id/@tauri-apps/api/core').catch(() => import('/node_modules/.vite/deps/@tauri-apps_api_core.js'));
		const st = await mod.invoke('ext_process_status', {});
		return JSON.stringify((st ?? []).find((s) => s.extensionId === 'neophack.git-graph-rs') ?? null);
	})()`, true);
	check('stage 2: the node-host process is running after the command', /"pid":\d+/i.test(String(status)) && !/"pid":0/.test(String(status)), status);

	// The sandboxed view iframe: attach to its own CDP target and wait for the commits to
	// render there (the git-graph-rs 1.0.25 CLI fallback path — extension.js spawns real
	// `git` through the frame host's child_process).
	let graphText = '';
	for (let i = 0; i < 20 && !graphText; i++) {
		const session = await viewSession();
		if (!session) {
			await sleep(1500);
			continue;
		}
		const text = await session.evaluate('(document.body ? document.body.innerText : "")').catch(() => '');
		if (typeof text === 'string' && /first|commit|提交|图形|作者/i.test(text)) graphText = text.replace(/\s+/g, ' ').slice(0, 400);
		else await sleep(1500);
	}

	// The ext-host frames' contexts: report the process env each frame actually sees
	// (tool discovery reads it) — informational, alongside the view text.
	const contextTexts = [];
	for (const [contextId, info] of contexts) {
		try {
			const isExtHost = (info.url ?? '').includes('ext-host');
			if (!isExtHost) continue;
			const expression = `(function(){
				const envLine = (typeof process !== 'undefined' && process.env && process.env.ProgramW6432 !== undefined)
					? ' ENV[ProgramW6432]=' + String(process.env.ProgramW6432).slice(0, 30) + ' PATH.len=' + String(process.env.PATH ?? '').length
					: '';
				return '[' + String(location.href).slice(0, 46) + ']' + envLine + ' BODY: ' + (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 160);
			})()`;
			const result = await send('Runtime.evaluate', {
				expression,
				returnByValue: true,
				contextId
			});
			const value = result?.result?.value;
			if (typeof value === 'string' && value.length > 3) {
				const line = `[ext-host] ${value}`;
				contextTexts.push(line);
				log(`[ctx] ${line}`);
			}
		} catch { /* a context that cannot evaluate is not reportable */ }
	}
	log(`[graph] view text: ${graphText}`);
	for (const line of contextTexts) log(`[ctx] ${line}`);
	check('stage 2: commits render in the view', /first|commit|提交|图形|作者/i.test(String(graphText) + contextTexts.join(' ')), `${graphText} | ${contextTexts.join(' | ')}`.slice(0, 200));
} else {
	check('stage 2: the Git Graph command ran', false, palette.picked);
}
await closePalette();

/* ---------- stage 3: the Python extension wakes on a .py file ---------- */
const filePalette = await runPaletteCommand('main.py', 'main.py');
log(`[file] rows: ${filePalette.rows} picked: ${filePalette.picked}`);
if (filePalette.picked === 'clicked') {
	await sleep(8000); // activation + grammar registration
	const editorState = await evaluate(`(function(){
		const tabs = [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim());
		const code = document.querySelector('.editors .cm-content, .editors [class*="code"]');
		const spans = document.querySelectorAll('.editors .cm-content span, .editors span[class]').length;
		return JSON.stringify({ tabs, text: (code?.textContent || '').slice(0, 60), spans });
	})()`);
	log(`[python] editor: ${editorState}`);
	check('stage 3: main.py is open', /main\.py/.test(String(editorState)), editorState);
	const pyPalette = await runPaletteCommand('> python', null);
	log(`[python] palette rows: ${pyPalette.rows}`);
	check('stage 3: Python commands are registered', /interpreter|python/i.test(String(pyPalette.rows)), pyPalette.rows);
	await closePalette();
} else {
	check('stage 3: main.py could be opened', false, filePalette.picked);
}

/* ---------- stage 4: the three marketplace extensions (EditorConfig / Prettier / Code Spell Checker) ---------- */
// All three activate onStartupFinished. EditorConfig's and Prettier's core commands write
// config files into the workspace — real end-to-end behaviour this probe verifies on disk.
const three = [
	{ label: 'EditorConfig', paletteQuery: '> editorconfig', match: 'generate', diskFile: null }, // generate opens a native save dialog — not automatable; command execution is the bar
	{ label: 'Prettier', paletteQuery: '> prettier', match: '配置', diskFile: '.prettierrc', nativeDialog: true }, // its config command opens a native folder dialog — not automatable; recorded, not failed
	{ label: 'Code Spell Checker', paletteQuery: '> spell', match: 'about', diskFile: null }
];
for (const extension of three) {
	const listed = await evaluate(`(function(){
		const rows = [...document.querySelectorAll('.ext-list .ext-row')];
		const needle = ${JSON.stringify(extension.label.toLowerCase())};
		const row = rows.find((r) => (r.querySelector('.ext-name')?.textContent || '').toLowerCase().includes(needle));
		return row ? 'listed' : 'missing';
	})()`);
	check(`stage 4: ${extension.label} is listed`, listed === 'listed', listed);

	const pick = await runPaletteCommand(extension.paletteQuery, extension.match);
	log(`[stage4] ${extension.label} palette: ${JSON.stringify(pick.picked)} rows=${JSON.stringify(pick.rows).slice(0, 160)}`);
	check(`stage 4: ${extension.label} commands are in the palette`, pick.picked === 'clicked' || pick.picked === 'inspect-only', JSON.stringify(pick.rows).slice(0, 120));

	if (pick.picked === 'clicked' && extension.diskFile) {
		// Some of these commands ask one follow-up quick-pick question; poll for it, take
		// the first row, then poll the workspace for the file it should write.
		let answered = false;
		for (let attempt = 0; attempt < 10 && !answered; attempt += 1) {
			await sleep(600);
			answered = await evaluate(`(function(){
				const row = document.querySelector('#overlays .quick-input .row');
				if (!row) return false;
				row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				return true;
			})()`);
		}
		let onDisk = false;
		for (let attempt = 0; attempt < 12 && !onDisk; attempt += 1) {
			await sleep(500);
			onDisk = existsSync(join(folder, extension.diskFile));
		}
		const detail = onDisk ? 'file exists' : `file missing (native dialog path — recorded, not failed)`;
		if (extension.nativeDialog) log(`[stage4] ${extension.label} ${extension.diskFile}: ${detail}`);
		else check(`stage 4: ${extension.label} wrote ${extension.diskFile} into the workspace`, onDisk, detail);
	}
	await closePalette();
}

/* ---------- stage 4½: the cspell squiggle — diagnostics as an editor surface ---------- */
// Open the deliberately-misspelled notes.txt and wait for CodeMirror lint marks: the
// visible end of cspell's whole chain (fork bridge → language server → diagnostics →
// editor squiggle). The server analyzes asynchronously, so the wait is generous.
await evaluate(`(function(){
	window.__rpcLog = [];
	window.addEventListener('message', (event) => {
		const data = event.data;
		if (data && data.type === '__studioExtRpc' && window.__rpcLog.length < 400) {
			window.__rpcLog.push(String(data.method) + (data.method === 'output.append' ? ':' + String(data.args?.[1] ?? '').replace(/\\s+/g, ' ').slice(0, 90) : ''));
		}
	}, true);
	const key = 'ggstudio.extSettings.streetsidesoftware.code-spell-checker';
	const settings = JSON.parse(localStorage.getItem(key) || '{}');
	settings['cSpell.logLevel'] = 'Diagnostic';
	settings['cSpell.logFile'] = 'C:/Users/penghongxia/AppData/Local/Temp/cspell-server.log';
	localStorage.setItem(key, JSON.stringify(settings));
	document.dispatchEvent(new CustomEvent('ggs-ext-settings', { detail: 'streetsidesoftware.code-spell-checker' }));
	return true;
})()`);
const notesPick = await runPaletteCommand('notes', 'notes');
log(`[stage4b] notes pick: ${JSON.stringify(notesPick).slice(0, 200)}`);
await sleep(4000);
await closePalette();
let squiggles = '';
for (let attempt = 0; attempt < 30; attempt += 1) {
	await sleep(2000);
	squiggles = String(await evaluate(`(function(){
		const marks = document.querySelectorAll('.editors .cm-lintRange, .editors [class*="lintRange"], .editors [class*="cm-lint"]').length;
		const active = [...document.querySelectorAll('.tabs-container .tab')].some((t) => /notes\\.txt/.test(t.textContent));
		return JSON.stringify({ active, marks });
	})()`));
	try {
		if (JSON.parse(squiggles).marks > 0) break;
	} catch { /* unparsable — keep waiting */ }
}
log(`[stage4b] squiggle state: ${squiggles}`);
const rpcLog = String(await evaluate(`JSON.stringify({ methods: [...new Set(window.__rpcLog || [])], counts: (window.__rpcLog || []).length })`));
log(`[stage4b] frame RPCs since open: ${rpcLog}`);
try {
	const state = JSON.parse(squiggles);
	check('stage 4b: the cspell server landed squiggles in the editor', state.marks > 0, `${state.marks} lint marks (notes.txt open: ${state.active})`);
} catch {
	check('stage 4b: the cspell server landed squiggles in the editor', false, squiggles);
}

/* ---------- stage 5: the compatibility surface — watcher refresh and the diff bridge ---------- */
if (view !== null) {
	const inView = (expression) => view.evaluate(expression).catch(() => '');
	// An external commit (the probe's own git, outside the app): the extension's
	// repoFileWatcher hears it through the host's fs-event bridge and the view refetches —
	// the marker subject is the visible end of createFileSystemWatcher + fsChanged.
	const marker = `watcher probe ${Date.now()}`;
	// A real file change (not --allow-empty): the commit row then carries a file the
	// diff-click half of this stage can open.
	appendFileSync(join(folder, 'main.py'), `# ${marker}\n`);
	const committed = spawnSync('git', ['-C', folder, 'add', 'main.py'], { encoding: 'utf8' })
		.status === 0
		? spawnSync('git', ['-C', folder, '-c', 'user.name=probe', '-c', 'user.email=probe@example.com', 'commit', '-m', marker], { encoding: 'utf8' })
		: { status: 1, stderr: 'git add failed' };
	if (committed.status !== 0) {
		log(`[stage5] probe commit failed: ${String(committed.stderr).slice(0, 120)}`);
	} else {
		let refreshed = '';
		for (let i = 0; i < 20 && !refreshed.includes(marker); i++) {
			await sleep(1000);
			refreshed = String(await inView('(document.body ? document.body.innerText : "")'));
		}
		check('stage 5: the view refreshed on an external commit (the fs watcher bridge)', refreshed.includes(marker), refreshed.replace(/\s+/g, ' ').slice(0, 140));
	}
	// A commit click opens its details; a file row in the details opens the diff through the
	// extension's content provider — a new editor tab is the visible end of vscode.diff.
	// The view's own DOM: commit rows are `tr.commit` in #commitTable, the details' file
	// rows carry `.fileTreeFile` (tree) or a `gitDiffPossible` class (list).
	const tabsBefore = String(await evaluate(`JSON.stringify([...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim()))`));
	const commitClicked = await inView(`(function(){
		const row = document.querySelector('#commitTable tr.commit');
		if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		return row ? 'clicked' : 'missed';
	})()`);
	await sleep(3500);
	const detailsOpen = await inView(`(function(){ return document.getElementById('cdv') !== null || document.querySelector('[class*="cdv"]') !== null ? 'yes' : 'no'; })()`);
	log(`[stage5] commit clicked: ${commitClicked}, details pane: ${detailsOpen}`);
	// The details' file list loads asynchronously after the pane opens — wait for the row
	// instead of racing it.
	let fileClicked = 'no element';
	for (let attempt = 0; attempt < 15 && fileClicked === 'no element'; attempt++) {
		fileClicked = await inView(`(function(){
			const file = document.querySelector('.fileTreeFile');
			if (!file) return 'no element';
			let fired = false;
			file.addEventListener('click', () => { fired = true; }, { once: true });
			file.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
			return (fired ? 'listener-fired' : 'listener-missed') + ' classes=' + file.className.slice(0, 80);
		})()`);
		if (fileClicked === 'no element') {
			if (attempt === 4) {
				const paneText = await inView(`(function(){
					const pane = document.getElementById('cdv') || document.querySelector('[class*="cdv"]');
					return pane ? pane.innerText.replace(/\\s+/g, ' ').slice(0, 260) : '(no pane element)';
				})()`);
				log(`[stage5] details pane text: ${paneText}`);
			}
			await sleep(1000);
		}
	}
	await sleep(4500);
	// The diff's own tab (whatever opened it earlier in the session, a diff-shaped title is
	// what the vscode.diff bridge produces): compare the label SETS, not the counts.
	const tabsAfter = String(await evaluate(`JSON.stringify([...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim()))`));
	const before = JSON.parse(tabsBefore);
	const after = JSON.parse(tabsAfter);
	const newTabs = after.filter((label) => !before.includes(label));
	const tabLabels = after.join(' | ');
	log(`[stage5] file clicked: ${fileClicked}, new tabs: ${newTabs.join(' | ') || '(none)'} (${tabLabels.slice(0, 140)})`);
	if (String(commitClicked).includes('clicked')) {
		check('stage 5: the commit details pane opened in the view', detailsOpen === 'yes', `details pane: ${detailsOpen}`);
	}
	if (String(fileClicked).startsWith('listener-fired')) {
		check('stage 5: a file click opened the diff tab (the vscode.diff bridge)', newTabs.some((label) => label.includes('↔')), `${newTabs.join(' | ') || '(none)'} | all: ${tabLabels.slice(0, 140)}`);
	} else {
		log('[stage5] diff-click check skipped: no file row found to click');
	}
	// The view's dropdowns (branch / author / repo) must paint an opaque menu: their
	// background is `var(--vscode-menu-background)`, defined by the theme the host injects
	// into every webview document — a missing injection used to leave them transparent.
	const dropdownStyle = await inView(`(function(){
		const control = document.querySelector('#branchDropdown .dropdownCurrentValue, #authorDropdown .dropdownCurrentValue, #repoDropdown .dropdownCurrentValue');
		if (!control) return 'no dropdown control';
		// The view's toggle listener compares e.target against the value element itself.
		control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		return 'clicked';
	})()`);
	await sleep(700);
	const menuPaint = await inView(`(function(){
		const menu = document.querySelector('.dropdown.dropdownOpen .dropdownMenu') || document.querySelector('.dropdownMenu');
		if (!menu) return 'no menu';
		const cs = getComputedStyle(menu);
		return JSON.stringify({ open: Boolean(document.querySelector('.dropdownOpen')), display: cs.display, background: cs.backgroundColor, color: cs.color });
	})()`);
	log(`[stage5] dropdown control: ${dropdownStyle}, menu paint: ${menuPaint}`);
	let menuPainted = false;
	try {
		const paint = JSON.parse(String(menuPaint).replace(/'/g, '"'));
		menuPainted = paint.open === true && paint.display !== 'none' && paint.background !== '' && paint.background !== 'transparent' && paint.background !== 'rgba(0, 0, 0, 0)';
	} catch { /* unparsable counts as unpainted */ }
	check('stage 5: the dropdown menu paints an opaque background (the theme injection)', menuPainted, menuPaint);
} else {
	log('[stage5] skipped: the view iframe target was not found');
}

/* ---------- console hygiene ---------- */
for (const entry of consoleEntries) {
	if (/\[ext-host\]|\[ggs-debug\]|\[frame-log\]|\[probe\]|\[ggs-ext\]|\[ggs-wvmsg\]|\[ggs-diff\]|\[ggs-fswatch\]|\[ggs-diff-frame\]/.test(String(entry.text ?? ''))) {
		const ctx = contexts.get(entry.contextId);
		log(`[debug] (${ctx && ctx.url ? ctx.url.slice(0, 60) : 'ctx' + entry.contextId}) ${String(entry.text ?? '').slice(0, 250)}`);
	}
}
const exceptions = consoleEntries.filter((e) => e.level === 'exception');
const errorEntries = consoleEntries.filter((e) => e.level === 'error');
log(`[console] ${consoleEntries.length} entries, ${exceptions.length} exceptions, ${errorEntries.length} error-level`);
for (const entry of [...exceptions.slice(0, 10), ...errorEntries.slice(0, 10)]) {
	const ctx = contexts.get(entry.contextId);
	log(`[console:${entry.level}] (${ctx && ctx.url ? ctx.url.slice(0, 60) : 'ctx' + entry.contextId}) ${String(entry.text ?? '').slice(0, 260)}`);
}
check('console: no exceptions', exceptions.length === 0, `${exceptions.length} exceptions`);

log(`[done] ${failures} failures`);
child.kill();
process.exit(failures === 0 ? 0 : 1);
