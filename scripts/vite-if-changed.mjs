// Module 15 — Build & Release Pipeline.
//
// Runs `npm run build:vite` only when the frontend actually changed since the last
// build — the local build-studio path (scripts/build-studio.bat) calls this instead
// of building unconditionally, so a Rust-only one-line edit skips the ~35 s of the
// two vite passes entirely. The stamp under target/studio/dist records the last
// build's frontend state: the newest commit that touched the frontend plus a dirty
// flag for uncommitted changes under the watched paths (a new frontend commit, a
// branch switch, or a dirty edit invalidates it; anything else is a skip).
//
// The stamp lives inside the dist dir, which vite empties on every build — written
// after the build, it survives exactly until the next real build replaces it.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = join(root, 'target', 'studio', 'dist', '.vite-stamp');
const watched = ['src', 'static', 'index.html', 'vite.config.ts', 'vite.remote.config.ts'];

function run(cmd) {
	return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let key;
try {
	const head = run(`git log -1 --format=%H -- ${watched.join(' ')}`);
	const dirty = run(`git status --porcelain -- ${watched.join(' ')}`) !== '' ? '-dirty' : '';
	key = head + dirty;
} catch {
	// git unavailable (or not a worktree) — always build rather than serve a stale dist.
	key = `unknown-${Date.now()}`;
}

if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === key) {
	console.log('[vite] the frontend is unchanged since the last build - skipping vite');
	process.exit(0);
}

execSync('npm run build:vite', { cwd: root, stdio: 'inherit' });
mkdirSync(dirname(stampPath), { recursive: true });
writeFileSync(stampPath, `${key}\n`);
