// Builds the git-graph-rs page bundles the package serves from its own web/ directory
// (compare.js, binarycompare.js, viewpage.js). This is the plugin's own copy of the bundling
// the app used to run (scripts/compare-bundle.mjs): the same patched-copy pipeline over the
// extension's compiled out/, with the one difference that the generated pages' asset URLs
// stay RELATIVE — the pages live beside their assets inside the package, over ggx://, instead
// of the app's /gitgraph/ public directory.
//
//   compare.js       -> GitGraphCompare.buildComparePage()    the Commit Comparison page
//                       GitGraphCompare.createHexSession()…    the binary-area responders
//   binarycompare.js -> GitGraphBinaryCompare.buildBinaryComparePage()  the Binary Compare page
//   viewpage.js      -> GitGraphViewPage.buildViewPage()      the Git Graph view page itself
//
// The Node-global banner and the original-fs fold are the app pipeline's own (see the file's
// history in scripts/compare-bundle.mjs, where this lived until 2026-09-23).
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

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

const FILE_FOLDS = {
	'backend/addon.js': [{
		find: "function loadAddon(root = path.join(__dirname, '..', '..')) {",
		replace: "function loadAddon(root) {\n" +
			"    var inProcessEngine = globalThis.__ggsInProcessEngine;\n" +
			"    if (inProcessEngine !== undefined) { cached = { engineVersion: function () { return inProcessEngine.version; } }; return cached; }\n" +
			"    if (root === undefined) root = path.join(__dirname, '..', '..');"
	}]
};

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

function bundleOptions(patchedOut, outfile) {
	return {
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2020',
		minify: true,
		alias: { vscode: join(scriptsDir, 'vscode-stub.cjs') },
		plugins: [{
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

/** The Commit Comparison page generator and the binary-area host machinery. */
export async function buildCompareBundle({ root, patchedOut, outfile }) {
	patchCompiledOut(root, patchedOut);
	await build({
		stdin: {
			contents: `
				const { CommitComparisonView } = require('./comparisonView.js');
				const binary = require('./binaryCompare.js');
				function buildComparePage(options) {
					const fake = Object.create(CommitComparisonView.prototype);
					fake.fileChanges = options.fileChanges || [];
					fake.singleCommit = options.singleCommit === true;
					fake.fromHash = options.fromHash;
					fake.toHash = options.toHash;
					fake.extensionPath = '';
					fake.panel = { webview: {
						cspSource: "'self'",
						// Relative: the highlighter rides beside the bundle in this package.
						asWebviewUri: () => ({ toString: () => 'highlight.min.js' })
					} };
					return CommitComparisonView.prototype.getHtml.call(fake,
						options.error || null,
						options.summaries || {},
						typeof options.commitsBetween === 'number' ? options.commitsBetween : null,
						options.loading === true);
				}
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

/** The standalone Binary Compare page generator. */
export async function buildBinaryCompareBundle({ root, patchedOut, outfile }) {
	patchCompiledOut(root, patchedOut);
	await build({
		stdin: {
			contents: `
				const { BinaryCompareView } = require('./binaryCompareView.js');
				function buildBinaryComparePage(options) {
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

/** The Git Graph view page generator - the extension's own getHtmlForWebview. */
export async function buildViewPageBundle({ root, patchedOut, outfile }) {
	patchCompiledOut(root, patchedOut);
	await build({
		stdin: {
			contents: `
				const { GitGraphView } = require('./gitGraphView.js');
				function buildViewPage(options) {
					globalThis.__gitGraphStudioOverrides = options.settings || {};
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
					fake.getAutomationShimScript = () => '';
					fake.panel = { webview: {
						cspSource: "'self'",
						// Relative: the generated page's assets sit beside it in this package.
						asWebviewUri: (uri) => ({ toString: () => String(uri.fsPath).split(/[\\\\\\\\/]/).pop() })
					} };
					return GitGraphView.prototype.getHtmlForWebview.call(fake);
				}
				// The tab titles of the pages the view opens - the extension's own panel titles
				// (comparisonView.ts / binaryCompareView.ts), in the view's interface language.
				const { t } = require('./i18n.js');
				const { abbrevCommit } = require('./utils.js');
				function panelTitle(options) {
					globalThis.__gitGraphStudioOverrides = options.settings || {};
					const present = (hash) => hash === '' || hash === '*';
					const label = (hash) => (present(hash) ? t('comparePresentLabel') : abbrevCommit(hash));
					if (options.kind === 'commit') return t('commitPanelTitle', abbrevCommit(options.toHash));
					if (options.kind === 'binary') return t('binaryCompareTitle', options.filePath, abbrevCommit(options.fromHash), label(options.toHash));
					return t('comparePanelTitle', abbrevCommit(options.fromHash), label(options.toHash));
				}
				globalThis.GitGraphViewPage = { buildViewPage: buildViewPage, panelTitle: panelTitle };
			`,
			resolveDir: patchedOut,
			loader: 'js'
		},
		...bundleOptions(patchedOut, outfile)
	});
}
