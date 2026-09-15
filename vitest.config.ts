import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildBuiltinContributions, buildBuiltinSettings } from './scripts/builtin-contributions.mjs';

// The UI tests run the workbench modules in jsdom with the Tauri APIs mocked (tests/tauriMock.ts):
// every `invoke` is recorded and answered from a scripted backend, so each view, menu, dialog and
// bridge can be exercised end-to-end without a window.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// The same baked-in extension contributions the app build gets (vite.config.ts): tests import
// the workbench modules, so both virtual modules must resolve here too — filled from the real
// vscode-git-graph-rs manifest, exactly what the app ships.
const builtinContributionsPlugin = () => ({
	name: 'builtin-contributions',
	resolveId(id: string) {
		return id === 'virtual:builtin-contributions' || id === 'virtual:builtin-settings' ? `\0${id}` : undefined;
	},
	load(id: string) {
		const root = resolve(__dirname, 'vscode-git-graph-rs');
		if (id === '\0virtual:builtin-contributions') {
			return `export const builtinContributions = ${JSON.stringify(buildBuiltinContributions(root))};`;
		}
		if (id === '\0virtual:builtin-settings') {
			return `export const builtinSettings = ${JSON.stringify(buildBuiltinSettings(root))};`;
		}
		return undefined;
	}
});

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(version) },
	plugins: [builtinContributionsPlugin()],
	test: {
		globalSetup: ['./scripts/check-seams.mjs'],
		environment: 'jsdom',
		include: ['tests/**/*.test.ts'],
		setupFiles: ['tests/setup.ts'],
		css: false,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			reportsDirectory: resolve(__dirname, 'target', 'studio', 'coverage')
		}
	}
});
