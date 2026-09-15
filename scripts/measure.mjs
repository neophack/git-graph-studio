// The size and performance baseline (docs/ggs-development-plan.md M0.6 / §6 / §7): measures
// the release build's artefacts, optionally runs the backend's headless `--measure` probes
// against a repository, writes everything to target/studio/metrics.json and prints a table.
//
//   node scripts/measure.mjs                 sizes only (after `npx tauri build`)
//   node scripts/measure.mjs --repo <path>   sizes + the backend probes on <path>
//   node scripts/measure.mjs --gate          exit 1 when a size budget is exceeded (CI)
//
// The budgets are the plan's section-4 acceptance lines. The gate is relative to them, not to
// a previous run, so a failure always means an absolute limit was crossed.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const studio = join(appDir, 'target', 'studio');
const root = appDir;
const release = join(studio, 'cargo', 'release');

/** The plan's hard targets, in bytes. */
export const BUDGETS = {
	exe: 10 * 1024 * 1024,
	installer: 8 * 1024 * 1024,
	dist: 2 * 1024 * 1024,
	firstPaintJs: 300 * 1024
};

function sizeOf(path) {
	return existsSync(path) ? statSync(path).size : null;
}

/** Total size of a directory tree, plus its largest file, for the frontend dist. */
function treeSize(dir) {
	if (!existsSync(dir)) return { total: null, largest: null };
	let total = 0;
	let largest = { path: null, size: 0 };
	const walk = (folder) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				const size = statSync(path).size;
				total += size;
				if (size > largest.size) largest = { path: relative(dir, path).split('\\').join('/'), size };
			}
		}
	};
	walk(dir);
	return { total, largest };
}

function firstMatching(dir, predicate) {
	if (!existsSync(dir)) return null;
	const found = readdirSync(dir).filter(predicate).sort();
	return found.length > 0 ? join(dir, found[0]) : null;
}

/** The first-paint JavaScript: the static closure the Vite build recorded in
 *  dist/first-paint.json (vite.config.ts `firstPaintPlugin`) - the boot entry, the workbench
 *  chunk and everything they import statically. Async chunks (xterm, merge views, language
 *  modes) are not in it. `null` before a build. */
function firstPaintChunk(dist) {
	const path = join(dist, 'first-paint.json');
	if (!existsSync(path)) return null;
	const closure = JSON.parse(readFileSync(path, 'utf8'));
	return { path: closure.chunks.map((c) => c.file).join(' + '), size: closure.total, chunks: closure.chunks };
}

export function collectSizes() {
	const exe = process.platform === 'win32' ? join(release, 'git-graph-studio.exe') : join(release, 'git-graph-studio');
	const nsis = firstMatching(join(release, 'bundle', 'nsis'), (f) => f.endsWith('.exe'));
	const msi = firstMatching(join(release, 'bundle', 'msi'), (f) => f.endsWith('.msi'));
	const dmg = firstMatching(join(release, 'bundle', 'dmg'), (f) => f.endsWith('.dmg'));
	const appImage = firstMatching(join(release, 'bundle', 'appimage'), (f) => f.endsWith('.AppImage'));
	const deb = firstMatching(join(release, 'bundle', 'deb'), (f) => f.endsWith('.deb'));
	const installer = nsis ?? dmg ?? appImage ?? msi ?? deb;
	const dist = treeSize(join(studio, 'dist'));
	return {
		exe: sizeOf(exe),
		installer: installer ? sizeOf(installer) : null,
		installerPath: installer ? relative(root, installer).split('\\').join('/') : null,
		msi: msi ? sizeOf(msi) : null,
		dist: dist.total,
		distLargest: dist.largest,
		firstPaintJs: firstPaintChunk(join(studio, 'dist'))
	};
}

/** Run the backend's `--measure` against a repository; `null` when the exe is not built. */
export function runProbes(repo) {
	const exe = process.platform === 'win32' ? join(release, 'git-graph-studio.exe') : join(release, 'git-graph-studio');
	if (!existsSync(exe)) return null;
	const result = spawnSync(exe, ['--measure', repo], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	if (result.status !== 0) {
		console.error(result.stderr || result.stdout);
		return null;
	}
	return JSON.parse(result.stdout);
}

/** The budgets `--gate` fails the build on. `dist` (the whole frontend, language modes and
 *  the codicon font included) is reported but not gated until the font subsetting lands. */
export const GATED = ['exe', 'installer', 'firstPaintJs'];

/** Which budgets the sizes exceed, as `[name, actual, budget]` triples. */
export function violations(sizes) {
	const out = [];
	const check = (name, actual, budget) => {
		if (actual !== null && actual !== undefined && actual > budget) out.push([name, actual, budget]);
	};
	check('exe', sizes.exe, BUDGETS.exe);
	check('installer', sizes.installer, BUDGETS.installer);
	check('dist', sizes.dist, BUDGETS.dist);
	check('firstPaintJs', sizes.firstPaintJs?.size ?? null, BUDGETS.firstPaintJs);
	return out;
}

const mb = (bytes) => (bytes === null || bytes === undefined ? '-' : `${(bytes / (1024 * 1024)).toFixed(2)} MB`);
const kb = (bytes) => (bytes === null || bytes === undefined ? '-' : `${(bytes / 1024).toFixed(0)} KB`);

function main() {
	const args = process.argv.slice(2);
	const gate = args.includes('--gate');
	const repoIndex = args.indexOf('--repo');
	const repo = repoIndex !== -1 ? args[repoIndex + 1] : null;

	const sizes = collectSizes();
	const perf = repo ? runProbes(repo) : null;
	const metrics = {
		measuredAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
		version: JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version,
		budgets: BUDGETS,
		sizes,
		perf
	};
	writeFileSync(join(studio, 'metrics.json'), JSON.stringify(metrics, null, '\t') + '\n');

	console.log('Git Graph Studio - size baseline');
	console.log(`  exe            ${mb(sizes.exe).padStart(10)}   budget ${mb(BUDGETS.exe)}`);
	console.log(`  installer      ${mb(sizes.installer).padStart(10)}   budget ${mb(BUDGETS.installer)}${sizes.installerPath ? `   (${sizes.installerPath})` : ''}`);
	console.log(`  frontend dist  ${mb(sizes.dist).padStart(10)}   budget ${mb(BUDGETS.dist)}${sizes.distLargest?.path ? `   (largest: ${sizes.distLargest.path} ${kb(sizes.distLargest.size)})` : ''}`);
	console.log(`  first-paint JS ${kb(sizes.firstPaintJs?.size ?? null).padStart(10)}   budget ${kb(BUDGETS.firstPaintJs)}   (static closure of the boot entry + workbench)`);
	for (const chunk of sizes.firstPaintJs?.chunks ?? []) console.log(`${''.padStart(19)}${kb(chunk.bytes).padStart(8)}   ${chunk.file}`);
	if (perf) {
		console.log(`Backend probes on ${perf.folder} (${perf.files} files, ${perf.symbols} symbols)`);
		for (const [phase, ms] of Object.entries(perf.ms)) console.log(`  ${phase.padEnd(15)} ${ms === null ? '-' : `${ms} ms`}`);
	}
	console.log(`Written to ${relative(root, join(studio, 'metrics.json')).split('\\').join('/')}`);

	let failing = false;
	for (const [name, actual, budget] of violations(sizes)) {
		const gated = GATED.includes(name);
		if (gate && gated) failing = true;
		console.log(`${gate && gated ? 'FAIL' : 'over budget'}: ${name} ${mb(actual)} > ${mb(budget)}${gated ? '' : ' (not gated yet)'}`);
	}
	if (failing) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
