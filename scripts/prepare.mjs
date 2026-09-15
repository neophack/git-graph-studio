// Assembles everything the app build consumes under <project>/target/studio/, so no generated
// file ever lands in the source tree:
//
//   target/studio/public/   the Vite public dir: static/** plus the extension's webview
//                           build (media/out.min.js, out.min.css, markdown-it), the extension's
//                           icons (resources/), and the runtime config bundle (see below) — the
//                           integrated git-graph-rs serves its webview from here
//   target/studio/icons/    the app icons `tauri icon` derives from vscode-git-graph-rs/resources/icon.png
//   target/studio/cargo/    the Cargo target dir (src-tauri/.cargo/config.toml)
//   target/studio/dist/     the Vite build output (vite.config.ts)
//
// The config bundle (public/gitgraph/config.js) is the extension's own compiled src/config.ts,
// bundled by esbuild with the `vscode` module replaced by a stub whose configuration reads
// come from an override map. The app calls it at runtime to build the Git Graph view's
// `initialState.config` - exactly as the extension host does - which keeps every default,
// every derived field and every setting the view's Settings Widget writes in sync with the
// extension, without a hand-maintained copy.
//
// Requires the plugin submodule checked out and compiled: `npm install && npm run compile`
// in vscode-git-graph-rs/ (its out/config.js and media/).
import { build } from 'esbuild';
import { checkSeams } from './check-seams.mjs';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The seam rules first: nothing may consume the extension's artifacts outside the designated
// interface files (graphHost.ts, view.html, cmd_graph.rs), so a violation fails the build
// before anything is assembled.
checkSeams();
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// The git-graph-rs extension lives in its own repository, checked out as the vscode-git-graph-rs/ submodule.
const root = join(appDir, 'vscode-git-graph-rs');
const out = join(appDir, 'target', 'studio');
const publicDir = join(out, 'public');

function requireArtifact(path, hint) {
	if (!existsSync(path)) {
		console.error(`${path} not found - ${hint}`);
		process.exit(1);
	}
	return path;
}

/* 1. The public dir: static sources, then the extension's artifacts. */
// Windows keeps handles on the public dir for a moment after a dev server or Explorer
// touched it; retrying makes the build resilient to that instead of failing with EPERM.
	rmSync(publicDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(publicDir, { recursive: true });
cpSync(join(appDir, 'static'), publicDir, { recursive: true });

const gitgraphDir = join(publicDir, 'gitgraph');
mkdirSync(gitgraphDir, { recursive: true });
for (const [from, to] of [
	['media/out.min.js', 'out.min.js'],
	['media/out.min.css', 'out.min.css'],
	['media/vendor/markdown-it.min.js', 'markdown-it.min.js']
]) {
	requireArtifact(join(root, from), 'run `npm run compile` in vscode-git-graph-rs/ first');
	copyFileSync(join(root, from), join(gitgraphDir, to));
}

// markdown-it once more as a workbench asset (public/vendor/), for the Extensions view's README
// rendering — so no module outside the Git Graph seam (graphHost.ts + static/gitgraph) touches
// the extension's files at runtime.
const vendorDir = join(publicDir, 'vendor');
mkdirSync(vendorDir, { recursive: true });
copyFileSync(join(root, 'media', 'vendor', 'markdown-it.min.js'), join(vendorDir, 'markdown-it.min.js'));

// The extension's own icons: the webview/tab icon, the 16px command icon, and the marketplace
// icon the welcome page shows.
const iconsDir = join(publicDir, 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const [from, to] of [
	['resources/git-graph-rs-webview-icon-dark.svg', 'git-graph.svg'],
	['resources/git-graph-rs-cmd-icon-dark.svg', 'git-graph-16.svg'],
	['resources/icon.png', 'icon.png']
]) {
	copyFileSync(join(root, from), join(iconsDir, to));
}

/* 2. The config bundle. */
const configPath = join(root, 'out', 'config.js');
requireArtifact(configPath, 'run `npm run compile` in vscode-git-graph-rs/ first');
await build({
	stdin: {
		contents: `
			const { getConfig } = require(${JSON.stringify(configPath)});
			const overrides = globalThis.__gitGraphStudioOverrides = globalThis.__gitGraphStudioOverrides || {};
			// The field mapping of GitGraphView.getWebviewConfig() (src/gitGraphView.ts), so the
			// result is exactly the shape the webview's initialState.config expects.
			module.exports = function buildWebviewConfig(settings) {
				for (const key of Object.keys(overrides)) delete overrides[key];
				Object.assign(overrides, settings || {});
				const config = getConfig();
				return {
					commitAuthors: config.commitAuthors,
					commitDetailsView: config.commitDetailsView,
					commitOrdering: config.commitOrder,
					contextMenuActionsVisibility: config.contextMenuActionsVisibility,
					customBranchGlobPatterns: config.customBranchGlobPatterns,
					customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
					customPullRequestProviders: config.customPullRequestProviders,
					dateFormat: config.dateFormat,
					dateType: config.dateType,
					defaultColumnVisibility: config.defaultColumnVisibility,
					enableLog: config.enableLog,
					stickyHeader: config.stickyHeader,
					dialogDefaults: config.dialogDefaults,
					enhancedAccessibility: config.enhancedAccessibility,
					fetchAndPrune: config.fetchAndPrune,
					fetchAndPruneTags: config.fetchAndPruneTags,
					fetchAvatars: false,
					gerrit: config.gerrit,
					graph: config.graph,
					// The resolved interface language: config.ts's interfaceLanguage getter defers
					// "auto" to vscode.env.language, which the stub resolves to the workbench's
					// locale - so "auto" follows the app's display language.
					interfaceLanguage: config.interfaceLanguage,
					interfaceLanguageSetting: config.interfaceLanguageSetting,
					includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
					initialLoadCommits: config.initialLoadCommits,
					keybindings: config.keybindings,
					loadMoreCommits: config.loadMoreCommits,
					loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
					markdown: config.markdown,
					mute: config.muteCommits,
					showBodyInline: config.showCommitBodyInline,
					onlyFollowFirstParent: config.onlyFollowFirstParent,
					onRepoLoad: config.onRepoLoad,
					pullRequests: config.pullRequests,
					referenceLabels: config.referenceLabels,
					repoDropdownOrder: config.repoDropdownOrder,
					showCommitBodyInline: config.showCommitBodyInline,
					showRemoteBranches: config.showRemoteBranches,
					showRemoteHeads: config.showRemoteHeads,
					showStashes: config.showStashes,
					showTags: config.showTags,
					showUncommittedChanges: config.showUncommittedChanges,
					showUntrackedFiles: config.showUntrackedFiles,
					trackRemoteTags: config.trackRemoteTags,
					// The git-side settings the app's own write path reads (the view never does).
					signCommits: config.signCommits,
					signTags: config.signTags,
					squashMergeMessageFormat: config.squashMergeMessageFormat,
					squashPullMessageFormat: config.squashPullMessageFormat
				};
			};
		`,
		resolveDir: root,
		loader: 'js'
	},
	bundle: true,
	format: 'iife',
	globalName: 'GitGraphStudioConfig',
	platform: 'browser',
	target: 'es2020',
	minify: true,
	alias: { vscode: join(appDir, 'scripts', 'vscode-stub.cjs') },
	outfile: join(gitgraphDir, 'config.js'),
	logLevel: 'warning'
});

/* 3. The Commit Comparison page generator.

   The comparison view is not part of the webview bundle the graph view loads - the extension
   generates its complete HTML page (inline CSS and script included) from extension-host code
   (src/comparisonView.ts). The app calls that same compiled generator: this bundle exposes
   `GitGraphCompare.buildComparePage()`, which runs the extension's own `getHtml` template
   against a stubbed panel, so the app hosts the extension's real comparison page - styles,
   markup and embedded script - instead of maintaining a copy. `vscode` resolves to the same
   stub the config bundle uses (the page's language follows the workbench locale); the Node
   built-ins that only the hex-session machinery touches resolve to inert stubs, unused here.

   The extension's compiled output wraps its fs requires in an Electron `original-fs` fallback
   (scripts/package-src.js) whose variable-argument require() defeats static bundling, so the
   bundle is built from patched copies under target/studio with that wrapper folded back to
   the plain require - the extension's sources and out/ are never touched. */
const patchedOut = join(out, 'compare-src');
rmSync(patchedOut, { recursive: true, force: true });
mkdirSync(patchedOut, { recursive: true });
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
	alias: { vscode: join(appDir, 'scripts', 'vscode-stub.cjs') },
	plugins: [{
		// esbuild resolves Node built-ins inside CommonJS requires before `alias` applies, so
		// they are redirected here instead: `path` gets a real join(), the rest inert stubs.
		name: 'node-builtin-shims',
		setup(builder) {
			builder.onResolve({ filter: /^(fs|child_process|os|util|crypto|http|https)$/ }, () => ({ path: join(appDir, 'scripts', 'empty-stub.cjs') }));
			builder.onResolve({ filter: /^path$/ }, () => ({ path: join(appDir, 'scripts', 'path-stub.cjs') }));
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
	outfile: join(gitgraphDir, 'compare.js'),
	logLevel: 'warning'
});

// The syntax highlighter the generated comparison page loads, next to the bundle.
copyFileSync(
	requireArtifact(join(root, 'media', 'vendor', 'highlight.min.js'), 'run `npm run compile` in vscode-git-graph-rs/ first'),
	join(gitgraphDir, 'highlight.min.js')
);

/* 4. The app icons, once. */
const appIcons = join(out, 'icons');
if (!existsSync(join(appIcons, 'icon.ico')) || !existsSync(join(appIcons, '32x32.png'))) {
	mkdirSync(appIcons, { recursive: true });
	const tauri = join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
	const result = spawnSync(tauri, ['icon', join(root, 'resources', 'icon.png'), '-o', appIcons], {
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		console.error('Generating the app icons failed');
		process.exit(1);
	}
}

console.log(`Prepared ${out}`);
