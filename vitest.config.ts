import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The UI tests run the workbench modules in jsdom with the Tauri APIs mocked (tests/tauriMock.ts):
// every `invoke` is recorded and answered from a scripted backend, so each view, menu, dialog and
// bridge can be exercised end-to-end without a window.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(version) },
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
