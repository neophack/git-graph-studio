// Build-time extraction of the contributions (menus, commands, keybindings, settings) of the
// extensions the app ships with - the integrated git-graph-rs, whose package.json is the
// vscode-git-graph-rs submodule's own, plus any .ggx packages staged for bundling. The Vite virtual module
// `virtual:builtin-contributions` (vite.config.ts) bakes the result into the frontend bundle, so
// the workbench registers these menus synchronously before its first render - no runtime
// ext_read_file round-trip, no race with the SCM view's boot render.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One baked extension contribution set: the manifest's `contributes` plus its NLS tables -
 *  the default English one and every shipped translation, so the display-language layer can
 *  relabel the declared titles without another read. */
export function buildBuiltinContributions(root) {
	const out = [];
	const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
	const manifestPath = join(root, 'package.json');
	if (existsSync(manifestPath)) {
		const manifest = readJson(manifestPath);
		const nlsPath = join(root, 'package.nls.json');
		const nlsTranslations = {};
		for (const locale of ['zh-cn']) {
			const localePath = join(root, `package.nls.${locale}.json`);
			if (existsSync(localePath)) nlsTranslations[locale] = readJson(localePath);
		}
		out.push({
			// The id the Rust side lists the extension under: publisher.name (GRAPH_PACKAGE_ID).
			extId: manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name,
			contributes: manifest.contributes ?? null,
			nls: existsSync(nlsPath) ? readJson(nlsPath) : {},
			nlsTranslations
		});
	}
	return out;
}
