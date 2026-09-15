// The seam rules of the app (docs/ggs-development-plan.md §3.7), enforced at build time: the
// extension's artifacts are consumed through exactly one file per language — graphHost.ts on
// the TS side (the single `graph_request` channel and the only namer of the extension's asset
// paths), view.html on the CSS side (the only loader of the webview bundle compiled from the
// extension's web/styles). The Rust counterpart of this check lives in src-tauri/build.rs.
//
// Wired into every path that compiles the frontend: scripts/prepare.mjs runs it first, the
// Vite plugin (vite.config.ts) runs it on every dev-server start and production build, and
// vitest runs it as its global setup. A violation fails the build with the file list below.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What each extension artifact may be referenced by, as paths under app/. Anything else that
 *  names the pattern fails the build. */
const RULES = [
	{ pattern: /graph_request/, paths: ['src/graphHost.ts'], because: 'the graph protocol is invoked only by the TS seam (graphHost.ts)' },
	{ pattern: /gitgraph\//, paths: ['src/graphHost.ts'], because: 'the extension\'s assets are named only by the TS seam (graphHost.ts)' },
	{ pattern: /GitGraphStudioConfig/, paths: ['src/graphHost.ts'], because: 'the extension\'s config bundle is read only by the TS seam' },
	{ pattern: /out\.min/, paths: ['static/gitgraph/view.html', 'src/graphHost.ts'], because: 'the webview bundle (compiled from the extension\'s web/styles) is loaded only by the view page, and resolved to the installed package\'s copy only by the TS seam (graphHost.ts)' },
	{ pattern: /web[\\/]styles/, paths: [], because: 'the extension\'s CSS sources are consumed only through the artifacts scripts/prepare.mjs builds from them — never referenced directly' }
];

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

export function checkSeams() {
	const scanned = [...listFiles(join(appDir, 'src')).filter((f) => f.endsWith('.ts')), ...listFiles(join(appDir, 'static'))];
	const violations = [];
	for (const file of scanned) {
		const rel = relative(appDir, file).split(sep).join('/');
		const content = readFileSync(file, 'utf8');
		for (const rule of RULES) {
			if (rule.pattern.test(content) && !rule.paths.includes(rel)) {
				violations.push(`${rel}: /${rule.pattern.source}/ — ${rule.because}`);
			}
		}
	}
	if (violations.length > 0) {
		throw new Error(`Git Graph seam violations (docs/ggs-development-plan.md §3.7):\n  ${violations.join('\n  ')}`);
	}
	return scanned.length;
}

export default function seamsGlobalSetup() {
	checkSeams();
}
