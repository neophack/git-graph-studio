// The claude-code sandbox: the logged-in Claude Code test this machine can run without an
// account, without the network, and — the point — without touching the owner's claude
// (fake-claude-server.mjs answers every model call on the loopback, the "login" is a fake
// API key, and CLAUDE_CONFIG_DIR relocates all of Claude Code's state into a throwaway
// directory under target/, so ~/.claude, ~/.claude.json and the macOS keychain entry are
// never read or written).
//
// What it does, in order:
//   1. builds the sandbox — target/studio/claude-sandbox/{claude-config,workspace}: the
//      config dir carries settings.json whose env map pins ANTHROPIC_BASE_URL at the fake
//      server (double-sealed: the app's env carries it too, and env inheritance carries it
//      into ggs-node and the extension's bundled claude CLI), and a .claude.json that has
//      onboarding done and the workspace folder trusted, so the chat opens ready;
//   2. pre-flight: runs the installed extension's own bundled CLI once (`-p`) against the
//      fake server — the fake login proven, and the CLI round-trip timed, before the app;
//   3. launches the app under `npx tauri dev` with the devUrl pointed straight at the dev
//      harness full pass (macOS WKWebView has no CDP — the harness runs inside the app and
//      posts its report back to the fake server, which this probe polls);
//   4. while the pass runs, samples the process tree's memory (the app, every ggs-node
//      backend, every claude the extension spawned) every few seconds;
//   5. writes target/studio/claude-sandbox-report.md (+ .json): the UI timings the harness
//      measured (chat open / warm reopen / new-session page / a real conversation send→reply,
//      all against the fake server), the memory table, and the request log summary.
//
//   node scripts/probes/claude-code-sandbox.mjs [--keep] [--no-harness] [--timeout <s>]
//     [--server-port <n>] [--cli-only]
//
//   --keep         leave the app open after the pass for interactive testing — chat with
//                  the fake account, click around; every reply is local and free
//   --no-harness   open the plain workbench instead of the harness (interactive-only mode)
//   --cli-only     stop after the pre-flight CLI round-trip (no app launched)
//
// Darwin/Linux only (ps/pkill; Windows' packaged pass is claude-code-live-check.mjs).

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.indexOf(name) === -1 ? fallback : args[args.indexOf(name) + 1]);
const keep = args.includes('--keep');
const noHarness = args.includes('--no-harness');
const cliOnly = args.includes('--cli-only');
const timeoutSec = Number(flag('--timeout', '600'));
const serverPort = Number(flag('--server-port', '0'));

const sandboxDir = join(appDir, 'target', 'studio', 'claude-sandbox');
const claudeConfigDir = join(sandboxDir, 'claude-config');
const workspaceDir = join(sandboxDir, 'workspace');
const remoteDir = join(sandboxDir, 'remote');
const serverLog = join(sandboxDir, 'fake-server.jsonl');
const daemonLog = join(sandboxDir, 'git-daemon.log');
const tauriLog = join(sandboxDir, 'tauri-dev.log');
const reportMd = join(appDir, 'target', 'studio', 'claude-sandbox-report.md');
const reportJson = join(appDir, 'target', 'studio', 'claude-sandbox-report.json');
const EXT_GLOB = 'Anthropic.claude-code-';
const FAKE_KEY = 'fake-sandbox-key';
const MARKER = 'FAKE-CLAUDE';

mkdirSync(join(appDir, 'target', 'studio'), { recursive: true });
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- 1. the sandbox: a claude config dir that is logged in to the fake server ---------- */
const installedExtDir = () => {
	const store = join(homedir(), '.ggs', 'extensions');
	if (!existsSync(store)) return null;
	const mine = readdirSync(store).filter((name) => name.startsWith(EXT_GLOB)).sort().pop();
	return mine ? join(store, mine) : null;
};
const extDir = installedExtDir();
const extCli = extDir ? join(extDir, 'resources', 'native-binary', 'claude') : null;

/* ---------- the fake git remote: a bare repository git-graph-rs can fetch from ---------- */
// A seeded bare repo served by `git daemon` on the loopback (real git:// protocol, fetch and
// push both enabled) — git-graph-rs's remote branches, tracking state and fetch command get a
// remote that costs nothing and touches nothing of the owner's. If the daemon cannot serve,
// the bare repo's plain path is the fallback origin URL; either way the clone is real.
const remote = { daemon: null, url: null, seededHead: null, refCount: 0 };

/** One sandbox git call — repo-local identity only, never the developer's global config. */
const sandboxGit = (cwd, gitArgs, extraEnv = {}) => spawnSync('git',
	['-c', 'user.name=GGS Sandbox', '-c', 'user.email=ggs-sandbox@example.com', ...gitArgs],
	{ cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });

const seedRemoteHistory = (scratch) => {
	/** A commit on the given date, so the graph layout reads left-to-right like a real project. */
	const commit = (message, date, files) => {
		for (const [name, body] of Object.entries(files)) {
			mkdirSync(join(scratch, dirname(name)), { recursive: true });
			writeFileSync(join(scratch, name), body);
		}
		sandboxGit(scratch, ['add', '-A']);
		const when = `${date}T12:00:00`;
		sandboxGit(scratch, ['commit', '-qm', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
	};
	mkdirSync(scratch, { recursive: true });
	sandboxGit(scratch, ['init', '-q', '-b', 'main', '.']);
	commit('readme: the sandbox project', '2026-01-05', { 'README.md': '# sandbox project\n\nA fake project over a fake remote (scripts/probes/claude-code-sandbox.mjs).\n' });
	commit('feat(a): the first module', '2026-01-08', { 'src/a.ts': 'export const a = () => 1;\n' });
	commit('feat(b): the second module', '2026-01-11', { 'src/b.ts': 'export const b = () => 2;\n' });
	sandboxGit(scratch, ['checkout', '-qb', 'feature/login', 'main~1']);
	commit('feat(login): the login branch', '2026-01-14', { 'src/login.ts': 'export const login = () => true;\n' });
	sandboxGit(scratch, ['checkout', '-q', 'main']);
	commit('fix(a): a fix on main', '2026-01-17', { 'src/a.ts': 'export const a = () => 11;\n' });
	// The merge commit — the graph's shape git-graph-rs exists to draw.
	sandboxGit(scratch, ['merge', '-q', '--no-ff', '-m', 'Merge branch \'feature/login\' into main', 'feature/login']);
	sandboxGit(scratch, ['tag', 'v1.0']);
	// A branch that stays remote-only in the workspace (no local counterpart after the clone).
	sandboxGit(scratch, ['checkout', '-qb', 'feature/api', 'main~1']);
	commit('feat(api): the api branch, never merged', '2026-01-20', { 'src/api.ts': 'export const api = () => 3;\n' });
	commit('chore(api): ignore build output', '2026-01-23', { '.gitignore': 'node_modules/\n' });
	sandboxGit(scratch, ['checkout', '-q', 'main']);
	sandboxGit(scratch, ['tag', '-a', 'v1.1', '-m', 'the sandbox release']);
};

const buildRemote = async () => {
	rmSync(remoteDir, { recursive: true, force: true });
	mkdirSync(remoteDir, { recursive: true });
	const scratch = join(remoteDir, 'seed');
	const bare = join(remoteDir, 'origin.git');
	seedRemoteHistory(scratch);
	sandboxGit(scratch, ['clone', '-q', '--bare', '.', bare]);
	sandboxGit(scratch, ['push', '-q', bare, 'main', 'feature/login', 'feature/api']);
	// The daemon: try a few loopback ports; the first whose URL answers ls-remote wins, and a
	// daemon that never serves falls back to the bare repo's path (a path remote is still a
	// real remote to git — every fetch/push below works identically).
	for (let attempt = 0; attempt < 5 && !remote.url; attempt++) {
		const port = 20000 + Math.floor(Math.random() * 20000);
		const daemon = spawn('git', ['daemon', '--export-all', '--enable=receive-pack', '--informative-errors',
			'--reuseaddr', '--base-path=' + remoteDir, '--port=' + port, '--verbose'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
		daemon.stderr.on('data', (chunk) => appendFileSync(daemonLog, chunk));
		const url = `git://127.0.0.1:${port}/origin.git`;
		for (let probe = 0; probe < 8 && daemon.exitCode === null; probe++) {
			await sleep(250);
			if (spawnSync('git', ['ls-remote', url], { encoding: 'utf8', timeout: 3000 }).status === 0) {
				remote.daemon = daemon;
				remote.url = url;
				break;
			}
		}
		if (!remote.url) daemon.kill();
	}
	if (!remote.url) remote.url = bare;
	remote.refCount = spawnSync('git', ['ls-remote', remote.url], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.trim()).length;
	return { scratch, bare };
};

const buildSandbox = async () => {
	rmSync(claudeConfigDir, { recursive: true, force: true });
	rmSync(workspaceDir, { recursive: true, force: true });
	mkdirSync(claudeConfigDir, { recursive: true });
	const { scratch } = await buildRemote();
	// The workspace: a real clone of the fake remote — the app opens it, git-graph-rs draws
	// its history, and Source Control's tracking state has a remote to track.
	if (spawnSync('git', ['clone', '-q', remote.url, workspaceDir], { encoding: 'utf8' }).status !== 0) {
		throw new Error('cloning the fake remote into the workspace failed');
	}
	// The divergence the graph view is about: one local commit ahead (unpushed), then two
	// commits pushed to the remote from the seed side (the clone stays behind them).
	sandboxGit(workspaceDir, ['commit', '-q', '--allow-empty', '-m', 'wip: a local commit ahead of the fake remote']);
	sandboxGit(scratch, ['checkout', '-q', 'main']);
	sandboxGit(scratch, ['commit', '-q', '--allow-empty', '-m', 'remote: the fake remote moves ahead (1/2)']);
	sandboxGit(scratch, ['commit', '-q', '--allow-empty', '-m', 'remote: the fake remote moves ahead (2/2)']);
	sandboxGit(scratch, ['push', '-q', remote.url, 'main']);
	remote.seededHead = sandboxGit(scratch, ['rev-parse', 'main']).stdout.trim();
	// The fake login, sealed twice: the settings env map applies inside every claude session
	// (even one spawned without our inherited env), and the process env carries it everywhere.
	// AUTH_TOKEN is the load-bearing half: the extension spawns its sessions with
	// CLAUDE_CODE_ENTRYPOINT=claude-vscode, and an IDE-entrypoint session accepts a gateway
	// token (ANTHROPIC_AUTH_TOKEN) as its login but not a bare API key — the API-key-only
	// shape left every in-app session answering "Not logged in · Please run /login" and the
	// chat stuck on the login-choice wizard (the extension's 2.1.285 behaviour; the same
	// reason the provider bridge writes both vars into Claude's settings).
	writeFileSync(join(claudeConfigDir, 'settings.json'), JSON.stringify({
		env: {
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
			ANTHROPIC_AUTH_TOKEN: FAKE_KEY,
			ANTHROPIC_API_KEY: FAKE_KEY,
			DISABLE_TELEMETRY: '1',
			DISABLE_ERROR_REPORTING: '1',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
		}
	}, null, '\t') + '\n');
	// Onboarding done, this workspace trusted, no first-run gates inside the chat.
	writeFileSync(join(claudeConfigDir, '.claude.json'), JSON.stringify({
		hasCompletedOnboarding: true,
		theme: 'dark',
		projects: { [resolve(workspaceDir)]: { hasTrustDialogAccepted: true, allowedTools: [] } }
	}, null, '\t') + '\n');
};

/** Whether the workspace's origin/main reached the seeded head — the proof a fetch through
 * the plugin actually crossed the fake remote (the clone predates those two commits). */
const fetchMovedOrigin = () => {
	const head = spawnSync('git', ['-C', workspaceDir, 'rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).stdout.trim();
	return remote.seededHead && head === remote.seededHead;
};

/* ---------- the fake server ---------- */
const server = { child: null, port: serverPort };
let appRef = null; // the app's process-group leader, for the exit handler's teardown
const startServer = async () => {
	server.child = spawn(process.execPath, [join(appDir, 'scripts', 'probes', 'fake-claude-server.mjs'),
		'--port', String(serverPort), '--log', serverLog, '--marker', MARKER], { stdio: ['ignore', 'pipe', 'pipe'] });
	let bound = null;
	server.child.stdout.on('data', (chunk) => { const m = String(chunk).match(/listening (\d+)/); if (m) bound = Number(m[1]); });
	server.child.stderr.on('data', (chunk) => appendFileSync(tauriLog, '[fake-server] ' + chunk));
	for (let i = 0; i < 50 && !bound; i++) await sleep(100);
	if (!bound) throw new Error('the fake Claude server never bound');
	server.port = bound;
	log(`[server] the fake Claude server listens on 127.0.0.1:${bound} (log: ${serverLog})`);
	return bound;
};
const serverGet = async (path) => (await fetch(`http://127.0.0.1:${server.port}${path}`)).json();

/* ---------- 2. pre-flight: the bundled CLI against the fake server, logged in as the fake key ---------- */
const preflight = () => {
	if (!extCli || !existsSync(extCli)) {
		log(`[preflight] skipped — no installed claude-code extension CLI (${extCli ?? 'no extension dir'})`);
		return null;
	}
	const started = Date.now();
	const ran = spawnSync(extCli, ['-p', 'sandbox preflight ping', '--output-format', 'text'], {
	 encoding: 'utf8',
		timeout: 120000,
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
			ANTHROPIC_AUTH_TOKEN: FAKE_KEY,
			ANTHROPIC_API_KEY: FAKE_KEY,
			DISABLE_TELEMETRY: '1',
			DISABLE_ERROR_REPORTING: '1',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
		}
	});
	const ms = Date.now() - started;
	const out = (ran.stdout || '') + (ran.stderr || '');
	const ok = ran.status === 0 && out.includes(MARKER);
	log(`[preflight] the bundled CLI round-tripped the fake server in ${ms} ms — ${ok ? out.split('\n')[0].slice(0, 90) : 'FAILED: ' + out.slice(0, 300).replace(/\n/g, ' ')}`);
	// The fake git remote answers too (git-graph-rs's fetch target): plain ls-remote, plus the
	// state the plugin's fetch will resolve — the remote holds commits the clone has not
	// fetched (its stored origin/main ref still points below the seeded head).
	const refs = spawnSync('git', ['ls-remote', remote.url], { encoding: 'utf8' });
	const remoteOk = refs.status === 0 && refs.stdout.trim().length > 0;
	const storedOriginMain = spawnSync('git', ['-C', workspaceDir, 'rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).stdout.trim();
	const fetchPending = remoteOk && storedOriginMain !== remote.seededHead;
	log(`[preflight] the fake git remote answers ls-remote (${remoteOk ? remote.refCount + ' refs' : 'FAILED'}) at ${remote.url} — ${fetchPending ? 'the clone has not fetched the remote\'s newest commits (the plugin fetch will)' : 'the clone is current'}`);
	return { ok, ms, extDir, remoteOk, remoteUrl: remote.url, fetchPending };
};

/* ---------- 3. the app, under tauri dev, opening straight into the harness ---------- */
/** One memory sample: the run's own processes by path (a tree walk breaks the moment an
 * intermediate npx/npm process exits, and averages then lie). The debug-build paths under
 * target/studio/cargo name exactly this run's processes; the installed release apps (under
 * /Volumes or /Applications) never match. */
const bucketOf = (command) => {
	if (/target\/studio\/cargo\/(debug|release)\/(git-graph-studio|ggs)(\s|$)/.test(command)) return 'app (git-graph-studio)';
	if (/target\/studio\/cargo\/(debug|release)\/ggs-node(\s|$)/.test(command)) return 'ggs-node backends';
	if (/extensions\/Anthropic\.claude-code.*native-binary\/claude(\s|$)/.test(command)) return 'claude CLI children';
	return null; // the dev toolchain (vite/cargo/npx) and everything else on the machine
};
const samples = [];
const sampleMemory = () => {
	const buckets = new Map();
	for (const line of spawnSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const space = trimmed.indexOf(' ');
		const rssKb = Number(trimmed.slice(0, space));
		const command = trimmed.slice(space + 1);
		const bucket = bucketOf(command);
		if (bucket && Number.isFinite(rssKb)) buckets.set(bucket, (buckets.get(bucket) ?? 0) + rssKb);
	}
	if (buckets.size) samples.push({ t: Date.now(), buckets: Object.fromEntries(buckets) });
};

/* ---------- report ---------- */
const writeReport = (preflightOut, harnessReport) => {
	// The git-graph-rs fetch verdict: the workspace's origin/main reaching the seeded head is
	// the proof the plugin's fetch crossed the fake remote (the clone predates those commits).
	const fetchState = remote.seededHead
		? (fetchMovedOrigin() ? 'verified — origin/main reached the seeded head through the plugin' : 'not verified (no fetch ran, or it did not move origin/main)')
		: 'no remote was built';
	const bucketStats = () => {
		const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.buckets)))];
		return names.map((name) => {
			// Only the samples where the process existed count: zero-filling the stretch
			// before it spawned (the app builds for minutes) dragged averages to nonsense
			// ("app avg 2 MB, peak 90 MB").
			const series = samples.map((sample) => sample.buckets[name]).filter((kb) => Number.isFinite(kb) && kb > 0);
			if (!series.length) return { name, samples: 0, avgMb: 0, peakMb: 0, finalMb: 0 };
			return { name, samples: series.length, avgMb: Math.round(series.reduce((a, b) => a + b, 0) / series.length / 1024),
				peakMb: Math.round(Math.max(...series) / 1024), finalMb: Math.round(series[series.length - 1] / 1024) };
		});
	};
	const requestSummary = (() => {
		if (!existsSync(serverLog)) return [];
		const counts = new Map();
		for (const line of readFileSync(serverLog, 'utf8').split('\n').filter(Boolean)) {
			try {
				const entry = JSON.parse(line);
				const key = `${entry.status} ${entry.method} ${entry.path}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			} catch { /* a torn tail line from the live writer */ }
		}
		return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
	})();
	const rows = harnessReport?.report ?? [];
	const interesting = rows.filter((row) => ['Anthropic.claude-code', 'neophack.git-graph-rs', 'speed'].includes(row.group));
	const verdict = (harnessReport ? (harnessReport.failed === 0 ? 'ALL PASS' : `${harnessReport.failed} FAILING`) : 'no harness report')
		+ (preflightOut?.ok === false ? ' + pre-flight FAILED' : '');
	const md = [
		`# claude-code sandbox run — ${new Date().toISOString()}`,
		'',
		`- fake login: API key \`${FAKE_KEY}\` against the local fake Claude server (127.0.0.1:${server.port})`,
		`- claude state: \`${claudeConfigDir}\` (CLAUDE_CONFIG_DIR — ~/.claude and the keychain untouched)`,
		`- workspace: \`${workspaceDir}\``,
		`- fake git remote: \`${remote.url ?? 'not built'}\` — ${remote.refCount} refs (main + feature/login merged, feature/api remote-only, tags v1.0/v1.1), clone 1 ahead / 2 behind`,
		preflightOut ? `- pre-flight: the bundled CLI round-tripped the fake server in ${preflightOut.ms} ms (${preflightOut.ok ? 'ok' : 'FAILED'}); the git remote ${preflightOut.remoteOk ? 'answers ls-remote' : 'FAILED ls-remote'}` : '- pre-flight: skipped (no installed claude-code extension)',
		`- fetch through git-graph-rs: **${fetchState}**`,
		`- verdict: **${verdict}**`,
		'',
		'## The measured rows — claude-code against the fake server, git-graph-rs against the fake remote (the full harness report is in the .json beside this file)',
		'',
		...(interesting.length ? [
			'| status | check | ms | detail |', '| --- | --- | --- | --- |',
			...interesting.map((row) => `| ${row.status.toUpperCase()} | ${row.group} — ${row.name} | ${row.ms ?? ''} | ${(row.detail ?? '').replace(/\|/g, '\\|')} |`)
		] : ['(the harness posted no rows — see the run log)']),
		'',
		'## Memory (RSS of the app process tree, toolchain excluded)',
		'',
		...(samples.length ? [
			'| process bucket | avg MB | peak MB | final MB | samples |', '| --- | --- | --- | --- | --- |',
			...bucketStats().map((stat) => `| ${stat.name} | ${stat.avgMb} | ${stat.peakMb} | ${stat.finalMb} | ${stat.samples} |`)
		] : ['(no samples — the pass ended before the first one)']),
		'',
		'## What the fake Claude server was asked',
		'',
		...(requestSummary.length ? requestSummary.map((entry) => `- ${entry.count}× ${entry.key}`) : ['(nothing asked — the conversation never crossed the fake server)'])
	].join('\n') + '\n';
	writeFileSync(reportMd, md);
	writeFileSync(reportJson, JSON.stringify({ startedAt: new Date().toISOString(), sandbox: { claudeConfigDir, workspaceDir, fakeServer: `127.0.0.1:${server.port}`, fakeKey: FAKE_KEY,
			gitRemote: { url: remote.url, refs: remote.refCount, seededHead: remote.seededHead }, fetchVerified: remote.seededHead ? fetchMovedOrigin() : null },
		preflight: preflightOut, harness: harnessReport, memorySamples: samples, memoryStats: bucketStats(), requests: requestSummary }, null, '\t'));
	log(`[report] ${reportMd}`);
};

/* ---------- the run ---------- */
const run = async () => {
	rmSync(serverLog, { force: true });
	await startServer();
	await buildSandbox();
	log(`[sandbox] claude config: ${claudeConfigDir}`);
	log(`[sandbox] workspace:     ${workspaceDir}`);

	const preflightOut = preflight();
	if (cliOnly) { writeReport(preflightOut, null); return preflightOut?.ok === false ? 1 : 0; }
	if (preflightOut && !preflightOut.ok) { log('[fatal] the fake login does not work standalone — not launching the app'); writeReport(preflightOut, null); return 1; }

	const devPort = 5173;
	if (!noHarness && spawnSync('lsof', ['-nP', '-iTCP:' + devPort, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim()) {
		log(`[fatal] port ${devPort} already has a listener — another vite/tauri dev run is up; stop it or pass --no-harness`);
		return 1;
	}
	const runId = String(Date.now());
	const harnessReportFile = join(sandboxDir, 'harness-report.json');
	rmSync(harnessReportFile, { force: true });
	// quick=1: the claude-code and speed phases without the module self-test sweep (the
	// sweep's live-command scan freezes under the real backend at the moment — the module-17
	// WIP — and it is not what the sandbox measures). --full-sweep opts back in.
	const sweep = args.includes('--full-sweep') ? '' : '&quick=1';
	const harnessPage = `dev/dev-harness.html?full=1&sandbox=1${sweep}&run=${runId}&reportFile=${encodeURIComponent(harnessReportFile)}&heartbeat=${encodeURIComponent(join(sandboxDir, 'harness-heartbeat.txt'))}&report=${encodeURIComponent(`http://127.0.0.1:${server.port}/report`)}&workspace=${encodeURIComponent(workspaceDir)}`;

	const appEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: claudeConfigDir,
		ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
		ANTHROPIC_AUTH_TOKEN: FAKE_KEY,
		ANTHROPIC_API_KEY: FAKE_KEY,
		DISABLE_TELEMETRY: '1',
		DISABLE_ERROR_REPORTING: '1',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		// lib.rs's dev-only probe hook navigates the window to the harness page at first load
		// (a --config windows[0].url override proved unreachable: the window is built from the
		// base config and always opened index.html), and dumps a page diagnostic on the second
		// load — the only window into a WKWebView with no CDP.
		...(noHarness ? {} : {
			GGS_DEV_HARNESS: harnessPage,
			GGS_DEV_HARNESS_DIAG: `${join(sandboxDir, 'harness-diag.json')}|http://127.0.0.1:${server.port}/diag`
		})
	};
	// Two `--`: the tauri CLI's runner args come first, the app's after the second —
	// one `--` fed the workspace to cargo as its package path and the app booted with
	// no folder (the binary's own launch_path_of never saw it).
	const tauriArgs = ['tauri', 'dev', '--no-watch', '--', '--', workspaceDir];
	log(`[app] npx ${tauriArgs.join(' ')}${noHarness ? ' (plain workbench — interactive mode)' : ''} — log: ${tauriLog}`);
	// The harness's waits are page timers; macOS must not nap the display mid-run (the app
	// side also asserts an activity and floats its window — lib.rs's probe hook).
	const caffeinate = spawn('caffeinate', ['-d', '-i'], { stdio: 'ignore' });
	// detached: the run's whole tree (npx → tauri → vite/cargo → the app → backends) becomes
	// one process group, which stopApp kills with one signal — no name-based sweeps that
	// could reach into another run.
	const app = spawn('npx', tauriArgs, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], env: appEnv, detached: true });
	appRef = app;
	app.stdout.on('data', (chunk) => appendFileSync(tauriLog, chunk));
	app.stderr.on('data', (chunk) => appendFileSync(tauriLog, chunk));

	const stopApp = async () => {
		if (app.exitCode === null) {
			app.kill('SIGINT'); // tauri dev forwards to the app, which stops its backends
			await sleep(4000);
		}
		// Kill this run's whole process GROUP (the app spawned detached: npx → tauri → vite/
		// cargo → the app → its backends are all one group). Never sweep by name: a global
		// pkill pattern once murdered a LATER run's vite tree mid-pass when an earlier,
		// timed-out probe got around to its cleanup — the mystery stalls were exactly that.
		try { process.kill(-app.pid, 'SIGTERM'); } catch { /* group already gone */ }
		await sleep(1500);
		try { process.kill(-app.pid, 'SIGKILL'); } catch { /* group already gone */ }
	};
	// One exit path: the report is (re)written, the tree and the server die unless --keep.
	let preflightRef = preflightOut;
	let harnessRef = null;
	const finish = async (code) => {
		writeReport(preflightRef, harnessRef);
		if (!keep) { await stopApp(); server.child?.kill(); caffeinate.kill(); }
		else log('[keep] the app and the fake server stay up — Ctrl-C this probe when done');
		return code;
	};

	if (noHarness) {
		log(`[interactive] the app is up with the fake login (config ${claudeConfigDir}). Chat freely — every reply is served by 127.0.0.1:${server.port}.`);
		log(`[interactive] git-graph-rs's remote is the fake origin ${remote.url} — fetch and push land there, never anywhere real.`);
		log('[interactive] memory samples land in the report each minute; Ctrl-C here when done.');
		process.on('SIGINT', () => { log('\n[interactive] writing the final report…'); finish(0).then((code) => process.exit(code)); });
		// Interactive runs have no report to wait for: without an explicit --timeout they stay
		// up until Ctrl-C (a default timeout would kill the fake remote mid-testing).
		const startedInteractive = Date.now();
		const bounded = args.includes('--timeout');
		while (!bounded || Date.now() - startedInteractive < timeoutSec * 1000) {
			await sleep(3000);
			try { sampleMemory(); } catch { /* a ps hiccup skips a sample */ }
			if (samples.length % 20 === 0 && samples.length) writeReport(preflightRef, harnessRef);
		}
		return finish(0);
	}

	let harnessReport = null;
	const deadline = Date.now() + timeoutSec * 1000;
	let lastRowCount = -1;
	let lastMessageCount = 0;
	let diagShown = false;
	let fetchSeen = false;
	let heartbeatAge = -1;
	while (Date.now() < deadline) {
		await sleep(3000);
		if (app.exitCode !== null) { log('[fatal] tauri dev exited early — tail of its log:'); for (const line of readFileSync(tauriLog, 'utf8').split('\n').slice(-12)) log('  ' + line); break; }
		try { sampleMemory(); } catch { /* a ps hiccup skips a sample */ }
		if (!diagShown && existsSync(join(sandboxDir, 'harness-diag.json'))) {
			diagShown = true;
			log('[diag] ' + readFileSync(join(sandboxDir, 'harness-diag.json'), 'utf8').slice(0, 1200));
		}
		// The page's pulse: the native hook writes a timestamp every 3 s through the IPC
		// bridge. Fresh → the page's JS runs (a stalled pass is harness logic); stale → the
		// page or the bridge is dead at the WebKit level, and no harness fix applies.
		if (existsSync(join(sandboxDir, 'harness-heartbeat.txt'))) {
			const age = Math.round((Date.now() - statSync(join(sandboxDir, 'harness-heartbeat.txt')).mtimeMs) / 1000);
			if (heartbeatAge === -1) log('[heartbeat] the page pulse is live');
			if (age > 15 && heartbeatAge <= 15) log(`[heartbeat] the page pulse went STALE (${age} s old) — the webview stopped executing JS`);
			if (age <= 15 && heartbeatAge > 15) log('[heartbeat] the page pulse recovered');
			heartbeatAge = age;
		}
		try {
			// The harness streams its rows into the report file over Tauri IPC (write_file) —
			// the page-boot beacon lands there before the pass even starts.
			if (existsSync(harnessReportFile)) {
				const current = JSON.parse(readFileSync(harnessReportFile, 'utf8'));
				if (current && current.probe === 'dev-harness') {
					if (current.beacon && lastRowCount === -1) log('[harness] the harness page booted (beacon)');
					const rowsNow = (current.report ?? []).length;
					if (rowsNow !== lastRowCount) {
						lastRowCount = rowsNow;
						const last = (current.report ?? [])[rowsNow - 1];
						if (last) log(`[harness ${rowsNow}] ${last.status.toUpperCase()} ${last.group} — ${last.name}${last.detail ? ' — ' + String(last.detail).slice(0, 110) : ''}`);
					}
					if (!current.partial) { harnessReport = current; break; }
				}
			}
			const requests = await serverGet('/requests');
			const messages = requests.filter((entry) => entry.path === '/v1/messages').length;
			if (messages > lastMessageCount) {
				lastMessageCount = messages;
				log(`[progress] the fake server has served ${messages} /v1/messages call${messages === 1 ? '' : 's'} (1 = the pre-flight; more = an in-app conversation)`);
			}
			if (!fetchSeen && remote.seededHead && fetchMovedOrigin()) {
				fetchSeen = true;
				log('[git] the workspace fetched the fake remote — origin/main reached the seeded head');
			}
		} catch { /* the server never dies in practice; a hiccup just skips a poll */ }
	}
	harnessRef = harnessReport;

	// The git-graph-rs fetch verdict, from the workspace itself: origin/main reaching the
	// seeded head means the plugin's fetch crossed the fake remote inside the app. The
	// fetch command's promise may outlive the row on a fresh engine — give the ref update
	// a landing window before ruling.
	if (remote.seededHead) {
		let verified = fetchMovedOrigin();
		for (let i = 0; i < 10 && !verified; i++) { await sleep(3000); verified = fetchMovedOrigin(); }
		log(`[git] fetch through git-graph-rs: ${verified ? 'verified — origin/main reached the seeded head' : 'not verified (no fetch ran, or it did not move origin/main)'}`);
	}
	if (!harnessReport) {
		log('[done] no harness report arrived — the report file carries what was collected');
		return finish(2);
	}
	const failed = harnessReport.failed ?? 0;
	const rowsAll = harnessReport.report ?? [];
	for (const row of rowsAll.filter((row) => row.status !== 'pass')) log(`[${row.status}] ${row.group} — ${row.name}${row.detail ? ' — ' + row.detail : ''}`);
	log(`[done] ${rowsAll.length - failed}/${rowsAll.length} harness rows pass (${rowsAll.filter((row) => row.status === 'skip').length} skipped) — ${reportMd}`);
	return finish(failed === 0 ? 0 : 1);
};

let exitCode = 1;
try { exitCode = await run(); } catch (error) { log('[fatal] ' + (error?.stack ?? error)); }
process.exit(exitCode);

// Every exit path kills the fake server and the git daemon — a crash between startServer and
// finish() must not leak loopback listeners (the earlier runs did, and the port-check below
// then refuses).
// Every exit path tears this run's own tree down — the server, the daemon and the app's
// process group (finish() handles the orderly paths; this handler catches the throws).
process.on('exit', () => {
	if (server.child && server.child.exitCode === null) server.child.kill();
	// The daemon spawned detached (its own group) — kill the group, so even a probe killed
	// with SIGKILL cannot leave a `git daemon` serving the sandbox to init.
	if (remote.daemon && remote.daemon.exitCode === null) { try { process.kill(-remote.daemon.pid, 'SIGTERM'); } catch { try { remote.daemon.kill(); } catch { /* gone */ } } }
	if (typeof appRef !== 'undefined' && appRef && appRef.exitCode === null) { try { process.kill(-appRef.pid, 'SIGTERM'); } catch { /* gone */ } }
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
