// Assembles everything the app build consumes under <project>/target/studio/, so no generated
// file ever lands in the source tree:
//
//   target/studio/public/   the Vite public dir: static/** (the theme files, the README
//                           renderer's vendored markdown-it, the chrome icon) — nothing of
//                           any plugin (each package builds its own contents, elsewhere)
//   target/studio/icons/    the app icons `tauri icon` derives from the app's own icon source
//   target/studio/cargo/    the Cargo target dir (src-tauri/.cargo/config.toml)
//   target/studio/dist/     the Vite build output (vite.config.ts)
//
// The bundled VSIX packages the installer carries are the marketplace's per-architecture
// builds (Open VSX — fetched by scripts/fetch-marketplace-extensions.mjs; there is no local
// source anymore, so a fetch that cannot be served from cache leaves the package unpacked —
// or fails the build in require mode). Which packages ride in the installer is a build-time
// choice (GGS_BUNDLE_GIT_GRAPH / GGS_BUNDLE_CLAUDE_CODE — CI's release form forwards its
// checkboxes): git-graph-rs rides in every build, claude-code in none by default (the
// Extensions view installs it from the marketplace on demand). The first launch installs
// whatever was packed, like VS Code's bundled extensions.
import { checkSeams } from './check-seams.mjs';
import { fetchMarketplacePackages } from './fetch-marketplace-extensions.mjs';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

// The seam rules first: nothing under src/ or static/ may name the git-graph-rs extension's
// artifacts (it is a plugin; the app's only interface to it is the extension platform), so a
// violation fails the build before anything is assembled.
checkSeams();
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
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

// The app's own chrome icon (the title bar's logo, served at /icons/icon.png) doubles as
// the source every installer icon derives from below — an app asset since the extension
// left this tree, carried in static/ like every other public file.
const iconSource = requireArtifact(join(appDir, 'static', 'icons', 'icon.png'), 'static/icons/icon.png is missing from the source tree');

/* 2. The app icons, once. */
const appIcons = join(out, 'icons');
if (!existsSync(join(appIcons, 'icon.ico')) || !existsSync(join(appIcons, '32x32.png'))) {
	mkdirSync(appIcons, { recursive: true });
	const tauri = join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
	const result = spawnSync(tauri, ['icon', iconSource, '-o', appIcons], {
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		console.error('Generating the app icons failed');
		process.exit(1);
	}
}

/* 3. The plugin binaries. The pretend Node runtime (`ggs-node`, the `node-runtime`
 *    feature) is the one bundled sidecar: it runs a package's own JS entry (CommonJS and
 *    the builtins) as its backend, so a VSIX can ship an `out/main.js`. It is the default
 *    `node`-backend host and needs no Node on the machine — a package's `.node` loads
 *    inside it (the N-API host); a real Node runtime hosts the entries only under
 *    `GGS_REAL_NODE=1` (node-host.cjs, built in step 3½). Release, so the shipped binary
 *    is as size-optimised as `tauri build`'s own; cargo's incremental cache keeps repeat
 *    builds (dev iteration) fast after the first. A package's own `.node` addon arrives
 *    inside its VSIX — nothing of any plugin compiles here anymore. */
const srcTauri = join(appDir, 'src-tauri');
function buildBackend(bin, features) {
	const exe = process.platform === 'win32' ? `${bin}.exe` : bin;
	// The sidecar's own profile: the release size diet with unwinding panics, because it
	// runs third-party JS whose poisoned closures must degrade, not abort the backend.
	const profile = 'ggs-node';
	// Where cargo actually puts artifacts: `.cargo/config.toml` says `../target/studio/cargo`,
	// but a caller's CARGO_TARGET_DIR env overrides the config — the Linux container pass
	// exports one onto its cache volume, and the sidecar was once looked for where it never
	// landed (build exit 0, binary missing, "refusing to pack"). `cargo metadata` resolves
	// the same precedence cargo itself builds with.
	const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'],
		{ cwd: srcTauri, encoding: 'utf8', shell: process.platform === 'win32' });
	let targetDir = join(out, 'cargo');
	try {
		const resolved = JSON.parse(meta.stdout ?? '').target_directory;
		if (typeof resolved === 'string' && resolved !== '') targetDir = resolved;
	} catch {
		// unparseable metadata — the configured guess above stands
	}
	const built = spawnSync(
		'cargo',
		['build', '--profile', profile, '--bin', bin, ...(features ? ['--no-default-features', '--features', features] : ['--no-default-features'])],
		{ cwd: srcTauri, stdio: 'inherit', shell: process.platform === 'win32' }
	);
	// The sidecars an installer serves are part of the product, not optional extras: a
	// build without them is broken, so it fails with the reason instead of shipping an
	// app whose extension packages cannot start.
	const path = join(targetDir, profile, exe);
	if (built.status === 0 && existsSync(path)) return path;
	console.error(`Building ${bin} failed (${built.status ?? 'spawn failed'}; looked at ${path}) — refusing to pack without it`);
	process.exit(1);
}
const nodeRuntimeBin = buildBackend('ggs-node', 'node-runtime');

/* The sidecar copy Tauri bundles: externalBin wants `<name>-<target-triple>[.exe]`, which the
 * installer drops next to the main binary (that is where ext_process's host lookup finds it). */
if (nodeRuntimeBin) {
	const TRIPLES = {
		'win32-x64': 'x86_64-pc-windows-msvc',
		'win32-arm64': 'aarch64-pc-windows-msvc',
		'linux-x64': 'x86_64-unknown-linux-gnu',
		'linux-arm64': 'aarch64-unknown-linux-gnu',
		'darwin-x64': 'x86_64-apple-darwin',
		'darwin-arm64': 'aarch64-apple-darwin'
	};
	const triple = TRIPLES[`${process.platform}-${process.arch}`] ?? `${process.platform}-${process.arch}`;
	const sidecarDir = join(out, 'bundled', 'binaries');
	mkdirSync(sidecarDir, { recursive: true });
	copyFileSync(nodeRuntimeBin, join(sidecarDir, `ggs-node-${triple}${process.platform === 'win32' ? '.exe' : ''}`));
}

/* 3½. The real-Node extension host bundle (`node-host.cjs`): the entry a system Node runs
 * as one extension's host process when a runtime is available — the same `vscode` shim the
 * sandboxed frames carry, over the ggs-ext/1 stdio channel, with `require('vscode')`
 * intercepted and every other require resolving through Node's own machinery (a package's
 * `.node` NAPI addon, its ESM, its workers, its `node_modules`). Bundled by the app's own
 * Vite (lib mode, CommonJS, node builtins external); shipped beside the binaries through
 * tauri.conf.json's bundle.resources, and copied to target/studio/ for the dev lookup. */
{
	const { build } = await import('vite');
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			outDir: join(out, 'bundled', 'app-resources'),
			emptyOutDir: false,
			minify: false,
			sourcemap: false,
			target: 'node20',
			lib: {
				entry: join(appDir, 'src', 'nodeHost.ts'),
				formats: ['cjs'],
				fileName: () => 'node-host.cjs'
			},
			rollupOptions: {
				external: [/^node:/]
			}
		}
	});
	copyFileSync(join(out, 'bundled', 'app-resources', 'node-host.cjs'), join(out, 'node-host.cjs'));

	// The `vscode` shim for ggs-node's own hosting of frame programs: an IIFE the Boa
	// context evaluates, installing `__ggsVscodeShim` on its global.
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			outDir: join(out, 'bundled', 'app-resources'),
			emptyOutDir: false,
			minify: false,
			sourcemap: false,
			target: 'node20',
			lib: {
				entry: join(appDir, 'src', 'ggsVscodeShim.ts'),
				formats: ['iife'],
				name: '__ggsVscodeShim'
			},
			rollupOptions: {
				output: { entryFileNames: 'vscode-shim.cjs' }
			}
		}
	});
	copyFileSync(join(out, 'bundled', 'app-resources', 'vscode-shim.cjs'), join(out, 'vscode-shim.cjs'));
}

/* The marketplace packages the installer carries (Open VSX, per architecture — see
 * scripts/fetch-marketplace-extensions.mjs). Which packages are packed is the build's
 * choice (the GGS_BUNDLE_* env, the release form's checkboxes in CI); `--vsix`/
 * GGS_BUNDLED_VSIX still outranks the registry for git-graph-rs — a developer
 * substituting a specific build means it. There is no local source anymore (the
 * extension lives in its own repository, outside this tree): a selected package that the
 * fetch cannot serve fails the build in require mode (CI, build-studio.bat) and is
 * simply not packed otherwise. */
const externalVsix = (() => {
	const flag = process.argv.indexOf('--vsix');
	return flag >= 0 ? process.argv[flag + 1] : process.env.GGS_BUNDLED_VSIX;
})();
const marketplace = await fetchMarketplacePackages({ cacheDir: join(out, 'marketplace-cache') });
const gitGraphMarketplace = marketplace['git-graph-rs'];
// Nothing of an unselected package ships.
const packGitGraph = Boolean(externalVsix) || gitGraphMarketplace?.selected !== false;

/* 4. The bundled packages — the app ships extensions as packages beside the app, not
 *    as embedded built-ins: tauri.conf.json's bundle.resources packs this whole directory
 *    (a directory mapping, so the file set is the build's to decide — an unpacked
 *    selection leaves no file behind) and the app's first-launch pass installs exactly
 *    what sits at its top level (cmd_ext::install_missing_bundled — it names no id).
 *
 *      extensions/git-graph-rs.vsix   the marketplace's build (or the --vsix
 *                                     substitution, verbatim)
 *      extensions/claude-code.vsix    the marketplace's build, only when a build
 *                                     explicitly selected it
 *
 *    The directory is rebuilt from nothing every run (a stale file here would ship: the
 *    mapping packs whatever sits in it). `--vsix <path>` (or GGS_BUNDLED_VSIX) substitutes
 *    a ready-built package for git-graph-rs: the named VSIX is bundled as-is — its
 *    engine, its manifest, its code. */
const bundledDir = join(out, 'bundled', 'app-resources', 'extensions');
rmSync(bundledDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(bundledDir, { recursive: true });
if (externalVsix) {
	copyFileSync(requireArtifact(externalVsix, 'the --vsix path names a file that does not exist'), join(bundledDir, 'git-graph-rs.vsix'));
} else if (!packGitGraph) {
	console.log('git-graph-rs: not selected for this build — not packed (the Extensions view installs it from the marketplace)');
} else if (gitGraphMarketplace?.path) {
	copyFileSync(gitGraphMarketplace.path, join(bundledDir, 'git-graph-rs.vsix'));
	console.log(`Packed git-graph-rs ${gitGraphMarketplace.version} @${gitGraphMarketplace.targetPlatform} from the marketplace`);
} else {
	console.warn('git-graph-rs: marketplace fetch unavailable — not packed (the Extensions view installs it from the marketplace)');
}

/* claude-code is left out by the same build-time choice, and its default is out
 * (2026-09-28, the owner's direction: the Extensions view's marketplace row
 * installs it on demand, so the default download stays small); only
 * GGS_BUNDLE_CLAUDE_CODE=1 — or CI's release form checking its box — packs it. */
const claudeCode = marketplace['claude-code'];
if (claudeCode?.path) {
	copyFileSync(claudeCode.path, join(bundledDir, 'claude-code.vsix'));
	console.log(`Packed claude-code ${claudeCode.version} @${claudeCode.targetPlatform} from the marketplace`);
} else if (claudeCode?.selected === false) {
	console.log('claude-code: not selected for this build — not packed (the Extensions view installs it from the marketplace)');
} else {
	console.warn('claude-code: the marketplace fetch failed — not packed (a required build would have failed already)');
}

console.log(`Prepared ${out}`);
