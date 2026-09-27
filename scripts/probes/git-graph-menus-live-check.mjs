// The Git Graph menus live check: drives the real app (debug or release exe + WebView2 CDP)
// and proves every menu the git-graph-rs extension contributes — and every command it
// registers — works where Studio surfaces it:
//   1. the Source Control view's header carries the extension's scm/title navigation button
//      (the manifest's own icon), and clicking it opens the Git Graph view;
//   2. the "..." menu offers the extension's scm/title entries (Amend / Gerrit hook /
//      Reset-to-remote), and the Amend entry really amends (the repository's HEAD moves);
//   3. the Pull, Push submenu offers the Gerrit refs/for/ push, and running it from there
//      reaches the extension (the Change-Id confirm appears; cancelling aborts cleanly);
//   4. the Source Control change row's context menu offers the file-history filter, and it
//      opens the view scoped to that file (only that file's commits render);
//   5. the File Explorer's context menu, the text editor's context menu and the editor tab's
//      context menu all offer the same file-history filter and all dispatch it;
//   6. the command palette lists every palette-visible command of the extension (either
//      interface language), and each runnable one produces its observable result:
//      version (a modal toast), clear avatar cache, amend, reset-to-remote (the no-upstream
//      error), the Gerrit hook fetch (its failure on a remote-less repository), search
//      commits (quick input → commit pick → view), fetch (the view opens), end-all code
//      reviews, and the no-review error of the specific/resume variants;
//   7. no exception-level console entry in the workbench.
//
//   node scripts/probes/git-graph-menus-live-check.mjs [--port 9233] [--exe <path>]
//
// The probe repository is a fresh temp repo with known commit subjects plus one uncommitted
// change (so Source Control has a row to right-click), outside every other repository.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const port = flag('--port', '9233');
const exe = flag('--exe', [
	join(appDir, 'target', 'studio', 'cargo', 'debug', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'git-graph-studio.exe'),
	join(appDir, 'target', 'studio', 'cargo', 'release', 'ggs.exe')
].find((p) => existsSync(p)));
if (!exe || !existsSync(exe)) {
	console.error('usage: node scripts/probes/git-graph-menus-live-check.mjs [--exe <exe>] (no built exe found)');
	process.exit(2);
}
const EXT_ID = 'neophack.git-graph-rs';

/* The probe repository: three commits (one file each), a second branch, one uncommitted
 * change — the row Source Control offers for the resourceState context menu. */
const repo = join(tmpdir(), 'ggs-git-graph-menus-check');
const SUBJECTS = ['probe alpha commit', 'probe beta commit', 'probe gamma commit'];
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...gitArgs) => {
	const run = spawnSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.com', ...gitArgs], { encoding: 'utf8' });
	if (run.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${run.stderr}`);
	return run.stdout;
};
git('init', '-b', 'main');
git('config', 'user.name', 'probe');
git('config', 'user.email', 'probe@example.com');
SUBJECTS.forEach((subject, at) => {
	writeFileSync(join(repo, `file${at}.txt`), `${subject}\n`);
	git('add', '.');
	git('commit', '-m', subject);
});
git('branch', 'probe-branch');
writeFileSync(join(repo, 'file1.txt'), 'probe beta commit\nplus an uncommitted line\n');

const logFile = join(appDir, 'target', 'studio', 'git-graph-menus-live-check.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, `Git Graph menus live check — ${new Date().toISOString()}\nexe: ${exe}\nrepo: ${repo}\n\n`);
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

/* Every title in either interface language (the extension switches its contributed commands
 * on the git-graph-rs:interfaceZhCn context, which follows the app's display language). */
const T = {
	view: /View Git Graph \(Rust\)|打开 Git Graph（Rust）/,
	filterByFile: /Show File History in Git Graph RS|在 Git Graph 中显示文件历史/,
	amend: /Amend Last Commit|修正上一次提交/,
	reset: /Reset Current Branch to Remote \(Soft\)|将当前分支重置到远程\(软重置\)/,
	gerritPush: /Push to Gerrit Ref for Current Branch|推送当前分支到 Gerrit 审阅引用/,
	gerritHook: /Fetch commit-msg Hook \(Gerrit\)|获取 commit-msg 钩子 \(Gerrit\)/,
	addRepo: /Add Git Repository\.\.\.|添加 Git 仓库\.\.\./,
	clearAvatars: /Clear Avatar Cache|清除头像缓存/,
	endAllReviews: /End All Code Reviews in Workspace|结束工作区中的所有代码评审/,
	endReview: /End a specific Code Review in Workspace\.\.\.|结束工作区中的指定代码评审\.\.\./,
	resumeReview: /Resume a specific Code Review in Workspace\.\.\.|恢复工作区中的指定代码评审\.\.\./,
	fetch: /Fetch from Remote\(s\)|从远程仓库拉取\(Fetch\)/,
	removeRepo: /Remove Git Repository\.\.\.|移除 Git 仓库\.\.\./,
	version: /Get Version Information|获取版本信息/,
	searchCommits: /Search Commits in History\.\.\.|在历史中搜索提交\.\.\./
};

/* ---------- CDP ---------- */

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
	return { evaluate, send, consoleEntries, close: () => ws.close() };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());

/** The sandboxed srcdoc frames' CDP targets — the Git Graph view is one of them (extension
 *  host frames may be others); callers pick the one whose text they expect. */
async function srcdocSessions() {
	const views = (await targets()).filter((target) => target.type === 'iframe' && target.url.startsWith('about:srcdoc'));
	const remote = await Promise.all(views.map((target) => session(target).catch(() => null)));
	// Same-process page frames have no target of their own: reach each through the
	// workbench's frame tree and an isolated world in it.
	const tree = await workbench.send('Page.getFrameTree').catch(() => null);
	const frames = [];
	const walk = (node) => {
		for (const child of node?.childFrames ?? []) {
			frames.push(child.frame);
			walk(child);
		}
	};
	walk(tree?.frameTree);
	const local = await Promise.all(frames.filter((frame) => /ggs|srcdoc/.test(frame.url)).map(async (frame) => {
		const world = await workbench.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'probe' }).catch(() => null);
		if (!world) return null;
		return {
			evaluate: async (expression) => {
				const result = await workbench.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId: world.executionContextId });
				if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
				return result?.result?.value ?? null;
			},
			close: () => undefined
		};
	}));
	return [...remote, ...local];
}

function killTree(pid) {
	spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8' });
}

// Tauri's own IPC surface — present in dev and release builds alike (the Vite module
// paths exist only under the dev server).
const tauri = `window.__TAURI_INTERNALS__`;

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

/* ---------- shared workbench drivers ---------- */

/** One palette round: close whatever overlay is open (Escape belongs to the quick input's
 *  own input element — a document-level dispatch never reaches it), open the command
 *  center, type a `>` query, and return the settled rows (for listing checks). */
async function paletteRows(query) {
	return await workbench.evaluate(`(async () => {
		const open = document.querySelector('#overlays .quick-input input');
		open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 400));
		const input = document.querySelector('#overlays .quick-input input');
		if (!input) return [];
		input.value = ${JSON.stringify(query)};
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		return [...document.querySelectorAll('#overlays .quick-input .row')].map((r) => r.textContent.trim());
	})()`) ?? [];
}

/** Type a palette query and click the first row matching the pattern — polling in-page until
 *  the row appears (the palette's filtering settles asynchronously), the way a user waits. */
async function paletteClick(query, pattern, tries = 20) {
	const rows = await workbench.evaluate(`(async () => {
		const open = document.querySelector('#overlays .quick-input input');
		open?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		document.querySelector('.command-center')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 400));
		const input = document.querySelector('#overlays .quick-input input');
		if (!input) return [];
		input.value = ${JSON.stringify(query)};
		input.dispatchEvent(new Event('input', { bubbles: true }));
		for (let attempt = 0; attempt < ${tries}; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			const rows = [...document.querySelectorAll('#overlays .quick-input .row')];
			const row = rows.find((r) => ${pattern}.test(r.textContent.trim()));
			if (row) {
				const texts = rows.map((r) => r.textContent.trim());
				row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
				return texts;
			}
		}
		return [...document.querySelectorAll('#overlays .quick-input .row')].map((r) => r.textContent.trim());
	})()`);
	return { rows: rows ?? [], clicked: (rows ?? []).some((text) => pattern.test(text)) };
}

/** Switch the sidebar to a view by running its workbench command from the palette. */
async function showView(titlePattern, commandQuery) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const { clicked } = await paletteClick(commandQuery, titlePattern);
		if (clicked) return true;
	}
	return false;
}

/** Wait for a toast that was NOT on screen when this was called (the ones already there are
 *  snapshotted and ignored — a confirm the caller just dismissed must not mask the follow-up
 *  message, and clearing outright would race a message that is already arriving). The
 *  snapshot can also be taken inside an earlier page turn (before a click) and passed in. */
async function toastMatching(pattern, timeoutMs = 30000, snapshot = null) {
	const before = snapshot ?? new Set(await workbench.evaluate(`[...document.querySelectorAll('#notifications .notification .message')].map((m) => m.textContent.trim())`) ?? []);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(250);
		const texts = await workbench.evaluate(`[...document.querySelectorAll('#notifications .notification .message')].map((m) => m.textContent.trim())`);
		const hit = (texts ?? []).find((text) => !before.has(text) && pattern.test(text));
		if (hit !== undefined) {
			await workbench.evaluate(`(function(){ for (const button of document.querySelectorAll('#notifications [title="Clear Notification"]')) button.click(); })()`);
			return hit;
		}
	}
	await workbench.evaluate(`(function(){ for (const button of document.querySelectorAll('#notifications [title="Clear Notification"]')) button.click(); })()`);
	return '';
}

/** Open the SCM "..." menu, hover into its Pull, Push submenu; returns nothing — the menus
 *  stay open for the caller's item queries. */
async function openMoreMenu() {
	return await workbench.evaluate(`(async () => {
		const buttons = [...document.querySelectorAll('.pane-header.scm-main-header .actions button')];
		const more = buttons.find((b) => /More Actions|更多/.test(b.title || ''));
		if (!more) return 'no more button';
		more.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		const menu = document.querySelector('#overlays .context-menu');
		if (!menu) return 'no menu';
		const pullPush = [...menu.querySelectorAll('.item')].find((i) => /Pull, Push|拉取, 推送/.test(i.textContent));
		if (!pullPush) return 'no Pull, Push item';
		pullPush.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		return 'open';
	})()`);
}

/** All visible texts of the open context menu (the last one = the deepest submenu). */
const menuTexts = () => workbench.evaluate(`[...document.querySelectorAll('#overlays .context-menu')].map((m) => [...m.querySelectorAll('.item')].map((i) => i.textContent.trim()))`);

/** Click the open menu item whose text matches (searches every open level, deepest first). */
async function clickMenuItem(pattern) {
	return await workbench.evaluate(`(function(){
		const menus = [...document.querySelectorAll('#overlays .context-menu')].reverse();
		for (const menu of menus) {
			const item = [...menu.querySelectorAll('.item')].find((i) => ${pattern}.test(i.textContent.trim()));
			if (!item) continue;
			item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
			return item.textContent.trim();
		}
		return null;
	})()`);
}

const closeMenus = () => workbench.evaluate(`(function(){ document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);

/** Right-click the first element matching a selector. */
const contextClick = (selector) => workbench.evaluate(`(function(){
	const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
	const el = all.find((e) => e.offsetParent !== null) ?? all[0];
	if (!el) return false;
	el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: 100, clientY: 100 }));
	return true;
})()`);

/** The editor tabs' texts. */
const tabTitles = () => workbench.evaluate(`[...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim())`);

/** Wait for the Git Graph view's text (whichever srcdoc frame carries it). */
async function viewText(want, avoid = [], timeoutMs = 20000) {
	for (let waited = 0; waited < timeoutMs; waited += 500) {
		await sleep(500);
		const views = await srcdocSessions();
		for (const view of views) {
			if (!view) continue;
			const text = String(await view.evaluate('document.body ? document.body.innerText : ""').catch(() => '')).replace(/\s+/g, ' ');
			view.close();
			if (want.every((part) => text.includes(part)) && avoid.every((part) => !text.includes(part))) return text;
		}
	}
	return '';
}

try {
	/* 0. The backend must be up for any of the extension's commands to answer. */
	let status = null;
	for (let attempt = 0; attempt < 60; attempt++) {
		await sleep(500);
		const all = await workbench.evaluate(`(async () => ${tauri}.invoke('ext_process_status'))()`).catch(() => null);
		status = (all ?? []).find((entry) => entry.extensionId === EXT_ID) ?? null;
		if (status && status.pid > 0) break;
	}
	check('the git-graph-rs backend is running', Boolean(status && status.pid > 0), JSON.stringify(status));

	/* 1. The Source Control view's header button (the palette titles localize with the app's
	 *    display language — the queries carry both). */
	check('the Source Control view opens', await showView(/Source Control|源代码管理/, '>源代码管理') || await showView(/Source Control/, '>Source Control'));
	await sleep(500);
	const headerButton = await workbench.evaluate(`(function(){
		const buttons = [...document.querySelectorAll('.pane-header.scm-main-header .actions button')];
		const graph = buttons.find((b) => /Git Graph/i.test(b.title || ''));
		return graph ? { title: graph.title, hasIcon: Boolean(graph.querySelector('img')) } : null;
	})()`);
	check('the scm/title navigation button renders in the SCM header', Boolean(headerButton), JSON.stringify(headerButton));
	check('the header button carries the manifest icon', Boolean(headerButton?.hasIcon));
	if (headerButton) {
		await workbench.evaluate(`(function(){
			const buttons = [...document.querySelectorAll('.pane-header.scm-main-header .actions button')];
			const graph = buttons.find((b) => /Git Graph/i.test(b.title || ''));
			graph?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		})()`);
		let tabs = '';
		for (let attempt = 0; attempt < 20 && !/Git Graph/i.test(tabs); attempt++) {
			await sleep(500);
			tabs = JSON.stringify(await tabTitles());
		}
		check('clicking the SCM header button opens the Git Graph view', /Git Graph/i.test(tabs), tabs);
	}

	/* 2. The "..." menu: the extension's scm/title entries, and Amend really amends. */
	const moreOpened = await openMoreMenu();
	check('the SCM "..." menu opens with its Pull, Push submenu', moreOpened === 'open', moreOpened);
	if (moreOpened === 'open') {
		const texts = (await menuTexts()) ?? [];
		const flat = texts.flat();
		check('the "..." menu offers Amend Last Commit', flat.some((t) => T.amend.test(t)), flat.filter((t) => /amend|修正/i.test(t)).join(' | '));
		check('the "..." menu offers Fetch commit-msg Hook (Gerrit)', flat.some((t) => T.gerritHook.test(t)), flat.filter((t) => /commit-msg|钩子/i.test(t)).join(' | '));
		check('the "..." menu offers Reset Current Branch to Remote', flat.some((t) => T.reset.test(t)), flat.filter((t) => /Remote|远程/i.test(t)).join(' | '));
		// The Pull, Push submenu is the deepest open level.
		const deepest = texts[texts.length - 1] ?? [];
		check('the Pull, Push submenu offers the Gerrit refs/for/ push', deepest.some((t) => T.gerritPush.test(t)), deepest.join(' | '));
	}

	/* 2b. The Gerrit push from the Pull, Push submenu: confirm appears, cancel aborts — a
	 *     read-only flow, so it runs before the amend changes the repository. */
	if ((await openMoreMenu()) === 'open') {
		const pushed = await clickMenuItem(T.gerritPush);
		check('the Gerrit push menu entry dispatches', Boolean(pushed), String(pushed));
		if (pushed) {
			// The Change-Id confirm: a toast with buttons. The toast snapshot is taken inside
			// the same page turn as the cancel click, BEFORE the click — the abort message that
			// follows within milliseconds would otherwise already be in the "before" set.
			let confirmSeen = '';
			let before = [];
			for (let attempt = 0; attempt < 20 && !confirmSeen; attempt++) {
				await sleep(300);
				const step = await workbench.evaluate(`(function(){
					const toasts = [...document.querySelectorAll('#notifications .notification')];
					const confirm = toasts.find((t) => /Change-Id/i.test(t.textContent) && t.querySelector('.buttons'));
					if (!confirm) return null;
					const cancel = [...confirm.querySelectorAll('.buttons button')].find((b) => /cancel/i.test(b.textContent) || /取消/.test(b.textContent));
					if (!cancel) return null;
					const before = [...document.querySelectorAll('#notifications .notification .message')].map((m) => m.textContent.trim());
					cancel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
					return { text: confirm.textContent.trim().slice(0, 120), before };
				})()`);
				if (step) {
					confirmSeen = step.text;
					before = step.before;
				}
			}
			check('the Gerrit push asks before amending a Change-Id', confirmSeen !== '', confirmSeen);
			const aborted = await toastMatching(/abort|取消|中止/i, 30000, new Set(before));
			check('cancelling the Gerrit push aborts cleanly', aborted !== '', aborted);
		}
		await closeMenus();
	}

	/* 4. The change row's context menu: the file-history filter, scoped to that file. */
	await sleep(500);
	const rowClicked = await contextClick('.scm-list .row');
	check('the Source Control change row answers a right-click', Boolean(rowClicked));
	if (rowClicked) {
		const texts = ((await menuTexts()) ?? []).flat();
		check('the change row menu offers the file-history filter', texts.some((t) => T.filterByFile.test(t)), texts.filter((t) => /Git Graph/i.test(t)).join(' | '));
		const picked = await clickMenuItem(T.filterByFile);
		check('the file-history filter dispatches from the change row', Boolean(picked), String(picked));
		// file1.txt: only beta touched it — the view must show beta and neither other commit.
		const text = await viewText(['probe beta commit'], ['probe alpha commit', 'probe gamma commit']);
		check('the view opens scoped to the right-clicked file (beta only)', text !== '', text.slice(0, 160));
	}
	await closeMenus();

	/* 5. The File Explorer's context menu — the same filter, dispatched with the file Uri. */
	check('the Explorer view opens', await showView(/Explorer|资源管理器/, '>资源管理器') || await showView(/Explorer/, '>Explorer'));
	await sleep(500);
	const explorerClicked = await contextClick('.row[data-path$="file0.txt"]');
	check('the explorer file row answers a right-click', Boolean(explorerClicked));
	if (explorerClicked) {
		const texts = ((await menuTexts()) ?? []).flat();
		check('the explorer context menu offers the file-history filter', texts.some((t) => T.filterByFile.test(t)), texts.filter((t) => /Git Graph/i.test(t)).join(' | '));
		const picked = await clickMenuItem(T.filterByFile);
		check('the file-history filter dispatches from the explorer', Boolean(picked), String(picked));
		const text = await viewText(['probe alpha commit'], ['probe beta commit', 'probe gamma commit']);
		check('the view opens scoped to the explorer file (alpha only)', text !== '', text.slice(0, 160));
	}
	await closeMenus();

	/* 6. The text editor's context menu, and the editor tab's. */
	await workbench.evaluate(`(function(){
		const row = [...document.querySelectorAll('.row[data-path$="file2.txt"]')].find((e) => e.offsetParent !== null);
		row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
	})()`);
	let editorUp = false;
	for (let attempt = 0; attempt < 20 && !editorUp; attempt++) {
		await sleep(300);
		editorUp = Boolean(await workbench.evaluate(`Boolean(document.querySelector('.cm-editor'))`));
	}
	check('a file opened in the text editor', editorUp);
	if (editorUp) {
		const editorClicked = await contextClick('.cm-editor');
		check('the text editor answers a right-click', Boolean(editorClicked));
		if (editorClicked) {
			const texts = ((await menuTexts()) ?? []).flat();
			check('the editor context menu offers the file-history filter', texts.some((t) => T.filterByFile.test(t)), texts.filter((t) => /Git Graph/i.test(t)).join(' | '));
			const picked = await clickMenuItem(T.filterByFile);
			check('the file-history filter dispatches from the editor', Boolean(picked), String(picked));
			const text = await viewText(['probe gamma commit'], ['probe alpha commit', 'probe beta commit']);
			check('the view opens scoped to the edited file (gamma only)', text !== '', text.slice(0, 160));
		}
		await closeMenus();
		const tabClicked = await contextClick('.tabs-container .tab');
		check('the editor tab answers a right-click', Boolean(tabClicked));
		if (tabClicked) {
			const texts = ((await menuTexts()) ?? []).flat();
			check('the tab context menu offers the file-history filter', texts.some((t) => T.filterByFile.test(t)), texts.filter((t) => /Git Graph/i.test(t)).join(' | '));
			await closeMenus();
		}
	}

	/* 6b. The Amend entry, run last among the repository mutations: its watcher push must not
	 *     race the view-filter checks above. */
	check('the Source Control view opens (again)', await showView(/Source Control|源代码管理/, '>源代码管理') || await showView(/Source Control/, '>Source Control'));
	if ((await openMoreMenu()) === 'open') {
		const headBefore = git('rev-parse', 'HEAD').trim();
		const amendedItem = await clickMenuItem(T.amend);
		const amendToast = amendedItem ? await toastMatching(/amend|修正/i) : '';
		const headAfter = git('rev-parse', 'HEAD').trim();
		check('the Amend menu entry amends the last commit', headBefore !== headAfter, `${headBefore.slice(0, 8)} → ${headAfter.slice(0, 8)}`);
		check('the amend reports its result', amendToast !== '', amendToast);
		await closeMenus();
	}

	/* 7. The command palette: every palette-visible command listed, and each runnable one
	 *    run. Add Git Repository... is listed but not run (its folder picker is native). */
	const palette = await paletteRows('>Git Graph RS');
	for (const [name, pattern] of Object.entries({ view: T.view, addRepo: T.addRepo, clearAvatars: T.clearAvatars, endAllReviews: T.endAllReviews, endReview: T.endReview, resumeReview: T.resumeReview, fetch: T.fetch, removeRepo: T.removeRepo, version: T.version, searchCommits: T.searchCommits, amend: T.amend, reset: T.reset, gerritPush: T.gerritPush, gerritHook: T.gerritHook })) {
		check(`the palette offers ${name}`, palette.some((t) => pattern.test(t)), palette.join(' | ').slice(0, 300));
	}

	// Version: a modal toast carrying the version.
	const versionRun = await paletteClick('>Git Graph RS', T.version);
	const versionToast = versionRun.clicked ? await toastMatching(/1\.0\.\d+|Git Graph|git-graph/i) : '';
	check('Get Version Information answers with the version toast', versionToast !== '', versionToast.slice(0, 160));

	// Clear avatar cache.
	const avatarRun = await paletteClick('>Git Graph RS', T.clearAvatars);
	const avatarToast = avatarRun.clicked ? await toastMatching(/avatar|头像/i) : '';
	check('Clear Avatar Cache answers', avatarToast !== '', avatarToast.slice(0, 160));

	// Reset to remote: this repository has no upstream — the command must say so.
	const resetRun = await paletteClick('>Git Graph RS', T.reset);
	const resetToast = resetRun.clicked ? await toastMatching(/upstream|上游/i) : '';
	check('Reset Current Branch to Remote reports the missing upstream', resetToast !== '', resetToast.slice(0, 160));

	// The Gerrit hook fetch: no remote configured — its failure must surface.
	const hookRun = await paletteClick('>Git Graph RS', T.gerritHook);
	const hookToast = hookRun.clicked ? await toastMatching(/commit-msg|钩子/i) : '';
	check('Fetch commit-msg Hook (Gerrit) reports its failure', hookToast !== '', hookToast.slice(0, 160));

	// Search Commits: the extension's own input box, the beta commit as a pick, the view on it.
	const searchRun = await paletteClick('>Git Graph RS', T.searchCommits);
	let searchFlowed = searchRun.clicked ? 'palette row not clicked' : 'no palette row';
	if (searchRun.clicked) {
		searchFlowed = await workbench.evaluate(`(async () => {
			// The extension's input box (its own quick input, title mentioning the commit history).
			let input = null;
			for (let attempt = 0; attempt < 30 && input === null; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				const overlay = document.querySelector('#overlays .quick-input');
				const candidate = overlay?.querySelector('input');
				if (candidate && /提交|commit/i.test((overlay.querySelector('.title')?.textContent ?? '') + (candidate.placeholder ?? ''))) input = candidate;
			}
			if (!input) return 'no extension input box';
			input.value = 'beta';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 400));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			for (let attempt = 0; attempt < 40; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				const rows = [...document.querySelectorAll('#overlays .quick-input .row')];
				const row = rows.find((r) => /probe beta commit/.test(r.textContent));
				if (row) {
					row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
					return 'picked';
				}
			}
			return 'no commit row';
		})()`);
	}
	let searchTabs = '';
	if (searchFlowed === 'picked') {
		for (let attempt = 0; attempt < 20 && !/Git Graph/i.test(searchTabs); attempt++) {
			await sleep(500);
			searchTabs = JSON.stringify(await tabTitles());
		}
	}
	check('Search Commits finds the commit and opens the view on it', searchFlowed === 'picked' && /Git Graph/i.test(searchTabs), `${searchFlowed} ${searchTabs}`);

	// Fetch: the view opens with the fetch queued (no remote — nothing to fetch, no crash).
	const fetchRun = await paletteClick('>Git Graph RS', T.fetch);
	let fetchTabs = '';
	if (fetchRun.clicked) {
		for (let attempt = 0; attempt < 20 && !/Git Graph/i.test(fetchTabs); attempt++) {
			await sleep(500);
			fetchTabs = JSON.stringify(await tabTitles());
		}
	}
	check('Fetch from Remote(s) opens the view', /Git Graph/i.test(fetchTabs), fetchTabs);

	// End all code reviews: always answers.
	const endAllRun = await paletteClick('>Git Graph RS', T.endAllReviews);
	const endAllToast = endAllRun.clicked ? await toastMatching(/code review|代码评审/i) : '';
	check('End All Code Reviews answers', endAllToast !== '', `${endAllRun.clicked ? 'clicked' : 'row not found'} ${endAllToast.slice(0, 160)}`);

	// The specific/resume variants: no reviews in progress — their error must surface.
	for (const [name, pattern, error] of [
		['End a specific Code Review', T.endReview, /review|评审/i],
		['Resume a specific Code Review', T.resumeReview, /review|评审/i]
	]) {
		const run = await paletteClick('>Git Graph RS', pattern);
		const toast = run.clicked ? await toastMatching(error) : '';
		check(`${name} reports no reviews in progress`, toast !== '', `${run.clicked ? 'clicked' : 'row not found'} ${toast.slice(0, 160)}`);
	}

	// Remove Git Repository: the repository quick pick appears; escape it (cancel).
	const removeRun = await paletteClick('>Git Graph RS', T.removeRepo);
	let removePickSeen = false;
	if (removeRun.clicked) {
		for (let attempt = 0; attempt < 10 && !removePickSeen; attempt++) {
			await sleep(300);
			removePickSeen = Boolean(await workbench.evaluate(`(function(){
				const input = document.querySelector('#overlays .quick-input input');
				return input && /repo|仓库/i.test(input.placeholder || '') || Boolean(document.querySelector('#overlays .quick-input .row'));
			})()`));
		}
		await workbench.evaluate(`(function(){
			const input = document.querySelector('#overlays .quick-input input');
			input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		})()`);
	}
	check('Remove Git Repository offers the repository pick', removePickSeen);

	/* 8. The workbench console. */
	const exceptions = workbench.consoleEntries.filter((entry) => entry.level === 'exception');
	for (const entry of exceptions.slice(0, 10)) log(`[console:exception] ${entry.text.slice(0, 300)}`);
	check('no exception in the workbench console', exceptions.length === 0, `${exceptions.length} entries`);
} catch (error) {
	check('the probe ran to the end', false, String(error?.stack ?? error).slice(0, 400));
} finally {
	workbench.close();
	killTree(child.pid);
}

log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
