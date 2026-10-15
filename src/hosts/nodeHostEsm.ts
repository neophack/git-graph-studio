// The real-Node host's ESM seam. The host's `require('vscode')` interception
// (nodeHost.ts's `Module._load` patch) never sees a static `import 'vscode'`: an ES
// module graph resolves through Node's own ESM resolver, which knows nothing of the
// shim, so a `"type": "module"` package (kimi-code's 8.8 MB entry is one) died with
// ERR_MODULE_NOT_FOUND before anything of it ran.
//
// The fix is Node's loader hooks (`module.register()`, Node 20.6+): the registered hook
// module resolves exactly the `vscode` specifier onto a synthetic module whose named
// exports read the shim instance off a global. Both halves are generated SOURCE, baked
// into data: URLs — no second file ships with the bundle, and the two threads' split is
// respected by construction: the hooks thread only fetches source (it cannot see host
// state), while the synthetic module EVALUATES on the main thread, where the stash it
// reads lives. nodeHost.ts stashes the instance and registers the hooks right after the
// require patch, so a CJS entry's dynamic `import()` of an ESM chunk is covered too.

import { Buffer } from 'node:buffer';

/** The global key the synthetic `vscode` module reads the shim instance from. */
export const VSCODE_ESM_GLOBAL = 'ggs.vscode';

/** The well-known VS Code value exports this host may not serve. An `import { LogLevel }
 *  from 'vscode'` must still LINK (the name answers undefined, the same tolerance the
 *  require path has — an absent member logs and the activation survives) instead of
 *  failing the whole graph with "does not provide an export". Type-only imports are
 *  erased by the package's own build and never reach here. */
const VSCODE_ESM_FALLBACK_EXPORTS = [
	'CancellationTokenSource', 'CodeAction', 'CodeActionKind', 'CodeActionTriggerKind', 'Color',
	'CompletionItem', 'CompletionItemKind', 'CompletionList', 'ConfigurationTarget',
	'DebugAdapterServer', 'DecorationRangeBehavior', 'Diagnostic', 'DiagnosticRelatedInformation',
	'DiagnosticSeverity', 'Disposable', 'EndOfLine', 'EnvironmentVariableMutatorType',
	'EventEmitter', 'ExtensionKind', 'ExtensionMode', 'FileChangeType', 'FileType', 'Hover',
	'InlineCompletionTriggerKind', 'Location', 'LogLevel', 'MarkdownString', 'NotebookCellKind',
	'NotebookCellOutputItem', 'NotebookCellStatusBarItem', 'NotebookData', 'NotebookEdit',
	'NotebookRange', 'OverviewRulerLane', 'Position', 'ProgressLocation', 'QuickPickItemKind',
	'Range', 'RelativePattern', 'Selection', 'SnippetString', 'StatusBarAlignment',
	'TaskPanelKind', 'TaskRevealKind', 'TaskScope', 'TextDocumentSaveReason',
	'TextEditorRevealType', 'TextEdit', 'ThemeColor', 'ThemeIcon', 'TreeItem',
	'TreeItemCheckboxState', 'TreeItemCollapsibleState', 'UIKind', 'Uri', 'ViewColumn',
	'WorkspaceEdit'
];

function isIdentifier(name: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** The synthetic `vscode` module: one named export per shim key plus every fallback name
 *  (absent ones `undefined`), a default export of the instance itself, and the instance
 *  read off the global at evaluation time. Only identifier names export — a stray key
 *  cannot poison the generated source. A fallback name the instance lacks exports a
 *  literal `undefined` rather than a read: the instance is the upgrade-safety probe
 *  (vscodeNamespaceProbe.ts), and reading every absent fallback at evaluation would log
 *  each one as an API gap of every ES module package, used or not. */
export function vscodeEsmModuleSource(api: object): string {
	const served = new Set(Object.keys(api));
	const names = [...new Set([...served, ...VSCODE_ESM_FALLBACK_EXPORTS])]
		.filter((name) => name !== 'default' && isIdentifier(name))
		.sort();
	return [
		`const api = globalThis[Symbol.for(${JSON.stringify(VSCODE_ESM_GLOBAL)})];`,
		...names.map((name) => served.has(name) ? `export const ${name} = api[${JSON.stringify(name)}];` : `export const ${name} = undefined;`),
		'export default api;'
	].join('\n');
}

/** The loader-hook module source: `import 'vscode'` short-circuits onto the synthetic
 *  module (a data: URL — the ESM loader serves those natively, so no load hook is
 *  needed); every other specifier falls through to Node's own resolver, keeping a
 *  package's ESM, workers and `node_modules` exactly native. */
export function vscodeEsmHookSource(api: object): string {
	const shimUrl = 'data:text/javascript;base64,' + Buffer.from(vscodeEsmModuleSource(api), 'utf8').toString('base64');
	return [
		`const SHIM_URL = ${JSON.stringify(shimUrl)};`,
		'export async function resolve(specifier, context, next) {',
		"  if (specifier === 'vscode') return { url: SHIM_URL, shortCircuit: true };",
		'  return next(specifier, context);',
		'}'
	].join('\n');
}

/** The data: URL `module.register()` takes for the hook module above. */
export function vscodeEsmHookUrl(api: object): string {
	return 'data:text/javascript;base64,' + Buffer.from(vscodeEsmHookSource(api), 'utf8').toString('base64');
}
