// Builds the Git Graph Commit Comparison page generator (public/gitgraph/compare.js). The
// comparison view is not part of the webview bundle the graph view loads - the extension host
// generates its complete HTML page (inline CSS and script included) from extension-host code
// (src/comparisonView.ts). This module bundles that same compiled generator: it exposes
// `GitGraphCompare.buildComparePage()`, which runs the extension's own `getHtml` template
// against a stubbed panel, so the app (graphHost.ts's CompareHost) hosts the extension's real
// comparison page - styles, markup and embedded script - instead of maintaining a copy.
//
// The extension's compiled output wraps its fs requires in an Electron `original-fs` fallback
// (its scripts/package-src.js) whose variable-argument require() defeats static bundling, so the
// bundle is built from patched copies under target/studio with that wrapper folded back to the
// plain require - the extension's sources and out/ are never touched.
//
// Those patched copies sit under the app's own package scope, and the app's package.json is
// "type": "module": esbuild reads a .js file's format from the nearest package.json, so without
// the CommonJS marker written below every patched file would be parsed as an ECMAScript module,
// its compiled `exports.X = …` assignments left as free references, and the bundle would throw
// "exports is not defined" the moment the browser loads it. The marker keeps esbuild's reading
// identical to Node's for the file the extension actually compiled.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** Build the comparison page generator from a compiled vscode-git-graph-rs checkout.
 *  `root` is the submodule; `patchedOut` receives the patched copies; `outfile` is the
 *  browser-loaded IIFE bundle graphHost.ts serves as /gitgraph/compare.js. */
export async function buildCompareBundle({ root, patchedOut, outfile }) {
	const compiledEntry = join(root, 'out', 'comparisonView.js');
	if (!existsSync(compiledEntry)) {
		throw new Error(`${compiledEntry} not found - run \`npm run compile\` in vscode-git-graph-rs/ first`);
	}
	rmSync(patchedOut, { recursive: true, force: true });
	mkdirSync(patchedOut, { recursive: true });
	writeFileSync(join(patchedOut, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
	(function patchCopies(dir) {
		const relativePath = relative(join(root, 'out'), dir);
		const targetDir = join(patchedOut, relativePath);
		mkdirSync(targetDir, { recursive: true });
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				patchCopies(join(dir, entry.name));
			} else if (entry.name.endsWith('.js')) {
				const text = readFileSync(join(dir, entry.name), 'utf8');
				writeFileSync(join(targetDir, entry.name),
					text.split('requireWithFallback("original-fs", "fs")').join('require("fs")'));
			}
		}
	})(join(root, 'out'));

	await build({
		stdin: {
			contents: `
				const { CommitComparisonView } = require('./comparisonView.js');
				function buildComparePage(options) {
					// The view's own template runs against a prototype-linked stand-in (so its own
					// helper methods resolve) carrying only the fields getHtml reads; the panel
					// supplies the CSP source and the highlight.js URL, here pointed at the copy
					// this build ships beside the bundle.
					const fake = Object.create(CommitComparisonView.prototype);
					fake.fileChanges = options.fileChanges || [];
					fake.singleCommit = options.singleCommit === true;
					fake.fromHash = options.fromHash;
					fake.toHash = options.toHash;
					fake.extensionPath = '';
					fake.panel = { webview: {
						cspSource: "'self'",
						asWebviewUri: () => ({ toString: () => '/gitgraph/highlight.min.js' })
					} };
					return CommitComparisonView.prototype.getHtml.call(fake,
						options.error || null,
						options.summaries || {},
						typeof options.commitsBetween === 'number' ? options.commitsBetween : null,
						options.loading === true);
				}
				globalThis.GitGraphCompare = { buildComparePage };
			`,
			resolveDir: patchedOut,
			loader: 'js'
		},
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		minify: true,
		alias: { vscode: join(scriptsDir, 'vscode-stub.cjs') },
		plugins: [{
			// esbuild resolves Node built-ins inside CommonJS requires before `alias` applies, so
			// they are redirected here instead: `path` gets a real join(), the rest inert stubs.
			name: 'node-builtin-shims',
			setup(builder) {
				builder.onResolve({ filter: /^(fs|child_process|os|util|crypto|http|https)$/ }, () => ({ path: join(scriptsDir, 'empty-stub.cjs') }));
				builder.onResolve({ filter: /^path$/ }, () => ({ path: join(scriptsDir, 'path-stub.cjs') }));
			}
		}],
		// The hex-session machinery the page generator is bundled with touches Node globals at
		// module scope (hexDiff's empty-buffer constant) and in its (here unused) code paths; the
		// banner gives the bundle inert browser stand-ins so loading never throws. The page
		// generation path itself uses none of them.
		banner: {
			js: `var Buffer = globalThis.Buffer || { alloc: function (n, f) { var a = new Uint8Array(n); if (f !== undefined) a.fill(f); return a; }, concat: function (list) { var t = 0; for (var i = 0; i < list.length; i++) t += list[i].length; var a = new Uint8Array(t); var o = 0; for (var j = 0; j < list.length; j++) { a.set(list[j], o); o += list[j].length; } return a; }, from: function (x) { return typeof x === 'string' ? new TextEncoder().encode(x) : new Uint8Array(x); }, isBuffer: function (b) { return b instanceof Uint8Array; } };
var process = globalThis.process || { env: {}, platform: 'browser', nextTick: function (f) { Promise.resolve().then(f); } };
var global = globalThis;`
		},
		outfile,
		logLevel: 'warning'
	});
}
