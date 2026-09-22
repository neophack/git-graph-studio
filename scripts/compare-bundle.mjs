// Builds the Git Graph comparison assets the app serves under /gitgraph/ (compare.js,
// binarycompare.js and viewpage.js). The comparison views and the main view page are not part
// of one webview bundle the graph view loads - the extension host generates their complete
// HTML pages (inline CSS and script included) from extension-host code (src/comparisonView.ts,
// src/binaryCompareView.ts, src/gitGraphView.ts), and drives the binary-file areas host-side
// (src/binaryCompare.ts + src/hexDiff.ts). These modules bundle that same compiled code, so
// the app hosts the extension's real pages - the main view page included, markup, initial
// state and all - and the extension's real hex/image session machinery instead of maintaining
// copies:
//
//   compare.js       -> GitGraphCompare.buildComparePage()    the Commit Comparison page
//                       GitGraphCompare.createHexSession()…    the binary-area responders
//   binarycompare.js -> GitGraphBinaryCompare.buildBinaryComparePage()  the Binary Compare page
//   viewpage.js      -> GitGraphViewPage.buildViewPage()      the Git Graph view page itself
//
// The extension's compiled output wraps its fs requires in an Electron `original-fs` fallback
// (its scripts/package-src.js) whose variable-argument require() defeats static bundling, so
// both bundles are built from patched copies under target/studio with that wrapper folded back
// to the plain require - the extension's sources and out/ are never touched.
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

/** The banner both bundles carry: Node globals the compiled machinery touches. `Buffer` is the
 *  critical one - hexDiff allocates, concatenates, slices, compares (`equals`), copies into
 *  (`copy`) and base64-encodes (`toString('base64')`) blob chunks, and none of that exists on a
 *  bare Uint8Array. The class keeps every view a Buffer instance (TypedArray species
 *  construction), so `subarray` results encode and compare the same way. */
// The Node globals the compiled machinery sees, with the platform and arch of the machine this
// bundle is built on baked in (prepare.mjs builds on the machine that ships the app, so they are
// the app's own): the extension's platform reporting - the Settings page's backend section - and
// its engine-directory lookup read `process.platform`/`process.arch`, and 'browser-undefined'
// would be a lie about a host that runs the engine in-process on win32-x64 (or the build host's
// real platform). When a real `process` exists (Node, the test harness) it stands, as before.
const BROWSER_GLOBALS_BANNER = `var Buffer = globalThis.Buffer || (function () {
	class Buffer extends Uint8Array {
		static alloc(length, fill) { var b = new Buffer(length); if (fill !== undefined) b.fill(fill); return b; }
		static concat(list) { var t = 0; for (var i = 0; i < list.length; i++) t += list[i].length; var a = new Buffer(t); var o = 0; for (var j = 0; j < list.length; j++) { a.set(list[j], o); o += list[j].length; } return a; }
		static from(value) { return typeof value === 'string' ? new Buffer(new TextEncoder().encode(value)) : new Buffer(value); }
		static isBuffer(value) { return value instanceof Buffer; }
		toString(encoding) {
			if (encoding === 'base64') {
				var binary = '';
				for (var i = 0; i < this.length; i += 0x8000) binary += String.fromCharCode.apply(null, this.subarray(i, Math.min(this.length, i + 0x8000)));
				return btoa(binary);
			}
			if (encoding === 'latin1') { var text = ''; for (var i2 = 0; i2 < this.length; i2++) text += String.fromCharCode(this[i2]); return text; }
			return new TextDecoder().decode(this);
		}
		equals(other) { if (!(other instanceof Uint8Array) || other.length !== this.length) return false; for (var i3 = 0; i3 < this.length; i3++) if (this[i3] !== other[i3]) return false; return true; }
		copy(target, targetStart, sourceStart, sourceEnd) { target.set(this.subarray(sourceStart, sourceEnd), targetStart); }
	}
	return Buffer;
})();
var process = globalThis.process || { env: {}, platform: ${JSON.stringify(process.platform)}, arch: ${JSON.stringify(process.arch)}, nextTick: function (f) { Promise.resolve().then(f); } };
var global = globalThis;`;

/** Folds applied to individual patched copies beyond the shared original-fs one. The anchors are
 *  checked, not searched for loosely: a submodule update that moves one fails this build loudly
 *  rather than silently shipping an unadapted bundle.
 *
 *  The engine probe fold: the extension's engine-loading layer (backend/addon.js) decides "is
 *  there a native engine on this machine" by probing for a `.node` binary beside the extension -
 *  true in VS Code, false in this app, where the very same engine is linked in-process behind the
 *  graph_request seam. The host declares it per page generation as
 *  globalThis.__ggsInProcessEngine (set by the viewpage wrapper from the backend's engine
 *  version), and the probe folds to that declaration so the page's own Settings backend section
 *  reports the engine that actually serves it. Without a declaration the original probe stands.
 *  The signature folds too: its default parameter reads `__dirname`, which does not exist in a
 *  browser and would throw before any body statement could run - the default is restored below
 *  the early return, so undeclared environments probe exactly as before. */
const FILE_FOLDS = {
	'backend/addon.js': [{
		find: "function loadAddon(root = path.join(__dirname, '..', '..')) {",
		replace: "function loadAddon(root) {\n" +
			"    var inProcessEngine = globalThis.__ggsInProcessEngine;\n" +
			"    if (inProcessEngine !== undefined) { cached = { engineVersion: function () { return inProcessEngine.version; } }; return cached; }\n" +
			"    if (root === undefined) root = path.join(__dirname, '..', '..');"
	}]
};

/** Rewrite the extension's compiled out/ into `patchedOut` as bundleable CommonJS: the
 *  Electron `original-fs` fallback wrapper folded back to the plain require, under a
 *  package.json marking the files as CommonJS (see the header comment). */
function patchCompiledOut(root, patchedOut) {
	const compiledOut = join(root, 'out');
	if (!existsSync(join(compiledOut, 'comparisonView.js'))) {
		throw new Error(`${join(compiledOut, 'comparisonView.js')} not found - run \`npm run compile\` in vscode-git-graph-rs/ first`);
	}
	rmSync(patchedOut, { recursive: true, force: true });
	mkdirSync(patchedOut, { recursive: true });
	writeFileSync(join(patchedOut, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
	(function patchCopies(dir) {
		const relativePath = relative(compiledOut, dir);
		const targetDir = join(patchedOut, relativePath);
		mkdirSync(targetDir, { recursive: true });
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				patchCopies(join(dir, entry.name));
			} else if (entry.name.endsWith('.js')) {
				let text = readFileSync(join(dir, entry.name), 'utf8');
				text = text.split('requireWithFallback("original-fs", "fs")').join('require("fs")');
				const fileKey = relative(compiledOut, join(dir, entry.name)).split('\\').join('/');
				for (const fold of FILE_FOLDS[fileKey] ?? []) {
					if (!text.includes(fold.find)) {
						throw new Error(`the viewpage fold anchor is gone from ${fileKey} - the submodule's engine-loading layer changed: ${JSON.stringify(fold.find)}`);
					}
					text = text.replace(fold.find, fold.replace);
				}
				writeFileSync(join(targetDir, entry.name), text);
			}
		}
	})(compiledOut);
}

/** The esbuild options both bundles share: the `vscode` alias, the Node built-in shims (`fs`
 *  resolves to a lazy proxy over the adapter graphHost.ts installs, so the hex machinery's
 *  working-tree reads reach the app's backend; the rest are inert), and the browser-globals
 *  banner. */
function bundleOptions(patchedOut, outfile) {
	return {
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		minify: true,
		alias: { vscode: join(scriptsDir, 'vscode-stub.cjs') },
		plugins: [{
			// esbuild resolves Node built-ins inside CommonJS requires before `alias` applies, so
			// they are redirected here instead: `path` gets a real join(), `fs` the host-driven
			// proxy, the rest inert stubs.
			name: 'node-builtin-shims',
			setup(builder) {
				builder.onResolve({ filter: /^(child_process|os|util|crypto|http|https|url)$/ }, () => ({ path: join(scriptsDir, 'empty-stub.cjs') }));
				builder.onResolve({ filter: /^fs$/ }, () => ({ path: join(scriptsDir, 'hex-fs-stub.cjs') }));
				builder.onResolve({ filter: /^path$/ }, () => ({ path: join(scriptsDir, 'path-stub.cjs') }));
			}
		}],
		banner: { js: BROWSER_GLOBALS_BANNER },
		outfile,
		logLevel: 'warning'
	};
}

/** Build the Commit Comparison page generator AND the binary-area host machinery from a
 *  compiled vscode-git-graph-rs checkout. `root` is the submodule; `patchedOut` receives the
 *  patched copies; `outfile` is the browser-loaded IIFE bundle graphHost.ts serves as
 *  /gitgraph/compare.js. */
export async function buildCompareBundle({ root, patchedOut, outfile }) {
	patchCompiledOut(root, patchedOut);
	await build({
		stdin: {
			contents: `
				const { CommitComparisonView } = require('./comparisonView.js');
				const binary = require('./binaryCompare.js');
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
				// The responders the comparison page's binary-file area talks to, exactly as the
				// extension host drives them (src/comparisonView.ts): graphHost.ts calls these with
				// a spawnGitStream-capable DataSource stand-in over the app's backend.
				globalThis.GitGraphCompare = {
					buildComparePage: buildComparePage,
					createHexSession: binary.createHexSession,
					wireHexSession: binary.wireHexSession,
					respondHexInfo: binary.respondHexInfo,
					respondHexRows: binary.respondHexRows,
					respondImageData: binary.respondImageData,
					respondCopyToClipboard: binary.respondCopyToClipboard
				};
			`,
			resolveDir: patchedOut,
			loader: 'js'
		},
		...bundleOptions(patchedOut, outfile)
	});
}

/** Build the standalone Binary Compare page generator (the tab the Commit Comparison view's
 *  "Open Diff in Editor" opens for a binary file, and the graph view's own click on one) from
 *  the same compiled checkout, served as /gitgraph/binarycompare.js. */
export async function buildBinaryCompareBundle({ root, patchedOut, outfile }) {
	patchCompiledOut(root, patchedOut);
	await build({
		stdin: {
			contents: `
				const { BinaryCompareView } = require('./binaryCompareView.js');
				function buildBinaryComparePage(options) {
					// The same prototype-linked stand-in over the view's own template: the slim
					// header naming the file and the two revisions, and the shared binary
					// comparison area (styles and client script inline) filling the rest.
					const fake = Object.create(BinaryCompareView.prototype);
					fake.fromHash = options.fromHash;
					fake.toHash = options.toHash;
					fake.panel = { webview: { cspSource: "'self'" } };
					return BinaryCompareView.prototype.getHtml.call(fake, options.filePath, options.file);
				}
				globalThis.GitGraphBinaryCompare = { buildBinaryComparePage: buildBinaryComparePage };
			`,
			resolveDir: patchedOut,
			loader: 'js'
		},
		...bundleOptions(patchedOut, outfile)
	});
}

/** Build the Git Graph view page generator - the extension's own getHtmlForWebview, the very
 *  page VS Code serves (markup, initial state, colours, CSP and the rescan-for-repos empty
 *  state included) - served as /gitgraph/viewpage.js. graphPreload.ts / graphHost.ts compose
 *  the generated page with the host environment (theme tokens, the acquireVsCodeApi protocol
 *  shim, deferred script loading) instead of the app carrying a hand-written copy of it. */
export async function buildViewPageBundle({ root, patchedOut, outfile }) {
	patchCompiledOut(root, patchedOut);
	await build({
		stdin: {
			contents: `
				const { GitGraphView } = require('./gitGraphView.js');
				function buildViewPage(options) {
					// The extension host's own inputs to the template, carried by a
					// prototype-linked stand-in so its helper methods resolve. getConfig() reads
					// the stored overrides through the stub's configuration, exactly as the app's
					// config bundle does.
					globalThis.__gitGraphStudioOverrides = options.settings || {};
					// The engine the app links in-process (see FILE_FOLDS): declared for the
					// addon probe whenever the host knows its version, cleared otherwise so a
					// generation without it can never report the previous one.
					if (typeof options.engineVersion === 'string') globalThis.__ggsInProcessEngine = { version: options.engineVersion };
					else delete globalThis.__ggsInProcessEngine;
					const fake = Object.create(GitGraphView.prototype);
					fake.extensionPath = '';
					fake.loadViewTo = options.loadViewTo || null;
					fake.loadRepoInfoRefreshId = options.loadRepoInfoRefreshId || 0;
					fake.loadCommitsRefreshId = options.loadCommitsRefreshId || 0;
					fake.repoManager = { getRepos: () => options.repos || {} };
					fake.extensionState = {
						getLastActiveRepo: () => options.lastActiveRepo !== undefined ? options.lastActiveRepo : null,
						getGlobalViewState: () => options.globalState || {},
						getWorkspaceViewState: () => options.workspaceState || {},
						isAvatarStorageAvailable: () => true
					};
					fake.dataSource = { isGitExecutableUnknown: () => false };
					fake.getAutomationShimScript = () => ''; // the standard build injects no shim
					fake.panel = { webview: {
						cspSource: "'self'",
						asWebviewUri: (uri) => ({ toString: () => '/gitgraph/' + String(uri.fsPath).split(/[\\\\\\\\/]/).pop() })
					} };
					return GitGraphView.prototype.getHtmlForWebview.call(fake);
				}
				globalThis.GitGraphViewPage = { buildViewPage: buildViewPage };
			`,
			resolveDir: patchedOut,
			loader: 'js'
		},
		...bundleOptions(patchedOut, outfile)
	});
}
