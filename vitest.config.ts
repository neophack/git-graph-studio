import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The UI tests run the workbench modules in jsdom with the Tauri APIs mocked (tests/tauriMock.ts):
// every `invoke` is recorded and answered from a scripted backend, so each view, menu, dialog and
// bridge can be exercised end-to-end without a window.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(version) },
	coverage: {
		provider: 'v8',
		include: ['src/**/*.ts'],
		reportsDirectory: resolve(__dirname, 'target', 'studio', 'coverage')
	},
	// Two pools (vitest 5 `projects`). Most files run under vmThreads: jsdom is created
	// once per WORKER instead of once per file — 60+ environments were ~1/3 of the whole
	// suite's wall time (per vitest's own post-run report). extensions.test.ts
	// vm-requires jsdom's CJS dependency tree, whose @exodus/bytes dependency ships ESM
	// under a CJS extension and breaks inside the vm context — that one file stays on
	// the classic threads pool. The global seam check runs in both; it is idempotent.
	test: {
		environment: 'jsdom',
		setupFiles: ['tests/setup.ts'],
		css: false,
		projects: [
			{
				extends: true,
				test: {
					name: 'unit-vm',
					globalSetup: ['./scripts/check-seams.mjs'],
					environment: 'jsdom',
					include: ['tests/**/*.test.ts'],
					exclude: ['tests/extensions.test.ts'],
					setupFiles: ['tests/setup.ts'],
					pool: 'vmThreads',
					poolOptions: { vmThreads: { memoryLimit: 4096 } }
				}
			},
			{
				extends: true,
				test: {
					name: 'ext-threads',
					globalSetup: ['./scripts/check-seams.mjs'],
					environment: 'jsdom',
					include: ['tests/extensions.test.ts'],
					setupFiles: ['tests/setup.ts'],
					pool: 'threads'
				}
			}
		]
	}
});
