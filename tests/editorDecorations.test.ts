// The extension-decoration store's semantics — the values behind
// `vscode.window.createTextEditorDecorationType` + `TextEditor.setDecorations` (the
// CodeMirror half renders these in editorDecorationsView.ts). Pinned: a type replaces
// its ranges per document (empty clears), types are isolated per key, disposal clears
// everywhere, and unknown keys are inert (an extension passing a foreign type never
// throws into another's pipeline).

import { describe, expect, it, beforeEach } from 'vitest';
import {
	decorationEntriesFor,
	decorationPathsOf,
	disposeDecorationType,
	normalizePathKey,
	registerDecorationType,
	setDecorationRanges,
	setDecorationsRenderer
} from '../src/editorDecorations';

describe('extension decoration store', () => {
	beforeEach(() => {
		for (const key of [...new Set(['.a', '.b', '.c'])].flatMap(decorationPathsOf)) {
			disposeDecorationType(key);
		}
		// (the loop above is defensive; dispose of the known keys directly)
		disposeDecorationType('ext/1/deco');
		disposeDecorationType('ext/2/deco');
	});

	it('a type registers its options and replaces its ranges per document', () => {
		registerDecorationType('ext/1/deco', { backgroundColor: 'red' });
		setDecorationRanges('/w/a.ts', 'ext/1/deco', [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 }]);
		expect(decorationEntriesFor(normalizePathKey('/w/a.ts')).map((e) => e.key)).toEqual(['ext/1/deco']);
		// REPLACE, not append: the second call's ranges are the only ones.
		setDecorationRanges(normalizePathKey('/w/a.ts'), 'ext/1/deco', [{ startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 2 }]);
		const entries = decorationEntriesFor(normalizePathKey('/w/a.ts'));
		expect(entries).toHaveLength(1);
		expect(entries[0]!.ranges).toEqual([{ startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 2 }]);
		expect(entries[0]!.options.backgroundColor).toBe('red');
	});

	it('an empty range set clears the type on that document only', () => {
		registerDecorationType('ext/1/deco', {});
		setDecorationRanges('/w/a.ts', 'ext/1/deco', [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }]);
		setDecorationRanges('/w/b.ts', 'ext/1/deco', [{ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 1 }]);
		setDecorationRanges(normalizePathKey('/w/a.ts'), 'ext/1/deco', []);
		expect(decorationEntriesFor(normalizePathKey('/w/a.ts'))).toHaveLength(0);
		expect(decorationEntriesFor(normalizePathKey('/w/b.ts'))).toHaveLength(1);
	});

	it('types are isolated per key and unknown keys are inert', () => {
		registerDecorationType('ext/1/deco', { color: 'blue' });
		registerDecorationType('ext/2/deco', { color: 'green' });
		setDecorationRanges('/w/a.ts', 'ext/1/deco', [{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 }]);
		expect(decorationEntriesFor(normalizePathKey('/w/a.ts'))).toHaveLength(1);
		// A foreign/unknown key (another host's object) writes nothing and throws nothing.
		setDecorationRanges('/w/a.ts', 'ext/9/deco', [{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 }]);
		expect(decorationEntriesFor(normalizePathKey('/w/a.ts'))).toHaveLength(1);
	});

	it('disposing a type clears it everywhere and reports its document paths', () => {
		registerDecorationType('ext/1/deco', {});
		setDecorationRanges('/w/a.ts', 'ext/1/deco', [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }]);
		setDecorationRanges('/w/b.ts', 'ext/1/deco', [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }]);
		expect(decorationPathsOf('ext/1/deco').sort()).toEqual([normalizePathKey('/w/a.ts'), normalizePathKey('/w/b.ts')]);
		disposeDecorationType('ext/1/deco');
		expect(decorationEntriesFor(normalizePathKey('/w/a.ts'))).toHaveLength(0);
		expect(decorationEntriesFor(normalizePathKey('/w/b.ts'))).toHaveLength(0);
	});

	it('store pushes reach the registered renderer with the document key', () => {
		const pushed: string[] = [];
		setDecorationsRenderer((pathKey) => pushed.push(pathKey));
		registerDecorationType('ext/1/deco', {});
		setDecorationRanges('/w/a.ts', 'ext/1/deco', []);
		expect(pushed).toEqual([normalizePathKey('/w/a.ts')]);
	});
});
