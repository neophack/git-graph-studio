// The Kimi Code live check: the moonshot-ai.kimi-code extension, installed into an
// isolated HOME and driven through the real app (tauri dev → the dev harness's kimi
// phase) — the package seen installed, its commands in the registry, its sidebar webview
// view mounted and timed. The pass is the "正常使用 + 打开速度快" bar, measured.
//
//   node scripts/probes/kimi-live-check.mjs [--timeout <s>] [--keep] [--version x.y.z]
//
// The extension downloads from Open VSX (this machine's platform build) into
// target/studio/marketplace-cache/compat/ and is installed into the sandbox HOME by
// unpacking it exactly where the app's own installer puts it. Nothing outside
// target/studio/kimi-sandbox/ is touched: the app's HOME points at the sandbox.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = args.indexOf(name);
	return at >= 0 ? (args[at + 1] ?? '') : fallback;
};
const keep = args.includes('--keep');
const timeoutS = Number(flag('--timeout', '180'));
const version = flag('--version', '');
const say = (line) => console.log(line);
const die = (line) => { console.error(`[fatal] ${line}`); process.exit(2); };

const appDir = resolve(import.meta.dirname, '..', '..');
const sandbox = join(appDir, 'target/studio/kimi-sandbox');
const home = join(sandbox, 'home');
const workspace = join(sandbox, 'workspace');
const reportFile = join(sandbox, 'kimi-report.json');
const tauriLog = join(sandbox, 'tauri-dev.log');
const KIMI = 'moonshot-ai.kimi-code';

rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(home, '.ggs/extensions'), { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(join(workspace, 'src'), { recursive: true });
writeFileSync(join(workspace, 'src', 'main.py'), 'print("kimi sandbox workspace")\n');
writeFileSync(join(workspace, 'README.md'), '# kimi sandbox\n');

// ---------- fetch + install (the installer's own layout) ----------
const cacheDir = join(appDir, 'target/studio/marketplace-cache/compat');
mkdirSync(cacheDir, { recursive: true });
const [namespace, name] = KIMI.split('.');
const meta = await (await fetch(`https://open-vsx.org/api/${namespace}/${name}${version ? `/${version}` : ''}`)).json();
if (!meta.version) die(`Open VSX knows no ${KIMI}`);
const url = meta.downloads?.[`${process.platform}-${process.arch}`]
	?? meta.downloads?.universal
	?? meta.files?.download;
if (!url) die(`no platform build for ${KIMI}`);
const vsixPath = join(cacheDir, `${KIMI}-${meta.version}.vsix`);
if (!existsSync(vsixPath)) {
	say(`downloading ${KIMI} ${meta.version} (${url.split('/file/')[1] ?? url})`);
	const response = await fetch(url);
	if (!response.ok) die(`download failed: ${response.status}`);
	writeFileSync(vsixPath, Buffer.from(await response.arrayBuffer()));
}
const installDir = join(home, '.ggs/extensions', `${KIMI}-${meta.version}`);
mkdirSync(installDir, { recursive: true });
for (const tool of [['unzip', ['-q', vsixPath, '-d', installDir]], ['bsdtar', ['-xf', vsixPath, '-C', installDir]]]) {
	const run = spawnSync(tool[0], tool[1], { stdio: 'ignore' });
	if (run.status === 0) break;
}
const flat = existsSync(join(installDir, 'extension', 'package.json')) ? join(installDir, 'extension') : installDir;
if (!existsSync(join(flat, 'package.json'))) die('the VSIX unpacked without a package.json');
if (flat !== installDir) {
	spawnSync('mv', [flat, `${installDir}-moving`]);
	rmSync(installDir, { recursive: true, force: true });
	spawnSync('mv', [`${installDir}-moving`, installDir]);
}
// The installer writes the runtime manifest beside the package; a main whose entry is
// past the frame host's code-map ceiling derives the ggs-node backend (the sidecar
// reads its files straight from the install directory — no code map, no 8 MB cap).
const pkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'));
const mainBytes = existsSync(join(installDir, pkg.main.replace(/^\.\//, '')))
	? Number(spawnSync('stat', ['-f', '%z', join(installDir, pkg.main.replace(/^\.\//, ''))]).stdout.toString().trim())
	: 0;
if (mainBytes > 8 * 1024 * 1024) {
	writeFileSync(
		join(installDir, 'manifest.json'),
		JSON.stringify({ id: KIMI, version: meta.version, backend: { kind: 'node', command: pkg.main, args: [], protocol: null, binaries: null } })
	);
	say(`backend: ggs-node (the main is ${(mainBytes / 1e6).toFixed(1)} MB — past the frame host's code map)`);
}
say(`installed: ${installDir.replace(home, '~')}`);

// ---------- the app, under tauri dev, into the harness's kimi phase ----------
const runId = `kimi-${Date.now()}`;
const harnessPage = `dev/dev-harness.html?full=1&quick=1&kimi=1&run=${runId}&reportFile=${encodeURIComponent(reportFile)}&workspace=${encodeURIComponent(workspace)}`;
const appEnv = {
	...process.env,
	HOME: home,
	// cargo and npm caches must not follow HOME into the sandbox (a fresh HOME would
	// otherwise re-download the world): the caches stay where the developer's are.
	CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
	// rustup's toolchains live under the real HOME too — a fresh HOME would leave
	// rustup with no default toolchain and cargo would refuse to run at all.
	RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
	DISABLE_TELEMETRY: '1',
	GGS_DEV_HARNESS: harnessPage,
	GGS_DEV_HARNESS_DIAG: join(sandbox, 'harness-diag.json')
};
const tauriArgs = ['tauri', 'dev', '--no-watch', '--', '--', workspace];
say(`[app] npx ${tauriArgs.join(' ')} (HOME=${home.replace(appDir, '…')})`);
const caffeinate = spawn('caffeinate', ['-d', '-i'], { stdio: 'ignore' });
const app = spawn('npx', tauriArgs, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], env: appEnv, detached: true });
const stopApp = async () => {
	if (app.exitCode === null) {
		app.kill('SIGINT');
		await new Promise((r) => setTimeout(r, 4000));
	}
	try { process.kill(-app.pid, 'SIGKILL'); } catch {}
	caffeinate.kill();
};
app.stdout.on('data', (chunk) => appendFileSync(tauriLog, chunk));
app.stderr.on('data', (chunk) => appendFileSync(tauriLog, chunk));

// ---------- poll the report ----------
const started = Date.now();
let report = null;
while (Date.now() - started < timeoutS * 1000) {
	await new Promise((r) => setTimeout(r, 3000));
	if (existsSync(reportFile)) {
		try {
			const parsed = JSON.parse(readFileSync(reportFile, 'utf8'));
			if (!parsed.partial) { report = parsed; break; }
		} catch { /* a racing partial write; the next tick reads it whole */ }
	}
	if (app.exitCode !== null) die(`the app exited early (exit ${app.exitCode}) — see ${tauriLog}`);
}
await stopApp();
if (!report) die(`no final report within ${timeoutS}s — see ${tauriLog}`);

// ---------- the verdict ----------
const kimiRows = report.report.filter((row) => row.group === 'kimi-code');
say('');
for (const row of kimiRows) {
	say(`${row.status === 'pass' ? '✓' : '✗'} [${row.ms} ms] ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
const failed = kimiRows.filter((row) => row.status !== 'pass');
say('');
say(`kimi-code: ${kimiRows.length - failed.length}/${kimiRows.length} checks passed${report.failed ? `, ${report.failed} failing elsewhere in the pass` : ', nothing else failing'}`);
if (!keep) rmSync(reportFile, { force: true });
else say(`report kept at ${reportFile}`);
process.exit(failed.length > 0 ? 1 : 0);
