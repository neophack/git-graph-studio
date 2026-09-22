// The shared `.ggx` packing infrastructure (docs/ggs-development-plan.md §8.2): the zip writer
// and the platform-key spelling every plugin's own packer uses. Generic on purpose — this file
// names neither `vscode-git-graph-rs` nor any other plugin's sources; a plugin's own folder
// under plugins/ owns that (its manifest, its files, its packer). `plugins/git-graph-rs/
// build.mjs` is git-graph-rs's own packer, built on this; `plugins/ggs-ext-demo/build.mjs` is
// the GGX Demo's.

import { createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** This build host's platform key, in the spelling `cmd_ext.rs`'s `host_platform_key()` (the
 * install-time resolver) and `ext_process.rs` (the spawn-time resolver) both use: Node's own
 * `process.platform`/`process.arch` words, joined — `win32-x64`, `darwin-arm64`, `linux-x64`. */
export function hostPlatformKey() {
	return `${process.platform}-${process.arch}`;
}

/** Every file under `dir`, as [archivePath, diskPath] pairs. */
export function filesUnder(dir, prefix) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(path, `${prefix}${entry.name}/`));
		else out.push([`${prefix}${entry.name}`, path]);
	}
	return out;
}

/** Write the package. `entries` is a list of [archivePath, diskPath]; `texts` inline files.
 * `requireFrom` is a path inside a package.json-rooted tree `yazl` (an npm dependency, not
 * this app's own) resolves from — every packer passes the plugin submodule's or the app's own
 * `package.json`, never a path inside plugins/ (plugin folders carry no node_modules). */
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
