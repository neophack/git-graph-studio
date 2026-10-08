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
	// suite's wall time (per vitest's own post-run report).
	//
	// The snapshot environment is named explicitly (tests/vmSnapshotEnvironment.ts,
	// vitest's own class): the default resolution is a bare dynamic import() that runs
	// INSIDE the vm context, one per test file, and Node 20 answers it with
	// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING — 61 unhandled rejections killed the CI
	// run while the tests themselves passed. The module-runner path knows no such
	// callback gap.
	//
	// Three files stay on the classic threads pool, each because the vm pool's module
	// system breaks something they exercise: extensions.test.ts vm-requires jsdom's CJS
	// dependency tree, whose @exodus/bytes dependency ships ESM under a CJS extension
	// and breaks inside the vm context; claudeRemoteActivation.test.ts's
	// require('vscode') interception patches Module._load, which the vm pool's module
	// system does not honor; and editor.test.ts asserts the lazy language chunk's
	// arrival — an in-app dynamic import the vm pool answers with
	// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING under the full suite's load, which
	// loadLanguage degrades to a silent Plain Text (the same vm import-callback gap the
	// snapshot environment works around above). The classic pool runs the app's imports
	// the way production does. The global seam check runs in both; it is idempotent.
	test: {
		environment: 'jsdom',
		setupFiles: ['tests/setup.ts'],
		snapshotEnvironment: './tests/vmSnapshotEnvironment.ts',
		css: false,
		projects: [
			{
				extends: true,
				test: {
					name: 'unit-vm',
					globalSetup: ['./scripts/check-seams.mjs'],
					environment: 'jsdom',
					include: ['tests/**/*.test.ts'],
					exclude: [
						'tests/extensions.test.ts',
						'tests/claudeRemoteActivation.test.ts',
						'tests/editor.test.ts'
					],
					setupFiles: ['tests/setup.ts'],
					pool: 'vmThreads',
					poolOptions: { vmThreads: { memoryLimit: 4096 } }
				}
			},
			{
				extends: true,
				test: {
					name: 'threads',
					globalSetup: ['./scripts/check-seams.mjs'],
					environment: 'jsdom',
					include: [
						'tests/extensions.test.ts',
						'tests/claudeRemoteActivation.test.ts',
						'tests/editor.test.ts'
					],
					setupFiles: ['tests/setup.ts'],
					pool: 'threads'
				}
			}
		]
	}
});
