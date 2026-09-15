// Builds a git-graph-rs `.ggx` package (docs/ggs-development-plan.md §8.2): Studio's own
// plugin format, as `src-tauri/src/cmd_ext.rs` installs it — a frontend-only package (ggx/1).
//
//   target/studio/bundled/git-graph-rs-<version>.ggx
//     manifest.json              the ggx header (id, version, frontend page)
//     package.json               the extension's manifest (contribution points, NLS, icon)
//     package.nls*.json, README.md, LICENSE.txt, licenses/, resources/
//     web/                       view.html, out.min.js/css, config.js, compare.js, markdown-it, highlight
//
// Not part of the app build: the app links the engine in-process and lists git-graph-rs as a
// built-in whose version follows the application (`cmd_ext.rs` refuses an install of its id).
// This script is the reference packer for the format; `tests/buildScripts.test.ts` covers the
// header it writes.
//
// Usage: node scripts/build-ggx.mjs [--out <file>]

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// The git-graph-rs extension lives in its own repository, checked out as the vscode-git-graph-rs/ submodule.
const root = join(appDir, 'vscode-git-graph-rs');
const studio = join(appDir, 'target', 'studio');

/** The `manifest.json` of the package. */
export function ggxManifest(pkg, { permissions = ['repo:read', 'git:write', 'clipboard', 'terminal', 'network'] } = {}) {
	return {
		format: 'ggx/1',
		id: `${pkg.publisher}.${pkg.name}`,
		version: pkg.version,
		displayName: pkg.displayName ?? pkg.name,
		engines: { ggs: '>=0.1.0' },
		frontend: { kind: 'webview', page: 'web/view.html', config: 'web/config.js', compare: 'web/compare.js' },
		permissions
	};
}

/** Every file under `dir`, as [archivePath, diskPath] pairs. */
function filesUnder(dir, prefix) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(path, `${prefix}${entry.name}/`));
		else out.push([`${prefix}${entry.name}`, path]);
	}
	return out;
}

/** Write the package. `entries` is a list of [archivePath, diskPath]; `texts` inline files. */
export function writeGgx(out, entries, texts, requireFrom) {
	const yazl = createRequire(requireFrom)('yazl');
	return new Promise((resolve, reject) => {
		const zip = new yazl.ZipFile();
		for (const [archivePath, text] of Object.entries(texts)) zip.addBuffer(Buffer.from(text, 'utf8'), archivePath, { compress: true });
		for (const [archivePath, diskPath] of entries) zip.addFile(diskPath, archivePath, { compress: true });
		mkdirSync(dirname(out), { recursive: true });
		zip.outputStream.pipe(createWriteStream(out)).on('close', () => resolve(statSync(out).size)).on('error', reject);
		zip.end();
	});
}

export async function buildGgx({ out } = {}) {
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

	const manifest = ggxManifest(pkg);
	const bytes = await writeGgx(target, entries, { 'manifest.json': JSON.stringify(manifest, null, '\t') + '\n' }, join(root, 'package.json'));
	console.log(`Built ${relative(root, target)}: ${entries.length + 1} entries, ${(bytes / 1024).toFixed(0)} KB`);
	return { target, manifest, bytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const value = (flag) => (args.indexOf(flag) === -1 ? undefined : args[args.indexOf(flag) + 1]);
	buildGgx({ out: value('--out') }).catch((error) => {
		console.error(error.message ?? error);
		process.exit(1);
	});
}
