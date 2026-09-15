// The async-chunk loaders: each library loads once, every caller shares the promise, and the
// editor group / terminal reach CodeMirror and xterm only through them (so the first paint
// never carries either).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadMerge, loadTextEditor, loadXterm } from '../src/lazy';

describe('lazy chunks', () => {
	it('loads each library once and shares the promise', async () => {
		expect(loadTextEditor()).toBe(loadTextEditor());
		expect(loadMerge()).toBe(loadMerge());
		expect(loadXterm()).toBe(loadXterm());
		const cm = await loadTextEditor();
		expect(typeof cm.EditorView).toBe('function');
		expect(cm.baseExtensions(true).length).toBeGreaterThan(5);
		const merge = await loadMerge();
		expect(typeof merge.MergeView).toBe('function');
		const xterm = await loadXterm();
		expect(typeof xterm.Terminal).toBe('function');
	});

	it('keeps CodeMirror and xterm out of the workbench module graph', () => {
		// The static import graph of the first paint: workbench.ts and the modules it reaches
		// without a dynamic import must not name the heavy libraries.
		const forbidden = /^import .* from '(@codemirror\/(?!merge)|@lezer\/|@xterm\/)/m;
		for (const file of ['workbench.ts', 'editor.ts', 'terminal.ts', 'folderCompare.ts', 'panel.ts', 'explorer.ts', 'scm.ts', 'searchView.ts', 'statusbar.ts', 'titlebar.ts', 'ui.ts', 'main.ts']) {
			const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
			const offending = source.split('\n').filter((line) => forbidden.test(line) && !line.startsWith('import type'));
			expect(offending, file).toEqual([]);
		}
	});
});

describe('the hex and CAN chunks', () => {
	it('load once, on demand, and stay out of the first-paint graph', async () => {
		const { loadCanViews, loadHexCompare, loadHexView } = await import('../src/lazy');
		expect(loadHexView()).toBe(loadHexView());
		expect(loadHexCompare()).toBe(loadHexCompare());
		expect(loadCanViews()).toBe(loadCanViews());
		expect(typeof (await loadHexView()).HexView).toBe('function');
		expect(typeof (await loadHexCompare()).HexCompareView).toBe('function');
		const can = await loadCanViews();
		expect(typeof can.CanRawView).toBe('function');
		expect(typeof can.CanLogView).toBe('function');
		// Only `import type` may name them from the modules the workbench paints with.
		const forbidden = /^import .* from '\.\/(hexView|hexCompare|canLogView|canRawView|canChart)'/m;
		for (const file of ['workbench.ts', 'editor.ts', 'editorArea.ts', 'folderCompare.ts', 'explorer.ts', 'scm.ts']) {
			const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
			const offending = source.split('\n').filter((line) => forbidden.test(line) && !line.startsWith('import type'));
			expect(offending, file).toEqual([]);
		}
	});
});
