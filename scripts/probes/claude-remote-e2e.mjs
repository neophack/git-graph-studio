// claude-remote-e2e — the whole Claude Remote path, live and hermetic, with the real
// pieces on every hop:
//
//   the relay        the built claude-remote-server binary (in-memory, open registration)
//   the PC window    the extension's own activate() under a VS Code-shaped fake (no ggs.*
//                    surface → the sdk-host source), long-polling like ggs-node does
//                    (`--ws` switches it to the WebSocket VS Code's Node speaks)
//   the model        the bundled claude CLI against scripts/probes/fake-claude-server.mjs
//                    (no account, no network beyond the loopback)
//   the phone        the relay's own phone app (web/app.js) in headless Edge, driven over
//                    CDP at a phone-sized viewport
//
// It walks what a user does: scan the pairing link → the window's conversation list →
// open a seeded history conversation (the transcript renders, tool rows included) → start
// a NEW conversation (the PC adopts the id the turn creates; the reply streams in as the
// CLI's own SDK messages) → a second turn in it (resumed, not a new conversation) → a
// tool-permission card answered from the phone → a page reload that keeps working → the
// panel's local debug page (the same app on 127.0.0.1, no relay) running a turn too.
//
//   node scripts/probes/claude-remote-e2e.mjs [--ws] [--keep] [--shots <dir>] [--relay <binary>] [--cli <claude>]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const nodeRequire = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null);
const keep = flag('--keep');
const useWs = flag('--ws');
const exe = process.platform === 'win32' ? '.exe' : '';

const relayBinary = option('--relay') ?? [
	`target/studio/claude-remote-server-dev/debug/claude-remote-server${exe}`,
	`target/studio/claude-remote-server/debug/claude-remote-server${exe}`,
	`target/studio/claude-remote-server/release/claude-remote-server${exe}`
].map((p) => join(repo, p)).find(existsSync);
if (!relayBinary) {
	console.error('no relay binary — build it first:  (cd claude-remote-server && cargo build)');
	process.exit(1);
}
const cliPath = option('--cli') ?? (() => {
	const dir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ggs', 'extensions');
	const pkg = existsSync(dir) ? readdirSync(dir).filter((d) => /^anthropic\.claude-code-/i.test(d)).sort().pop() : null;
	const candidate = pkg ? join(dir, pkg, 'resources', 'native-binary', `claude${exe}`) : null;
	return candidate && existsSync(candidate) ? candidate : null;
})();
if (!cliPath) {
	console.error('no claude CLI — pass --cli <path to claude(.exe)> (the claude-code extension bundles one)');
	process.exit(1);
}
const edgePath = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome']
	.find(existsSync);
if (!edgePath) {
	console.error('no Edge/Chrome for the headless phone');
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (label, condition, detail = '') => {
	if (!condition) throw new Error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
	passed++;
	console.log(`  ok  ${label}`);
};
const children = [];
const cleanup = () => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } };

/* ---------- the scratch world: home, Claude's store, the workspace, seeded history ---------- */
const world = mkdtempSync(join(tmpdir(), 'crr-e2e-'));
const root = join(world, 'claude');
const workspace = join(world, 'work', 'demo-app');
const elsewhere = join(world, 'work', 'other-app');
mkdirSync(workspace, { recursive: true });
mkdirSync(elsewhere, { recursive: true });
Object.assign(process.env, {
	HOME: world, USERPROFILE: world, CLAUDE_CONFIG_DIR: root, CLAUDE_CLI_PATH: cliPath,
	ANTHROPIC_API_KEY: 'sk-crr-e2e', ANTHROPIC_AUTH_TOKEN: 'sk-crr-e2e',
	DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1'
});
// Ask before tools (this CLI's built-in default is auto mode, whose classifier cannot run
// against a loopback endpoint — it would block the probe's tool call instead of asking).
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
const sessions = nodeRequire(join(repo, 'extensions-src/claude-remote/sessions.js'));
const seed = (cwd, id, records) => {
	const dir = join(root, 'projects', sessions.mungePath(cwd));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify({ cwd, timestamp: '2026-10-10T08:00:00Z', ...r }) + '\n').join(''));
};
seed(workspace, '11111111-1111-4111-8111-111111111111', [
	{ type: 'user', uuid: 'h-u1', message: { role: 'user', content: 'Seeded history: list the files' } },
	{ type: 'assistant', uuid: 'h-a1', message: { role: 'assistant', model: 'fake-1', content: [{ type: 'tool_use', id: 'toolu_h1', name: 'Bash', input: { command: 'ls -la' } }] } },
	{ type: 'user', uuid: 'h-u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_h1', content: 'README.md\nsrc' }] } },
	{ type: 'assistant', uuid: 'h-a2', message: { role: 'assistant', model: 'fake-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The **seeded** answer: README.md and src.' }] } }
]);
seed(elsewhere, '22222222-2222-4222-8222-222222222222', [
	{ type: 'user', uuid: 'o-u1', message: { role: 'user', content: 'A conversation from another project' } },
	{ type: 'assistant', uuid: 'o-a1', message: { role: 'assistant', model: 'fake-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Other project answer.' }] } }
]);

/* ---------- the relay and the fake model ---------- */
const lineOf = (child, pattern, what) => new Promise((resolveLine, reject) => {
	const timer = setTimeout(() => reject(new Error(`${what} never printed its listening line`)), 20000);
	child.stdout.on('data', (chunk) => {
		const match = String(chunk).match(pattern);
		if (match) { clearTimeout(timer); resolveLine(match[1]); }
	});
});
const relay = spawn(relayBinary, ['serve', '--memory', '--registration', 'open', '--listen', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'inherit'] });
children.push(relay);
const base = `http://${await lineOf(relay, /listening on (127\.0\.0\.1:\d+)/, 'the relay')}`;
const fake = spawn(process.execPath, [join(here, 'fake-claude-server.mjs'), '--port', '0', '--tokens', '6'], { stdio: ['ignore', 'pipe', 'inherit'] });
children.push(fake);
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${await lineOf(fake, /listening (\d+)/, 'the fake Claude server')}`;
console.log(`relay ${base} · model ${process.env.ANTHROPIC_BASE_URL} · cli ${cliPath}`);

// The CDP client keeps the platform WebSocket; the extension leg may not see it.
const PlatformWebSocket = globalThis.WebSocket;
if (!useWs) globalThis.WebSocket = undefined;

/* ---------- the PC window: the extension's own activate() ---------- */
function fakeVscode(settings) {
	const secrets = {};
	const gState = {};
	const logs = [];
	const commands = new Map();
	const opened = [];
	const vscode = {
		version: '1.100.0',
		StatusBarAlignment: { Left: 1, Right: 2 },
		ViewColumn: { Active: -1, Beside: -2 },
		ConfigurationTarget: { Global: 1 },
		env: { uriScheme: 'vscode', appName: 'Visual Studio Code', language: 'en', clipboard: { writeText: async () => {} }, openExternal: async (uri) => { opened.push(String(uri)); return true; } },
		Uri: { parse: (value) => ({ toString: () => value }) },
		commands: {
			registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; },
			executeCommand: async (id) => { if (id === 'setContext') return undefined; throw new Error(`command '${id}' not found`); },
			getCommands: async () => []
		},
		window: {
			createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
			createWebviewPanel: () => { throw new Error('no panel in the probe'); },
			showErrorMessage: async (m) => { logs.push('ERROR ' + m); },
			showInformationMessage: async (m) => { logs.push('INFO ' + m); },
			showWarningMessage: async (m) => { logs.push('WARN ' + m); },
			showInputBox: async () => undefined,
			showQuickPick: async () => undefined,
			tabGroups: { all: [], close: async () => false, activeTabGroup: { activeTab: null } }
		},
		workspace: {
			workspaceFolders: [{ name: 'demo-app', uri: { fsPath: workspace } }],
			getConfiguration: () => ({ get: (key) => settings[key], update: async (key, value) => { settings[key] = value; } }),
			onDidChangeConfiguration: () => ({ dispose() {} })
		}
	};
	const context = {
		secrets: { get: async (k) => secrets[k], store: async (k, v) => { secrets[k] = v; }, delete: async (k) => { delete secrets[k]; } },
		globalState: { get: (k) => gState[k], update: async (k, v) => { gState[k] = v; } },
		subscriptions: []
	};
	return { vscode, context, secrets, logs, commands, opened };
}
const pc = fakeVscode({ serverUrl: base, autoConnect: true, backend: 'desktop', desktopTab: 'off' });
const Module = nodeRequire('node:module');
const originalLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? pc.vscode : originalLoad.apply(this, [request, ...rest]); };
const extensionLog = [];
const originalLog = console.log;
console.log = (...a) => { const line = a.map(String).join(' '); if (line.startsWith('[claude-remote]')) extensionLog.push(line); else originalLog(...a); };
const extension = nodeRequire(join(repo, 'extensions-src/claude-remote/extension.js'));
extension.activate(pc.context);

const identityLib = nodeRequire(join(repo, 'extensions-src/claude-remote/identity.js'));
const wire = nodeRequire(join(repo, 'extensions-src/claude-remote/wire.js'));
async function until(probe, ok, ms, what) {
	const start = Date.now();
	for (;;) {
		const value = await probe();
		if (ok(value)) return value;
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)?.slice(0, 400)}`);
		await sleep(150);
	}
}

let edge = null;
try {
	const identity = await until(() => identityLib.readIdentity(pc.context), Boolean, 20000, 'the PC to register on the relay');
	check('PC: registered on the relay', /^u_/.test(identity.userId), identity.userId);
	const windows = await until(() => identityLib.windows(identity), (list) => list.some((w) => w.online && w.meta_ct), 20000, 'the window to come online with its meta');
	const meta = wire.decode(windows.find((w) => w.online).meta_ct);
	check(`PC: the window is online (${useWs ? 'websocket' : 'long-poll'}) with a plain meta`, meta.name === 'demo-app', JSON.stringify(meta));
	const link = identityLib.link(identity);
	check('PC: the pairing link carries the plain credential', /#p\.[0-9a-f]{64}\.\d+$/.test(link), link);

	/* ---------- the phone ---------- */
	const cdpPort = 9600 + Math.floor(Math.random() * 300);
	edge = spawn(edgePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'crr-e2e-edge-'))}`, '--no-first-run', '--disable-gpu', '--lang=en-US', '--accept-lang=en-US', 'about:blank'], { stdio: 'ignore' });
	children.push(edge);
	const targets = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); } catch { return null; } }, (v) => Array.isArray(v) && v.some((t) => t.type === 'page'), 15000, 'Edge');
	const socket = new PlatformWebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
	let nextId = 1;
	const waiting = new Map();
	const consoleLines = [];
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && waiting.has(message.id)) {
			const { resolve: done, reject } = waiting.get(message.id);
			waiting.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else done(message.result);
		} else if (message.method === 'Runtime.consoleAPICalled') {
			consoleLines.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
		} else if (message.method === 'Runtime.exceptionThrown') {
			consoleLines.push('EXCEPTION ' + (message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
		}
	};
	await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
	const cdp = (method, params = {}) => new Promise((ok, fail) => { const id = nextId++; waiting.set(id, { resolve: ok, reject: fail }); socket.send(JSON.stringify({ id, method, params })); });
	await cdp('Runtime.enable');
	await cdp('Page.enable');
	await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await cdp('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => undefined); // the labels the probe taps are the English ones
	const page = async (expression) => {
		const result = await cdp('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error('page: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
		return result.result.value;
	};
	const pageText = () => page('return document.body.innerText;');
	const waitText = (needle, ms = 30000) => until(pageText, (body) => (needle instanceof RegExp ? needle.test(body) : body.includes(needle)), ms, `"${needle}" on the phone`);
	const tap = (label) => page(`const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && n.textContent.trim().includes(${JSON.stringify(label)})); if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.click(); return true;`);
	const type = (value) => page(`const i = document.querySelector('#dock textarea'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); return true;`);
	const stats = () => page('return JSON.parse(JSON.stringify(window.__crrStats || {}));');
	const shotsDir = option('--shots');
	const shot = async (name) => {
		if (!shotsDir) return;
		mkdirSync(shotsDir, { recursive: true });
		const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
		writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
	};
	const openRow = async (needle) => {
		const find = `[...document.querySelectorAll('.row-card.session')].find((n) => n.textContent.includes(${JSON.stringify(needle)}))`;
		await until(() => page(`return !!${find};`), Boolean, 20000, `the "${needle}" row`);
		await page(`${find}.click(); return true;`);
	};

	await cdp('Page.navigate', { url: link });
	await waitText('Seeded history: list the files');
	check('phone: paired by the link and landed on the window\'s conversation list', true);
	await shot('1-conversations');
	check('phone: the link\'s credential left the address bar', !(await page('return location.hash;')));

	await tap('All');
	await waitText('A conversation from another project');
	check('phone: the "All" scope lists another project\'s conversation', true);
	await tap('This workspace');

	await openRow('Seeded history');
	await waitText('README.md and src');
	const history = await page(`return { tools: document.querySelectorAll('.msg.tool').length, strong: !!document.querySelector('.md strong'), user: document.querySelector('.msg.user')?.innerText };`);
	check('phone: a history conversation renders its transcript (markdown, the tool row, the prompt)', history.tools === 1 && history.strong && /Seeded history/.test(history.user), JSON.stringify(history));
	await page(`document.querySelector('.msg.tool').open = true; return true;`);
	await waitText('ls -la');
	check('phone: a tool row\'s body loads lazily from the PC', true);
	await shot('2-history');

	// A new conversation.
	await page(`document.getElementById('backBtn').click(); return true;`);
	await waitText('Seeded history');
	const sessionsBefore = await page(`return document.querySelectorAll('.row-card.session').length;`);
	await tap('New conversation');
	await until(() => page(`return !!document.querySelector('#dock textarea');`), Boolean, 10000, 'the composer');
	await type('hello from the phone');
	await tap('Send');
	await waitText('hello from the phone');
	await until(() => page(`return !!document.querySelector('.streaming');`), Boolean, 30000, 'the reply streaming in').catch(() => undefined);
	await shot('3-streaming');
	await waitText('FAKE-CLAUDE: you said "hello from the phone"', 90000);
	// The streamed partial already spells the answer; the turn's own messages follow it.
	const afterFirst = await until(stats, (v) => (v.live?.result ?? 0) >= 1, 30000, "the turn's result over the live stream");
	check('live: the new conversation was adopted from the turn\'s first event', afterFirst.adopted === 1, JSON.stringify(afterFirst));
	check('live: the turn crossed as the CLI\'s own SDK messages (stream deltas, the assistant message, the result)',
		(afterFirst.live.stream_event ?? 0) > 3 && (afterFirst.live.assistant ?? 0) >= 1 && (afterFirst.live.result ?? 0) >= 1, JSON.stringify(afterFirst.live));
	await until(() => page(`return !document.querySelector('.msg.working') && !document.querySelector('.msg.user.pending');`), Boolean, 20000, 'the turn to settle on the phone');
	const bubbles = await page(`return [...document.querySelectorAll('.msg.user')].map((n) => n.innerText);`);
	check('phone: the prompt shows once (the pending bubble yields to the transcript\'s own)', bubbles.filter((b) => b.includes('hello from the phone')).length === 1, JSON.stringify(bubbles));

	// A second turn in the same conversation.
	await type('second turn please');
	await tap('Send');
	await waitText('FAKE-CLAUDE: you said "second turn please"', 90000);
	const answers = await page(`return [...document.querySelectorAll('.msg.assistant')].map((n) => n.innerText).filter((t) => t.includes('FAKE-CLAUDE')).length;`);
	check('phone: a second turn resumes the same conversation (both answers in one transcript)', answers === 2, String(answers));
	check('live: no second adoption — the second turn rode the adopted id', (await stats()).adopted === 1);

	// The permission card, answered from the phone.
	await type('RUN_BASH: mkdir crr-e2e-made-it');
	await tap('Send');
	await until(() => page(`return !!document.querySelector('.perm-card');`), Boolean, 90000, 'the permission card');
	await shot('4-permission');
	check('phone: the tool-permission card arrived', /Bash/.test(await page(`return document.querySelector('.perm-card').innerText;`)));
	check('pop-up: the permission prompt is a modal over the conversation', await page(`return !!document.querySelector('.modal-overlay .perm-card');`));
	await page(`[...document.querySelectorAll('.perm-card button')].find((n) => n.textContent.trim() === 'Allow').click(); return true;`);
	await until(() => existsSync(join(workspace, 'crr-e2e-made-it')), Boolean, 60000, 'the allowed command to run');
	check('PC: the command the phone allowed ran', true);
	await waitText(/FAKE-CLAUDE: you said "RUN_BASH/, 90000);
	check('phone: the turn finished after the answered permission', true);

	// A question pop-up (AskUserQuestion arrives as the protocol's can_use_tool request):
	// the pick crosses as the allow's updatedInput.answers, and the tool reads it back.
	await type('RUN_ASK: pick a color');
	await tap('Send');
	await until(() => page(`return !!document.querySelector('.modal-overlay .modal-card');`), Boolean, 90000, 'the question pop-up');
	check('pop-up: AskUserQuestion opens the question modal', /Which color\?/.test(await page(`return document.querySelector('.modal-card').innerText;`)));
	await shot('4b-question');
	await page(`[...document.querySelectorAll('.modal-card .q-opt')].find((n) => n.textContent.includes('Blue')).click(); return true;`);
	await page(`[...document.querySelectorAll('.modal-card button')].find((n) => n.textContent.trim() === 'Submit').click(); return true;`);
	await until(() => page(`return !document.querySelector('.modal-overlay');`), Boolean, 20000, 'the pop-up to close');
	await waitText(/FAKE-CLAUDE: you said "RUN_ASK/, 90000);
	const projectDir = join(root, 'projects', sessions.mungePath(workspace));
	const transcript = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl')).map((f) => readFileSync(join(projectDir, f), 'utf8')).join('\n');
	check("pop-up: the pick reached the tool as its answer (the CLI's own tool_result says Blue)", /tool_result[^\n]*Blue/.test(transcript));

	// The list knows the new conversation (exactly one more), and a reload keeps working.
	await page(`document.getElementById('backBtn').click(); return true;`);
	await until(() => page(`return document.querySelectorAll('.row-card.session').length;`), (n) => n === sessionsBefore + 1, 20000, 'the new conversation in the list');
	check('phone: the list carries the new conversation once', true);
	await cdp('Page.reload');
	await waitText('hello from the phone', 30000);
	await openRow('hello from the phone');
	await until(() => page(`return !!document.querySelector('#dock textarea');`), Boolean, 10000, 'the composer after reload');
	await waitText('second turn please');
	await type('after the reload');
	await tap('Send');
	await waitText('FAKE-CLAUDE: you said "after the reload"', 90000);
	check('phone: after a page reload the same device keeps talking (no replay rejection)', true);

	/* ---------- the local debug page: the same app, straight to the window ---------- */
	const debugUrl = await pc.commands.get('claude-remote.openDebugPage')();
	check('debug: the panel command starts the loopback page and opens it in the browser', /^http:\/\/127\.0\.0\.1:\d+\/d\/[0-9a-f]{32}$/.test(debugUrl) && pc.opened[0] === debugUrl, `${debugUrl} / ${pc.opened}`);
	await cdp('Page.navigate', { url: debugUrl });
	await waitText('local debug');
	await waitText('hello from the phone');
	check("debug: no pairing — the page lands on the window's conversations", true);
	const statsBefore = await stats();
	await openRow('hello from the phone');
	await waitText('after the reload');
	await until(() => page(`return !!document.querySelector('#dock textarea');`), Boolean, 10000, 'the composer on the debug page');
	await type('from the debug page');
	await tap('Send');
	await waitText('FAKE-CLAUDE: you said "from the debug page"', 90000);
	const debugStats = await until(stats, (v) => (v.live?.result ?? 0) >= 1 && (v.live?.stream_event ?? 0) > 3, 30000, 'the live stream on the debug page');
	check("debug: a turn from the debug page streams live as the CLI's SDK messages", (debugStats.live.assistant ?? 0) >= 1 && !(statsBefore.live && statsBefore.live.result), JSON.stringify(debugStats.live));
	await shot('5-local-debug');

	const errors = consoleLines.filter((l) => /EXCEPTION/.test(l));
	check('phone: no uncaught exceptions', errors.length === 0, errors.join(' | '));
	console.log(`\nPASS — ${passed} checks (${useWs ? 'websocket' : 'long-poll'} window, real relay, real CLI, phone in headless Edge)`);
	if (keep) {
		console.log(`\n--keep: phone link ${link}`);
		await new Promise(() => {});
	}
	socket.close();
} catch (error) {
	console.error(String(error && error.stack || error));
	console.error('\nthe extension log:\n' + extensionLog.slice(-40).join('\n'));
	cleanup();
	process.exit(1);
} finally {
	console.log = originalLog;
}
for (const d of pc.context.subscriptions) { try { d.dispose && d.dispose(); } catch { /* best effort */ } }
cleanup();
process.exit(0);
