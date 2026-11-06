// The editor command bundle: the line-editing family (join, sort, transforms, trim), the
// selection ladder (expand/shrink), the Ctrl+Tab most-recently-used walk, the text menu's
// linewise cut/copy and its Compare with Clipboard diff, and the breadcrumb dropdowns.
// The pure CodeMirror commands run on bare views; the group-level behaviour runs over the
// scripted backend like the rest of the module's suites.

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { EditorGroup, expandSelection, joinLines, shrinkSelection, sortLines, transformSelection, trimTrailingWhitespace } from '../src/features/editor';
import { backend } from './tauriMock';
import { click, flush, menuItem, menuLabels, rightClick, texts, until } from './helpers';

/** A bare view for the CodeMirror-level commands (the comments suite's pattern). Multiple
 *  selections stay multiple only under the facet the real editors enable — without it
 *  CodeMirror collapses every extra range, and the multi-cursor paths would never run. */
function viewOf(text: string, selection?: { anchor: number; head?: number }): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	return new EditorView({
		state: EditorState.create({
			doc: text,
			selection: selection ? EditorSelection.range(selection.anchor, selection.head ?? selection.anchor) : undefined,
			extensions: EditorState.allowMultipleSelections.of(true)
		}),
		parent
	});
}

function files(contents: Record<string, string>): void {
	backend.on('read_file', ({ path }) => {
		const text = contents[String(path)];
		if (text === undefined) throw new Error(`${path}: not found`);
		return { contents: text, binary: false, size: text.length };
	});
	backend.on('write_file', ({ path, contents: text }) => {
		contents[String(path)] = String(text);
		return null;
	});
	backend.on('viewer_open', () => ({ docId: 1, lineCount: 3, language: 'plaintext', syntaxName: 'Plain Text', symbols: [{ name: 'alpha', kind: 'function', line: 2 }] }));
	backend.on('viewer_close', () => null);
}

describe('line-editing commands', () => {
	it('Join Lines merges the cursor line with the next one at a single space', () => {
		const view = viewOf('one\n   two\nthree\n', { anchor: 3 });
		expect(joinLines(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('one two\nthree\n');
		// The cursor sits at the seam: the end of what was line one, past the space.
		expect(view.state.selection.main.head).toBe(4);
		view.destroy();
	});

	it('Join Lines collapses every line of a multi-line selection and trims empty seams', () => {
		const view = viewOf('a\n\nb\nc\n', { anchor: 0 });
		// The selection spans lines 1-3 ("a\n\nb").
		view.dispatch({ selection: EditorSelection.range(0, 4) });
		expect(joinLines(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('a b\nc\n');
		view.destroy();
	});

	it('Join Lines refuses on the document\'s last line and joins every cursor in one transaction', () => {
		const view = viewOf('one\ntwo\nthree\n', { anchor: 10 });
		expect(joinLines(view)).toBe(false);
		expect(view.state.sliceDoc()).toBe('one\ntwo\nthree\n');
		// Two cursors: line 1 joins line 2, line 3 has nothing after it. One dispatch serves
		// both — a single CodeMirror transaction is a single undo step.
		view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(10)]) });
		expect(joinLines(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('one two\nthree\n');
		view.destroy();
	});

	it('Sort Lines orders each multi-line selection and refuses a lone cursor', () => {
		const view = viewOf('c\nb\na\n', { anchor: 0, head: 5 });
		expect(sortLines(1)(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('a\nb\nc\n');
		// Descending reverts it; the selection rides along through the permutation.
		expect(sortLines(-1)(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('c\nb\na\n');
		// A cursor alone (or a single-line selection) sorts nothing.
		view.dispatch({ selection: { anchor: 0 } });
		expect(sortLines(1)(view)).toBe(false);
		view.dispatch({ selection: EditorSelection.range(0, 1) });
		expect(sortLines(1)(view)).toBe(false);
		view.destroy();
	});

	it('Sort Lines serves two selections in one press', () => {
		const view = viewOf('3\n1\n2\n\nz\nx\ny\n');
		view.dispatch({
			selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(7, 12)])
		});
		expect(sortLines(1)(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('1\n2\n3\n\nx\ny\nz\n');
		view.destroy();
	});

	it('Transform rewrites every selection; Title Case capitalizes each word', () => {
		const view = viewOf('abc and DEF\nhello WORLD\n', { anchor: 0, head: 3 });
		view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 11)]) });
		expect(transformSelection('upper')(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('ABC and DEF\nhello WORLD\n');
		expect(transformSelection('lower')(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('abc and def\nhello WORLD\n');
		// Title Case over the whole first line.
		view.dispatch({ selection: EditorSelection.range(0, 12) });
		expect(transformSelection('title')(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('Abc And Def\nhello WORLD\n');
		// Empty cursors only: the command refuses, like its disabled VS Code row.
		view.dispatch({ selection: { anchor: 0 } });
		expect(transformSelection('upper')(view)).toBe(false);
		view.destroy();
	});

	it('Trim Trailing Whitespace clears every line\'s tail in one pass', () => {
		const view = viewOf('a  \nb\t\nc\n');
		expect(trimTrailingWhitespace(view)).toBe(true);
		expect(view.state.sliceDoc()).toBe('a\nb\nc\n');
		view.destroy();
	});
});

describe('expand / shrink selection', () => {
	it('climbs word → bracket content → bracket pair → indentation block, then walks back', () => {
		const text = 'const a = compute(1, 2);\n';
		// The cursor sits inside the argument list, on the `1`.
		const view = viewOf(text, { anchor: 19 });
		expect(expandSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('1');
		expect(expandSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('1, 2');
		expect(expandSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('(1, 2)');
		expect(expandSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('const a = compute(1, 2);');
		// The block is the widest tier: another expand does nothing.
		expect(expandSelection(view)).toBe(false);
		// Shrink walks the exact path back down.
		expect(shrinkSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('(1, 2)');
		expect(shrinkSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('1, 2');
		expect(shrinkSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('1');
		expect(shrinkSelection(view)).toBe(true);
		expect(view.state.selection.main.empty).toBe(true);
		// The floor: an empty cursor shrinks nothing.
		expect(shrinkSelection(view)).toBe(false);
		view.destroy();
	});

	it('grows from a bare cursor to the word first, and merges overlapping results', () => {
		const view = viewOf('alpha beta alpha\n');
		// Two cursors inside one word grow into the same span: the union stands, one range.
		view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]) });
		expect(expandSelection(view)).toBe(true);
		expect(view.state.selection.ranges.length).toBe(1);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('alpha');
		// Two cursors in two different words grow into two word spans.
		view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(13)]) });
		expect(expandSelection(view)).toBe(true);
		expect(view.state.selection.ranges.length).toBe(2);
		view.destroy();
	});

	it('a document edit invalidates the remembered path; a word selection still collapses', () => {
		const view = viewOf('value;\n', { anchor: 1 });
		expect(expandSelection(view)).toBe(true);
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('value');
		// The edit lands outside the word, so the collapse below is the word tier's floor.
		view.dispatch({ changes: { from: 6, insert: 'x' } });
		expect(shrinkSelection(view)).toBe(true);
		expect(view.state.selection.main.empty).toBe(true);
		view.destroy();
	});
});

describe('the Ctrl+Tab most-recently-used walk', () => {
	it('activates the previous editor, walks back on repeats, and Shift reverses', async () => {
		files({ 'C:\\repo\\a.txt': 'a\n', 'C:\\repo\\b.txt': 'b\n', 'C:\\repo\\c.txt': 'c\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');
		await group.openFile('C:\\repo\\c.txt');
		await group.openFile('C:\\repo\\a.txt');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');

		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('c.txt');
		// Repeats while the walk is live step further back through the frozen order.
		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		// Shift+Tab walks the other way along the same walk.
		group.cycleMru(1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');

		// The modifier coming up ends the walk: the next Ctrl+Tab starts fresh from the
		// order of use, which the previews have kept current.
		document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
		await flush();
		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		await flush();
	});

	it('ends the walk on any other key and never leaves listeners behind', async () => {
		files({ 'C:\\repo\\a.txt': 'a\n', 'C:\\repo\\b.txt': 'b\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');
		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		// A different key abandons the walk in place; the next press starts a fresh walk,
		// and from the previewed editor the previous one is its neighbour again.
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
		await flush();
		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
		document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
		await flush();
	});

	it('with one editor open the walk refuses', async () => {
		files({ 'C:\\repo\\a.txt': 'a\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		group.cycleMru(-1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
		await flush();
	});
});

describe('the text menu\'s clipboard group', () => {
	it('Cut and Copy speak linewise for an empty selection', async () => {
		files({ 'C:\\repo\\a.ts': 'first\nsecond\nthird\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.ts');
		const view = group.activeView!;
		view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		rightClick(document.querySelector('.cm-content'));
		expect(menuLabels()).toContain('Compare with Clipboard');
		expect(menuItem('Copy')!.classList.contains('disabled')).toBe(false);
		click(menuItem('Copy'));
		expect(backend.clipboard).toEqual(['second\n']);

		// Cut takes the line's own newline with it.
		rightClick(document.querySelector('.cm-content'));
		click(menuItem('Cut'));
		expect(view.state.sliceDoc()).toBe('first\nthird\n');
		expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
		await flush();
	});

	it('Compare with Clipboard diffs the live buffer against the clipboard in memory', async () => {
		files({ 'C:\\repo\\a.ts': 'saved\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.ts');
		const view = group.activeView!;
		// An unsaved edit: the comparison speaks for the buffer, not the disk.
		view.dispatch({ changes: { from: 0, insert: 'edited ' } });
		backend.clipboardText = 'clip';
		rightClick(document.querySelector('.cm-content'));
		click(menuItem('Compare with Clipboard'));
		// The diff's first render waits one frame for the pane to be measurable, behind the
		// lazy chunk imports — poll it into view (a fixed beat starves under the full
		// suite's load, the 2026-10-15 failure class).
		await until(() => group.active!.merge !== undefined);
		expect(texts('.tab .label')).toEqual(['a.ts', 'a.ts ↔ Clipboard']);
		const diff = group.active!;
		expect(diff.merge!.a.state.doc.toString()).toBe('clip');
		expect(diff.merge!.b.state.doc.toString()).toBe('edited saved\n');
	});
});

describe('breadcrumb dropdowns', () => {
	it('a folder crumb lists its entries; a file pick opens, a folder pick drills deeper', async () => {
		files({ 'C:\\repo\\src\\main.ts': 'x\n', 'C:\\repo\\src\\util\\helper.ts': 'h\n' });
		backend.on('list_dir', ({ path }) => {
			if (String(path) === 'C:\\repo\\src') {
				return [
					{ name: 'main.ts', path: 'C:\\repo\\src\\main.ts', isDir: false, size: 2 },
					{ name: 'util', path: 'C:\\repo\\src\\util', isDir: true, size: 0 }
				];
			}
			if (String(path) === 'C:\\repo\\src\\util') {
				return [{ name: 'helper.ts', path: 'C:\\repo\\src\\util\\helper.ts', isDir: false, size: 1 }];
			}
			throw new Error(`unexpected ${String(path)}`);
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\src\\main.ts');
		const crumbs = document.querySelectorAll<HTMLElement>('.breadcrumbs .crumb');
		expect(crumbs.length).toBe(2);

		// The folder crumb lists folders first, then files.
		click(crumbs[0]!);
		await flush();
		expect(menuLabels()).toEqual(['util', 'main.ts']);
		// Picking the folder drills one level deeper at the same crumb.
		click(menuItem('util')!);
		await flush();
		expect(menuLabels()).toEqual(['helper.ts']);
		// Picking the file opens it in this group.
		click(menuItem('helper.ts')!);
		await flush();
		expect(texts('.tab .label')).toEqual(['main.ts', 'helper.ts']);
	});

	it('the file crumb lists the outline; a pick reveals the symbol\'s line', async () => {
		files({ 'C:\\repo\\src\\main.ts': 'one\n two\n  alpha();\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\src\\main.ts');
		const crumbs = document.querySelectorAll<HTMLElement>('.breadcrumbs .crumb');
		click(crumbs[crumbs.length - 1]!);
		await flush();
		expect(menuLabels()).toEqual(['alpha']);
		click(menuItem('alpha')!);
		await flush();
		const head = group.activeView!.state.selection.main.head;
		expect(group.activeView!.state.doc.lineAt(head).number).toBe(3);
	});

	it('a file without symbols says so; an empty folder says so', async () => {
		files({ 'C:\\repo\\src\\main.ts': 'x\n' });
		backend.on('viewer_open', () => ({ docId: 1, lineCount: 1, language: 'plaintext', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('list_dir', () => []);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\src\\main.ts');
		const crumbs = document.querySelectorAll<HTMLElement>('.breadcrumbs .crumb');
		click(crumbs[0]!);
		await flush();
		expect(menuLabels()).toEqual(['Empty Folder']);
		click(crumbs[crumbs.length - 1]!);
		await flush();
		expect(menuLabels()).toEqual(['No Symbols Found']);
	});
});
