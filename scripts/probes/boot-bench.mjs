// End-to-end startup latency of the packaged app: launches the release exe with an argument
// (a large text file, a binary file, a folder), reads the `[boot]` stamps it prints, kills it
// once the terminal stage of that mode has landed, and repeats. The numbers are wall-clock
// milliseconds from the moment the script spawned the process (so exe loading counts too),
// with the process's own "since process start" stamp beside them.
//
//   node scripts/probes/boot-bench.mjs <path> [--runs N] [--until "<stage>"] [--json out.json]
//                               [--exe <build.exe>] [--ab <a.exe>,<b.exe>]
//
// The terminal stage defaults to "single file shown" for a file and "folder shown" for a
// folder. `--exe` measures a build other than target/studio's; `--ab` alternates two builds
// run by run (A, B, A, B, ...), so both see the same machine state - the only fair way to
// compare a change, since the WebView2 start alone swings by hundreds of milliseconds
// between sessions. The console must be able to see the exe's stdout: the release build is
// a GUI subsystem binary, but a piped stdout reaches it fine.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const release = join(appDir, 'target', 'studio', 'cargo', 'release');
const defaultExe = process.platform === 'win32' ? join(release, 'git-graph-studio.exe') : join(release, 'git-graph-studio');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
	const at = args.indexOf(name);
	return at === -1 ? fallback : args[at + 1];
};
const runs = Number(flag('--runs', '5'));
const jsonOut = flag('--json', null);
if (!target || !existsSync(target)) {
	console.error('usage: node scripts/probes/boot-bench.mjs <file-or-folder> [--runs N] [--until stage] [--json out] [--exe build.exe] [--ab a.exe,b.exe]');
	process.exit(2);
}
/** The builds under test: one, or the A/B pair. */
const builds = flag('--ab', null)
	? flag('--ab', '').split(',').map((path, i) => ({ label: i === 0 ? 'A' : 'B', exe: path }))
	: [{ label: '', exe: flag('--exe', defaultExe) }];
for (const build of builds) {
	if (!existsSync(build.exe)) {
		console.error(`no build at ${build.exe} (run npx tauri build first)`);
		process.exit(2);
	}
}
const isDir = statSync(target).isDirectory();
const until = flag('--until', isDir ? 'folder shown' : 'single file shown');
const TIMEOUT_MS = 30_000;

/** One launch: resolves with the stamps `{ stage: { wall, proc } }` seen before `until`. */
function launch(exe) {
	return new Promise((resolve) => {
		const stamps = {};
		let done = false;
		const started = process.hrtime.bigint();
		const child = spawn(exe, [target], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
		const finish = (reason) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			// Close the window the way the user would (WM_CLOSE): a killed WebView2 leaves its
			// profile locked, and the next launch then pays a slow crash-recovery start that
			// has nothing to do with the app. The hard kill is only the fallback.
			let closed = 'graceful';
			if (process.platform === 'win32') {
				const out = spawnSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow(); if ($p.WaitForExit(4000)) { 'closed' } else { Stop-Process -Id ${child.pid} -Force; 'killed' } } else { 'gone' }`], { encoding: 'utf8' });
				closed = (out.stdout ?? '').trim() || 'unknown';
				spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
			} else child.kill('SIGTERM');
			resolve({ stamps, reason, closed });
		};
		const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);
		let buffer = '';
		const onData = (chunk) => {
			buffer += chunk;
			let nl;
			while ((nl = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				const m = /^\[boot\] (.+?): \+(\d+) ms since process start/.exec(line);
				if (!m) continue;
				const wall = Number(process.hrtime.bigint() - started) / 1e6;
				stamps[m[1]] = { wall: Math.round(wall), proc: Number(m[2]) };
				if (m[1] === until) finish('done');
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', () => finish('exited'));
	});
}

/** A compile or a test run elsewhere on the machine would be measured as app latency: wait
 *  until no such process is running and the CPU has been quiet for two samples. */
async function waitForQuietMachine() {
	if (process.platform !== 'win32') return;
	const busyNames = ['rustc.exe', 'cargo.exe', 'link.exe', 'lld-link.exe', 'vitest', 'tsc', 'esbuild.exe'];
	let quietSamples = 0;
	let waited = 0;
	while (quietSamples < 2 && waited < 30 * 60_000) {
		const out = spawnSync('powershell', ['-NoProfile', '-Command', '$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $names = (Get-Process | Select-Object -ExpandProperty ProcessName) -join ","; "$load|$names"'], { encoding: 'utf8' });
		const [load, names] = (out.stdout ?? '0|').trim().split('|');
		const busy = busyNames.some((name) => names.split(',').includes(name.replace(/\.exe$/, '')));
		if (!busy && Number(load) < 30) {
			quietSamples++;
			await new Promise((r) => setTimeout(r, 1000));
		} else {
			if (quietSamples === 0 && waited === 0) console.log(`waiting for a quiet machine (cpu ${load}%${busy ? ', a build is running' : ''})...`);
			quietSamples = 0;
			await new Promise((r) => setTimeout(r, 3000));
			waited += 3000;
		}
	}
}

/** The closed app's WebView2 helper processes take a moment to exit; a launch while they
 *  still hold the profile pays for their shutdown. Wait for the app's own to be gone. */
async function waitForWebViewExit() {
	if (process.platform !== 'win32') return;
	for (let i = 0; i < 20; i++) {
		const out = spawnSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*com.gitgraph.studio*' } | Measure-Object).Count"], { encoding: 'utf8' });
		if ((out.stdout ?? '').trim() === '0') return;
		await new Promise((r) => setTimeout(r, 500));
	}
}

const results = [];
for (let i = 0; i < runs; i++) {
	for (const build of builds) {
		await waitForQuietMachine();
		const result = await launch(build.exe);
		result.label = build.label;
		results.push(result);
		const end = result.stamps[until];
		console.log(`run ${i + 1}${build.label ? ` ${build.label}` : ''}: ${end ? `${end.wall} ms wall (${end.proc} ms in-process)` : `no "${until}" stamp (${result.reason})`}, exit: ${result.closed}`);
		await waitForWebViewExit();
		await new Promise((r) => setTimeout(r, 1500));
	}
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const summaries = {};
for (const build of builds) {
	const own = results.filter((r) => r.label === build.label);
	const stages = [...new Set(own.flatMap((r) => Object.keys(r.stamps)))];
	const summary = {};
	for (const stage of stages) {
		const walls = own.map((r) => r.stamps[stage]?.wall).filter((x) => x !== undefined);
		const procs = own.map((r) => r.stamps[stage]?.proc).filter((x) => x !== undefined);
		summary[stage] = { wallMedian: median(walls), procMedian: median(procs), wallMin: Math.min(...walls), samples: walls.length };
	}
	summaries[build.label] = summary;
	console.log(`\n${build.label ? `[${build.label}] ${build.exe}\n` : ''}${target}  (${runs} runs, median wall ms from spawn / min)`);
	for (const [stage, s] of Object.entries(summary).sort((a, b) => a[1].wallMedian - b[1].wallMedian)) {
		console.log(`  ${stage.padEnd(28)} ${String(s.wallMedian).padStart(6)} ms   min ${String(s.wallMin).padStart(6)}   (in-process ${s.procMedian} ms, ${s.samples}/${runs})`);
	}
}
if (builds.length === 2) {
	const a = summaries.A[until]?.wallMedian;
	const b = summaries.B[until]?.wallMedian;
	if (a && b) console.log(`\nA -> B at "${until}": ${a} -> ${b} ms wall median (${Math.round((1 - b / a) * 100)}% faster)`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ target, until, runs, builds, summaries, results }, null, '\t') + '\n');
