// Packs the GGX Demo extension — the worked example of the `ggx/2` package format, the way
// VS Code ships a sample extension. Its files live in one folder, like every plugin under
// plugins/ (scripts/build-plugins.bat builds them all): plugins/ggs-ext-demo/{package.json,
// web/view.html, src/main.rs}. One zip, three parts:
//
//   target/studio/bundled/ggs-ext-demo-<version>.ggx
//     manifest.json   the ggx/2 header: the page registry and the process backend
//     package.json    the two contributed commands (palette titles) — copied as-is
//     web/view.html   the page — plain HTML whose scripts use the acquireGgsApi() the ggx://
//                     protocol composes into every served page — copied as-is
//     bin/main[.exe]  the backend binary (plugins/ggs-ext-demo/src/main.rs), copied from the
//                     Cargo target dir (or --bin <path>)
//
// Not part of the app build: a developer tool, like build-ggx.mjs the reference packer.
// Without a backend binary it still packs (frontend-only) and says so — the page's
// backend.run calls then fail with a clear error at runtime.
//
// Usage: node scripts/build-ggx-demo.mjs [--bin <path-to-ggs-ext-demo[.exe]>] [--out <file>]

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeGgx } from './build-ggx.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const studio = join(appDir, 'target', 'studio');
const pluginDir = join(appDir, 'plugins', 'ggs-ext-demo');

const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const ID = `${pkg.publisher}.${pkg.name}`;
const EXE = process.platform === 'win32' ? 'ggs-ext-demo.exe' : 'ggs-ext-demo';

function manifestFor(backend) {
	const manifest = {
		format: 'ggx/2',
		id: ID,
		version: pkg.version,
		displayName: pkg.displayName,
		engines: pkg.engines,
		pages: { main: { page: 'web/view.html', title: pkg.displayName } },
		permissions: ['clipboard']
	};
	if (backend) manifest.backend = { kind: 'process', command: `bin/${EXE}` };
	return manifest;
}

export async function buildDemo({ out, bin } = {}) {
	// The backend binary: --bin, else the Cargo target dir (.cargo/config.toml points it at
	// target/studio/cargo), else the crate-local default.
	const candidates = [bin, join(studio, 'cargo', 'debug', EXE), join(appDir, 'src-tauri', 'target', 'debug', EXE)].filter(Boolean);
	const backend = candidates.find((path) => existsSync(path) && statSync(path).isFile());
	if (!backend) console.warn(`No backend binary found (looked at: ${candidates.join(', ')}); packing frontend-only.`);

	const manifest = manifestFor(Boolean(backend));
	const texts = {
		'manifest.json': JSON.stringify(manifest, null, '\t') + '\n',
		'package.json': readFileSync(join(pluginDir, 'package.json'), 'utf8'),
		'web/view.html': readFileSync(join(pluginDir, 'web', 'view.html'), 'utf8'),
		'README.md': readFileSync(join(pluginDir, 'README.md'), 'utf8')
	};
	const target = out ?? join(studio, 'bundled', `ggs-ext-demo-${pkg.version}.ggx`);
	mkdirSync(dirname(target), { recursive: true });
	const entries = backend ? [[`bin/${EXE}`, backend]] : [];
	// yazl resolves from the submodule's dependencies (writeGgx's convention — build-ggx.mjs
	// resolves it the same way, the app itself does not depend on it).
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
