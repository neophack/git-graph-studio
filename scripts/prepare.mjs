// Assembles everything the app build consumes under <project>/target/studio/, so no generated
// file ever lands in the source tree:
//
//   target/studio/public/   the Vite public dir: static/** plus the extension README renderer's
//                           markdown-it vendor copy — nothing of any plugin (each plugin's
//                           packer, under plugins/, builds its own package contents)
//   target/studio/icons/    the app icons `tauri icon` derives from the app's own icon source
//   target/studio/cargo/    the Cargo target dir (src-tauri/.cargo/config.toml)
//   target/studio/dist/     the Vite build output (vite.config.ts)
//
// The bundled `.ggx` packages the installer carries are each plugin's own packer's output —
// prepare.mjs only builds their backends and delegates (it never reaches into a plugin's
// sources, and never into the vscode-git-graph-rs submodule: only git-graph-rs's packer does).
import { checkSeams } from './check-seams.mjs';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

// The seam rules first: nothing under src/ or static/ may name the git-graph-rs extension's
// artifacts (it is a plugin; the app's only interface to it is the extension platform), so a
// violation fails the build before anything is assembled.
checkSeams();
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// The git-graph-rs extension lives in its own repository, checked out as the vscode-git-graph-rs/ submodule.
const root = join(appDir, 'vscode-git-graph-rs');
const out = join(appDir, 'target', 'studio');
const publicDir = join(out, 'public');

function requireArtifact(path, hint) {
	if (!existsSync(path)) {
		console.error(`${path} not found - ${hint}`);
		process.exit(1);
	}
	return path;
}

/* 1. The public dir: the app's static sources and the README renderer's markdown-it. */
// Windows keeps handles on the public dir for a moment after a dev server or Explorer
// touched it; retrying makes the build resilient to that instead of failing with EPERM.
rmSync(publicDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(publicDir, { recursive: true });
cpSync(join(appDir, 'static'), publicDir, { recursive: true });

const vendorDir = join(publicDir, 'vendor');
mkdirSync(vendorDir, { recursive: true });
copyFileSync(
	requireArtifact(join(root, 'media', 'vendor', 'markdown-it.min.js'), 'run `npm run compile` in vscode-git-graph-rs/ first'),
	join(vendorDir, 'markdown-it.min.js')
);

// The app's own chrome icon (the title bar's logo) — one asset copy from the icon set the
// extension ships, the same source the installer icon derives from below.
const iconsDir = join(publicDir, 'icons');
mkdirSync(iconsDir, { recursive: true });
copyFileSync(requireArtifact(join(root, 'resources', 'icon.png'), 'the submodule is checked out'), join(iconsDir, 'icon.png'));

/* 2. The app icons, once. */
const appIcons = join(out, 'icons');
if (!existsSync(join(appIcons, 'icon.ico')) || !existsSync(join(appIcons, '32x32.png'))) {
	mkdirSync(appIcons, { recursive: true });
	const tauri = join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
	const result = spawnSync(tauri, ['icon', join(root, 'resources', 'icon.png'), '-o', appIcons], {
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		console.error('Generating the app icons failed');
		process.exit(1);
	}
}

/* 3. The plugin backends. The git-graph-rs engine backend (`git-graph-backend`, the `engine`
 *    Cargo feature) is the only binary that links `git-graph-core`; the app itself never does
 *    (src-tauri/build.rs's seam check). Release, so the shipped package carries the same
 *    size-optimised binary `tauri build` produces for the app itself; cargo's incremental
 *    cache keeps repeat builds (dev iteration) fast after the first. The sample plugin's own
 *    backend is a plain no-default-features build of its [[bin]]. */
const srcTauri = join(appDir, 'src-tauri');
function buildBackend(bin, features) {
	const exe = process.platform === 'win32' ? `${bin}.exe` : bin;
	const built = spawnSync(
		'cargo',
		['build', '--release', '--bin', bin, ...(features ? ['--no-default-features', '--features', features] : ['--no-default-features'])],
		{ cwd: srcTauri, stdio: 'inherit', shell: process.platform === 'win32' }
	);
	if (built.status === 0) {
		const path = join(out, 'cargo', 'release', exe);
		if (existsSync(path)) return path;
		console.warn(`${path} was not produced; packing ${bin} without its backend`);
		return undefined;
	}
	console.warn(`Building ${bin} failed; packing without its backend`);
	return undefined;
}
const backendPath = buildBackend('git-graph-backend', 'engine');
const demoBin = buildBackend('ggs-ext-demo', null);

/* 4. The bundled `.ggx` packages — the app ships extensions as packages beside the app, not
 *    as embedded built-ins: tauri.conf.json's bundle.resources packs the fixed-name copies
 *    under app-resources/extensions/ so the installer carries them, and the app lists and
 *    installs them by scanning that directory (cmd_ext.rs — it names no id). Each package is
 *    its own plugin's packer's output; this file never reaches into a plugin's sources for
 *    packaging. */
const { buildGgx } = await import('../plugins/git-graph-rs/build.mjs');
const { target: ggxPath } = await buildGgx({ backend: backendPath });
const { buildDemo } = await import('../plugins/ggs-ext-demo/build.mjs');
const { target: demoGgxPath } = await buildDemo({ bin: demoBin });
const bundledDir = join(out, 'bundled', 'app-resources', 'extensions');
mkdirSync(bundledDir, { recursive: true });
copyFileSync(ggxPath, join(bundledDir, 'git-graph-rs.ggx'));
copyFileSync(demoGgxPath, join(bundledDir, 'ggs-ext-demo.ggx'));

console.log(`Prepared ${out}`);
