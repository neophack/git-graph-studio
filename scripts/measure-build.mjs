// The build-cost baseline of docs/architecture-restructure-plan.md §3 / P0-1: cold and
// incremental compile walls, test-binary link times, typecheck/vitest walls, target-dir
// size breakdown, per-product dependency counts and duplicate-version counts. Everything
// lands under `build.*` in target/studio/metrics.json (merged into whatever is already
// there — scripts/measure.mjs preserves the key when IT writes the file), and `--json`
// prints the same object for pasting into a PR description.
//
// Usage:
//   node scripts/measure-build.mjs            # incremental scenarios + trees + sizes
//   node scripts/measure-build.mjs --cold     # additionally cargo-clean the app package
//                                             # first (a true app-crate rebuild wall)
//   node scripts/measure-build.mjs --no-npm   # skip the typecheck/vitest walls
//   node scripts/measure-build.mjs --json     # also print the build object as JSON
//
// The incremental scenarios append one comment line to a source file, time `cargo build`
// and `cargo test --no-run`, then `git checkout` the file back. A file with uncommitted
// modifications fails the run instead of being restored over.
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = join(appDir, 'src-tauri');
const targetDir = join(appDir, 'target', 'studio', 'cargo');
const studio = join(appDir, 'target', 'studio');

const args = process.argv.slice(2);
const WANT_COLD = args.includes('--cold');
const WANT_JSON = args.includes('--json');
const RUN_NPM = !args.includes('--no-npm');

// docs/architecture-restructure-plan.md D.4. The paths move as the phases land — keep
// them pointing at the current file of each scenario (P2-8 moves applets.rs, P4-1
// dissolves lib.rs) by resolving the first that exists.
const SCENARIOS = [
	{
		name: 'applets',
		files: ['src/ggs_bash/applets.rs', 'crates/ggs-bash/src/applets/mod.rs', 'crates/ggs-bash/src/applets.rs']
	},
	{
		name: 'scm',
		files: ['src/cmd_scm.rs', 'src/commands/scm.rs', 'crates/ggs-git/src/status.rs']
	},
	{
		name: 'viewerFind',
		files: ['src/viewer/find.rs', 'crates/ggs-text/src/viewer/find.rs']
	},
	{
		name: 'lib',
		files: ['src/lib.rs', 'src/commands/mod.rs']
	}
];

const fmtMs = (ms) => (ms === null ? null : Math.round(ms));

function run(cmd, argv, opts = {}) {
	const started = performance.now();
	const result = spawnSync(cmd, argv, {
		cwd: opts.cwd ?? srcTauri,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		shell: opts.shell ?? false,
		env: { ...process.env, ...(opts.env ?? {}) }
	});
	const wall = performance.now() - started;
	return { wall, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null };
}

function cargoBuild(extra = []) {
	const r = run('cargo', ['build', '--timings', ...extra]);
	if (r.status !== 0) {
		console.error(r.stderr || r.stdout);
		throw new Error(`cargo build failed (exit ${r.status})`);
	}
	return r.wall;
}

function gitStatusPorcelain(file) {
	const r = run('git', ['status', '--porcelain', '--', file], { cwd: appDir });
	return r.stdout.trim();
}

function resolveScenarioFile(files) {
	for (const f of files) {
		const abs = join(srcTauri, f);
		if (existsSync(abs)) return f;
	}
	return null;
}

function dirSize(path) {
	let total = 0;
	if (!existsSync(path)) return 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const p = join(path, entry.name);
		if (entry.isDirectory()) total += dirSize(p);
		else total += statSync(p).size;
	}
	return total;
}

function uniqueCrates(form) {
	// Each product's normal-dependency count (cargo tree -e normal --prefix none | sort -u).
	const r = run('cargo', ['tree', '-e', 'normal', '--prefix', 'none', ...form.split(' ')]);
	if (r.status !== 0) return null;
	const names = new Set();
	for (const line of r.stdout.split(/\r?\n/)) {
		const m = line.match(/^([\w-]+) v/);
		if (m) names.add(m[1]);
	}
	return names.size;
}

function duplicateVersions() {
	const r = run('cargo', ['tree', '-d', '--prefix', 'none']);
	if (r.status !== 0) return null;
	const seen = new Map(); // name -> Set(versions)
	for (const line of r.stdout.split(/\r?\n/)) {
		const m = line.match(/^([\w-]+) v([^\s]+)/);
		if (!m) continue;
		if (!seen.has(m[1])) seen.set(m[1], new Set());
		seen.get(m[1]).add(m[2]);
	}
	return [...seen.values()].filter((versions) => versions.size > 1).length;
}

function npmWall(npmArgs) {
	const r = run('npm', npmArgs, { cwd: appDir, shell: process.platform === 'win32' });
	if (r.status !== 0) {
		console.error(r.stderr || r.stdout);
		throw new Error(`npm ${npmArgs.join(' ')} failed (exit ${r.status})`);
	}
	return r.wall;
}

function main() {
	const build = { measuredAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };

	// 1. The compile walls. Without --cold this is a warm build (a no-op if the tree is
	//    already built); --clean cleans ONLY the app package first so the number is a
	//    reproducible "app crate from scratch" wall without nuking every dependency.
	if (WANT_COLD) {
		const clean = run('cargo', ['clean', '-p', 'git-graph-studio']);
		if (clean.status !== 0) {
			console.error(clean.stderr || clean.stdout);
			throw new Error('cargo clean -p git-graph-studio failed');
		}
	}
	build.cold = { cleanFirst: WANT_COLD, wallMs: fmtMs(cargoBuild()) };

	// 2. The incremental scenarios: append a comment, build, test --no-run, restore,
	//    rebuild untimed so the next scenario starts from the same state.
	build.incremental = {};
	for (const scenario of SCENARIOS) {
		const file = resolveScenarioFile(scenario.files);
		if (!file) {
			console.error(`measure-build: scenario ${scenario.name} has no existing file — update SCENARIOS`);
			continue;
		}
		const dirty = gitStatusPorcelain(file);
		if (dirty) throw new Error(`${file} has uncommitted changes — refusing to touch it`);
		const abs = join(srcTauri, file);
		const original = readFileSync(abs, 'utf8');
		const marker = original.endsWith('\n') ? '' : '\n';
		writeFileSync(abs, original + `${marker}// measure-build touch ${Date.now()}\n`);
		try {
			const buildWall = cargoBuild();
			const testNoRun = run('cargo', ['test', '--no-run']);
			if (testNoRun.status !== 0) {
				console.error(testNoRun.stderr || testNoRun.stdout);
				throw new Error('cargo test --no-run failed');
			}
			build.incremental[scenario.name] = {
				file: `src-tauri/${file.split(sep).join('/')}`,
				buildMs: fmtMs(buildWall),
				testNoRunMs: fmtMs(testNoRun.wall)
			};
			console.error(`measure-build: ${scenario.name} build ${Math.round(buildWall)} ms, test --no-run ${Math.round(testNoRun.wall)} ms`);
		} finally {
			const restore = run('git', ['checkout', '--', file], { cwd: appDir });
			if (restore.status !== 0) throw new Error(`git checkout -- ${file} failed`);
			if (readFileSync(abs, 'utf8') !== original) throw new Error(`${file} was not restored`);
			cargoBuild(); // back to a clean state; untimed
		}
	}

	// 3. The frontend walls.
	if (RUN_NPM) {
		build.typecheckMs = fmtMs(npmWall(['run', 'typecheck']));
		build.vitestMs = fmtMs(npmWall(['test']));
	}

	// 4. Target-dir size breakdown.
	const mb = (bytes) => Math.round(bytes / (1024 * 1024));
	build.targetSize = {
		dir: relative(appDir, targetDir).split(sep).join('/'),
		depsMb: mb(dirSize(join(targetDir, 'debug', 'deps'))),
		incrementalMb: mb(dirSize(join(targetDir, 'debug', 'incremental'))),
		buildMb: mb(dirSize(join(targetDir, 'debug', 'build')))
	};

	// 5. Dependency counts, one per product form, and the duplicate-version count.
	build.crates = {
		app: uniqueCrates(''),
		ggsNode: uniqueCrates('--no-default-features --features node-runtime'),
		ggsBash: uniqueCrates('--no-default-features --features ggs-bash'),
		ggsConfig: uniqueCrates('--no-default-features')
	};
	build.duplicates = duplicateVersions();

	// Merge into metrics.json (create the studio dir if a clean tree has none yet).
	const metricsPath = join(studio, 'metrics.json');
	let metrics = {};
	if (existsSync(metricsPath)) metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
	metrics.build = build;
	writeFileSync(metricsPath, JSON.stringify(metrics, null, '\t') + '\n');

	console.log('Git Graph Studio - build-cost baseline');
	console.log(`  compile wall       ${build.cold.wallMs} ms${WANT_COLD ? ' (app package cleaned first)' : ' (warm; --clean for a cold wall)'}`);
	for (const [name, s] of Object.entries(build.incremental ?? {})) {
		console.log(`  ${`${name} +build`.padEnd(20)} ${s.buildMs} ms   (+test --no-run ${s.testNoRunMs} ms)   ${s.file}`);
	}
	if (build.typecheckMs !== undefined) console.log(`  typecheck          ${build.typecheckMs} ms`);
	if (build.vitestMs !== undefined) console.log(`  vitest             ${build.vitestMs} ms`);
	console.log(`  target             deps ${build.targetSize.depsMb} MB, incremental ${build.targetSize.incrementalMb} MB, build ${build.targetSize.buildMb} MB`);
	console.log(`  crate counts       app ${build.crates.app}, ggs-node ${build.crates.ggsNode}, ggs-bash ${build.crates.ggsBash}, ggs-config ${build.crates.ggsConfig}; duplicates ${build.duplicates}`);
	console.log(`Written to ${relative(appDir, metricsPath).split(sep).join('/')} (build.*)`);
	if (WANT_JSON) console.log(JSON.stringify(build, null, 2));
}

main();
