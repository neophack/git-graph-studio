// The documentation path check (docs/redundancy-cleanup-plan.md §6): every backtick-wrapped
// token in AGENTS.md / README.md that names a repository path must exist — a moved file's
// stale reference is how the module map drifted 28 paths deep. Runs through
// scripts/check-seams.mjs (so vitest, prepare and the vite build all carry it).
//
// What counts as a repository path: a token with a slash whose first segment is a root the
// repository actually has (src/, src-tauri/, scripts/, tests/, …) or a well-known root file
// (package.json, tsconfig.json, …). Tokens with wildcards test their wildcard-free prefix
// (`src/features/editor/*` tests `src/features/editor`); `~`-paths, URLs, protocol ids
// (`ggs-ext/1`) and anything with spaces never name the tree.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository roots a backtick token may name (checked against the tree itself, so a
 *  new root joins simply by existing). */
const ROOT_DIRS = new Set(
	['src', 'src-tauri', 'scripts', 'tests', 'dev', 'docs', 'static', 'extensions-src', '.github', 'crates', 'assets']
		.filter((d) => existsSync(join(appDir, d)))
);
const ROOT_FILES = new Set(['package.json', 'tsconfig.json', 'tsconfig.e2e.json', 'tsconfig.tests.json', 'vite.config.ts', 'vite.remote.config.ts', 'playwright.remote.config.ts', 'AGENTS.md', 'README.md', 'Cargo.toml']);

/** The repo paths a token may name even though the checker's root list would not see them
 *  (generated at build time under target/, user-home paths in prose). Nothing is here
 *  today; entries carry their why in the PR that adds them. */
const PATH_ALLOWLIST = new Set([]);

function candidates(text) {
	const out = [];
	for (const m of text.matchAll(/`([^`\n]+)`/g)) {
		const token = m[1];
		if (token.includes(' ') || token.includes('$') || token.includes('#')) continue;
		if (/[<>]/.test(token)) continue; // a placeholder (`tests/<module>.test.ts`), not a path
		if (token.startsWith('~') || token.includes('://')) continue;
		const segments = token.split('/');
		if (ROOT_DIRS.has(segments[0]) || ROOT_FILES.has(token)) out.push(token);
	}
	return out;
}

function pathExists(token) {
	if (PATH_ALLOWLIST.has(token)) return true;
	if (ROOT_FILES.has(token)) return existsSync(join(appDir, token));
	// brace sets (`src/platform/i18n/{en,zh-cn}.ts`) exist when every alternative does
	const braces = token.match(/\{([^}]+)\}/);
	if (braces) {
		return braces[1].split(',').every((alt) => pathExists(token.replace(braces[0], alt.trim())));
	}
	// wildcards and brace sets test their wildcard-free prefix
	const solid = token.split('*')[0].replace(/\/+$/, '');
	const probe = solid === '' ? null : join(appDir, solid);
	return probe !== null && existsSync(probe);
}

export function checkDocPaths() {
	const failures = [];
	for (const doc of ['AGENTS.md', 'README.md']) {
		const path = join(appDir, doc);
		if (!existsSync(path)) continue;
		const seen = new Set();
		for (const token of candidates(readFileSync(path, 'utf8'))) {
			if (seen.has(token)) continue;
			seen.add(token);
			if (!pathExists(token)) failures.push(`${doc}: \`${token}\` does not exist in the tree`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Documentation path failures (docs/redundancy-cleanup-plan.md §6):\n  ${failures.join('\n  ')}`);
	}
	return failures.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	checkDocPaths();
	console.log('check-doc-paths: every documented path exists.');
}
