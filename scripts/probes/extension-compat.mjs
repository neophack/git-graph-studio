// The extension compatibility probe: activate a battery of popular Open VSX extensions
// through a real ggs-node + vscode-shim host and aggregate every compatibility gap —
// the measurement behind "most extensions should work".
//
// For each extension: download (cached per version), unpack, drive the real activation
// over ggs-ext/1 (host.env answered; every shim `log` captured), then record:
//   - did `activate` settle, and how long did it take?
//   - which vscode API members it reached for that this host does not serve
//     (the namespace probe names them — nested namespaces included);
//   - any other activation failure, with its reason (a missing Node builtin, a throw).
//
// The last section ranks the gaps by how many extensions hit them — that ranking is
// what to fix next in src/vscodeApi.ts, one fix serving every host.
//
// Usage:
//   node scripts/probes/extension-compat.mjs [--ids ns.name,ns.name] [--exe <ggs-node>] \
//        [--timeout 45] [--only-gap-extensions]
// Without --ids a default battery of popular extensions runs.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i].startsWith('--')) flags.set(process.argv[i], process.argv[++i] ?? '');
}
const say = (line) => console.log(line);
const die = (line) => { console.error(`[fatal] ${line}`); process.exit(2); };

const root = resolve(import.meta.dirname, '..', '..');
const exe = flags.get('--exe') ?? join(root, 'target/studio/cargo/ggs-node/ggs-node');
if (!existsSync(exe)) die(`no ggs-node binary (looked at ${exe}) — build it or pass --exe`);

// A spread of the popular, code-bearing (main-having) extensions on Open VSX — formatters,
// linters, viewers, git tools, UI helpers — each exercising a different API surface.
const DEFAULT_BATTERY = [
	'esbenp.prettier-vscode',
	'dbaeumer.vscode-eslint',
	'eamodio.gitlens',
	'ritwickdey.LiveServer',
	'vscodevim.vim',
	'oderwat.indent-rainbow',
	'streetsidesoftware.code-spell-checker',
	'redhat.vscode-yaml',
	'formulahendry.code-runner',
	'christian-kohler.path-intellisense',
	'usernamehw.errorlens',
	'wayou.vscode-todo-highlight',
	'alefragnani.project-manager',
	'Gruntfuggly.todo-tree',
	'mechatroner.rainbow-csv',
	'CoenraadS.bracket-pair-colorizer'
];

const ids = (flags.get('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dirs = (flags.get('--dirs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const battery = [...dirs, ...(ids.length > 0 ? ids : dirs.length > 0 ? [] : DEFAULT_BATTERY)];
const timeoutMs = Number(flags.get('--timeout') ?? 45) * 1000;

// ---------- download + unpack (cached under marketplace-cache/compat/) ----------
const cacheRoot = join(root, 'target/studio/marketplace-cache/compat');
mkdirSync(cacheRoot, { recursive: true });

/** A battery entry that is a local directory skips the registry entirely. */
const isLocalDir = (id) => id.startsWith('/') || id.startsWith('~');

async function fetchExtension(id) {
	if (isLocalDir(id)) return id.replace(/^~/, process.env.HOME ?? '~');
	const dir = join(cacheRoot, id.replaceAll('.', '_'));
	const marker = join(dir, 'unpacked');
	if (existsSync(marker)) return marker;
	mkdirSync(dir, { recursive: true });
	const [namespace, name] = id.split('.');
	const response = await fetch(`https://open-vsx.org/api/${namespace}/${name}`);
	const meta = await response.json();
	if (!response.ok || !meta.version) die(`Open VSX knows no ${id} (status ${response.status}, ${JSON.stringify(meta).slice(0, 120)})`);
	const url = meta.downloads?.universal
		?? meta.downloads?.[`${process.platform}-${process.arch}`]
		?? meta.files?.download;
	if (!url) die(`${id}: no universal or platform build`);
	say(`  downloading ${id} ${meta.version}`);
	const vsix = await fetch(url);
	if (!vsix.ok) die(`download failed ${vsix.status}: ${url}`);
	writeFileSync(join(dir, 'pkg.vsix'), Buffer.from(await vsix.arrayBuffer()));
	for (const tool of [['unzip', ['-q', join(dir, 'pkg.vsix'), '-d', dir]], ['bsdtar', ['-xf', join(dir, 'pkg.vsix'), '-C', dir]]]) {
		const run = spawnSync(tool[0], tool[1], { stdio: 'ignore' });
		if (run.status === 0) break;
	}
	const flat = existsSync(join(dir, 'extension', 'package.json')) ? join(dir, 'extension') : dir;
	if (!existsSync(join(flat, 'package.json'))) die(`${id}: unpacked without package.json`);
	writeFileSync(join(dir, 'version.txt'), meta.version);
	return flat;
}

// ---------- one activation ----------
async function activateOne(id, extensionDir) {
	const pkg = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));
	// Node's own `main` resolution — the same the host does at bootstrap: a VSIX `main`
	// is frequently extension-less (`./out/extension`).
	const rawEntry = resolve(extensionDir, pkg.main ?? 'extension.js');
	const entry = [rawEntry, ...['js', 'cjs', 'mjs', 'node'].map((e) => `${rawEntry}.${e}`), join(rawEntry, 'index.js')].find((candidate) => existsSync(candidate));
	if (!entry) return { id, verdict: 'no-entry', ms: 0, gaps: [], error: `no entry at ${pkg.main ?? 'extension.js'}` };

	const child = spawn(exe, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
	let buf = '';
	let requestId = 0;
	const pending = new Map();
	const gaps = [];
	let settled = false;

	const killTimer = setTimeout(() => {
		if (!settled) { child.kill('SIGKILL'); settled = true; finish({ id, verdict: 'hung', ms: timeoutMs, gaps, error: 'activation did not settle in time' }); }
	}, timeoutMs);

	let result;
	let finish;
	const done = new Promise((res) => { finish = res; });

	child.stdout.on('data', (chunk) => {
		buf += chunk.toString('utf8');
		let index;
		while ((index = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, index).trim();
			buf = buf.slice(index + 1);
			if (!line) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; }
			if (msg.method === 'ggs.hostRequest') {
				const inner = msg.params?.method ?? '';
				if (inner === 'log') {
					const [level, message] = msg.params?.args ?? [];
					if (typeof message === 'string') gaps.push({ level, message });
					child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
				} else if (inner === 'host.env') {
					child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { language: 'en', appVersion: 'compat-probe', themeKind: 'dark', settings: {}, state: { global: {}, workspace: {} }, workspaceFolders: [] } }) + '\n');
				} else {
					child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
				}
				continue;
			}
			if (msg.id !== undefined && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});
	child.on('exit', () => { if (!settled) { settled = true; finish({ id, verdict: 'crashed', ms: 0, gaps, error: 'the runtime exited during activation' }); } });

	function request(method, params) {
		const seq = ++requestId;
		return new Promise((res) => {
			pending.set(seq, res);
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: seq, method, params }) + '\n');
		});
	}

	const started = Date.now();
	try {
		const initReply = await request('initialize', { extensionPath: extensionDir, workspaceFolders: [] });
		// The first command orders behind the queued activation (FIFO): its answer IS the
		// settlement marker (the probe's made-up command answers "no handler" once the
		// package's own dispatcher is live).
		const cmdReply = await request('runCommand', { command: 'compat.probe.settle', args: [] });
		const reply = cmdReply.error ? String(cmdReply.error.message ?? '') : '';
		const ms = Date.now() - started;
		settled = true;
		clearTimeout(killTimer);
		if (/no handler registered for compat\.probe\.settle/.test(reply)) {
			result = { id, verdict: 'activated', ms, gaps, commands: initReply.result?.capabilities?.commands?.length ?? 0 };
		} else {
			result = { id, verdict: 'failed', ms, gaps, error: reply.split('\n')[0] };
		}
		child.stdin.end();
		child.kill('SIGKILL');
		finish(result);
	} catch (error) {
		settled = true;
		clearTimeout(killTimer);
		child.kill('SIGKILL');
		finish({ id, verdict: 'failed', ms: Date.now() - started, gaps, error: String(error).split('\n')[0] });
	}
	return done;
}

// ---------- the battery ----------
const results = [];
for (const id of battery) {
	say(`\n== ${id}`);
	try {
		const dir = await fetchExtension(id);
		results.push(await activateOne(id, dir));
	} catch (error) {
		results.push({ id, verdict: 'fetch-failed', ms: 0, gaps: [], error: String(error).split('\n')[0] });
	}
}

// ---------- the report ----------
say('\n================ verdicts ================');
for (const r of results) {
	const error = r.error ? ` — ${r.error}` : '';
	say(`${r.verdict.padEnd(8)} ${String(r.ms).padStart(6)} ms  ${r.id}${error}`);
}

const activated = results.filter((r) => r.verdict === 'activated').length;
say('');
say(`activation rate: ${activated}/${results.length}`);
say('');

// The gap ranking: which unsupported APIs does the battery actually reach for — the
// next fixes in src/vscodeApi.ts, highest frequency first.
const gapCount = new Map();
const gapExtensions = new Map();
for (const r of results) {
	for (const gap of r.gaps) {
		// vscodeApi's own messages name the member without the namespace prefix
		// ("unsupported API workspace.registerFileSystemProvider(...)").
		const match = /unsupported API ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/.exec(gap.message);
		if (!match) continue;
		const api = `vscode.${match[1]}`;
		gapCount.set(api, (gapCount.get(api) ?? 0) + 1);
		if (!gapExtensions.has(api)) gapExtensions.set(api, []);
		gapExtensions.get(api).push(r.id);
	}
}
if (gapCount.size > 0) {
	say('================ gaps by reach (extensions hitting each) ================');
	for (const [api, count] of [...gapCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
		say(`${String(count).padStart(2)}x  ${api}`);
		if (count <= 4) say(`      (${gapExtensions.get(api).join(', ')})`);
	}
	say('');
	say('--- raw gap lines:');
	for (const r of results) {
		for (const gap of r.gaps) {
			if (/unsupported API/.test(gap.message)) say(`${r.id}: [${gap.level}] ${gap.message.slice(0, 150)}`);
		}
	}
}

// Non-gap failures: the activation errors themselves (missing builtins, throws).
const failures = results.filter((r) => r.verdict !== 'activated');
if (failures.length > 0) {
	say('');
	say('================ non-activating, with reasons ================');
	for (const r of failures) say(`${r.id}: [${r.verdict}] ${r.error ?? ''}`);
}
process.exit(0);
