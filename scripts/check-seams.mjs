// The seam rules of the app, enforced at build time: nothing under src/ or static/ may name
// the git-graph-rs extension's artifacts or protocols — the extension is a plugin (everything
// of it lives in its standard VSIX, built in its own repository outside this tree), and the
// app's only interface to it is the generic extension platform. The Rust counterpart of this
// check lives in src-tauri/build.rs.
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
	// The app consumes no extension artifact at all anymore (everything of git-graph-rs lives
	// in its VSIX, packed by the extension's own studio packer). These patterns fail the build anywhere under src/
	// or static/ — the seam is the extension platform itself, not a file of the app.
	{ pattern: /graph_request/, paths: [], because: 'the graph protocol belongs to the git-graph-rs plugin (its bridge speaks it); the app never names it' },
	{ pattern: /gitgraph\//, paths: [], because: 'the extension assets live inside its VSIX; nothing of the app names their paths' },
	{ pattern: /GitGraphStudioConfig/, paths: [], because: 'the config bundle is the plugin page own (web/config.js); the app never reads it' },
	{ pattern: /out\.min/, paths: [], because: 'the webview bundle is the plugin page own; the app never references it' },
	{ pattern: /web[\\/]styles/, paths: [], because: 'the extension CSS sources are consumed only through its plugin packer — never referenced by the app' }
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
