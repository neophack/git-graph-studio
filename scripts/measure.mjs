// The size and performance baseline (docs/ggs-development-plan.md M0.6 / §6 / §7): measures
// the release build's artefacts, optionally runs the backend's headless `--measure` probes
// against a repository, writes everything to target/studio/metrics.json and prints a table.
//
//   node scripts/measure.mjs                 sizes only (after `npx tauri build`)
//   node scripts/measure.mjs --repo <path>   sizes + the backend probes on <path>
//
// Sizes are recorded, never gated: the exe / installer / dist / first-paint budgets and the
// `--gate` exit code were removed on 2026-09-15 at the owner's request ("不要限制大小了"),
// after the exe crossed the old 10 MB line. Backend performance stays gated where it always
// was, in src-tauri/tests/perf.rs.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const studio = join(appDir, 'target', 'studio');
const root = appDir;
const release = join(studio, 'cargo', 'release');

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

const mb = (bytes) => (bytes === null || bytes === undefined ? '-' : `${(bytes / (1024 * 1024)).toFixed(2)} MB`);
const kb = (bytes) => (bytes === null || bytes === undefined ? '-' : `${(bytes / 1024).toFixed(0)} KB`);

function main() {
	const args = process.argv.slice(2);
	const repoIndex = args.indexOf('--repo');
	const repo = repoIndex !== -1 ? args[repoIndex + 1] : null;

	const sizes = collectSizes();
	const perf = repo ? runProbes(repo) : null;
	const metrics = {
		measuredAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
		version: JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version,
		sizes,
		perf
	};
	writeFileSync(join(studio, 'metrics.json'), JSON.stringify(metrics, null, '\t') + '\n');

	console.log('Git Graph Studio - size baseline');
	console.log(`  exe            ${mb(sizes.exe).padStart(10)}`);
	console.log(`  installer      ${mb(sizes.installer).padStart(10)}${sizes.installerPath ? `   (${sizes.installerPath})` : ''}`);
	console.log(`  frontend dist  ${mb(sizes.dist).padStart(10)}${sizes.distLargest?.path ? `   (largest: ${sizes.distLargest.path} ${kb(sizes.distLargest.size)})` : ''}`);
	console.log(`  first-paint JS ${kb(sizes.firstPaintJs?.size ?? null).padStart(10)}   (static closure of the boot entry + workbench)`);
	for (const chunk of sizes.firstPaintJs?.chunks ?? []) console.log(`${''.padStart(19)}${kb(chunk.bytes).padStart(8)}   ${chunk.file}`);
	if (perf) {
		console.log(`Backend probes on ${perf.folder} (${perf.files} files, ${perf.symbols} symbols)`);
		for (const [phase, ms] of Object.entries(perf.ms)) console.log(`  ${phase.padEnd(15)} ${ms === null ? '-' : `${ms} ms`}`);
	}
	console.log(`Written to ${relative(root, join(studio, 'metrics.json')).split('\\').join('/')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
