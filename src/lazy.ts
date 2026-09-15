// The libraries that are not needed to paint the workbench, loaded on first use so they live
// in async chunks (vite.config.ts `manualChunks`) instead of the first-paint bundle: xterm
// arrives with the first terminal, @codemirror/merge with the first diff. Each loader runs
// its import once and hands every later caller the same promise.

function once<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => (pending ??= load());
}

/** The text editor widget (`textEditor.ts`) and with it CodeMirror's core. */
export const loadTextEditor = once(() => import('./textEditor'));

/** `@codemirror/merge`: the side-by-side and unified diff views. */
export const loadMerge = once(() => import('@codemirror/merge'));

/** xterm.js with its fit addon and stylesheet. */
export const loadXterm = once(async () => {
	const [{ Terminal }, { FitAddon }] = await Promise.all([
		import('@xterm/xterm'),
		import('@xterm/addon-fit'),
		import('@xterm/xterm/css/xterm.css')
	]);
	return { Terminal, FitAddon };
});

/** The CAN log views - the raw frame browser, the statistics tab and its charts - loaded
 *  with the first .blf / .asc that opens. */
export const loadCanViews = once(async () => {
	const [{ CanRawView }, { CanLogView }] = await Promise.all([import('./canRawView'), import('./canLogView')]);
	return { CanRawView, CanLogView };
});

/** The hex viewer, loaded with the first binary file; the hex comparison shares its helpers. */
export const loadHexView = once(() => import('./hexView'));
export const loadHexCompare = once(() => import('./hexCompare'));
