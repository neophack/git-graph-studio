// The GGX Demo's own packer: builds `ggs-ext-demo-<version>.ggx` — the worked example of the
// `ggx/2` package format, the way VS Code ships a sample extension. Like every plugin under
// plugins/, the whole plugin lives in this one folder: its manifest fields, its pages, its
// backend source (src/main.rs, compiled by src-tauri/Cargo.toml's `ggs-ext-demo` [[bin]]) and
// this packer. Part of the app build: scripts/prepare.mjs compiles the backend and calls
// `buildDemo` here, then carries the fixed-name copy (app-resources/ggs-ext-demo.ggx) into the
// installer — the Extensions view offers it as the bundled sample's one-click install.
// scripts/build-plugins.bat does the same standalone.
//
//   target/studio/bundled/ggs-ext-demo-<version>.ggx
//     manifest.json              the ggx/2 header: the two-page registry and the process backend
//     package.json               the seven contributed commands — copied as-is
//     web/view.html              the tour page — plain HTML whose script uses acquireGgsApi()
//     web/params.html            the params page — what its opener sent, round-tripped
//     resources/icon.svg         the Extensions view's icon
//     bin/<platform>/ggs-ext-demo[.exe]   the backend, under its platform key
//     README.md                  the plugin authoring guide
//
// Usage: node plugins/ggs-ext-demo/build.mjs [--bin <path-to-ggs-ext-demo[.exe]>] [--out <file>]
// Without a backend binary it still packs (frontend-only) and says so — the pages'
// backend.run calls then fail with a clear error at runtime.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostPlatformKey, writeGgx } from '../../scripts/build-ggx.mjs';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(pluginDir, '..', '..');
const studio = join(appDir, 'target', 'studio');

const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const ID = `${pkg.publisher}.${pkg.name}`;
const EXE = process.platform === 'win32' ? 'ggs-ext-demo.exe' : 'ggs-ext-demo';

function manifestFor(backendCommand) {
	const manifest = {
		format: 'ggx/2',
		id: ID,
		version: pkg.version,
		displayName: pkg.displayName,
		engines: pkg.engines,
		// The two-page registry: everything a package can show, by id. A page is opened by a
		// command's openPage result or another page's pages.open — never anything else.
		pages: {
			main: { page: 'web/view.html', title: pkg.displayName },
			params: { page: 'web/params.html', title: 'GGX Demo — Params' }
		},
		permissions: ['clipboard']
	};
	if (backendCommand) {
		manifest.backend = { kind: 'process', command: backendCommand, binaries: { [hostPlatformKey()]: backendCommand } };
	}
	return manifest;
}

export async function buildDemo({ out, bin } = {}) {
	// The backend binary: --bin, else the Cargo target dir (.cargo/config.toml points it at
	// target/studio/cargo), else the crate-local default.
	const candidates = [bin, join(studio, 'cargo', 'release', EXE), join(studio, 'cargo', 'debug', EXE), join(appDir, 'src-tauri', 'target', 'release', EXE), join(appDir, 'src-tauri', 'target', 'debug', EXE)].filter(Boolean);
	const backend = candidates.find((path) => existsSync(path) && statSync(path).isFile());
	if (!backend) console.warn(`No backend binary found (looked at: ${candidates.join(', ')}); packing frontend-only.`);

	// The backend lands under its platform key, like git-graph-rs's engine backend — the
	// layout a multi-platform package grows into without changing shape.
	const backendCommand = backend ? `bin/${hostPlatformKey()}/${EXE}` : undefined;
	const manifest = manifestFor(backendCommand);
	const texts = {
		'manifest.json': JSON.stringify(manifest, null, '\t') + '\n',
		'package.json': readFileSync(join(pluginDir, 'package.json'), 'utf8'),
		'web/view.html': readFileSync(join(pluginDir, 'web', 'view.html'), 'utf8'),
		'web/params.html': readFileSync(join(pluginDir, 'web', 'params.html'), 'utf8'),
		'resources/icon.svg': readFileSync(join(pluginDir, 'resources', 'icon.svg'), 'utf8'),
		'README.md': readFileSync(join(pluginDir, 'README.md'), 'utf8')
	};
	const target = out ?? join(studio, 'bundled', `ggs-ext-demo-${pkg.version}.ggx`);
	mkdirSync(dirname(target), { recursive: true });
	const entries = backend ? [[backendCommand, backend]] : [];
	// yazl resolves from the submodule's dependencies (writeGgx's convention — the app itself
	// does not depend on it; plugin folders carry no node_modules).
	const requireFrom = join(appDir, 'vscode-git-graph-rs', 'package.json');
	const bytes = await writeGgx(target, entries, texts, requireFrom);
	console.log(`Built ${target}: ${entries.length + Object.keys(texts).length} entries, ${(bytes / 1024).toFixed(0)} KB${backend ? '' : ' (no backend)'}`);
	return { target, manifest, bytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const value = (flag) => (args.indexOf(flag) === -1 ? undefined : args[args.indexOf(flag) + 1]);
	buildDemo({ out: value('--out'), bin: value('--bin') }).catch((error) => {
		console.error(error.message ?? error);
		process.exit(1);
	});
}
