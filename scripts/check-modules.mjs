// The module-map coverage check of docs/architecture-restructure-plan.md §6: every source
// file under src/, src-tauri/src/ and src-tauri/crates/*/src/ is covered by exactly one
// module of modules.json (a more specific file entry wins over a directory prefix), and
// every test a module lists exists. This turns the module map from hand-maintained prose —
// which had already drifted (§1.3) — into a build-time fact; AGENTS.md keeps the narrative.
//
// Run standalone (`node scripts/check-modules.mjs`) or through scripts/check-seams.mjs.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = JSON.parse(readFileSync(join(appDir, 'modules.json'), 'utf8')).modules;

const ROOTS = ['src', 'src-tauri/src', ...readdirSync(join(appDir, 'src-tauri', 'crates'), { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => `src-tauri/crates/${e.name}/src`)];

function listSourceFiles(relDir, out = []) {
	const abs = join(appDir, relDir);
	if (!existsSync(abs)) return out;
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		const rel = `${relDir}/${entry.name}`;
		if (entry.isDirectory()) listSourceFiles(rel, out);
		else if (/\.(ts|rs|js|css)$/.test(entry.name)) out.push(rel);
	}
	return out;
}

/** The module owning `rel`: the most specific matching entry (a file beats a directory;
 *  among directories, the longer prefix wins). Two equally specific matches are an error. */
function ownerOf(rel, report) {
	let best = null;
	let bestScore = -1;
	for (const module of MODULES) {
		for (const entry of [...(module.ts ?? []), ...(module.rust ?? [])]) {
			let score;
			if (entry === rel) score = 1_000_000 + entry.length;
			else if (entry.endsWith('/') && rel.startsWith(entry)) score = entry.length;
			else continue;
			if (score > bestScore) {
				bestScore = score;
				best = module;
			} else if (score === bestScore && best !== module) {
				report.push(`${rel}: claimed by both '${best.name}' and '${module.name}' at the same specificity (${entry})`);
			}
		}
	}
	return best;
}

export function checkModules() {
	const problems = [];
	const files = ROOTS.flatMap((root) => listSourceFiles(root));
	const claimed = new Map();
	for (const rel of files) {
		const owner = ownerOf(rel, problems);
		if (!owner) {
			problems.push(`${rel}: no module claims it (modules.json)`);
			continue;
		}
		claimed.set(owner.name, (claimed.get(owner.name) ?? 0) + 1);
	}
	for (const module of MODULES) {
		for (const test of module.tests ?? []) {
			if (!existsSync(join(appDir, test))) problems.push(`module ${module.id} (${module.name}): test ${test} does not exist`);
		}
	}
	if (MODULES.some((m, i) => MODULES.findIndex((o) => o.id === m.id) !== i)) problems.push('modules.json: duplicate module ids');
	for (let i = 1; i <= 19; i += 1) {
		if (!MODULES.some((m) => m.id === i)) problems.push(`modules.json: module id ${i} missing`);
	}
	if (problems.length > 0) throw new Error(`Module-map coverage violations (docs/architecture-restructure-plan.md §6, modules.json):\n  ${problems.join('\n  ')}`);
	return { modules: MODULES.length, files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const summary = checkModules();
	console.log(`check-modules: ${summary.modules} modules cover ${summary.files} source files.`);
}
