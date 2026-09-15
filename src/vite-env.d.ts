/// <reference types="vite/client" />

/** The app version from package.json, defined by vite.config.ts (and vitest.config.ts). */
declare const __APP_VERSION__: string;

/** The baked-in extension contributions (vite.config.ts's builtin-contributions plugin, filled
 *  by scripts/builtin-contributions.mjs from the shipped extensions' manifests at build time)
 *  - the first-paint slice: commands, menus, keybindings and the `when`-referenced settings'
 *  type/default, with just the NLS keys their titles use. `nlsTranslations` carries each
 *  shipped package.nls.<locale>.json beside the default table. */
declare module 'virtual:builtin-contributions' {
	import type { ManifestContributes } from './contributions';
	export const builtinContributions: { extId: string; contributes: ManifestContributes | null; nls: Record<string, string>; nlsTranslations: Record<string, Record<string, string>> }[];
}

/** The same extensions' settings schemas with their default NLS table (the async chunk the
 *  Settings dialog's extension rows come from - extHost.ts's ensureBuiltinSettings). */
declare module 'virtual:builtin-settings' {
	import type { ManifestContributes } from './contributions';
	export const builtinSettings: { extId: string; configuration: ManifestContributes['configuration']; nls: Record<string, string> }[];
}
