// Builds the git-graph-rs `.ggx` package (docs/ggs-development-plan.md §8.2): Studio's own
// plugin format, frontend and backend together.
//
//   target/studio/bundled/git-graph-rs-<version>.ggx
//     manifest.json              the ggx header (id, version, frontend page, backend binaries)
//     package.json               the extension's manifest (contribution points, NLS, icon)
//     package.nls*.json, README.md, LICENSE.txt, licenses/, resources/
//     web/                       view.html, out.min.js/css, config.js, compare.js, markdown-it, highlight
//     backend/<platform>/git-graph-backend[.exe]   the engine + git runner as a process (ggx-rpc/2)
//
// The backend binary is `cargo build --release --bin git-graph-backend --no-default-features --features engine`
// (no Tauri, no webview - the size profile of src-tauri/Cargo.toml applies), built here unless
// `--backend <path>` names one already built (CI cross-builds pass the per-platform binary).
// `--no-backend` packs a frontend-only package (the app then answers the graph in-process).
//
// Usage: node scripts/build-ggx.mjs [--out <file>] [--backend <exe>] [--platform <key>] [--no-backend]

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// The git-graph-rs extension lives in its own repository, checked out as the plugin/ submodule.
const root = join(appDir, 'plugin');
const studio = join(appDir, 'target', 'studio');

/** The platform key (VS Code's target names) the manifest files binaries under. */
export function platformKey(platform = process.platform, arch = process.arch) {
	const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
	const cpu = arch === 'arm64' ? 'arm64' : 'x64';
	return `${os}-${cpu}`;
}

/** The `manifest.json` of the package. */
export function ggxManifest(pkg, { backends = {}, permissions = ['repo:read', 'git:write', 'clipboard', 'terminal', 'network'] } = {}) {
	return {
		format: 'ggx/1',
		id: `${pkg.publisher}.${pkg.name}`,
		version: pkg.version,
		displayName: pkg.displayName ?? pkg.name,
		engines: { ggs: '>=0.1.0' },
		frontend: { kind: 'webview', page: 'web/view.html', config: 'web/config.js', compare: 'web/compare.js' },
		backend: Object.keys(backends).length > 0 ? { kind: 'process', protocol: 'ggx-rpc/2', binaries: backends } : undefined,
		permissions
	};
}

function buildBackend() {
	const exe = join(studio, 'cargo', 'release', process.platform === 'win32' ? 'git-graph-backend.exe' : 'git-graph-backend');
	console.log('Building the plugin backend (release, no Tauri)…');
	const result = spawnSync('cargo', ['build', '--release', '--bin', 'git-graph-backend', '--no-default-features', '--features', 'engine'], {
		cwd: join(appDir, 'src-tauri'),
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	if (result.status !== 0 || !existsSync(exe)) throw new Error('building git-graph-backend failed');
	return exe;
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

export async function buildGgx({ out, backend, platform, noBackend } = {}) {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	// `%displayName%` and friends resolve through the default NLS file, as VS Code does.
	const nlsPath = join(root, 'package.nls.json');
	const nls = existsSync(nlsPath) ? JSON.parse(readFileSync(nlsPath, 'utf8')) : {};
	if (typeof pkg.displayName === 'string') pkg.displayName = pkg.displayName.replace(/^%(.+)%$/, (_, key) => nls[key] ?? key);
	const target = out ?? join(studio, 'bundled', `${pkg.name}-${pkg.version}.ggx`);
	const key = platform ?? platformKey();
	const backends = {};
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

	if (!noBackend) {
		const exe = backend ?? buildBackend();
		const name = `git-graph-backend${key.startsWith('win32') ? '.exe' : ''}`;
		backends[key] = `backend/${key}/${name}`;
		entries.push([backends[key], exe]);
	}

	const manifest = ggxManifest(pkg, { backends });
	const bytes = await writeGgx(target, entries, { 'manifest.json': JSON.stringify(manifest, null, '\t') + '\n' }, join(root, 'package.json'));
	console.log(`Built ${relative(root, target)}: ${entries.length + 1} entries, ${(bytes / 1024).toFixed(0)} KB${noBackend ? ' (frontend only)' : ` (backend for ${key})`}`);
	return { target, manifest, bytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const value = (flag) => (args.indexOf(flag) === -1 ? undefined : args[args.indexOf(flag) + 1]);
	buildGgx({ out: value('--out'), backend: value('--backend'), platform: value('--platform'), noBackend: args.includes('--no-backend') }).catch((error) => {
		console.error(error.message ?? error);
		process.exit(1);
	});
}
