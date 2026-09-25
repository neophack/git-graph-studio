// The Git Graph live check: drives the real app (debug or release exe + WebView2 CDP) and
// proves the git-graph-rs extension works end to end on the default host — ggs-node, the
// Boa runtime — with its Rust engine (the NAPI `git-graph.node`) serving the reads:
//   1. the extension's backend is running, its process is ggs-node, and that process has
//      `git-graph.node` loaded (the addon registered over the N-API host);
//   2. the extension's log is switched on live — its `git-graph-rs.enableLog` setting,
//      written the way the Settings dialog writes it, reaches `onDidChangeConfiguration`;
//   3. the Git Graph command (run from the command palette) opens the view, and the probe
//      repository's branches and commits render in it;
//   4. a commit click loads its details (hash, parents, changed files);
//   5. the extension's own log records the loads and no fallback from the Rust engine to
//      the git CLI;
//   6. no exception-level console entry in the workbench.
//
//   node scripts/probes/git-graph-live-check.mjs [--port 9231] [--exe <path>]
//
// A debug exe loads the workbench from the Vite dev server (`npm run dev:vite`); a release
// exe carries its own. The probe repository is a fresh temp repo with known commit
// subjects, outside every other repository (a nested folder would show its enclosing repo).

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9231');
const exe = flag('--exe', [
	join(appDir, 'target', 'studio', 'cargo', 'debug', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'ggs.exe')
].find((p) => existsSync(p)));
if (!exe || !existsSync(exe)) {
	console.error('usage: node scripts/probes/git-graph-live-check.mjs [--exe <exe>] (no built exe found)');
	process.exit(2);
}
const EXT_ID = 'neophack.git-graph-rs';

/* The probe repository: three commits and a second branch the view must show. */
const repo = join(tmpdir(), 'ggs-git-graph-live-check');
const SUBJECTS = ['probe alpha commit', 'probe beta commit', 'probe gamma commit'];
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...gitArgs) => {
	const run = spawnSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.com', ...gitArgs], { encoding: 'utf8' });
	if (run.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${run.stderr}`);
	return run.stdout;
};
git('init', '-b', 'main');
SUBJECTS.forEach((subject, at) => {
	writeFileSync(join(repo, `file${at}.txt`), `${subject}\n`);
	git('add', '.');
	git('commit', '-m', subject);
});
git('branch', 'probe-branch');

const logFile = join(appDir, 'target', 'studio', 'git-graph-live-check.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `Git Graph live check — ${new Date().toISOString()}\nexe: ${exe}\nrepo: ${repo}\n\n`);
const log = (line) => {
	console.log(line);
	appendFileSync(logFile, line + '\n');
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
	log(`[${ok ? 'pass' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

/* ---------- CDP ---------- */

/** One CDP session on a target: evaluate, and the console entries it saw. */
async function session(target) {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const consoleEntries = [];
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
		}
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
	await send('Runtime.enable');
	const evaluate = async (expression) => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result?.result?.value ?? null;
	};
	return { evaluate, consoleEntries, close: () => ws.close() };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

/** The view's document: a sandboxed srcdoc frame, its own (out-of-process) CDP target. */
async function viewSession() {
	const view = (await targets()).find((target) => target.type === 'iframe' && target.url.startsWith('about:srcdoc'));
	return view ? session(view) : null;
}

function killTree(pid) {
	spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8' });
}

/** The image name of a pid, and whether it has `git-graph.node` loaded (tasklist's reading). */
function processFacts(pid) {
	const image = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.trim();
	const modules = spawnSync('tasklist', ['/M', 'git-graph.node', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.trim();
	return { image: image.split(',')[0]?.replace(/"/g, '') ?? '', engineLoaded: /git-graph\.node/i.test(modules) };
}

const tauri = `(await import('/@id/@tauri-apps/api/core').catch(() => import('/node_modules/.vite/deps/@tauri-apps_api_core.js')))`;
const tauriEvent = `(await import('/@id/@tauri-apps/api/event').catch(() => import('/node_modules/.vite/deps/@tauri-apps_api_event.js')))`;

/* ---------- launch ---------- */

const child = spawn(exe, [repo], {
	cwd: appDir,
	stdio: ['ignore', 'ignore', 'pipe'],
	env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
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

try {
	/* 1. The backend: ggs-node, with the engine loaded. */
	let status = null;
	for (let attempt = 0; attempt < 60; attempt++) {
		await sleep(500);
		const all = await workbench.evaluate(`(async () => ${tauri}.invoke('ext_process_status'))()`).catch(() => null);
		status = (all ?? []).find((entry) => entry.extensionId === EXT_ID) ?? null;
		if (status && status.pid > 0) break;
	}
	check('the git-graph-rs backend is running', Boolean(status && status.pid > 0), JSON.stringify(status));
	if (status && status.pid > 0) {
		const facts = processFacts(status.pid);
		check('the backend process is ggs-node (the Boa host)', /ggs-node/i.test(facts.image), facts.image);
		check('the ggs-node process has git-graph.node loaded (N-API)', facts.engineLoaded);
	}

	/* 2. The extension's log, switched on live and captured as it crosses to the Output view. */
	await workbench.evaluate(`(async () => {
		window.__probeOutput = [];
		await ${tauriEvent}.listen('ext-host-request', (event) => {
			if (event.payload.extId === '${EXT_ID}' && event.payload.method === 'output.append') {
				window.__probeOutput.push(String(event.payload.args[1]).trim());
			}
		});
		const key = 'ggstudio.extSettings.${EXT_ID}';
		const settings = JSON.parse(localStorage.getItem(key) || '{}');
		settings['git-graph-rs.enableLog'] = true;
		localStorage.setItem(key, JSON.stringify(settings));
		document.dispatchEvent(new CustomEvent('ggs-ext-settings', { detail: '${EXT_ID}' }));
		return true;
	})()`);
	await sleep(500);

	/* 3. The view, from the command palette. */
	const picked = await workbench.evaluate(`(async () => {
		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await pause(500);
		const input = document.querySelector('#overlays .quick-input input');
		if (!input) return 'no quick input';
		input.value = '>Git Graph RS';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		for (let attempt = 0; attempt < 20; attempt++) {
			await pause(250);
			const rows = [...document.querySelectorAll('#overlays .quick-input .row')];
			// The view command's title in either display language.
			const row = rows.find((r) => /(打开 Git Graph|View Git Graph)\\s*$/.test(r.textContent.trim()));
			if (row) {
				row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				return 'clicked';
			}
		}
		return 'no view command row';
	})()`);
	check('the Git Graph command runs from the palette', picked === 'clicked', picked);

	let view = null;
	let rendered = '';
	for (let attempt = 0; attempt < 40 && !rendered; attempt++) {
		await sleep(500);
		view ??= await viewSession();
		if (!view) continue;
		const text = await view.evaluate('document.body ? document.body.innerText : ""').catch(() => '');
		if (typeof text === 'string' && SUBJECTS.every((subject) => text.includes(subject))) rendered = text.replace(/\s+/g, ' ');
	}
	const tabs = await workbench.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim())`);
	check('the Git Graph view tab opened', /Git Graph/i.test(JSON.stringify(tabs)), JSON.stringify(tabs));
	check('all three probe commits render in the view', Boolean(rendered), rendered.slice(0, 200));
	check('both branches render in the view', rendered.includes('main') && rendered.includes('probe-branch'));

	/* 4. Commit details: a click loads them from the engine. */
	if (view) {
		await view.evaluate(`(() => {
			const row = [...document.querySelectorAll('tr')].find((r) => r.innerText.includes('probe beta commit'));
			row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			return Boolean(row);
		})()`);
		let details = '';
		const beta = git('rev-parse', 'HEAD~1').trim();
		for (let attempt = 0; attempt < 20 && !details.includes(beta); attempt++) {
			await sleep(300);
			details = String(await view.evaluate('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ');
		}
		check('commit details load (full hash and changed file)', details.includes(beta) && details.includes('file1.txt'), beta);
	}

	/* 5. The extension's own account of the loads. */
	await sleep(1000);
	const output = (await workbench.evaluate('window.__probeOutput')) ?? [];
	for (const line of output) log(`[extension] ${line}`);
	check('the extension log reached the Output channel (the live setting change applied)', output.length > 0, `${output.length} lines`);
	check('the view loaded its commits', output.some((line) => /Loaded \d+ commits/.test(line)));
	const fallbacks = output.filter((line) => /could not answer .*falling back/i.test(line));
	check('no read fell back from the Rust engine to the git CLI', fallbacks.length === 0, fallbacks.slice(0, 3).join(' | '));

	/* 6. The workbench console. */
	const exceptions = workbench.consoleEntries.filter((entry) => entry.level === 'exception');
	for (const entry of exceptions.slice(0, 10)) log(`[console:exception] ${entry.text.slice(0, 300)}`);
	check('no exception in the workbench console', exceptions.length === 0, `${exceptions.length} entries`);
	view?.close();
} finally {
	workbench.close();
	killTree(child.pid);
}

log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
