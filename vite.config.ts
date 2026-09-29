import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkSeams } from './scripts/check-seams.mjs';
import { buildBuiltinContributions, buildBuiltinSettings } from './scripts/builtin-contributions.mjs';

// The seam rules (scripts/check-seams.mjs) gate every compile: a module that reaches around
// the designated interface files fails the dev-server start and the production build alike.
const checkSeamsPlugin = (): Plugin => ({
	name: 'check-git-graph-seams',
	buildStart() {
		checkSeams();
	}
});

// Every generated file lives under <project>/target/studio (see scripts/prepare.mjs): the public
// dir is assembled there, and the build output lands there too.
const studio = resolve(__dirname, 'target', 'studio');

// The first-paint closure: every chunk the window loads before the workbench can render -
// the boot entry, the workbench chunk, and their static imports, transitively (dynamic
// imports such as xterm, the merge views and the language modes are excluded). Written to
// dist/first-paint.json so scripts/measure.mjs reports the real number, not a file-name guess.
const firstPaintPlugin = (): Plugin => ({
	name: 'first-paint-closure',
	generateBundle(_options, bundle) {
		const chunks = Object.values(bundle).filter((item): item is Extract<typeof item, { type: 'chunk' }> => item.type === 'chunk');
		const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
		// The workbench chunk is not a pure facade (shared modules were hoisted into it), so it
		// is found by the module it carries rather than by `facadeModuleId`.
		const roots = chunks.filter((chunk) => (chunk.isEntry && chunk.name === 'main') || chunk.moduleIds.some((id) => id.endsWith('/src/workbench.ts')));
		const seen = new Set<string>();
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const dep of byFile.get(file)?.imports ?? []) walk(dep);
		};
		for (const root of roots) walk(root.fileName);
		const list = [...seen].map((file) => ({ file, bytes: Buffer.byteLength(byFile.get(file)!.code) })).sort((a, b) => b.bytes - a.bytes);
		this.emitFile({
			type: 'asset',
			fileName: 'first-paint.json',
			source: JSON.stringify({ total: list.reduce((sum, c) => sum + c.bytes, 0), chunks: list }, null, '\t') + '\n'
		});
	}
});

// The version the About box shows, from package.json - one source of truth for the number.
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(version) },
	plugins: [checkSeamsPlugin(), firstPaintPlugin()],
	clearScreen: false,
	publicDir: resolve(studio, 'public'),
	build: {
		outDir: resolve(studio, 'dist'),
		emptyOutDir: true,
		// The extension host frame is its own entry (app/ext-host.html), emitted next to the
		// main window so `src/extHost.ts` can load it as /ext-host.html.
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'index.html'),
				extHost: resolve(__dirname, 'ext-host.html')
			},
			output: {
				manualChunks(id) {
					// Vite's dynamic-import preload helper: on its own, or Rollup parks it in whichever
					// library chunk it meets first and the boot entry then pulls that chunk in.
					if (id.includes('vite/preload-helper')) return 'preload';
					if (id.includes('node_modules/@xterm/')) return 'xterm';
					// The module analysis drawing's mermaid + ELK engine — one named chunk
					// the page loads on the drawing's first render (never first paint).
					if (id.includes('node_modules/mermaid/') || id.includes('node_modules/@mermaid-js/') || id.includes('node_modules/elkjs/')) return 'mermaid';
					if (id.includes('node_modules/@codemirror/merge/')) return 'cm-merge';
					if (id.includes('node_modules/@codemirror/language-data/')) return 'cm-language-data';
					if (/node_modules\/@codemirror\/(state|view|commands|language|search|autocomplete|lint)\//.test(id) || /node_modules\/@lezer\/(common|highlight|lr)\//.test(id) || /node_modules\/(style-mod|w3c-keyname|crelt)\//.test(id)) return 'codemirror';
					if (id.includes('node_modules/@tauri-apps/')) return 'tauri';
					return undefined;
				}
			}
		}
	},
	server: {
		port: 5173,
		strictPort: true,
		// The extension host frames are sandboxed without `allow-same-origin`, so their
		// documents sit on an opaque origin and every module fetch they make is CORS-mode:
		// without these headers the frame scripts never load and no extension ever
		// activates under `tauri dev` (the packaged app serves same-origin assets, where
		// the tauri protocol's own permissive headers cover it).
		cors: true,
		// Dev never wants a cached module: the webviews heuristically cache vite's
		// unversioned html-proxy URLs, and a stale harness module then runs for every
		// later probe run while the edits sit on disk (the sandbox run lost an hour to
		// exactly that). no-store on everything in dev; the build is unaffected.
		headers: { 'Cache-Control': 'no-store' },
		watch: {
			ignored: ['**/src-tauri/**', '**/target/**']
		}
	}
});
