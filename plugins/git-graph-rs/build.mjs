// git-graph-rs's own packer: builds `git-graph-rs-<version>.ggx` fully self-contained — the
// only script that reads the `vscode-git-graph-rs` submodule, and the one place the extension
// is turned into a package. The app (`scripts/prepare.mjs`) calls `buildGgx` here for the
// bundled copy and never reaches into the submodule itself.
//
//   target/studio/bundled/git-graph-rs-<version>.ggx
//     manifest.json                       the ggx header (id, version, the page registry, the backend)
//     package.json                        the extension's manifest (contribution points, NLS, icon)
//     package.nls*.json, README.md, LICENSE.txt, licenses/, resources/
//     web/                                the pages this package serves over ggx://:
//                                         view.html / compare.html / binarycompare.html (authored
//                                         shells), bridge.js / compare-bridge.js (the in-page
//                                         extension host), config.js, viewpage.js, compare.js,
//                                         binarycompare.js, out.min.js/css, markdown-it, highlight
//     backend/<platformKey>/git-graph-backend[.exe]   src/main.rs + engine_impl + writes + gerrit,
//                                         compiled — this build host's platform only
//
// Usage: node plugins/git-graph-rs/build.mjs [--out <file>] [--backend <path-to-git-graph-backend[.exe]>]

import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { filesUnder, hostPlatformKey, writeGgx } from '../../scripts/build-ggx.mjs';
import { buildBinaryCompareBundle, buildCompareBundle, buildViewPageBundle } from './bundle.mjs';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(pluginDir, '..', '..');
// The git-graph-rs extension lives in its own repository, checked out as the vscode-git-graph-rs/ submodule.
const root = join(appDir, 'vscode-git-graph-rs');
const studio = join(appDir, 'target', 'studio');
const staging = join(studio, 'plugin', 'git-graph-rs');

/** The page tabs' icon: the extension's colour webview icon. */
const PAGE_ICON = 'resources/git-graph-rs-webview-icon.svg';

/** The `manifest.json` of the package. `backendPath` is the compiled `git-graph-backend`
 * binary for this host, or `undefined` to pack frontend-only. */
export function ggxManifest(pkg, { permissions = ['repo:read', 'git:write', 'clipboard', 'terminal', 'fs', 'network'], backendPath } = {}) {
	const manifest = {
		format: 'ggx/2',
		id: `${pkg.publisher}.${pkg.name}`,
		version: pkg.version,
		displayName: pkg.displayName ?? pkg.name,
		engines: { ggs: '>=0.1.0' },
		// Every page the package can show. `view` is the singleton the manifest's view command
		// reveals (a second open focuses the tab and delivers its params as an event);
		// `compare` and `binarycompare` are the graph's own diff surfaces, each open its own tab.
		// Each page's tab wears the extension's colour icon (its webview panels' own).
		pages: {
			view: { page: 'web/view.html', title: 'Git Graph', singleton: true, icon: PAGE_ICON },
			compare: { page: 'web/compare.html', icon: PAGE_ICON },
			binarycompare: { page: 'web/binarycompare.html', icon: PAGE_ICON }
		},
		// The view's activity-bar entry: the grey icon the app used to hardcode there, now the
		// package's own declaration — a click runs the view command (which opens `view`).
		activitybar: { command: 'git-graph-rs.view', title: 'Git Graph', icon: 'resources/git-graph-rs-webview-icon-dark.svg' },
		permissions
	};
	if (backendPath) {
		const exe = process.platform === 'win32' ? 'git-graph-backend.exe' : 'git-graph-backend';
		const command = `backend/${hostPlatformKey()}/${exe}`;
		manifest.backend = { kind: 'process', protocol: 'ggx-rpc/1', command, binaries: { [hostPlatformKey()]: command } };
	}
	return manifest;
}

/** The config bundle's entry source: `config-stdin.js` with its `require(CONFIG_PATH)` aimed at
 * the compiled `config.js`. The call itself is replaced — the placeholder's name also appears
 * in the file's comment, and a bare `CONFIG_PATH` left in the code is a ReferenceError when the
 * page loads the bundle (the view then fails with "config.js did not load"). */
export function configEntry(source, configPath) {
	const call = 'require(CONFIG_PATH)';
	if (!source.includes(call)) throw new Error(`config-stdin.js no longer contains ${call}`);
	return source.replace(call, `require(${JSON.stringify(configPath)})`);
}

/** The thin authored shells the package's pages boot from: everything the user sees is still
 *  the extension's own generated page — these only load the bridge, which generates and swaps
 *  the document (the app's protocol serves them with the ggx bootstrap composed in). */
function pageShells(webStaging) {
	writeFileSync(join(webStaging, 'view.html'), [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head><meta charset="utf-8"><title>Git Graph</title>',
		'<script src="config.js"></script>',
		'<script src="viewpage.js"></script>',
		'<script src="bridge.js"></script>',
		'</head>',
		'<body><div style="padding:20px;color:var(--vscode-descriptionForeground,#888)">Loading Git Graph…</div></body>',
		'</html>\n'
	].join('\n'));
	writeFileSync(join(webStaging, 'compare.html'), [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head><meta charset="utf-8"><title>Commit Comparison</title>',
		'<script src="compare-bridge.js"></script>',
		'</head>',
		'<body></body>',
		'</html>\n'
	].join('\n'));
	writeFileSync(join(webStaging, 'binarycompare.html'), [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head><meta charset="utf-8"><title>Binary Compare</title>',
		'<script src="compare.js"></script>',
		'<script src="compare-bridge.js"></script>',
		'</head>',
		'<body></body>',
		'</html>\n'
	].join('\n'));
}

export async function buildGgx({ out, backend } = {}) {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	// `%displayName%` and friends resolve through the default NLS file, as VS Code does.
	const nlsPath = join(root, 'package.nls.json');
	const nls = existsSync(nlsPath) ? JSON.parse(readFileSync(nlsPath, 'utf8')) : {};
	if (typeof pkg.displayName === 'string') pkg.displayName = pkg.displayName.replace(/^%(.+)%$/, (_, key) => nls[key] ?? key);
	const target = out ?? join(studio, 'bundled', `${pkg.name}-${pkg.version}.ggx`);
	const entries = [];

	/* 1. The web staging: the extension's compiled assets, the page bundles, the config
	      bundle, the authored shells and the two bridges — everything the pages load. */
	rmSync(staging, { recursive: true, force: true });
	const web = join(staging, 'web');
	mkdirSync(web, { recursive: true });
	for (const [from, to] of [
		['media/out.min.js', 'out.min.js'],
		['media/out.min.css', 'out.min.css'],
		['media/vendor/markdown-it.min.js', 'markdown-it.min.js'],
		['media/vendor/highlight.min.js', 'highlight.min.js']
	]) {
		const source = join(root, from);
		if (!existsSync(source)) throw new Error(`${source} is missing; run \`npm run compile\` in vscode-git-graph-rs/ first`);
		copyFileSync(source, join(web, to));
	}

	// The runtime config bundle: the extension's compiled src/config.ts behind the override
	// map, with GitGraphView.getWebviewConfig()'s field mapping (the same bundle the app
	// served as /gitgraph/config.js — the page calls it, the bridge feeds it the settings).
	const configPath = join(root, 'out', 'config.js');
	if (!existsSync(configPath)) throw new Error(`${configPath} is missing; run \`npm run compile\` in vscode-git-graph-rs/ first`);
	await build({
		stdin: {
			contents: configEntry(readFileSync(join(pluginDir, 'config-stdin.js'), 'utf8'), configPath),
			resolveDir: root,
			loader: 'js'
		},
		bundle: true,
		format: 'iife',
		globalName: 'GitGraphStudioConfig',
		platform: 'browser',
		target: 'es2020',
		minify: true,
		alias: { vscode: join(appDir, 'scripts', 'vscode-stub.cjs') },
		outfile: join(web, 'config.js'),
		logLevel: 'warning'
	});

	await buildCompareBundle({ root, patchedOut: join(staging, 'compare-src'), outfile: join(web, 'compare.js') });
	await buildBinaryCompareBundle({ root, patchedOut: join(staging, 'compare-src'), outfile: join(web, 'binarycompare.js') });
	await buildViewPageBundle({ root, patchedOut: join(staging, 'compare-src'), outfile: join(web, 'viewpage.js') });

	copyFileSync(join(pluginDir, 'web', 'bridge.js'), join(web, 'bridge.js'));
	copyFileSync(join(pluginDir, 'web', 'compare-bridge.js'), join(web, 'compare-bridge.js'));
	pageShells(web);
	entries.push(...filesUnder(web, 'web/'));

	/* 2. The extension's own manifest and assets, straight from the plugin submodule. */
	for (const file of readdirSync(root)) {
		if (!statSync(join(root, file)).isFile()) continue;
		if (/^package(\.nls(\.[a-z-]+)?)?\.json$/i.test(file) || /^README\.md$/i.test(file) || /^LICENSE/i.test(file)) entries.push([file, join(root, file)]);
	}
	for (const dir of ['resources', 'licenses']) {
		if (existsSync(join(root, dir))) entries.push(...filesUnder(join(root, dir), `${dir}/`));
	}

	/* 3. The engine backend (this plugin's own sources, compiled): this host's platform only. */
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
		`Built ${target.replace(/\\/g, '/')}: ${entries.length + 1} entries, ${(bytes / 1024).toFixed(0)} KB` +
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
