// The remote workbench build (docs/ggs-remote-plan.md §9.1): the same frontend, its Tauri
// seam aliased onto the WebSocket shims of src/remote/tauriShim/, with relative asset URLs so
// the daemon can serve it under /w/<instance>/v/<version>/. Output: target/studio/dist/remote/
// — inside the app's frontendDist, so the instance embeds it and serves it to the daemon
// (remote_host.rs reads only the `remote/` prefix). Runs after the main build, which empties
// dist/ first.
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { precacheList } from './src/remote/precache';
import base from './vite.config';

const shim = (name: string) => resolve(__dirname, 'src/remote/tauriShim', name);
const studio = resolve(__dirname, 'target', 'studio');

const baseConfig = base as UserConfig;

/** Writes precache.json beside remote.html (§10.2): the shell plus its hashed first-paint
 *  assets — the list the Service Worker warms at install, so the second visit pays one
 *  revalidation instead of a cold start. */
function precacheManifest(outDir: string): Plugin {
	return {
		name: 'ggs-remote-precache',
		closeBundle() {
			const shell = readFileSync(resolve(outDir, 'remote.html'), 'utf8');
			const manifest = { files: precacheList(shell) };
			writeFileSync(resolve(outDir, 'precache.json'), JSON.stringify(manifest, null, '\t') + '\n');
		}
	};
}

export default mergeConfig(
	{ ...baseConfig, build: { ...baseConfig.build, rollupOptions: undefined } },
	defineConfig({
		base: './',
		resolve: {
			alias: [
				{ find: /^@tauri-apps\/api\/core$/, replacement: shim('core.ts') },
				{ find: /^@tauri-apps\/api\/event$/, replacement: shim('event.ts') },
				{ find: /^@tauri-apps\/api\/window$/, replacement: shim('window.ts') },
				{ find: /^@tauri-apps\/api\/webview$/, replacement: shim('webview.ts') },
				{ find: /^@tauri-apps\/api\/app$/, replacement: shim('app.ts') },
				{ find: /^@tauri-apps\/plugin-dialog$/, replacement: shim('dialog.ts') },
				{ find: /^@tauri-apps\/plugin-clipboard-manager$/, replacement: shim('clipboard.ts') },
				{ find: /^@tauri-apps\/plugin-opener$/, replacement: shim('opener.ts') }
			]
		},
		plugins: [precacheManifest(resolve(studio, 'dist', 'remote'))],
		build: {
			outDir: resolve(studio, 'dist', 'remote'),
			emptyOutDir: true,
			target: ['es2021', 'safari16', 'firefox115', 'chrome100'],
			rollupOptions: {
				input: {
					remote: resolve(__dirname, 'remote.html'),
					sw: resolve(__dirname, 'src/remote/sw.ts')
				},
				output: {
					entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
					manualChunks(id) {
						if (id.includes('vite/preload-helper')) return 'preload';
						if (id.includes('node_modules/@xterm/')) return 'xterm';
						if (id.includes('node_modules/mermaid/') || id.includes('node_modules/@mermaid-js/') || id.includes('node_modules/elkjs/')) return 'mermaid';
						if (id.includes('node_modules/@codemirror/merge/')) return 'cm-merge';
						if (id.includes('node_modules/@codemirror/language-data/')) return 'cm-language-data';
						if (/node_modules\/@codemirror\/(state|view|commands|language|search|autocomplete|lint)\//.test(id) || /node_modules\/@lezer\/(common|highlight|lr)\//.test(id)) return 'codemirror';
						if (id.includes('node_modules/@msgpack/')) return 'msgpack';
						return undefined;
					}
				}
			}
		}
	})
);
