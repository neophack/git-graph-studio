// Merge conflict parsing and resolution: the marker blocks git leaves in a conflicted file,
// and the document edits the three choices apply.

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import { applyChoice, conflictAt, conflictDecorations, MergeToolbar, parseConflicts } from '../src/features/compare';
import { backend } from './tauriMock';
import { click, flush } from './helpers';
import type { Extension } from '@codemirror/state';

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

const TWO = [
	'a',
	'<<<<<<< HEAD', 'ours one', '=======', 'theirs one', '>>>>>>> b',
	'mid',
	'<<<<<<< HEAD', 'ours two', '=======', 'theirs two', '>>>>>>> c',
	'z'
].join('\n');

function viewOf(text: string, extensions: Extension[] = []): EditorView {
	const host = document.createElement('div');
	document.body.appendChild(host);
	return new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host });
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

	it('a side the merge resolved away applies as nothing, never an inverted range', () => {
		const view = viewOf('<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> b');
		const conflict = parseConflicts(view.state.doc.toString())[0]!;
		// Keep ours on an empty-ours conflict: the whole block (theirs side included) is
		// replaced by ours' zero lines.
		expect(applyChoice(view, conflict, 'ours')).toBe(true);
		expect(view.state.doc.toString()).toBe('');
		view.destroy();
		// Keep theirs brings that side's lines back.
		const view2 = viewOf('<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> b');
		expect(applyChoice(view2, parseConflicts(view2.state.doc.toString())[0]!, 'theirs')).toBe(true);
		expect(view2.state.doc.toString()).toBe('theirs');
		view2.destroy();
	});
});

describe('merge conflict decorations', () => {
	it('paints the sides in VS Code\'s tints, one actions widget above each conflict', () => {
		const view = viewOf(CONFLICTED, [conflictDecorations()]);
		const lines = (cls: string) => Array.from(view.dom.querySelectorAll(`.cm-line.${cls}`)).map((line) => line.textContent);
		expect(lines('cm-conflict-ours')).toEqual(['ours line']);
		expect(lines('cm-conflict-base')).toEqual(['base line']);
		expect(lines('cm-conflict-theirs')).toEqual(['theirs line']);
		expect(lines('cm-conflict-ours-head')).toEqual(['<<<<<<< HEAD']);
		expect(lines('cm-conflict-theirs-head')).toEqual(['>>>>>>> feature']);
		expect(lines('cm-conflict-mid')).toEqual(['=======']);
		expect(view.dom.querySelectorAll('.cm-conflict-actions')).toHaveLength(1);
		view.destroy();
	});

	it('a plain document paints nothing, and an edit that resolves the markers clears the paint', () => {
		const view = viewOf(SIMPLE, [conflictDecorations()]);
		expect(view.dom.querySelector('.cm-conflict-actions')).not.toBeNull();
		click(Array.from(view.dom.querySelectorAll('.cm-conflict-action')).find((b) => b.textContent === 'Accept Current Change')!);
		expect(view.state.doc.toString()).toBe('one\nours\ntwo');
		expect(view.dom.querySelector('.cm-conflict-actions')).toBeNull();
		expect(view.dom.querySelector('.cm-conflict-ours')).toBeNull();
		view.destroy();

		const plain = viewOf('no markers\nat all\n', [conflictDecorations()]);
		plain.dispatch({ changes: { from: plain.state.doc.length, insert: 'x' } });
		expect(plain.dom.querySelector('.cm-conflict-ours')).toBeNull();
		plain.destroy();
	});

	it('the widget resolves against its own conflict, not whichever is first', () => {
		const view = viewOf(TWO, [conflictDecorations()]);
		const widgets = Array.from(view.dom.querySelectorAll('.cm-conflict-actions'));
		expect(widgets).toHaveLength(2);
		// The second conflict's widget accepts ITS incoming side; the first conflict's
		// markers stand untouched.
		const theirs = Array.from(widgets[1]!.querySelectorAll('button')).find((b) => b.textContent === 'Accept Incoming Change')!;
		click(theirs);
		expect(view.state.doc.toString()).toBe('a\n<<<<<<< HEAD\nours one\n=======\ntheirs one\n>>>>>>> b\nmid\ntheirs two\nz');
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

	it('previous and next land the selection on the conflict, like VS Code\'s navigation', () => {
		const conflicted = viewOf(TWO);
		const { bar } = toolbarFor(conflicted);
		// The count names the first conflict; stepping forward moves the selection to the
		// second one's first marker, and stepping back past the first wraps to it.
		expect(bar.textContent).toContain('1 / 2');
		click(button(bar, '›')!);
		const head = conflicted.state.selection.main.head;
		expect(conflicted.state.doc.lineAt(head).number).toBe(8);
		expect(conflicted.state.doc.lineAt(head).text).toBe('<<<<<<< HEAD');
		click(button(bar, '‹')!);
		const back = conflicted.state.selection.main.head;
		expect(conflicted.state.doc.lineAt(back).number).toBe(2);
		click(button(bar, '‹')!);
		const wrapped = conflicted.state.selection.main.head;
		expect(conflicted.state.doc.lineAt(wrapped).number).toBe(8);
		conflicted.destroy();
	});
});
