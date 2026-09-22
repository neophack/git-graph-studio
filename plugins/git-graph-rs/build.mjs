// git-graph-rs's own packer: builds `git-graph-rs-<version>.ggx` (docs/ggs-development-plan.md
// §8.2) — the only script that reads the `vscode-git-graph-rs` submodule to do it. `ggs` itself
// (scripts/prepare.mjs, the app's own asset pipeline) never reaches into the submodule for
// this — it calls `buildGgx` here and gets back a finished package, the same way it calls any
// other plugin's packer. (`prepare.mjs` does separately compile the submodule's *webview*
// assets through `compare-bundle.mjs` for the app's embedded fallback view — that is the
// documented TypeScript seam, `graphHost.ts`/`graphPreload.ts`, and is unrelated to packing
// this plugin's `.ggx`.)
//
//   target/studio/bundled/git-graph-rs-<version>.ggx
//     manifest.json                       the ggx header (id, version, the page registry, the backend)
//     package.json                        the extension's manifest (contribution points, NLS, icon)
//     package.nls*.json, README.md, LICENSE.txt, licenses/, resources/
//     web/                                view.html, out.min.js/css, config.js, compare.js, markdown-it, highlight
//     backend/<platformKey>/git-graph-backend[.exe]   src/main.rs, compiled — this build host's platform only
//
// `src/main.rs` is this plugin's own backend: the `git-graph-backend` binary
// (`src-tauri/Cargo.toml`'s `[[bin]] name = "git-graph-backend"`, the `engine` Cargo feature —
// the only place `git-graph-core` links). `scripts/prepare.mjs` compiles it, then calls
// `buildGgx({ backend: <path> })`; `scripts/build-plugins.bat` does the same standalone.
//
// Usage: node plugins/git-graph-rs/build.mjs [--out <file>] [--backend <path-to-git-graph-backend[.exe]>]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { filesUnder, hostPlatformKey, writeGgx } from '../../scripts/build-ggx.mjs';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(pluginDir, '..', '..');
// The git-graph-rs extension lives in its own repository, checked out as the vscode-git-graph-rs/ submodule.
const root = join(appDir, 'vscode-git-graph-rs');
const studio = join(appDir, 'target', 'studio');

/** The `manifest.json` of the package. `backendPath` is the compiled `git-graph-backend`
 * binary for this host, or `undefined` to pack frontend-only. */
export function ggxManifest(pkg, { permissions = ['repo:read', 'git:write', 'clipboard', 'terminal', 'network'], backendPath } = {}) {
	const manifest = {
		format: 'ggx/2',
		id: `${pkg.publisher}.${pkg.name}`,
		version: pkg.version,
		displayName: pkg.displayName ?? pkg.name,
		engines: { ggs: '>=0.1.0' },
		// The legacy frontend block stays (the host machinery GraphHost serves: the config
		// and compare page generators), and the named page registry joins it — ggx/2's
		// openable page of this package is "view".
		frontend: { kind: 'webview', page: 'web/view.html', config: 'web/config.js', compare: 'web/compare.js' },
		pages: { view: { page: 'web/view.html' } },
		permissions
	};
	if (backendPath) {
		const exe = process.platform === 'win32' ? 'git-graph-backend.exe' : 'git-graph-backend';
		const command = `backend/${hostPlatformKey()}/${exe}`;
		manifest.backend = { kind: 'process', protocol: 'ggx-rpc/1', command, binaries: { [hostPlatformKey()]: command } };
	}
	return manifest;
}

export async function buildGgx({ out, backend } = {}) {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	// `%displayName%` and friends resolve through the default NLS file, as VS Code does.
	const nlsPath = join(root, 'package.nls.json');
	const nls = existsSync(nlsPath) ? JSON.parse(readFileSync(nlsPath, 'utf8')) : {};
	if (typeof pkg.displayName === 'string') pkg.displayName = pkg.displayName.replace(/^%(.+)%$/, (_, key) => nls[key] ?? key);
	const target = out ?? join(studio, 'bundled', `${pkg.name}-${pkg.version}.ggx`);
	const entries = [];

	// The frontend: the artefacts prepare.mjs assembled into the public dir (the same files
	// the app serves from /gitgraph/ when no package is installed).
	const web = join(studio, 'public', 'gitgraph');
	if (!existsSync(join(web, 'out.min.js'))) throw new Error(`${web} is missing; run scripts/prepare.mjs first`);
	// Only the extension's own files: the host injects its theme tokens into the page at
	// load, so no Studio stylesheet travels inside the package.
	entries.push(...filesUnder(web, 'web/'));

	// The extension's own manifest and assets, straight from the plugin submodule.
	for (const file of readdirSync(root)) {
		if (!statSync(join(root, file)).isFile()) continue;
		if (/^package(\.nls(\.[a-z-]+)?)?\.json$/i.test(file) || /^README\.md$/i.test(file) || /^LICENSE/i.test(file)) entries.push([file, join(root, file)]);
	}
	for (const dir of ['resources', 'licenses']) {
		if (existsSync(join(root, dir))) entries.push(...filesUnder(join(root, dir), `${dir}/`));
	}

	// The engine backend (this plugin's own src/main.rs, compiled): this host's platform only
	// (matching the reference packer's own admitted scope — no per-platform CI matrix yet).
	// Without one, `ggxManifest` omits the `backend` block and the package stays frontend-only.
	let backendEntry;
	if (backend) {
		if (!existsSync(backend)) throw new Error(`--backend ${backend} does not exist`);
		const exe = process.platform === 'win32' ? 'git-graph-backend.exe' : 'git-graph-backend';
		backendEntry = [`backend/${hostPlatformKey()}/${exe}`, backend];
		entries.push(backendEntry);
	}

	const manifest = ggxManifest(pkg, { backendPath: backendEntry?.[1] });
	const bytes = await writeGgx(target, entries, { 'manifest.json': JSON.stringify(manifest, null, '\t') + '\n' }, join(root, 'package.json'));
	console.log(
		`Built ${relative(root, target)}: ${entries.length + 1} entries, ${(bytes / 1024).toFixed(0)} KB` +
			(backend ? '' : ' (no backend)')
	);
	return { target, manifest, bytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const value = (flag) => (args.indexOf(flag) === -1 ? undefined : args[args.indexOf(flag) + 1]);
	buildGgx({ out: value('--out'), backend: value('--backend') }).catch((error) => {
		console.error(error.message ?? error);
		process.exit(1);
	});
}
