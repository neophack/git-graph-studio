// The diff editor's VS Code parity surfaces (module 6/8): the per-pane side headers, the
// accessible diff viewer (F7) with its change rows and jump, the Open File action, and the
// Copy Deleted/Changed Lines context-menu rows — every piece of VS Code's diff editor the
// keyboard or a right-click reaches.

import { describe, expect, it } from 'vitest';

import { EditorGroup, type Editor, type EditorInput } from '../src/features/editor';
import { backend, clipboard } from './tauriMock';
import { click, flush, key, menuItem, menuLabels, rightClick, texts, until } from './helpers';

function files(contents: Record<string, string | null>): void {
	backend.on('read_file', ({ path }) => {
		const text = contents[String(path)];
		if (text === undefined) throw new Error(`${path}: not found`);
		return { contents: text, binary: text === null, size: text?.length ?? 0 };
	});
}

/** The first render waits one frame for a measurable pane — the tests wait it out. */
const RENDER = 20;

async function openWorkingDiff(group: EditorGroup, left: string, right: string): Promise<Editor> {
	backend.on('read_file_at', ({ revision }) => revision === 'HEAD'
		? { contents: left, binary: false, size: 20, encoding: 'utf8', eol: 'lf' }
		: { contents: right, binary: false, size: 20, encoding: 'utf8', eol: 'lf' });
	await group.openDiff({
		kind: 'diff', id: 'w1', title: 'a.ts (Working Tree)',
		left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
		right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
	});
	await new Promise((resolve) => setTimeout(resolve, RENDER));
	return (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'diff')!;
}

function viewer(): HTMLElement {
	return document.querySelector('.diff-viewer')!;
}

function viewerButton(): HTMLButtonElement {
	return [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.title.startsWith('Accessible Diff Viewer'))!;
}

describe('the diff editor\u2019s side headers', () => {
	it('each pane carries its own `path (revision)` label; the inline view keeps one', async () => {
		backend.on('read_file_at', ({ revision, path }) => ({ contents: `${revision}:${path}\n`, binary: false, size: 5 }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'd1', title: 'x.ts (Working Tree)',
			left: { revision: ':index', path: 'a/x.ts', label: 'Index', exists: true },
			right: { revision: '*', path: 'a/x.ts', label: 'Working Tree', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, RENDER));
		expect(texts('.diff-side-header')).toEqual(['a/x.ts (Index)', 'a/x.ts (Working Tree)']);
		// A local-file compare whose label equals the path shows the path alone (the
		// combined header never repeated "C:\a.txt (C:\a.txt)"; the side headers keep that).
		// The layout switch rebuilds both panes: the headers are re-injected, not lost.
		const layoutButton = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.title.startsWith('Switch between'))!;
		click(layoutButton);
		await new Promise((resolve) => setTimeout(resolve, RENDER));
		expect(document.querySelector('.diff-side-header')!.textContent).toBe('a/x.ts (Working Tree)');
	});
});

describe('the accessible diff viewer (F7)', () => {
	it('F7 opens it, one row per change with a +/\u2212 preview; Escape closes', async () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const editor = await openWorkingDiff(group, 'one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nfour\nfive\n');
		expect(document.querySelector('.diff-viewer')).toBeNull();
		key(editor.merge!.b.contentDOM, 'F7');
		// Two changes: the modified second line and the appended fifth line.
		expect(document.querySelectorAll('.diff-viewer-row')).toHaveLength(2);
		expect(texts('.diff-viewer-row-title')[0]).toContain('Difference 1 of 2');
		expect(texts('.diff-viewer-row-title')[0]).toContain('+1');
		expect(texts('.diff-viewer-row-title')[0]).toContain('\u22121');
		// The first row's preview shows the change's own lines, deleted first then added.
		expect(texts('.diff-viewer-line', document.querySelectorAll('.diff-viewer-row')[0]!)).toEqual(['\u2212two', '+TWO']);
		key(viewer(), 'Escape');
		expect(document.querySelector('.diff-viewer')).toBeNull();
		// Identical sides open the viewer into its empty state.
		const clean = await openWorkingDiff(group, 'same\n', 'same\n');
		key(clean.merge!.b.contentDOM, 'F7');
		expect(texts('.diff-viewer-empty')).toEqual(['There are no changes to review.']);
		key(viewer(), 'Escape');
		expect(document.querySelector('.diff-viewer')).toBeNull();
	});

	it('the toolbar button toggles it; arrows and F7 walk the rows; Enter jumps and closes', async () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const editor = await openWorkingDiff(group, 'one\ntwo\nkeep\n', 'ONE\ntwo\nkeep\nthree\n');
		click(viewerButton());
		expect(document.querySelectorAll('.diff-viewer-row')).toHaveLength(2);
		// The viewer opens on the change the cursor sits in (the first, from the document
		// start), the row highlighted; ArrowDown walks to the second change.
		expect(document.querySelectorAll('.diff-viewer-row.current')).toHaveLength(1);
		key(viewer(), 'ArrowDown');
		expect(document.querySelectorAll('.diff-viewer-row.current')[0]!.textContent).toContain('Difference 2 of 2');
		// Enter jumps the editors to that change and closes the viewer: the modified pane's
		// cursor now anchors at the insertion (the fourth line's start, after 13 chars).
		key(viewer(), 'Enter');
		expect(document.querySelector('.diff-viewer')).toBeNull();
		expect(editor.merge!.b.state.selection.main.anchor).toBe(13);
		// F7 in the pane opens again; F7 inside walks; F7 in the pane (the pane refocused on
		// close) walks the open viewer rather than stacking a second one.
		key(editor.merge!.b.contentDOM, 'F7');
		expect(document.querySelectorAll('.diff-viewer-row')).toHaveLength(2);
		key(viewer(), 'F7');
		expect(document.querySelectorAll('.diff-viewer-row.current')[0]!.textContent).toContain('Difference 2 of 2');
		// Escape closes; the toolbar button then toggles it back open and shut.
		key(viewer(), 'Escape');
		expect(document.querySelector('.diff-viewer')).toBeNull();
		click(viewerButton());
		expect(document.querySelector('.diff-viewer')).not.toBeNull();
		click(viewerButton());
		expect(document.querySelector('.diff-viewer')).toBeNull();
	});
});

describe('the diff toolbar\u2019s Open File action', () => {
	it('a working-tree diff opens its working file; a staged diff has no button', async () => {
		const store: Record<string, string> = { 'C:\\repo\\a.ts': 'ONE\ntwo\nkeep\nthree\n' };
		files(store);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		const editor = await openWorkingDiff(group, 'one\ntwo\nkeep\n', 'ONE\ntwo\nkeep\nthree\n');
		const openFile = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.title === 'Open File')!;
		click(openFile);
		await until(() => texts('.tab .label').includes('a.ts'));
		// The file tab joined the diff in this group (VS Code's Open File lands the file).
		expect(texts('.tab .label')).toContain('a.ts');
		expect(group.activeView?.state.doc.toString()).toBe('ONE\ntwo\nkeep\nthree\n');
		// The staged compare edits no file: VS Code disables the action, the button is absent.
		await group.openDiff({
			kind: 'diff', id: 's1', title: 'a.ts (Index)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: ':index', path: 'a.ts', label: 'Index', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, RENDER));
		const staged = (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'diff' && e.input.id === 's1')!;
		// Scoped to the staged pane: the working-tree diff's button still lives beside it.
		expect([...staged.pane.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].some((b) => b.title === 'Open File')).toBe(false);
	});
});

describe('Copy Deleted / Changed Lines', () => {
	it('the clicked pane\u2019s change lines copy whole; rows stay off outside a change', async () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const editor = await openWorkingDiff(group, 'one\ntwo\n', 'ONE\ntwo\nthree\n');
		// The deleted side: a cursor (or right-click) inside the change offers its lines.
		// The copy is VS Code's copy-line form: the change's lines each with their break.
		editor.merge!.a.dispatch({ selection: { anchor: 0 } });
		rightClick(editor.merge!.a.dom);
		expect(menuLabels()).toContain('Copy Deleted Lines');
		expect(menuLabels()).not.toContain('Copy Changed Lines');
		click(menuItem('Copy Deleted Lines'));
		await flush();
		expect(clipboard.writeText).toHaveBeenLastCalledWith('one\n');
		// The modified side's change copies its own lines — the changed chunk whole.
		editor.merge!.b.dispatch({ selection: { anchor: 0 } });
		rightClick(editor.merge!.b.dom);
		click(menuItem('Copy Changed Lines'));
		await flush();
		expect(clipboard.writeText).toHaveBeenLastCalledWith('ONE\n');
		// The insertion-only chunk (the third line) copies from the modified pane too — a
		// selection overlapping it reads the selection (a bare right-click would read the
		// clicked position, which jsdom can only spell as the document's start).
		editor.merge!.b.dispatch({ selection: { anchor: 8, head: 10 } });
		rightClick(editor.merge!.b.dom);
		click(menuItem('Copy Changed Lines'));
		await flush();
		expect(clipboard.writeText).toHaveBeenLastCalledWith('three\n');
		// Outside every change the rows disappear (an unchanged region has nothing to copy):
		// a selection over the unchanged second line, since jsdom's right-click can only
		// land at the document's start (inside the first change).
		editor.merge!.a.dispatch({ selection: { anchor: 4, head: 7 } });
		rightClick(editor.merge!.a.dom);
		expect(menuLabels()).not.toContain('Copy Deleted Lines');
	});

	it('an edit moves the chunk list the menu and viewer read', async () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const editor = await openWorkingDiff(group, 'one\ntwo\nthree\n', 'ONE\ntwo\nthree\n');
		expect(editor.diffChunks).toHaveLength(1);
		// Changing the third line to a second change updates the chunk list live — the
		// context menu and the viewer see two changes without a rebuild. (Adjacent changes
		// would merge into one chunk; the separated line grows the list.)
		editor.merge!.b.dispatch({ changes: { from: 8, to: 13, insert: 'THREE' } });
		expect(editor.diffChunks).toHaveLength(2);
		key(editor.merge!.b.contentDOM, 'F7');
		expect(document.querySelectorAll('.diff-viewer-row')).toHaveLength(2);
		key(viewer(), 'Escape');
		expect(document.querySelector('.diff-viewer')).toBeNull();
	});
});
