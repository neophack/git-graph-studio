// Module 15 — Build & Release Pipeline.
//
// Runs `npm run build:vite` only when the frontend actually changed since the last
// build — the local build-studio path (scripts/build-studio.bat) calls this instead
// of building unconditionally, so a Rust-only one-line edit skips the ~35 s of the
// two vite passes entirely. The stamp under target/studio/dist records the last
// build's frontend state: a git tree hash over the watched paths' CONTENT (tracked
// edits, untracked files and deletions all move it; a commit over identical content
// keeps it, and that skip is correct). The earlier key — the newest frontend commit
// plus a dirty flag — could not see a second dirty edit: an entire session of
// uncommitted work shared one `-dirty` key, so a build after fresh edits kept
// packaging the previous dist.
//
// The stamp lives inside the dist dir, which vite empties on every build — written
// after the build, it survives exactly until the next real build replaces it.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = join(root, 'target', 'studio', 'dist', '.vite-stamp');
const watched = ['src', 'static', 'index.html', 'vite.config.ts', 'vite.remote.config.ts'];

function run(cmd, env) {
	return execSync(cmd, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...(env ?? {}) }
	}).trim();
}

let key;
try {
	// Stage the watched paths into a throwaway index and hash the tree — the content
	// fingerprint, without touching the real index. A `git add` can hit a live
	// `index.lock` (an editor's git polling), so one retry after a beat.
	const indexFile = join(mkdtempSync(join(tmpdir(), 'ggs-vite-')), 'index');
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				run(`git add -A -- ${watched.join(' ')}`, { GIT_INDEX_FILE: indexFile });
				key = run('git write-tree', { GIT_INDEX_FILE: indexFile });
				break;
			} catch (error) {
				if (attempt > 0 || !String(error).includes('index.lock')) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
			}
		}
	} finally {
		rmSync(dirname(indexFile), { recursive: true, force: true });
	}
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
