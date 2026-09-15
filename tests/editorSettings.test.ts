// The settings the recent features added (M3 3.1-3.3 and the editor settings round): the
// editor font size, tab size and word wrap apply to open editors live, the completion toggles
// gate their sources, and the Settings dialog offers every one of them.

import { beforeEach, describe, expect, it } from 'vitest';
import { indentUnit } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';

import { EditorGroup } from '../src/editor';
import { pathCompletion, snippetCompletionSource, wordCompletion, fileNameFacet } from '../src/autocomplete';
import { applyFontSize, updateSetting } from '../src/settings';
import { openSettingsPanel } from '../src/settingsPanel';
import { backend } from './tauriMock';
import { click, texts } from './helpers';

const CONTENT = 'const a = 1;\n';

describe('the editor settings', () => {
	let group: EditorGroup;

	beforeEach(async () => {
		updateSetting('fontSize', 14);
		updateSetting('tabSize', 4);
		updateSetting('wordWrap', false);
		updateSetting('snippetSuggestions', true);
		updateSetting('pathCompletion', true);
		const part = document.getElementById('editorGroup')!;
		part.innerHTML = '';
		document.getElementById('overlays')!.innerHTML = '';
		backend.on('read_file', () => ({ contents: CONTENT, binary: false, size: CONTENT.length }));
		group = new EditorGroup(part);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\main.ts');
	});

	it('the font size travels on a CSS variable', () => {
		applyFontSize(18);
		expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('18px');
		updateSetting('fontSize', 20);
		expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('20px');
	});

	it('tab size and word wrap reconfigure the open editor in place', async () => {
		const view = group.activeView!;
		expect(view.state.facet(indentUnit)).toBe('    ');
		expect(view.dom.classList.contains('cm-lineWrapping')).toBe(false);

		updateSetting('tabSize', 2);
		updateSetting('wordWrap', true);
		expect(view.state.facet(indentUnit)).toBe('  ');
		// A tab character renders at the setting's width as well.
		expect(view.state.tabSize).toBe(2);
		expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
	});

	it('the completion toggles gate their sources', async () => {
		const context = new CompletionContext(EditorState.create({ doc: 'fn', extensions: [fileNameFacet.of('main.rs')] }), 2, true);
		expect(snippetCompletionSource(context)).not.toBeNull();
		updateSetting('snippetSuggestions', false);
		expect(snippetCompletionSource(context)).toBeNull();
		// The word source is independent of the snippet toggle.
		const doc = 'const total = tot';
		const wordContext = new CompletionContext(EditorState.create({ doc, extensions: [fileNameFacet.of('main.ts')] }), doc.length, true);
		expect(wordCompletion(wordContext)!.options.map((o) => o.label)).toEqual(['total']);

		// A path-looking fragment: gated off without asking the backend.
		const pathContext = new CompletionContext(EditorState.create({ doc: 'src/', extensions: [fileNameFacet.of('main.ts')] }), 4, true);
		updateSetting('pathCompletion', false);
		expect(await pathCompletion(pathContext)).toBeNull();
		updateSetting('pathCompletion', true);
		backend.on('list_files', () => ['src/main.ts']);
		const result = await pathCompletion(pathContext);
		expect(result!.options.map((o) => o.label)).toEqual(['main.ts']);
	});

	it('the settings dialog offers every new setting', () => {
		openSettingsPanel();
		// The dialog opens on General; the editor settings live behind its Editor tab.
		const navItems = Array.from(document.querySelectorAll('.settings-nav-item'));
		click(navItems.find((item) => item.textContent === 'Editor')!);
		const labels = texts('.settings-row-label');
		for (const label of ['Auto Save Delay', 'Editor Font Size', 'Tab Size', 'Word Wrap', 'Snippet Suggestions', 'Path Suggestions']) {
			expect(labels).toContain(label);
		}
		// The font-size select applies through updateSetting.
		const selects = Array.from(document.querySelectorAll('.settings-select')) as HTMLSelectElement[];
		const fontSelect = selects.find((s) => s.textContent === '12 px13 px14 px16 px18 px20 px24 px')!;
		fontSelect.value = '18';
		fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
		expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('18px');
		click(document.querySelector('.settings-close'));
	});
});

describe('word completion in a large document', () => {
	it('scans a window around the cursor, so a keystroke never walks megabytes', () => {
		// A 3 MB document: a rare word far from the cursor is out of the window, a word
		// near it is in, and the scan stays fast.
		const filler = 'lorem ipsum dolor sit amet '.repeat(120_000); // ~3.2 MB
		const doc = 'farawayword ' + filler + 'nearbyword nea';
		const context = new CompletionContext(EditorState.create({ doc, extensions: [fileNameFacet.of('big.txt')] }), doc.length, true);
		const started = performance.now();
		const result = wordCompletion(context)!;
		expect(performance.now() - started).toBeLessThan(500);
		expect(result.options.map((o) => o.label)).toEqual(['nearbyword']);
		const far = new CompletionContext(EditorState.create({ doc: doc + ' far', extensions: [fileNameFacet.of('big.txt')] }), doc.length + 4, true);
		expect(wordCompletion(far)).toBeNull();
	});
});
