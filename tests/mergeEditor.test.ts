// Merge conflict parsing and resolution: the marker blocks git leaves in a conflicted file,
// and the document edits the three choices apply.

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import { applyChoice, conflictAt, MergeToolbar, parseConflicts } from '../src/mergeEditor';
import { backend } from './tauriMock';
import { click, flush } from './helpers';

const CONFLICTED = [
	'common start',
	'<<<<<<< HEAD',
	'ours line',
	'||||||| base',
	'base line',
	'=======',
	'theirs line',
	'>>>>>>> feature',
	'common end'
].join('\n');

const SIMPLE = ['one', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> b', 'two'].join('\n');

function viewOf(text: string): EditorView {
	const host = document.createElement('div');
	document.body.appendChild(host);
	return new EditorView({ state: EditorState.create({ doc: text }), parent: host });
}

describe('merge conflict parsing', () => {
	it('finds conflict blocks with and without a diff3 base section', () => {
		expect(parseConflicts(CONFLICTED)).toEqual([{ start: 2, separator: 6, end: 8, baseSeparator: 4 }]);
		expect(parseConflicts(SIMPLE)).toEqual([{ start: 2, separator: 4, end: 6, baseSeparator: null }]);
		expect(parseConflicts('no markers here')).toEqual([]);
	});

	it('ignores stray markers without their partners', () => {
		expect(parseConflicts('a\n<<<<<<< HEAD\nb\n')).toEqual([]);
	});

	it('locates the conflict containing a line', () => {
		const conflicts = parseConflicts(CONFLICTED);
		expect(conflictAt(conflicts, 3)?.start).toBe(2);
		expect(conflictAt(conflicts, 1)).toBeNull();
	});
});

describe('merge conflict resolution', () => {
	it('keeps ours, theirs, or both, dropping every marker', () => {
		for (const [choice, expected] of [
			['ours', 'ours line'],
			['theirs', 'theirs line'],
			['both', 'ours line\ntheirs line']
		] as const) {
			const view = viewOf(CONFLICTED);
			expect(applyChoice(view, parseConflicts(view.state.doc.toString())[0]!, choice)).toBe(true);
			expect(view.state.doc.toString()).toBe(`common start\n${expected}\ncommon end`);
			view.destroy();
		}
	});

	it('resolves a simple conflict and leaves the document marker-free', () => {
		const view = viewOf(SIMPLE);
		expect(applyChoice(view, parseConflicts(view.state.doc.toString())[0]!, 'both')).toBe(true);
		const text = view.state.doc.toString();
		expect(text).toBe('one\nours\ntheirs\ntwo');
		expect(parseConflicts(text)).toEqual([]);
		view.destroy();
	});
});

describe('mark resolved', () => {
	function toolbarFor(view: EditorView): { bar: HTMLElement; toolbar: MergeToolbar } {
		const bar = document.createElement('div');
		view.dom.prepend(bar);
		const toolbar = new MergeToolbar(bar);
		toolbar.attach(view, 'C:\\repo\\f.txt');
		return { bar, toolbar };
	}

	function button(bar: HTMLElement, label: string): HTMLElement | undefined {
		return Array.from(bar.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent === label);
	}

	it('writes the file in its own encoding and line endings, then settles the editor save state', async () => {
		backend.on('read_file', () => ({ contents: SIMPLE, binary: false, size: SIMPLE.length, encoding: 'gb18030', eol: 'crlf' }));
		backend.on('write_file', () => null);
		backend.on('git_stage', () => null);
		let editorSaves = 0;
		const host = document.createElement('div');
		document.body.appendChild(host);
		// The Mod-s binding mirrors the editor group's (editor.ts): saving through it is what
		// clears the dirty flag, the tab dot and the hot-exit backup.
		const view = new EditorView({
			state: EditorState.create({
				doc: SIMPLE,
				extensions: [keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { editorSaves++; return true; } }])]
			}),
			parent: host
		});
		const { bar, toolbar } = toolbarFor(view);
		expect(bar.hidden).toBe(false);

		// Resolving the last conflict keeps the bar - now offering to finish the resolution.
		click(button(bar, 'Keep Ours'));
		expect(toolbar.conflictCount).toBe(0);
		expect(bar.hidden).toBe(false);
		expect(bar.textContent).toContain('No conflicts');

		click(button(bar, 'Mark Resolved'));
		await flush();
		expect(backend.callsTo('write_file')[0]).toMatchObject({
			path: 'C:\\repo\\f.txt',
			contents: 'one\nours\ntwo',
			encoding: 'gb18030',
			eol: 'crlf'
		});
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['C:\\repo\\f.txt'] }]);
		expect(editorSaves).toBe(1);
		// Staged: the bar steps aside until another conflict appears.
		expect(bar.hidden).toBe(true);
		view.destroy();
	});

	it('a clean file shows no bar, and Mark Resolved with conflicts left only warns', async () => {
		backend.on('write_file', () => null);
		backend.on('git_stage', () => null);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new EditorView({ state: EditorState.create({ doc: 'plain\ntext\n' }), parent: host });
		const { bar } = toolbarFor(view);
		expect(bar.hidden).toBe(true);
		view.destroy();

		const conflicted = viewOf(SIMPLE);
		const { bar: bar2 } = toolbarFor(conflicted);
		click(button(bar2, 'Mark Resolved'));
		await flush();
		expect(backend.callsTo('write_file')).toHaveLength(0);
		expect(backend.callsTo('git_stage')).toHaveLength(0);
		conflicted.destroy();
	});
});
