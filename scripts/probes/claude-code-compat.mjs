// The claude-code compatibility probe: run ANY version of the extension (an installed
// directory, a .vsix file, or a version number fetched from Open VSX) through a real
// ggs-node activation and report every compatibility gap it hits — before an upgrade
// ships to users, not after.
//
// What it answers:
//   - does the package activate at all on this host (its `activate` settling)?
//   - which `vscode` API members it reached for that this host does not serve (the
//     namespace probe names them in the extension host log — this probe collects them);
//   - does its `engines.vscode` floor exceed the version the shim claims?
//
// The gaps are advisories (the report names them), an activation failure is an error:
// the exit code is 0 only when the activation settled.
//
// Usage:
//   node scripts/probes/claude-code-compat.mjs [--exe <ggs-node>] \
//       [--dir <extension-dir> | --vsix <file> | --version x.y.z] [--keep]
//
// Without a source flag the newest installed ~/.ggs/extensions/Anthropic.claude-code-*
// is probed. `--version` downloads from Open VSX (the marketplace the app itself uses)
// into target/studio/marketplace-cache/compat/ and reuses a cached download.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg.startsWith('--')) flags.set(arg, process.argv[++i] ?? '');
	else console.error(`unexpected argument ${arg}`);
}
const say = (line) => console.log(line);
const die = (line) => { console.error(`[fatal] ${line}`); process.exit(2); };

// ---------- the ggs-node binary ----------
const root = resolve(import.meta.dirname, '..', '..');
const exe = flags.get('--exe') ?? join(root, 'target/studio/cargo/ggs-node/ggs-node');
if (!existsSync(exe)) die(`no ggs-node binary (looked at ${exe}) — build it or pass --exe`);

// ---------- the extension under test ----------
function newestInstalled() {
	const dir = join(process.env.HOME ?? '~', '.ggs/extensions');
	if (!existsSync(dir)) return null;
	const match = readdirSync(dir)
		.filter((name) => /^Anthropic\.claude-code-/.test(name))
		.sort()
		.at(-1);
	return match ? join(dir, match) : null;
}

async function fetchVersion(version) {
	const cacheDir = join(root, 'target/studio/marketplace-cache/compat');
	mkdirSync(cacheDir, { recursive: true });
	const cached = join(cacheDir, `claude-code-${version}.vsix`);
	if (existsSync(cached)) return cached;
	const meta = await (await fetch(`https://open-vsx.org/api/Anthropic/claude-code/${version}`)).json();
	const files = meta.files ?? {};
	// The platform build the probe runs on — the registry's bare `files.download` answers
	// an ARBITRARY target (alpine-arm64 here), and claude-code's VSIXes are per-platform:
	// the matching build first, the universal one only as a fallback.
	const url = meta.downloads?.[`${process.platform}-${process.arch}`]
		?? meta.downloads?.universal
		?? files.download
		?? Object.values(meta.downloads ?? {}).find(Boolean);
	if (!url) die(`Open VSX serves no download for ${version}`);
	say(`downloading ${url}`);
	const response = await fetch(url);
	if (!response.ok) die(`download failed: ${response.status} ${url}`);
	const size = Number(response.headers.get('content-length') ?? 0);
	if (size > 0) say(`  ${(size / 1e6).toFixed(1)} MB`);
	const blob = Buffer.from(await response.arrayBuffer());
	writeFileSync(cached, blob);
	return cached;
}

function unpackVsix(vsix) {
	const dir = mkdtempSync(join(tmpdir(), 'claude-compat-'));
	for (const tool of ['unzip', 'bsdtar', 'tar']) {
		const run = spawnSync(tool, ['-xf', vsix, '-C', dir], { stdio: 'inherit' });
		if (run.status !== 0) continue;
		// The VSIX layout carries the package under `extension/` (VS Code's own shape);
		// an already-flat archive works too.
		if (existsSync(join(dir, 'extension', 'package.json'))) return join(dir, 'extension');
		if (existsSync(join(dir, 'package.json'))) return dir;
		die('the VSIX unpacked without a package.json — not a claude-code package?');
	}
	rmSync(dir, { recursive: true, force: true });
	die(`no unzip/bsdtar/tar could unpack ${vsix}`);
}

let extensionDir = null;
if (flags.has('--dir')) extensionDir = flags.get('--dir');
else if (flags.has('--vsix')) extensionDir = unpackVsix(resolve(flags.get('--vsix')));
else if (flags.has('--version')) extensionDir = unpackVsix(await fetchVersion(flags.get('--version')));
else extensionDir = newestInstalled();
if (!extensionDir || !existsSync(extensionDir)) die('no claude-code installation found — pass --dir, --vsix or --version');
say(`extension: ${extensionDir}`);

const pkg = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));
const entry = resolve(extensionDir, pkg.main ?? 'extension.js');
if (!existsSync(entry)) die(`no entry at ${entry}`);

// ---------- the engines.vscode floor vs the shim's claimed version ----------
const shimSource = readFileSync(join(root, 'src/vscodeApi.ts'), 'utf8');
const claimed = /version:\s*'([0-9.]+)'/.exec(shimSource)?.[1];
const floor = pkg.engines?.vscode?.replace(/[^0-9.*]/g, '');
const versionOk = !floor || !claimed || floor === '*' || compareSemver(floor, claimed) <= 0;
say(`engines.vscode: ${floor ?? '(none)'} — the shim claims ${claimed}: ${versionOk ? 'ok' : 'BELOW THE FLOOR (the package may refuse to activate)'}`);

function compareSemver(a, b) {
	const pa = a.split('.').map((n) => Number.parseInt(n, 10));
	const pb = b.split('.').map((n) => Number.parseInt(n, 10));
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

// ---------- drive ggs-node over ggs-ext/1 ----------
const { spawn } = await import('node:child_process');
const child = spawn(exe, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
const t0 = Date.now();
let buf = '';
let id = 0;
const pending = new Map();
/** Every shim anomaly the namespace probe and the unsupported-API surface logged. */
const gaps = [];
let initializedAt = 0;
let settledAt = 0;

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
			if (inner === 'host.env') {
				const result = { language: 'en', appVersion: 'compat-probe', themeKind: 'dark', settings: {}, state: { global: {}, workspace: {} }, workspaceFolders: [] };
				child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
			} else if (inner === 'log') {
				const [level, message] = msg.params?.args ?? [];
				if (typeof message === 'string') gaps.push({ level, message });
				child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }) + '\n');
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

function request(method, params) {
	const requestId = ++id;
	return new Promise((res) => {
		pending.set(requestId, res);
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
	});
}

const initReply = await request('initialize', { extensionPath: extensionDir, workspaceFolders: [] });
initializedAt = Date.now();
if (initReply.error) die(`the handshake failed: ${JSON.stringify(initReply.error)}`);
const commands = initReply.result?.capabilities?.commands ?? [];

// The first command orders behind the queued activation (FIFO): its answer IS the
// activation's settlement.
const cmdReply = await request('runCommand', { command: 'compat.probe.settle', args: [] });
settledAt = Date.now();
// The settlement marker: the package's own dispatcher answering (a "no handler" for the
// probe's made-up command IS that answer — the activation queued ahead of it settled).
// Anything else (the command ran, or a different failure crossed) means the activation
// itself died.
const reply = cmdReply.error ? String(cmdReply.error.message ?? '') : '';
const activationError = /no handler registered for compat\.probe\.settle/.test(reply) ? null : (reply || null);
child.stdin.end();
await new Promise((res) => child.on('exit', res));

// ---------- the report ----------
say('');
say(`activation: ${activationError ? 'FAILED' : 'settled'} in ${settledAt - initializedAt} ms${activationError ? ` — ${activationError.split('\n')[0]}` : ''}`);
say(`commands the handshake reported: ${commands.length}`);
const unsupported = gaps.filter((g) => /unsupported API/.test(g.message));
const otherLogs = gaps.filter((g) => !/unsupported API/.test(g.message));
if (unsupported.length > 0) {
	say('');
	say('vscode API gaps this package version reached for:');
	for (const gap of unsupported) say(`  - [${gap.level}] ${gap.message}`);
} else {
	say('vscode API gaps: none — every member this version touched is served');
}
if (otherLogs.length > 0) {
	say('');
	say('other shim anomalies:');
	for (const gap of otherLogs.slice(0, 20)) say(`  - [${gap.level}] ${gap.message.slice(0, 160)}`);
}
if (extensionDir?.startsWith(tmpdir())) {
	if (flags.has('--keep')) say(`\n(--keep) the unpacked extension stays at ${extensionDir}`);
	else rmSync(extensionDir, { recursive: true, force: true });
}
say('');
process.exit(activationError ? 1 : 0);
