// Build-time extraction of the contributions (menus, commands, keybindings, settings) of the
// extensions the app ships with - the integrated git-graph-rs, whose package.json is the
// vscode-git-graph-rs submodule's own, plus any .ggx packages staged for bundling. Two Vite
// virtual modules consume it:
//
//   `virtual:builtin-contributions` - the first-paint slice: commands, menus, keybindings, the
//     NLS keys their titles use, and the `when`-referenced settings' type/default. Baked into
//     the workbench bundle, so the first render registers these menus synchronously - no
//     runtime ext_read_file round-trip, no race with the SCM view's boot render.
//   `virtual:builtin-settings` - the settings schema (VS Code's `contributes.configuration`)
//     with its full NLS tables. Only the Settings dialog renders it, so it lives in an async
//     chunk the extension host applies after boot (extHost.ts's ensureBuiltinSettings).
//
// The split keeps the baked JSON an order of magnitude smaller than the whole manifest: the
// schema and its localised descriptions are most of it, and they are not first-paint code.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every extension the app ships: its id, its manifest and its NLS tables. */
function readBuiltins(root) {
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

/** The `%key%` placeholders a string resolves through, so the first-paint slice can carry just
 *  the NLS entries its own strings need. */
function nlsKeysOf(text) {
	if (typeof text !== 'string') return [];
	const match = /^%([\w.:-]+)%$/.exec(text.trim());
	return match ? [match[1]] : [];
}

/** The setting ids a manifest's `when` clauses read (`config.<id> == 'literal'`), so their
 *  defaults stay available to menu placement before the async settings pass lands. */
function configKeysOf(contributes) {
	const keys = new Set();
	const scan = (when) => {
		for (const clause of String(when ?? '').split('&&')) {
			const comparison = /^([\w.:-]+)\s*(==|!=)\s/.exec(clause.trim());
			const name = comparison?.[1];
			if (name?.startsWith('config.')) keys.add(name.slice('config.'.length));
		}
	};
	for (const entries of Object.values(contributes?.menus ?? {})) {
		for (const entry of entries ?? []) scan(entry.when);
	}
	return keys;
}

/** The first-paint slice of the shipped extensions' contributions - see the module doc. */
export function buildBuiltinContributions(root) {
	return readBuiltins(root).map((ext) => {
		const contributes = ext.contributes;
		const usedKeys = new Set();
		for (const declared of contributes?.commands ?? []) {
			for (const text of [declared.title, declared.category]) {
				for (const key of nlsKeysOf(text)) usedKeys.add(key);
			}
		}
		// `when`-referenced settings keep their type and default (menu placement reads the
		// default until the stored override arrives); their descriptions do not travel.
		const referenced = configKeysOf(contributes);
		const properties = {};
		for (const [id, property] of Object.entries(contributes?.configuration?.properties ?? {})) {
			if (!referenced.has(id)) continue;
			properties[id] = { type: property.type, default: property.default };
		}
		const keepNls = (table) => Object.fromEntries([...usedKeys].filter((key) => key in table).map((key) => [key, table[key]]));
		return {
			extId: ext.extId,
			contributes: contributes
				? {
					commands: contributes.commands,
					menus: contributes.menus,
					keybindings: contributes.keybindings,
					configuration: Object.keys(properties).length > 0 ? { properties } : undefined
				}
				: null,
			nls: keepNls(ext.nls),
			nlsTranslations: Object.fromEntries(Object.entries(ext.nlsTranslations).map(([locale, table]) => [locale, keepNls(table)]))
		};
	});
}

/** The shipped extensions' settings schemas with their default NLS table - the async chunk the
 *  Settings dialog's rows come from (extHost.ts's ensureBuiltinSettings). Command titles'
 *  translations stay in the first-paint slice, where menu relabeling reads them; the schema's
 *  descriptions localize against the default table, so no per-locale copy travels here. */
export function buildBuiltinSettings(root) {
	return readBuiltins(root).map((ext) => ({
		extId: ext.extId,
		configuration: ext.contributes?.configuration ?? null,
		nls: ext.nls
	}));
}
