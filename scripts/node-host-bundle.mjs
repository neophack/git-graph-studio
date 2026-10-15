// The real-Node extension host bundle (`node-host.cjs`), as one function: the entry a
// system Node runs as one extension's host process when a runtime is available — the same
// `vscode` shim the sandboxed frames carry, over the ggs-ext/1 stdio channel, with
// `require('vscode')` intercepted and every other require resolving through Node's own
// machinery (a package's `.node` NAPI addon, its ESM, its workers, its `node_modules`).
// Bundled by the app's own Vite (lib mode, CommonJS, node builtins external); shipped
// beside the binaries through tauri.conf.json's bundle.resources, and copied to
// target/studio/ for the dev lookup. prepare.mjs's step 3½ and the dev-loop helper
// scripts/build-node-host.mjs share this one definition.

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Build `node-host.cjs` into `<out>/bundled/app-resources/` and copy it to
 *  `<out>/node-host.cjs` (the dev lookup path). */
export async function buildNodeHost(appDir, out) {
	const { build } = await import('vite');
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			outDir: join(out, 'bundled', 'app-resources'),
			emptyOutDir: false,
			minify: false,
			sourcemap: false,
			target: 'node20',
			lib: {
				entry: join(appDir, 'src', 'hosts', 'nodeHost.ts'),
				formats: ['cjs'],
				fileName: () => 'node-host.cjs'
			},
			rollupOptions: {
				external: [/^node:/]
			}
		}
	});
	mkdirSync(join(out, '.'), { recursive: true });
	copyFileSync(join(out, 'bundled', 'app-resources', 'node-host.cjs'), join(out, 'node-host.cjs'));
}
