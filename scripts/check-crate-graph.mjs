// The crate-graph rules of docs/architecture-restructure-plan.md §4.3 / D.3: the Rust
// workspace's internal dependency edges are build-time facts, not conventions. The
// whitelist lives in scripts/crate-graph.json; the check reads `cargo metadata
// --no-deps` (offline, ~100 ms) once crates/ exists — until then only the
// git-graph-core seam scan (moved here from src-tauri/build.rs, which keeps its own
// copy until P4-2) and the //! doc-header rule apply.
//
// Run standalone (`node scripts/check-crate-graph.mjs`) or through
// scripts/check-seams.mjs.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = join(appDir, 'src-tauri');
const WHITELIST = JSON.parse(readFileSync(join(appDir, 'scripts', 'crate-graph.json'), 'utf8'));

function listFiles(dir, ext, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) listFiles(path, ext, out);
		else if (entry.name.endsWith(ext)) out.push(path);
	}
	return out;
}

/** D.3 #4/#5 — the engine crate is named by no manifest and no source under src-tauri/
 *  (src/ and the future crates tree both): it ships inside the extension's VSIX as
 *  git-graph.node and is hosted by whatever N-API runtime loads it. Sources are scanned
 *  for the underscore form (a real path reference — the hyphen form appears in prose
 *  comments that document the seam itself); manifests for both forms. This is build.rs's
 *  check, widened; build.rs keeps its own copy until P4-2 deletes it. */
function checkEngineSeam(errors) {
	const codeForm = /git_graph_core/;
	const manifestForm = /git[_-]graph[_-]core/;
	const roots = [join(srcTauri, 'src')];
	const cratesDir = join(srcTauri, 'crates');
	if (existsSync(cratesDir)) {
		for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
			if (entry.isDirectory()) roots.push(join(cratesDir, entry.name, 'src'), join(cratesDir, entry.name, 'build.rs'));
		}
	}
	for (const root of roots) {
		for (const file of listFiles(root, '.rs')) {
			if (codeForm.test(readFileSync(file, 'utf8'))) {
				errors.push(`${relative(appDir, file).split(sep).join('/')}: names git-graph-core — the engine is a plugin, nothing in this tree links it`);
			}
		}
	}
	for (const manifest of [join(srcTauri, 'Cargo.toml'), ...listFiles(cratesDir, 'Cargo.toml')]) {
		if (manifest && existsSync(manifest) && manifestForm.test(readFileSync(manifest, 'utf8'))) {
			errors.push(`${relative(appDir, manifest).split(sep).join('/')}: names git-graph-core in a manifest`);
		}
	}
}

/** D.3 #6 — every member crate's lib.rs / main.rs opens with a `//!` doc header naming
 *  its mission, its module-map number and its allowed globals (plan principle 5). */
function checkDocHeaders(members, errors) {
	for (const member of members) {
		const crateRoot = dirname(member.manifest_path);
		for (const target of ['src/lib.rs', 'src/main.rs']) {
			const path = join(crateRoot, target);
			if (!existsSync(path)) continue;
			if (!readFileSync(path, 'utf8').startsWith('//!')) {
				errors.push(`${relative(appDir, path).split(sep).join('/')}: must open with a //! doc header (mission, module number, allowed globals)`);
			}
		}
	}
}

/** D.3 #1–#3 — the internal edges match the whitelist, layers only point down (same-layer
 *  edges only when listed), and the app-only heavy deps appear in no other member. */
function checkGraph(metadata, errors) {
	const members = new Map();
	const cratesPrefix = join(srcTauri, 'crates').split(sep).join('/');
	for (const pkg of metadata.packages) {
		const manifest = (pkg.manifest_path ?? '').split(sep).join('/');
		if (manifest.startsWith(cratesPrefix) || pkg.name === 'git-graph-studio') {
			members.set(pkg.name, { ...pkg, manifest_path: manifest });
		}
	}
	const internal = new Set(members.keys());
	for (const [name, pkg] of members) {
		const allowed = WHITELIST.allowed[name] ?? [];
		const myLayer = WHITELIST.layers[name];
		if (myLayer === undefined) {
			errors.push(`crate-graph.json: '${name}' is a workspace member but has no layer — add it to the whitelist`);
			continue;
		}
		for (const dep of pkg.dependencies) {
			const depName = dep.name;
			if (!internal.has(depName)) {
				// Our namespace: a ggs-* dependency that is not a workspace member is a
				// typo or a crate that has not landed — either way it must not compile on.
				if (depName.startsWith('ggs-') && WHITELIST.layers[depName] === undefined) {
					errors.push(`${name} depends on ${depName}, which is neither a workspace member nor on the crate-graph.json layer table`);
				}
				if (WHITELIST.appOnly.includes(depName) && name !== 'git-graph-studio') {
					errors.push(`${name} depends on ${depName} — only the app crate may (crate-graph.json appOnly)`);
				}
				continue;
			}
			if (!allowed.includes(depName)) {
				errors.push(`${name} -> ${depName}: not on the whitelist (scripts/crate-graph.json); if it cannot be a composition-root wiring, add it with a why in the PR`);
			}
			const depLayer = WHITELIST.layers[depName] ?? -1;
			if (depLayer > myLayer) {
				errors.push(`${name} (layer ${myLayer}) -> ${depName} (layer ${depLayer}): dependencies only point down`);
			} else if (depLayer === myLayer && !allowed.includes(depName)) {
				errors.push(`${name} -> ${depName}: a same-layer edge must be listed explicitly`);
			}
		}
	}
	return members;
}

export function checkCrateGraph() {
	const errors = [];
	checkEngineSeam(errors);

	// The metadata part activates with the first crate under crates/ (P2-1).
	const hasCrates = existsSync(join(srcTauri, 'crates'));
	let members = new Map();
	if (hasCrates) {
		const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--offline'], {
			cwd: srcTauri,
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024
		});
		if (result.status !== 0) throw new Error(`check-crate-graph: cargo metadata failed:\n${result.stderr}`);
		const metadata = JSON.parse(result.stdout);
		members = checkGraph(metadata, errors);
		checkDocHeaders([...members.values()], errors);
	}

	if (errors.length > 0) {
		throw new Error(`Crate-graph violations (docs/architecture-restructure-plan.md §4.3):\n  ${errors.join('\n  ')}`);
	}
	return { members: members.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const summary = checkCrateGraph();
	console.log(`check-crate-graph: ${summary.members} members checked, seam clean.`);
}
