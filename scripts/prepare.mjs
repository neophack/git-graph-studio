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
// The bundled VSIX packages the installer carries are the marketplace's per-architecture
// builds (Open VSX — fetched by scripts/fetch-marketplace-extensions.mjs; offline the
// git-graph-rs package is the submodule's own `npm run package` VSIX). Which packages ride
// in the installer is a build-time choice (GGS_BUNDLE_GIT_GRAPH / GGS_BUNDLE_CLAUDE_CODE —
// CI's release form forwards its checkboxes); the first launch installs whatever was
// packed, like VS Code's bundled extensions.
import { checkSeams } from './check-seams.mjs';
import { fetchMarketplacePackages } from './fetch-marketplace-extensions.mjs';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

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

/* 3. The plugin binaries. The pretend Node runtime (`ggs-node`, the `node-runtime`
 *    feature) is the one bundled sidecar: it runs a package's own JS entry (CommonJS and
 *    the builtins) as its backend, so a VSIX can ship an `out/main.js`. It is the default
 *    `node`-backend host and needs no Node on the machine — a package's `.node` loads
 *    inside it (the N-API host); a real Node runtime hosts the entries only under
 *    `GGS_REAL_NODE=1` (node-host.cjs, built in step 3½). Release, so the shipped binary
 *    is as size-optimised as `tauri build`'s own; cargo's incremental cache keeps repeat
 *    builds (dev iteration) fast after the first. The engine `.node` itself is built by
 *    the submodule's addon script (`@napi-rs/cli`): one NAPI binary — the VSIX carries it
 *    and nothing else. */
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
 * substituting a specific build means it. A fetch failure downgrades here: git-graph-rs
 * falls back to the locally packed VSIX (built below); claude-code is simply not packed
 * (in CI a required miss fails the fetch itself). */
const externalVsix = (() => {
	const flag = process.argv.indexOf('--vsix');
	return flag >= 0 ? process.argv[flag + 1] : process.env.GGS_BUNDLED_VSIX;
})();
const marketplace = await fetchMarketplacePackages({ cacheDir: join(out, 'marketplace-cache') });
const gitGraphMarketplace = marketplace['git-graph-rs'];
// Nothing of an unselected package ships: not the registry's build, not the local one.
const packGitGraph = Boolean(externalVsix) || gitGraphMarketplace?.selected !== false;

/* The engine `.node`: the submodule's addon build, cached by cargo underneath — it runs
 * whenever git-graph-rs is packed, whatever the payload's source: besides the locally
 * packed VSIX carrying it, the build is what keeps the submodule's
 * `native/<platform>/git-graph.node` on the machine, the fixture node_runtime's N-API
 * roundtrip test resolves first (without it the test would fall back to — or skip on —
 * whatever engine happens to be installed, and CI, which installs nothing, would skip it
 * entirely). Skipped under `--vsix` (the substituted package carries its own engine and
 * the submodule compiles nothing) and when git-graph-rs is not packed at all. */
const engineNode = externalVsix || !packGitGraph
	? null
	: (() => {
		const addon = spawnSync('node', ['scripts/build-addon.mjs', '--release'], {
			cwd: root,
			stdio: 'inherit'
		});
		const directories = {
			'win32-x64': 'win32-x64-msvc',
			'win32-arm64': 'win32-arm64-msvc',
			'linux-x64': 'linux-x64-gnu',
			'linux-arm64': 'linux-arm64-gnu',
			'darwin-x64': 'darwin-x64',
			'darwin-arm64': 'darwin-arm64'
		};
		const path = join(root, 'native', directories[`${process.platform}-${process.arch}`] ?? `${process.platform}-${process.arch}`, 'git-graph.node');
		if (addon.status === 0 && existsSync(path)) return path;
		// An installer whose Git Graph VSIX has no engine is an installer whose flagship view
		// cannot run — that is a broken build, not a degraded one, so it fails here with the
		// reason instead of quietly shipping a frontend-only package.
		console.error(`The engine .node was not produced (${addon.status ?? 'spawn failed'}; looked at ${path}) — refusing to pack a VSIX without its engine`);
		process.exit(1);
	})();

/* 4. The bundled packages — the app ships extensions as packages beside the app, not
 *    as embedded built-ins: tauri.conf.json's bundle.resources packs this whole directory
 *    (a directory mapping, so the file set is the build's to decide — an unpacked
 *    selection leaves no file behind) and the app's first-launch pass installs exactly
 *    what sits at its top level (cmd_ext::install_missing_bundled — it names no id).
 *
 *      extensions/git-graph-rs.vsix   the marketplace's build (or, offline / under
 *                                     --vsix, the extension's own standard build)
 *      extensions/claude-code.vsix    the marketplace's build, when the build chose
 *                                     to pack it
 *
 *    The directory is rebuilt from nothing every run (a stale file here would ship: the
 *    mapping packs whatever sits in it). `--vsix <path>` (or GGS_BUNDLED_VSIX) substitutes
 *    a ready-built package for git-graph-rs: the named VSIX is bundled as-is — its
 *    engine, its manifest, its code — and nothing in the submodule compiles. */
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
	console.warn('git-graph-rs: marketplace fetch unavailable — packing the submodule build instead');
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const packaged = spawnSync('npm', ['run', 'package'], {
		cwd: root,
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	const vsixPath = requireArtifact(
		join(root, `git-graph-rs-${pkg.version}.vsix`),
		`npm run package in vscode-git-graph-rs/ failed (${packaged.status ?? 'spawn failed'})`
	);
	copyFileSync(vsixPath, join(bundledDir, 'git-graph-rs.vsix'));
}

/* claude-code is packed or left out by the same build-time choice (the release form's
 * checkbox — unchecked by default there, so a tag release ships without it; local builds
 * pack it unless GGS_BUNDLE_CLAUDE_CODE=0). */
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
