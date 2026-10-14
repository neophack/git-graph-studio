// The TypeScript import-graph rules of docs/architecture-restructure-plan.md §5.2 / D.1:
// the frontend's layers (platform → features → workbench/hosts, remote on top) become
// build-time facts before the files move into them. The rules are enforced against
// scripts/seams-allowlist.json — a shrink-only list seeded once at P1 with every current
// violation; each later PR deletes entries, and a new violation that is not on the list
// fails the build. R10 (oversized files) is a warning.
//
// Run standalone (`node scripts/ts-import-graph.mjs [--seed]`) or through
// scripts/check-seams.mjs, which vitest, prepare.mjs and the Vite build all execute.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(appDir, 'src');
const ALLOWLIST_PATH = join(appDir, 'scripts', 'seams-allowlist.json');
const OVERSIZE_LINES = 1500;

/** The from-form and side-effect import statements (and export … from re-exports).
 *  The middle character class cannot cross a `;`, so the match cannot span statements;
 *  `import type` and `export *` are covered by their leading keywords. */
const IMPORT_FROM_RE = /(?:^|[\n;])[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?[\w$*{},\s]*?from[ \t]*['"]([^'"]+)['"]/g;
const IMPORT_BARE_RE = /(?:^|[\n;])[ \t]*import[ \t]*['"]([^'"]+)['"]/g;
const IMPORT_DYNAMIC_RE = /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g;

function listTsFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) listTsFiles(path, out);
		else if (entry.name.endsWith('.ts')) out.push(path);
	}
	return out;
}

/** `src/editor.ts` → 'root', `src/features/scm/view.ts` → 'features/scm', … */
function layerOf(rel) {
	if (rel.startsWith('src/platform/')) return 'platform';
	if (rel.startsWith('src/scroll/')) return 'scroll';
	if (rel.startsWith('src/features/')) return `features/${rel.split('/')[2]}`;
	if (rel.startsWith('src/workbench/')) return 'workbench';
	if (rel.startsWith('src/hosts/')) return 'hosts';
	if (rel.startsWith('src/remote/')) return 'remote';
	return 'root';
}

function toRel(abs) {
	return relative(appDir, abs).split(sep).join('/');
}

/** Resolve a relative import specifier to a file under src/, or null (non-local or
 *  unresolvable — CSS side-effect imports are dropped by the caller). */
function resolveLocal(fromRel, spec) {
	if (!spec.startsWith('.')) return null;
	if (spec.endsWith('.css')) return null;
	const target = resolvePath(dirname(resolvePath(appDir, fromRel)), spec);
	const base = relative(appDir, target).split(sep).join('/');
	if (!base.startsWith('src/')) return null;
	for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
		const abs = join(appDir, candidate);
		if (!existsSync(abs)) continue;
		try {
			readdirSync(abs);
			continue; // a directory, not the file itself
		} catch {
			return candidate;
		}
	}
	return null;
}

function buildGraph() {
	const files = listTsFiles(SRC);
	const nodes = files.map(toRel).sort();
	const nodeSet = new Set(nodes);
	const staticEdges = new Map(); // rel -> Set<rel>
	const dynamicEdges = new Map();
	const packageImports = new Map(); // rel -> Set<pkg>
	const lineCounts = new Map();
	for (const abs of files) {
		const rel = toRel(abs);
		const content = readFileSync(abs, 'utf8');
		lineCounts.set(rel, content.split('\n').length);
		staticEdges.set(rel, new Set());
		dynamicEdges.set(rel, new Set());
		packageImports.set(rel, new Set());
		for (const re of [IMPORT_FROM_RE, IMPORT_BARE_RE]) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(content)) !== null) {
				const spec = m[1];
				const local = resolveLocal(rel, spec);
				if (local) {
					if (nodeSet.has(local)) staticEdges.get(rel).add(local);
					else console.error(`ts-import-graph: ${rel} imports ${spec}, which resolved to ${local} outside src/ — skipped`);
				} else if (!spec.startsWith('.')) {
					packageImports.get(rel).add(spec);
				} else if (!spec.endsWith('.css')) {
					console.error(`ts-import-graph: ${rel} imports ${spec}, which does not resolve — skipped`);
				}
			}
		}
		IMPORT_DYNAMIC_RE.lastIndex = 0;
		let dm;
		while ((dm = IMPORT_DYNAMIC_RE.exec(content)) !== null) {
			const spec = dm[1];
			const local = resolveLocal(rel, spec);
			if (local && nodeSet.has(local)) dynamicEdges.get(rel).add(local);
		}
	}
	return { nodes, staticEdges, dynamicEdges, packageImports, lineCounts };
}

/** Tarjan's strongly-connected-components over the static edge map. */
function stronglyConnectedComponents(nodes, edges) {
	const index = new Map();
	const low = new Map();
	const onStack = new Set();
	const stack = [];
	const sccs = [];
	let counter = 0;
	const strongConnect = (v) => {
		index.set(v, counter);
		low.set(v, counter);
		counter += 1;
		stack.push(v);
		onStack.add(v);
		for (const w of edges.get(v) ?? []) {
			if (!index.has(w)) {
				strongConnect(w);
				low.set(v, Math.min(low.get(v), low.get(w)));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v), index.get(w)));
			}
		}
		if (low.get(v) === index.get(v)) {
			const scc = [];
			let w;
			do {
				w = stack.pop();
				onStack.delete(w);
				scc.push(w);
			} while (w !== v);
			sccs.push(scc);
		}
	};
	for (const v of nodes) if (!index.has(v)) strongConnect(v);
	return sccs;
}

function collectViolations(graph) {
	const violations = [];
	const push = (rule, from, to) => violations.push({ rule, from, to });

	// Static local edges: R1, R2, R3
	for (const [from, targets] of graph.staticEdges) {
		const layerA = layerOf(from);
		for (const to of targets) {
			const layerB = layerOf(to);
			// R1 — the platform layers are leaves.
			if ((layerA === 'platform' || layerA === 'scroll') && layerB !== 'platform' && layerB !== 'scroll') push('R1', from, to);
			// R2 — cross-feature imports go through the module's facade only.
			if (layerA.startsWith('features/') && layerB.startsWith('features/') && layerA !== layerB) {
				const leaf = to.split('/').pop();
				if (leaf !== 'index.ts' && leaf !== 'types.ts') push('R2', from, to);
			}
			// R3 — nothing but remote itself (and the composition root, main.ts) statically
			// imports remote/. The remote features arrive through platform/hooks.ts.
			if (layerB === 'remote' && layerA !== 'remote' && from !== 'src/main.ts') push('R3', from, to);
			// R7 — the frame/Node hosts run without a workbench.
			if (layerA === 'hosts' && (layerB.startsWith('features/') || layerB === 'workbench')) push('R7', from, to);
		}
	}

	// R4 — dynamic remote imports load from remote/ or the hooks installer only.
	for (const [from, targets] of graph.dynamicEdges) {
		if (layerOf(from) === 'remote' || from === 'src/platform/hooks.ts') continue;
		for (const to of targets) if (layerOf(to) === 'remote') push('R4', from, to);
	}

	// R5 — no static import cycles, type-only included; every edge inside an SCC of more
	// than one node is reported, so an allowlist entry dissolves with its edge.
	for (const scc of stronglyConnectedComponents(graph.nodes, graph.staticEdges)) {
		if (scc.length < 2) continue;
		const members = new Set(scc);
		for (const from of [...members].sort()) {
			for (const to of [...(graph.staticEdges.get(from) ?? [])].filter((t) => members.has(t)).sort()) push('R5', from, to);
		}
	}

	// R6 — the Tauri API surface has one door: platform/ipc (events may also reach the
	// workbench layer, where main-window listeners live).
	for (const [from, packages] of graph.packageImports) {
		for (const pkg of packages) {
			if (pkg === '@tauri-apps/api/core' && from !== 'src/platform/ipc/core.ts' && !from.startsWith('src/platform/ipc/')) push('R6', from, pkg);
			if (pkg === '@tauri-apps/api/event') {
				const layer = layerOf(from);
				if (!from.startsWith('src/platform/ipc/') && layer !== 'workbench') push('R6', from, pkg);
			}
		}
	}
	violations.sort((a, b) => (a.rule + a.from + a.to).localeCompare(b.rule + b.from + b.to));
	return violations;
}

function key(v) {
	return `${v.rule}|${v.from}|${v.to}`;
}

export function checkImportGraph() {
	const graph = buildGraph();
	const violations = collectViolations(graph);
	const warnings = [];
	for (const [rel, lines] of graph.lineCounts) if (lines > OVERSIZE_LINES) warnings.push(`${rel}: ${lines} lines (> ${OVERSIZE_LINES}; R10 — split candidate)`);

	const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
	const allowed = new Set(allowlist.map(key));
	const fresh = violations.filter((v) => !allowed.has(key(v)));
	const stale = allowlist.filter((entry) => !violations.some((v) => key(v) === key(entry)));

	const errors = [];
	for (const v of fresh) errors.push(`  ${v.rule}: ${v.from} → ${v.to}`);
	if (errors.length > 0) {
		errors.unshift(`TS layer/import-graph violations (docs/architecture-restructure-plan.md §5.2) — ${errors.length} not on scripts/seams-allowlist.json:`);
	}
	if (stale.length > 0) {
		errors.push(`  allowlist entries that no longer occur (delete them, the list only shrinks):\n  ${stale.map((e) => key(e)).join('\n  ')}`);
	}
	if (errors.length > 0) throw new Error(errors.join('\n'));
	for (const w of warnings) console.error(`ts-import-graph (R10 warning): ${w}`);
	return { violations: violations.length, allowlist: allowlist.length, files: graph.nodes.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--seed')) {
	// The one-time P1 bootstrap: every violation that exists today becomes the baseline.
	const violations = collectViolations(buildGraph());
	writeFileSync(ALLOWLIST_PATH, JSON.stringify(violations, null, '\t') + '\n');
	console.log(`Seeded ${ALLOWLIST_PATH} with ${violations.length} entries. The list only shrinks from here.`);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const summary = checkImportGraph();
	console.log(`ts-import-graph: ${summary.files} files, ${summary.violations} violations (all allowlisted), allowlist ${summary.allowlist}.`);
}
