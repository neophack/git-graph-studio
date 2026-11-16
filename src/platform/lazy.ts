// The libraries that are not needed to paint the workbench, loaded on first use so they live
// in async chunks (vite.config.ts `manualChunks`) instead of the first-paint bundle: xterm
// arrives with the first terminal, the diff view with the first diff. Each loader runs
// its import once and hands every later caller the same promise.

function once<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => (pending ??= load());
}

/** The text editor widget (`textEditor.ts`) and with it CodeMirror's core. */
export const loadTextEditor = once(() => import('../features/editor/textEditor'));

/** The file editor's extension-provider surfaces - diagnostics squiggles, decorations and the
 *  hover / Go-to-Definition tooltips (`editorDiagnosticsView.ts` / `editorDecorationsView.ts` /
 *  `editorProviderViews.ts`): CodeMirror extensions that ride with the editor suite, never
 *  first paint. */
export const loadEditorExtensions = once(() => Promise.all([
	import('../features/editor/editorDiagnosticsView'),
	import('../features/editor/editorDecorationsView'),
	import('../features/editor/editorProviderViews')
]));

/** The text diff view (`diffView.ts`): the diff editor's renderer over the backend's
 *  git-computed hunks, loaded with the first diff. */
export const loadDiffView = once(() => import('../features/editor/diffView'));

/** xterm.js with its fit and search addons and the stylesheet. */
export const loadXterm = once(async () => {
	const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
		import('@xterm/xterm'),
		import('@xterm/addon-fit'),
		import('@xterm/addon-search'),
		import('@xterm/xterm/css/xterm.css')
	]);
	return { Terminal, FitAddon, SearchAddon };
});

/** The CAN log views - the raw frame browser, the statistics tab and its charts - loaded
 *  with the first .blf / .asc that opens. */
export const loadCanViews = once(async () => {
	const [{ CanRawView }, { CanLogView }] = await Promise.all([import('../features/can/canRawView'), import('../features/can/canLogView')]);
	return { CanRawView, CanLogView };
});

/** The Data Table views (module 20) - the CSV table browser and its plot - loaded with
 *  the first .csv / .tsv that opens. */
export const loadDataViews = once(() => import('../features/data/csvView'));

/** The CAN database view (module 13) - the .dbc message browser and its decode panel -
 *  loaded with the first .dbc that opens. */
export const loadDbcView = once(() => import('../features/dbc/dbcView'));

/** The ELF Inspector (module 21) - the .elf/.axf summary, sections and symbols -
 *  loaded with the first image that opens. */
export const loadElfView = once(() => import('../features/elf/elfView'));

/** The Device Tree view (module 22) - the .dts/.dtb node tree - loaded with the first
 *  device tree that opens. */
export const loadDevTreeView = once(() => import('../features/devtree/devTreeView'));

/** The Memory Dump Viewer (module 21), loaded with the first .dmp / .mdmp that opens. */
export const loadDumpViews = once(() => import('../features/dump/dumpView'));

/** The hex viewer, loaded with the first binary file; the hex comparison shares its helpers. */
export const loadHexView = once(() => import('../features/viewers/hexView'));
export const loadHexCompare = once(() => import('../features/viewers/hexCompare'));
/** The image viewer (zoom, pan, gestures, gallery), loaded with the first image that opens. */
export const loadImageView = once(() => import('../features/viewers/imageView'));
/** The media viewer (video/audio player, information panel), loaded with the first media
 *  file that opens. */
export const loadMediaView = once(() => import('../features/viewers/mediaView'));

/** The Fast Viewer (a read-only large file), the folder-compare and merge-conflict views, the
 *  file-history timeline, the call tree and the workspace snippets - each opens with its first
 *  use, and together they keep the first-paint bundle to what the workbench paints with. */
export const loadFastView = once(() => import('../features/viewers/fastView'));
export const loadFolderCompare = once(() => import('../features/compare/folderCompare'));
export const loadMergeEditor = once(() => import('../features/compare/mergeEditor'));
export const loadFileHistory = once(() => import('../features/scm/fileHistory'));
export const loadCallTree = once(() => import('../features/search/callTree'));
export const loadSymbolDbView = once(() => import('../features/search/symbolDbView'));
export const loadSnippetRegistry = once(() => import('../features/editor/snippetRegistry'));

/** The Code Analysis result pages (module 17): the streaming reports and the graph
 *  drawings, loaded with the first tool tab the Analysis sidebar opens. */
export const loadAnalysisPages = once(() => import('../features/analysis/analysisPages'));
