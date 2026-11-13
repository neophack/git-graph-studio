import { describe, expect, it, vi } from 'vitest';

import { EditorGroup, type Editor, type EditorInput } from '../src/features/editor';
import { workspaceFileCache } from '../src/features/editor/navigate';
import { fileIcon } from '../src/platform/fileIcons';
import { settings } from '../src/platform/settings';
import { el } from '../src/platform/ui';
import { backend } from './tauriMock';
import { click, flush, key, menuItem, menuLabels, notificationButton, notifications, rightClick, texts } from './helpers';

function files(contents: Record<string, string | null>): void {
	backend.on('read_file', ({ path }) => {
		const text = contents[String(path)];
		if (text === undefined) throw new Error(`${path}: not found`);
		return { contents: text, binary: text === null, size: text?.length ?? 0 };
	});
	backend.on('write_file', ({ path, contents: text }) => {
		contents[String(path)] = String(text);
		return null;
	});
}

describe('file icons', () => {
	it('picks VS Code-style codicons by extension', () => {
		expect(fileIcon('README.md')).toBe('markdown');
		expect(fileIcon('package.json')).toBe('json');
		expect(fileIcon('main.rs')).toBe('file-code');
		expect(fileIcon('logo.png')).toBe('file-media');
		expect(fileIcon('a.zip')).toBe('file-zip');
		expect(fileIcon('app.exe')).toBe('file-binary');
		expect(fileIcon('notes.txt')).toBe('file');
	});
});

describe('editor group', () => {
	it('opens files in tabs with breadcrumbs, tracks dirty state, saves and closes', async () => {
		files({ 'C:\\repo\\src\\main.ts': 'const a = 1;\n', 'C:\\repo\\README.md': '# Hi\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		const states: string[] = [];
		group.onActiveChange = (e) => states.push(e ? `${e.kind}:${e.path ?? ''}:${e.line}:${e.column}` : 'none');
		let saved: string[] = [];
		group.onFileSaved = (p) => saved.push(p);

		expect(document.querySelector('.welcome')!.hidden).toBe(false);
		await group.openFile('C:\\repo\\src\\main.ts');
		await group.openFile('C:\\repo\\README.md');
		expect(texts('.tab .label')).toEqual(['main.ts', 'README.md']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('README.md');
		expect(texts('.breadcrumbs .crumb')).toEqual(['README.md']);
		expect(document.querySelector('.welcome')!.hidden).toBe(true);

		// Re-opening activates the existing tab; the breadcrumbs show the repo-relative path.
		await group.openFile('C:\\repo\\src\\main.ts');
		expect(texts('.breadcrumbs .crumb')).toEqual(['src', 'main.ts']);
		expect(backend.callsTo('read_file')).toHaveLength(2);
		expect(states.at(-1)).toBe('file:C:\\repo\\src\\main.ts:1:1');

		// Typing marks the tab dirty; Save writes and clears it.
		const view = group.activeView!;
		view.dispatch({ changes: { from: 0, insert: '// x\n' } });
		expect(group.hasDirtyEditors()).toBe(true);
		expect(document.querySelector('.tab.active')!.classList.contains('dirty')).toBe(true);
		await group.save();
		expect(backend.callsTo('write_file')[0]).toMatchObject({ path: 'C:\\repo\\src\\main.ts', contents: '// x\nconst a = 1;\n' });
		expect(group.hasDirtyEditors()).toBe(false);
		expect(saved).toEqual(['C:\\repo\\src\\main.ts']);

		// Closing a dirty editor asks; "Don't Save" discards.
		view.dispatch({ changes: { from: 0, insert: 'more' } });
		const closing = group.close();
		await flush();
		expect(notifications()[0]).toContain('Do you want to save');
		click(notificationButton("Don't Save"));
		await closing;
		expect(texts('.tab .label')).toEqual(['README.md']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('README.md');

		// Middle-click closes; the welcome page returns.
		document.querySelector('.tab')!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
		await flush();
		expect(texts('.tab .label')).toEqual([]);
		expect(document.querySelector('.welcome')!.hidden).toBe(false);
		expect(states.at(-1)).toBe('none');
	});

	it('clears the dirty mark when an undo returns the text to the saved content', async () => {
		files({ 'C:\\repo\\a.txt': 'one\ntwo\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		const view = group.activeView!;
		// Typing dirties the tab…
		view.dispatch({ changes: { from: 0, insert: 'X' } });
		expect(group.hasDirtyEditors()).toBe(true);
		expect(document.querySelector('.tab.active')!.classList.contains('dirty')).toBe(true);
		// …and the Ctrl+Z that returns the text exactly to the saved content cleans it
		// again: there is nothing left to save, and the tab must not claim otherwise.
		group.runEditorCommand('undo');
		expect(group.hasDirtyEditors()).toBe(false);
		expect(document.querySelector('.tab.active')!.classList.contains('dirty')).toBe(false);
		// Redo walks past the saved text once more: dirty again.
		group.runEditorCommand('redo');
		expect(group.hasDirtyEditors()).toBe(true);
		// The plain delete that restores the saved text — no undo involved — cleans too.
		view.dispatch({ changes: { from: 0, to: 1, insert: '' } });
		expect(group.hasDirtyEditors()).toBe(false);
		// A save mid-way moves the baseline: an undo past it differs from what disk holds.
		view.dispatch({ changes: { from: 4, to: 7, insert: 'TWO' } });
		await group.save();
		expect(group.hasDirtyEditors()).toBe(false);
		group.runEditorCommand('undo');
		expect(group.hasDirtyEditors()).toBe(true);
		// Redo back to the saved text cleans, so the close below has nothing to ask about.
		group.runEditorCommand('redo');
		expect(group.hasDirtyEditors()).toBe(false);
		await group.closeAll();
	});

	it('opens binary files in the hex viewer and reports read errors', async () => {
		files({ 'C:\\repo\\a.bin': null });
		backend.on('read_file_chunk', () => ({ size: 4, base64: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64') }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\a.bin');
		// A binary file is the hex viewer's, with its rows paged from read_file_chunk.
		expect(document.querySelector('.hex-view')).not.toBeNull();
		expect(document.querySelector('.hex-status')!.textContent).toContain('4 bytes');
		await group.openFile('C:\\repo\\missing.txt');
		expect(notifications()[0]).toContain('not found');
		expect(texts('.tab .label')).toEqual(['a.bin']);
	});

	it('opens diffs and read-only revisions, and distinguishes same-named tabs', async () => {
		backend.on('read_file_at', ({ revision, path }) => ({ contents: `${revision}:${path}\n`, binary: false, size: 5 }));
		files({ 'C:\\repo\\a\\x.ts': 'a', 'C:\\repo\\b\\x.ts': 'b' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'd1', title: 'x.ts (Working Tree)',
			left: { revision: ':index', path: 'a/x.ts', label: 'Index', exists: true },
			right: { revision: '*', path: 'a/x.ts', label: 'Working Tree', exists: true }
		});
		// The first render waits one frame for the pane to be measurable (a perf choice -
		// building blind and flipping cost two editor constructions on narrow panes).
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(document.querySelectorAll('.cm-mergeView .cm-editor')).toHaveLength(2);
		// VS Code's side headers: one `path (revision)` label over each pane.
		expect(texts('.diff-side-header')).toEqual(['a/x.ts (Index)', 'a/x.ts (Working Tree)']);
		// The Xcode-style change navigation: statistics for a modified file, counters absent
		// for identical sides.
		// +1 added, −1 deleted, one change (the pieces are separate spans + a text node).
		expect(document.querySelector('.diff-stats')!.textContent).toMatch(/^\+1−1/);
		expect(document.querySelector('.diff-stats')!.textContent).toContain('1 change');
		expect(document.querySelector('.tab.active .codicon-diff')).not.toBeNull();
		// A missing side (an added file) reads as empty without a backend call.
		await group.openDiff({
			kind: 'diff', id: 'd2', title: 'new.ts (Added)',
			left: { revision: 'HEAD', path: 'new.ts', label: 'HEAD', exists: false },
			right: { revision: '*', path: 'new.ts', label: 'Working Tree', exists: true }
		});
		expect(backend.callsTo('read_file_at').map((c) => c['path'])).toEqual(['a/x.ts', 'a/x.ts', 'new.ts']);

		await group.openRevision('abc12345', 'src/lib.rs', 'abc12345: lib.rs');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('abc12345: lib.rs');
		expect(group.activeView!.state.readOnly).toBe(true);

		await group.openFile('C:\\repo\\a\\x.ts');
		await group.openFile('C:\\repo\\b\\x.ts');
		expect(texts('.tab .description')).toEqual(['a', 'b']);
	});

	it('a diff error that is not a missing side surfaces; a missing revision side reads empty', async () => {
		backend.on('read_file_at', ({ path }) => {
			if (String(path) === 'gone.ts') throw new Error('The file "gone.ts" does not exist in HEAD');
			throw new Error('fatal: repository not found');
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		// A repository-level failure is not an empty side: it surfaces as an error, no tab.
		await group.openDiff({
			kind: 'diff', id: 'd1', title: 'a.ts (HEAD)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: 'abc1234', path: 'a.ts', label: 'abc1234', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(notifications().some((n) => n.includes('repository not found'))).toBe(true);
		expect(texts('.tab .label')).toEqual([]);

		// A path absent at the revision (deleted between the two) still renders the empty side.
		await group.openDiff({
			kind: 'diff', id: 'd2', title: 'gone.ts (Deleted)',
			left: { revision: 'HEAD', path: 'gone.ts', label: 'HEAD', exists: true },
			right: { revision: 'abc1234', path: 'gone.ts', label: 'abc1234', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(texts('.tab .label')).toEqual(['gone.ts (Deleted)']);
	});

	it('the diff layout button toggles side-by-side and inline repeatedly', async () => {
		backend.on('read_file_at', ({ revision, path }) => ({ contents: `${String(revision)}:${String(path)}\nline\n`, binary: false, size: 5 }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'd1', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20)); // the first render waits a frame
		const pane = document.querySelector('.editor-pane')!;
		const layoutButton = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.title.startsWith('Switch between'))!;
		// Wide (unmeasurable) panes start side-by-side; the button pins the other layout.
		expect(document.querySelectorAll('.cm-mergeView .cm-editor')).toHaveLength(2);
		click(layoutButton);
		expect(pane.classList.contains('diff-inline')).toBe(true);
		// Toggling an ignore option rebuilds the diff: the pinned layout must survive it.
		click([...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.textContent === 'Wh'));
		expect(pane.classList.contains('diff-inline')).toBe(true);
		// And the button toggles back to side-by-side instead of being stuck on inline.
		click(layoutButton);
		expect(pane.classList.contains('diff-inline')).toBe(false);
		expect(document.querySelectorAll('.cm-mergeView .cm-editor')).toHaveLength(2);
	});

	it('the diff shows unchanged lines whole by default; the toolbar button folds them in both layouts', async () => {
		// One change over line 1 with a long unchanged stretch behind it: folded
		// (margin 3, minSize 4), the tail compresses into a "… N lines" bar; unfolded,
		// every line shows and no bar renders anywhere.
		const filler = Array.from({ length: 12 }, (_, i) => `pad ${i + 1}`).join('\n');
		backend.on('read_file_at', ({ revision }) => ({ contents: `${revision === 'HEAD' ? 'old' : 'new'}\n${filler}\n`, binary: false, size: 60 }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'd1', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20)); // the first render waits a frame
		// Default unfolded: no collapse bars in either pane.
		expect(document.querySelectorAll('.cm-collapsedLines')).toHaveLength(0);
		const collapseButton = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')]
			.find((b) => b.title === 'Collapse Unchanged Regions')!;
		click(collapseButton);
		expect(collapseButton.classList.contains('active')).toBe(true);
		// Both sides of the split view fold their shared unchanged stretch.
		expect(document.querySelectorAll('.cm-collapsedLines').length).toBeGreaterThan(0);
		// The choice rides the rebuild a layout switch makes: the inline view folds too…
		const layoutButton = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')]
			.find((b) => b.title.startsWith('Switch between'))!;
		click(layoutButton);
		expect(document.querySelector('.editor-pane')!.classList.contains('diff-inline')).toBe(true);
		expect(document.querySelectorAll('.cm-collapsedLines').length).toBeGreaterThan(0);
		// …and toggling the fold off there shows every line again.
		click(collapseButton);
		expect(document.querySelectorAll('.cm-collapsedLines')).toHaveLength(0);
	});

	it('a working-tree diff is editable and saves back; a staged diff stays read-only', async () => {
		const store: Record<string, string> = { 'C:\\repo\\a.ts': 'worktree text\n' };
		// The working-tree side (`*`) reads through read_file_at as the backend does — the
		// repo-relative path joined under the repository root; the staged side (:index) is
		// its own text, so the two diffs stay distinguishable.
		backend.on('read_file_at', ({ revision, path }) => revision === '*'
			? { contents: store[`C:\\repo\\${String(path)}`] ?? '', binary: false, size: 20, encoding: 'utf8', eol: 'lf' }
			: { contents: `${revision}:${String(path)}\n`, binary: false, size: 20, encoding: 'utf8', eol: 'lf' });
		files(store);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		let saved: string[] = [];
		group.onFileSaved = (p) => saved.push(p);
		// The working tree (revision *): the modified pane is the editor, the base pane is not.
		await group.openDiff({
			kind: 'diff', id: 'w1', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const worktree = (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'diff')!;
		expect(worktree.merge!.a.state.readOnly).toBe(true);
		expect(worktree.merge!.b.state.readOnly).toBe(false);
		expect(worktree.diffSavePath).toBe('C:\\repo\\a.ts');

		// Typing in the modified pane dirties the tab; Ctrl+S's save writes the working file.
		worktree.merge!.b.dispatch({ changes: { from: 0, insert: 'edited ' } });
		expect(group.hasDirtyEditors()).toBe(true);
		expect(document.querySelector('.tab.active')!.classList.contains('dirty')).toBe(true);
		await group.save();
		expect(store['C:\\repo\\a.ts']).toBe('edited worktree text\n');
		expect(group.hasDirtyEditors()).toBe(false);
		expect(saved).toEqual(['C:\\repo\\a.ts']);

		// A staged diff (the index side) has no working file behind it: both panes read-only.
		await group.openDiff({
			kind: 'diff', id: 's1', title: 'a.ts (Index)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: ':index', path: 'a.ts', label: 'Index', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const staged = (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'diff' && e.input.id === 's1')!;
		expect(staged.merge!.b.state.readOnly).toBe(true);
		expect(staged.merge!.b.state.doc.eq(worktree.merge!.b.state.doc)).toBe(false);
		expect(group.hasDirtyEditors()).toBe(false);

		// A working file that moved under a dirty diff pane is never overwritten silently.
		worktree.merge!.b.dispatch({ changes: { from: 0, insert: 'more ' } });
		store['C:\\repo\\a.ts'] = 'changed elsewhere\n';
		await group.save(worktree);
		expect(store['C:\\repo\\a.ts']).toBe('changed elsewhere\n');
		expect(group.hasDirtyEditors()).toBe(true);
		expect(notifications().some((n) => n.includes('changed on disk'))).toBe(true);
	});

	it('the diff layout rebuild carries an unsaved buffer and refuses the ignore toggles while dirty', async () => {
		const store: Record<string, string> = { 'C:\\repo\\a.ts': 'worktree line\n' };
		backend.on('read_file_at', ({ revision, path }) => revision === '*'
			? { contents: store[`C:\\repo\\${String(path)}`] ?? '', binary: false, size: 15, encoding: 'utf8', eol: 'lf' }
			: { contents: 'base line\n', binary: false, size: 10, encoding: 'utf8', eol: 'lf' });
		files(store);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'w1', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const editor = (group as unknown as { open: Editor[] }).open[0]!;
		editor.merge!.b.dispatch({ changes: { from: 0, insert: 'keep ' } });
		expect(group.hasDirtyEditors()).toBe(true);
		// The ignore toggles wait for the save while a buffer is unsaved.
		const wh = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.textContent === 'Wh')!;
		click(wh);
		expect(wh.classList.contains('active')).toBe(false);
		expect(editor.merge!.b.state.readOnly).toBe(false);
		// The layout switch rebuilds the panes and carries the unsaved buffer over.
		const layoutButton = [...document.querySelectorAll<HTMLButtonElement>('.diff-toolbar button')].find((b) => b.title.startsWith('Switch between'))!;
		click(layoutButton);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(editor.merge).toBeUndefined();
		expect(editor.view).toBeDefined();
		expect(editor.view!.state.doc.toString()).toBe('keep worktree line\n');
		expect(group.hasDirtyEditors()).toBe(true);
		// The clean tab may ignore whitespace again (the pane goes read-only for the review).
		await group.save();
		click(wh);
		expect(wh.classList.contains('active')).toBe(true);
		expect(editor.view!.state.readOnly).toBe(true);
	});

	it('a clean diff re-reads its sides when the working file changes; a dirty buffer keeps the pane', async () => {
		// The Source Control diff's comparison is a snapshot only until the disk moves: the
		// watcher batch naming the file re-reads both sides of a clean tab (VS Code's diff
		// editor follows its file). The save path keeps the repo side's forward slashes
		// (`src/a.ts`) while the batch spells them the root's way (`src\\a.ts`) — one file,
		// both spellings must match.
		const store: Record<string, string> = { 'C:\\repo\\src/a.ts': 'first\n' };
		backend.on('read_file_at', ({ revision, path }) => revision === '*'
			? { contents: store[`C:\\repo\\${String(path)}`] ?? '', binary: false, size: 20, encoding: 'utf8', eol: 'lf' }
			: { contents: `${revision}:${String(path)}\n`, binary: false, size: 20, encoding: 'utf8', eol: 'lf' });
		files(store);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openDiff({
			kind: 'diff', id: 'w1', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'src/a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'src/a.ts', label: 'Working Tree', exists: true }
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const diff = (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'diff')!;
		expect(diff.merge!.b.state.doc.toString()).toBe('first\n');
		// This save's own echo re-reads both sides but changes nothing: no rebuild, the
		// pane's document keeps its identity (the cursor never jumps).
		const doc = diff.merge!.b.state.doc;
		await group.reloadIfClean('C:\\repo\\src\\a.ts');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(diff.merge!.b.state.doc).toBe(doc);
		// The disk moved under the clean tab: the modified pane shows the new text, the
		// base pane re-reads its revision, the tab stays clean.
		store['C:\\repo\\src/a.ts'] = 'changed on disk\n';
		await group.reloadIfClean('C:\\repo\\src\\a.ts');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(diff.merge!.b.state.doc.toString()).toBe('changed on disk\n');
		expect(diff.dirty).toBe(false);
		// A dirty buffer owns the pane: the batch leaves it alone, exactly like a dirty
		// file tab (which takes the conflict bar instead).
		diff.merge!.b.dispatch({ changes: { from: 0, insert: 'mine ' } });
		store['C:\\repo\\src/a.ts'] = 'changed again\n';
		await group.reloadIfClean('C:\\repo\\src\\a.ts');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(diff.merge!.b.state.doc.toString()).toBe('mine changed on disk\n');
		expect(diff.dirty).toBe(true);
	});

	it('clicking an already-open diff again re-reads a clean tab and keeps a dirty buffer', async () => {
		// The Source Control row's second click used to re-activate the tab with the
		// comparison it opened with: the file's new state stayed invisible until the tab
		// (or the app) was closed and reopened.
		const store: Record<string, string> = { 'C:\\repo\\a.ts': 'first\n' };
		backend.on('read_file_at', ({ revision, path }) => revision === '*'
			? { contents: store[`C:\\repo\\${String(path)}`] ?? '', binary: false, size: 20, encoding: 'utf8', eol: 'lf' }
			: { contents: `${revision}:${String(path)}\n`, binary: false, size: 20, encoding: 'utf8', eol: 'lf' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		const input: Extract<EditorInput, { kind: 'diff' }> = {
			kind: 'diff', id: 'scm:worktree:a.ts', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
		};
		await group.openDiff(input);
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The file changed since the tab opened; the click re-reads the sides in place.
		store['C:\\repo\\a.ts'] = 'second\n';
		await group.openDiff(input);
		expect(texts('.tab .label')).toEqual(['a.ts (Working Tree)']);
		const diff = (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'diff')!;
		expect(diff.merge!.b.state.doc.toString()).toBe('second\n');
		// An unsaved buffer survives the second click with the tab: the edits are not the
		// disk's, and the activation alone is what the user asked for.
		diff.merge!.b.dispatch({ changes: { from: 0, insert: 'mine ' } });
		store['C:\\repo\\a.ts'] = 'third\n';
		await group.openDiff(input);
		expect(diff.merge!.b.state.doc.toString()).toBe('mine second\n');
		expect(diff.dirty).toBe(true);
		expect(texts('.tab .label')).toEqual(['a.ts (Working Tree)']);
	});

	it('back/forward navigation lands on an open revision tab', async () => {
		backend.on('read_file_at', () => ({ contents: 'rev contents\n', binary: false, size: 2 }));
		files({ 'C:\\repo\\a.txt': 'a\n', 'C:\\repo\\b.txt': 'b\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openRevision('abc1234', 'src/lib.rs', 'abc1234: lib.rs');
		// Re-opening the same revision activates the existing tab instead of duplicating it.
		await group.openRevision('abc1234', 'src/lib.rs', 'abc1234: lib.rs');
		expect(texts('.tab .label')).toEqual(['a.txt', 'abc1234: lib.rs']);
		await group.openFile('C:\\repo\\b.txt');

		group.goBack();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('abc1234: lib.rs');
		group.goBack();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		group.goForward();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('abc1234: lib.rs');
	});

	it('clamps the markdown preview scroll sync to the source\'s current line count', async () => {
		// A markdown-it stand-in whose blocks carry their source line, as the bundled one's
		// renderer rules do after markdown.ts wraps them.
		const instance = {
			render: (text: string) => text.split('\n').map((line, index) => {
				const token = { map: [index, index + 1] as [number, number], attrs: [] as [string, string][], attrSet: (name: string, value: string) => { token.attrs.push([name, value]); } };
				return (instance.renderer.rules.paragraph_open as unknown as (tokens: unknown[], idx: number) => string)([token], 0) + line + '</p>';
			}).join(''),
			renderer: { rules: { paragraph_open: (tokens: { attrs?: [string, string][] }[], idx: number) => '<p' + (tokens[idx]!.attrs ?? []).map(([name, value]) => ` ${name}="${value}"`).join('') + '>' } }
		};
		(window as unknown as { markdownit: unknown }).markdownit = instance;
		const text = 'zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n';
		backend.on('read_file', () => ({ contents: text, binary: false, size: text.length, encoding: 'utf8', eol: 'lf' }));
		backend.on('backup_write', () => null);
		backend.on('backup_clear', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\doc.md');
		await group.openMarkdownPreview('C:\\repo\\doc.md');
		await flush();
		expect(document.querySelectorAll('.markdown-preview-body [data-line]')).toHaveLength(11);

		// Deleting most of the source leaves the preview's rendered line map stale for the
		// re-render debounce window; a preview scroll then must not overshoot the doc.
		const source = (group as unknown as { open: Editor[] }).open.find((e) => e.input.kind === 'file')!;
		source.view!.dispatch({ changes: { from: source.view!.state.doc.line(2).from, to: source.view!.state.doc.length } });
		const doc = source.view!.state.doc;
		expect(doc.lines).toBe(2);
		const lineSpy = vi.spyOn(doc, 'line');
		document.querySelector('.editor-pane.markdown-preview')!.dispatchEvent(new Event('scroll'));
		// The last rendered block still says line 10 (0-based): the lookup lands on the
		// clamped last line instead of throwing past the end of the 2-line document.
		expect(lineSpy).toHaveBeenCalledWith(2);
		// Let the edit's backup and preview re-render timers run out inside this test.
		await new Promise((resolve) => setTimeout(resolve, 700));
	});

	it('retargets hex and markdown tabs (and the hex view\'s save path) on rename', async () => {
		backend.on('read_file_chunk', () => ({ size: 4, base64: Buffer.from([1, 2, 3, 4]).toString('base64') }));
		backend.on('read_file', ({ path }) => ({ contents: String(path).endsWith('.md') ? '# T\n' : null, binary: !String(path).endsWith('.md'), size: 4 }));
		backend.on('patch_file', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openHex('C:\\repo\\a.bin');
		await group.openMarkdownPreview('C:\\repo\\doc.md');
		expect(group.openEditorIds()).toEqual(['hex:C:\\repo\\a.bin', 'markdown:C:\\repo\\doc.md']);

		group.pathRenamed('C:\\repo\\a.bin', 'C:\\repo\\b.bin');
		group.pathRenamed('C:\\repo\\doc.md', 'C:\\repo\\renamed.md');
		expect(group.openEditorIds()).toEqual(['hex:C:\\repo\\b.bin', 'markdown:C:\\repo\\renamed.md']);
		expect(texts('.tab .label')).toEqual(['Hex b.bin', 'Preview renamed.md']);

		// The hex view writes its byte patches to the new path, not the old one.
		const hexEditor = (group as unknown as { open: Editor[] }).open[0]!;
		click(hexEditor.pane.querySelector('.hex-edit-toggle'));
		key(hexEditor.pane.querySelector('.hex-view')!, '1');
		key(hexEditor.pane.querySelector('.hex-view')!, '2');
		await group.save(hexEditor);
		expect(backend.callsTo('patch_file')[0]).toMatchObject({ path: 'C:\\repo\\b.bin', edits: [{ offset: 0, byte: 0x12 }] });

		// The renamed preview re-reads the renamed file.
		const preview = (group as unknown as { open: Editor[] }).open[1]!;
		await preview.render!();
		expect(backend.callsTo('read_file').at(-1)).toMatchObject({ path: 'C:\\repo\\renamed.md' });
	});

	it('a pending backup follows a renamed dirty file to its new path', async () => {
		const contents: Record<string, string> = { 'C:\\repo\\a.txt': 'hello\n' };
		backend.on('read_file', ({ path }) => {
			const text = contents[String(path)];
			if (text === undefined) throw new Error(`${String(path)}: not found`);
			return { contents: text, binary: false, size: text.length };
		});
		backend.on('write_file', ({ path, contents: text }) => { contents[String(path)] = String(text); return null; });
		backend.on('backup_write', () => null);
		backend.on('backup_clear', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		group.activeView!.dispatch({ changes: { from: 0, insert: 'x' } });
		group.pathRenamed('C:\\repo\\a.txt', 'C:\\repo\\b.txt');
		await new Promise((resolve) => setTimeout(resolve, 650));
		// The already-scheduled backup writes the new path, not the one captured on edit.
		expect(backend.callsTo('backup_write')).toEqual([{ path: 'C:\\repo\\b.txt', contents: 'xhello\n' }]);
		await group.save();
		expect(backend.callsTo('backup_clear')).toEqual([{ path: 'C:\\repo\\b.txt' }]);
	});

	it('two parallel opens of the same file produce one tab', async () => {
		files({ 'C:\\repo\\a.txt': 'a\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		// Both calls pass the synchronous "already open" check before either finishes
		// reading; the second one must not add a duplicate tab.
		await Promise.all([group.openFile('C:\\repo\\a.txt'), group.openFile('C:\\repo\\a.txt')]);
		expect(group.openEditorIds()).toEqual(['file:C:\\repo\\a.txt']);
		expect(texts('.tab .label')).toEqual(['a.txt']);
	});

	it('a slow open landing after a newer click adds its tab but does not steal the view', async () => {
		files({ 'C:\\repo\\slow.txt': 'slow\n', 'C:\\repo\\quick.txt': 'quick\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		// The first file's probe hangs until released — its open is still in flight when
		// the user clicks the second file.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		backend.on('file_probe', ({ path }) => {
			if (String(path).endsWith('slow.txt')) return gate.then(() => ({ binary: false, size: 5 }));
			return { binary: false, size: 6 };
		});
		const slow = group.openFile('C:\\repo\\slow.txt');
		await flush(2);
		await group.openFile('C:\\repo\\quick.txt');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('quick.txt');
		release();
		await slow;
		await flush(2);
		// The latecomer's tab joined the bar, but the user's last pick kept the view.
		expect(texts('.tab .label')).toEqual(['quick.txt', 'slow.txt']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('quick.txt');
	});

	it('parallel opens of the same hex / preview / diff / revision target produce one tab each', async () => {
		backend.on('read_file', () => ({ contents: '# T\n', binary: false, size: 4, encoding: 'utf8', eol: 'lf' }));
		backend.on('read_file_chunk', () => ({ size: 4, base64: Buffer.from([1, 2, 3, 4]).toString('base64') }));
		backend.on('read_file_at', () => ({ contents: 'x\n', binary: false, size: 2 }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		const diff = {
			kind: 'diff' as const, id: 'd1', title: 'a.ts (Working Tree)',
			left: { revision: 'HEAD', path: 'a.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'a.ts', label: 'Working Tree', exists: true }
		};
		await Promise.all([
			group.openHex('C:\\repo\\a.bin'), group.openHex('C:\\repo\\a.bin'),
			group.openMarkdownPreview('C:\\repo\\doc.md'), group.openMarkdownPreview('C:\\repo\\doc.md'),
			group.openDiff(diff), group.openDiff(diff),
			group.openRevision('abc1234', 'src/lib.rs', 'abc1234: lib.rs'), group.openRevision('abc1234', 'src/lib.rs', 'abc1234: lib.rs')
		]);
		await new Promise((resolve) => setTimeout(resolve, 20)); // the diff's first render frame
		expect(group.openEditorIds().sort()).toEqual([
			'diff:d1', 'diff:rev:abc1234:src/lib.rs', 'hex:C:\\repo\\a.bin', 'markdown:C:\\repo\\doc.md'
		]);
		// The dropped duplicate diff never builds views into its detached pane.
		expect(document.querySelectorAll('.cm-mergeView')).toHaveLength(1);
	});

	it('retargets tabs on rename/delete and cycles them', async () => {
		files({ 'C:\\repo\\old.txt': 'x', 'C:\\repo\\dir\\y.txt': 'y', 'C:\\repo\\z.txt': 'z' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\old.txt');
		await group.openFile('C:\\repo\\dir\\y.txt');
		await group.openFile('C:\\repo\\z.txt');
		expect(texts('.tab .label')).toEqual(['old.txt', 'y.txt', 'z.txt']);

		group.pathRenamed('C:\\repo\\old.txt', 'C:\\repo\\new.txt');
		expect(texts('.tab .label')).toEqual(['new.txt', 'y.txt', 'z.txt']);
		await group.pathDeleted('C:\\repo\\dir');
		expect(texts('.tab .label')).toEqual(['new.txt', 'z.txt']);
		group.activateNext(1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('new.txt');
		expect(await group.closeAll()).toBe(true);
		expect(texts('.tab .label')).toEqual([]);
	});

	it('reloads a clean editor when its file changed on disk', async () => {
		const contents: Record<string, string | null> = { '/r/a.txt': 'one' };
		files(contents);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('/r/a.txt');
		contents['/r/a.txt'] = 'two';
		await group.reloadIfClean('/r/a.txt');
		expect(group.activeView!.state.doc.toString()).toBe('two');
		group.activeView!.dispatch({ changes: { from: 0, insert: 'edit ' } });
		contents['/r/a.txt'] = 'three';
		await group.reloadIfClean('/r/a.txt');
		expect(group.activeView!.state.doc.toString()).toBe('edit two');
	});

	it('an external reload keeps the cursor where the reader was, clamped to the new text', async () => {
		const contents: Record<string, string | null> = { '/r/a.txt': 'one\ntwo\nthree\nfour\nfive\n' };
		files(contents);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('/r/a.txt');
		const view = group.activeView!;
		// Reading in the middle: the cursor rests one column into line 3.
		view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } });
		// Lines shift around the reader (one inserted above, more appended below).
		contents['/r/a.txt'] = 'zero\none\ntwo\nthree\nfour\nfive\nsix\n';
		await group.reloadIfClean('/r/a.txt');
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		expect(line.number).toBe(3); // the cursor's line and column survive the replace
		expect(head - line.from).toBe(1);
		// A reload that shrinks the file past the cursor clamps it to the document's end.
		contents['/r/a.txt'] = 'x\n';
		await group.reloadIfClean('/r/a.txt');
		expect(view.state.selection.main.head).toBe(view.state.doc.length);
	});

	it('a CRLF file that did not change is not rebuilt by a refresh (the refocus path)', async () => {
		const contents: Record<string, string | null> = { '/r/crlf.txt': 'one\r\ntwo\r\nthree\r\n' };
		files(contents);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('/r/crlf.txt');
		const view = group.activeView!;
		view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		const state = view.state;
		// The disk bytes are unchanged (still CRLF): a window refocus's refresh must not
		// rebuild the document - CodeMirror's text normalises line endings, so the raw
		// comparison alone would see a change on every read of every CRLF file.
		await group.reloadIfClean('/r/crlf.txt');
		expect(view.state).toBe(state);
	});

	it('a real change to a CRLF file reloads with normalised endings and the reader in place', async () => {
		const contents: Record<string, string | null> = { '/r/crlf.txt': 'one\r\ntwo\r\nthree\r\n' };
		files(contents);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('/r/crlf.txt');
		const view = group.activeView!;
		view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 1 } });
		contents['/r/crlf.txt'] = 'zero\r\none\r\ntwo\r\nthree\r\n';
		await group.reloadIfClean('/r/crlf.txt');
		expect(view.state.doc.toString()).toBe('zero\none\ntwo\nthree\n');
		const head = view.state.selection.main.head;
		expect(view.state.doc.lineAt(head).number).toBe(2);
		expect(head - view.state.doc.lineAt(head).from).toBe(1);
	});

	it('offers the VS Code tab context menu', async () => {
		files({ 'C:\\repo\\a.txt': 'a', 'C:\\repo\\b.txt': 'b' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');

		const firstTab = document.querySelector('.tab')!; // a.txt
		rightClick(firstTab);
		expect(menuLabels()).toEqual(['Close', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All', 'Save As...', 'Save All', 'Copy Path', 'Copy Relative Path', 'Reveal in File Explorer', 'Pin', 'Move into New Window', 'Copy into New Window', 'Lock Editor Group']);
		click(menuItem('Copy Relative Path'));
		expect(backend.clipboard).toEqual(['a.txt']);

		// Reveal opens the PC's own file manager at the file (desktop only).
		rightClick(firstTab);
		click(menuItem('Reveal in File Explorer'));
		expect(backend.revealed).toEqual(['C:\\repo\\a.txt']);

		// VS Code shows Save on a dirty tab's menu only, between Close All and Save As.
		const view = group.activeView!;
		view.dispatch({ changes: { from: 0, insert: 'x' } });
		rightClick(document.querySelector('.tab.active')!);
		expect(menuLabels()).toEqual(['Close', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All', 'Save', 'Save As...', 'Save All', 'Copy Path', 'Copy Relative Path', 'Reveal in File Explorer', 'Pin', 'Move into New Window', 'Copy into New Window', 'Lock Editor Group']);
		click(menuItem('Save'));
		await flush();
		expect(document.querySelector('.tab.active')!.classList.contains('dirty')).toBe(false);
		expect(backend.callsTo('write_file').at(-1)).toMatchObject({ path: 'C:\\repo\\b.txt', contents: 'xb' });

		// The remote shell is a browser page: no desktop file manager and no sibling
		// instance, so Reveal and the new-window pair hide while the rest stands (the
		// Explorer's row-menu gate).
		document.documentElement.setAttribute('data-remote-shell', '');
		try {
			rightClick(document.querySelector('.tab.active')!);
			const remote = menuLabels();
			expect(remote).not.toContain('Reveal in File Explorer');
			expect(remote).not.toContain('Move into New Window');
			expect(remote).not.toContain('Copy into New Window');
			expect(remote).toContain('Copy Path');
			expect(remote).toContain('Copy Relative Path');
		} finally {
			document.documentElement.removeAttribute('data-remote-shell');
		}

		rightClick(firstTab);
		click(menuItem('Close Others'));
		await flush();
		expect(texts('.tab .label')).toEqual(['a.txt']);
		rightClick(firstTab);
		click(menuItem('Close Saved'));
		await flush();
		expect(texts('.tab .label')).toEqual([]);
	});

	it('Save As writes the buffer to the chosen path and the tab becomes the new file', async () => {
		files({ 'C:\\repo\\a.txt': 'a' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		const view = group.activeView!;
		view.dispatch({ changes: { from: 0, insert: 'x' } });

		// A cancelled dialog leaves the tab alone.
		backend.dialog.saveResult = null;
		rightClick(document.querySelector('.tab.active')!);
		click(menuItem('Save As...'));
		await flush();
		expect(texts('.tab .label')).toEqual(['a.txt']);

		backend.dialog.saveResult = 'C:\\repo\\renamed.txt';
		rightClick(document.querySelector('.tab.active')!);
		click(menuItem('Save As...'));
		await flush();
		expect(backend.callsTo('write_file').at(-1)).toMatchObject({ path: 'C:\\repo\\renamed.txt', contents: 'xa' });
		// The tab became the new file, clean: input, label and the saved baseline moved.
		expect(texts('.tab .label')).toEqual(['renamed.txt']);
		expect(document.querySelector('.tab')!.classList.contains('dirty')).toBe(false);
		expect(group.activeInput).toMatchObject({ kind: 'file', path: 'C:\\repo\\renamed.txt' });
		// The history stops that held the old input now land on the new path.
		expect(group.navHistory.at(-1)?.input).toMatchObject({ kind: 'file', path: 'C:\\repo\\renamed.txt' });
	});

	it('a save that changes the file re-runs the outline against the saved content', async () => {
		// The outline reads its symbols from a throwaway viewer open; before the save
		// refresh, a save that added a function left the pane showing the open-time symbol
		// set until the tab was reopened (VS Code's outline follows the save).
		let symbols = [{ kind: 'function', name: 'before', line: 0 }];
		backend.on('viewer_open', () => ({ docId: 77, lineCount: 1, language: 'ts', syntaxName: 'TypeScript', symbols }));
		backend.on('viewer_close', () => null);
		settings.showOutline = true;
		files({ 'C:\\repo\\src\\main.ts': 'const a = 1;\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		try {
			await group.openFile('C:\\repo\\src\\main.ts');
			await flush();
			expect(texts('.editor-outline-item')).toEqual(['before']);
			// The save adds a function: the outline re-runs against the saved file.
			group.activeView!.dispatch({ changes: { from: 0, insert: 'function after() {}\n' } });
			symbols = [{ kind: 'function', name: 'before', line: 0 }, { kind: 'function', name: 'after', line: 1 }];
			await group.save();
			await flush();
			expect(texts('.editor-outline-item')).toEqual(['before', 'after']);
			// The outline's throwaway document was released again after the refresh.
			expect(backend.callsTo('viewer_close')).toHaveLength(2);
		} finally {
			settings.showOutline = false;
			await group.closeAll();
		}
	});

	it('a pinned tab renders the pin marker, sorts ahead, and every bulk close skips it', async () => {
		files({ 'C:\\repo\\a.txt': 'a', 'C:\\repo\\b.txt': 'b', 'C:\\repo\\c.txt': 'c' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');
		await group.openFile('C:\\repo\\c.txt');

		// Double-clicking a tab pins it (VS Code's doubleClickTabToPin): the pinned tab
		// sorts ahead of the unpinned ones and carries the pin marker, not the close button.
		const bTab = Array.from(document.querySelectorAll('.tab')).find((tab) => tab.querySelector('.label')?.textContent === 'b.txt')!;
		bTab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(texts('.tab .label')).toEqual(['b.txt', 'a.txt', 'c.txt']);
		expect(document.querySelector('.tab.pinned .pin')).not.toBeNull();
		expect(document.querySelector('.tab.pinned .close')).toBeNull();

		// The pinned tab's menu offers Unpin now.
		rightClick(document.querySelector('.tab.pinned')!);
		expect(menuLabels()).toContain('Unpin');

		// No bulk close touches the pinned tab; only its own Close does. The dirty mark
		// reads from the label, so a dirty pinned tab stays on the bar too.
		const pinned = group.open.find((editor) => editor.label === 'b.txt')!;
		pinned.dirty = true;
		group.update();
		rightClick(document.querySelector('.tab.pinned')!);
		click(menuItem('Close All'));
		await flush();
		expect(texts('.tab .label')).toEqual(['b.txt']);

		// Middle-click on a pinned tab is sticky, like VS Code's.
		document.querySelector('.tab.pinned')!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
		await flush();
		expect(texts('.tab .label')).toEqual(['b.txt']);

		// The pin marker's click unhooks it; the close button comes back. The buffer was
		// dirtied above and no bulk close may touch it — its unsaved changes survive the
		// Close All, so the explicit close still asks before dropping them.
		const editor = group.open[0]!;
		expect(editor.dirty).toBe(true);
		click(document.querySelector('.tab.pinned .pin'));
		await flush();
		expect(document.querySelector('.tab.pinned')).toBeNull();
		expect(document.querySelector('.tab .close')).not.toBeNull();
		editor.dirty = false;
		group.update();
		click(document.querySelector('.tab .close')!);
		await flush();
		expect(texts('.tab .label')).toEqual([]);
	});

	it('closing the active tab returns to the most recently used editor, like VS Code', async () => {
		files({ 'C:\\repo\\a.txt': 'a', 'C:\\repo\\b.txt': 'b', 'C:\\repo\\c.txt': 'c' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');
		await group.openFile('C:\\repo\\c.txt');
		// Order of use: a, b, c, then back to a. Closing a must land on c (last used), not b
		// (its neighbour).
		await group.openFile('C:\\repo\\a.txt');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		await group.close();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('c.txt');
		// "Close to the Right" from b closes c only; the last tab has nothing to its right.
		rightClick(document.querySelector('.tab')!); // b.txt
		click(menuItem('Close to the Right'));
		await flush();
		expect(texts('.tab .label')).toEqual(['b.txt']);
		rightClick(document.querySelector('.tab')!);
		expect(menuItem('Close to the Right')!.classList.contains('disabled')).toBe(true);
	});

	it('navigates back and forward through editors, restoring the cursor position', async () => {
		files({ 'C:\\repo\\a.txt': 'one\ntwo\nthree\n', 'C:\\repo\\b.txt': 'b\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		expect(group.canGoBack()).toBe(false);
		await group.openFile('C:\\repo\\a.txt');
		expect(group.canGoBack()).toBe(false);
		// The cursor moves within a.txt (line 2) before the jump to b.txt.
		group.activeView!.dispatch({ selection: { anchor: group.activeView!.state.doc.line(2).from } });
		await group.openFile('C:\\repo\\b.txt');
		expect(group.canGoBack()).toBe(true);
		expect(group.canGoForward()).toBe(false);

		group.goBack();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		expect(group.activeView!.state.doc.lineAt(group.activeView!.state.selection.main.head).number).toBe(2);
		expect(group.canGoForward()).toBe(true);

		group.goForward();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
		// Going back again, and a jump made from history does not extend it.
		group.goBack();
		await flush();
		group.goForward();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
		expect(group.canGoForward()).toBe(false);

		// Back reopens a tab that was closed in the meantime (closing b made a active again,
		// which extends the history; going back then returns to the closed b stop).
		await group.close();
		group.goBack();
		await flush();
		expect(texts('.tab .label')).toEqual(['a.txt', 'b.txt']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
	});

	it('offers the editor context menu, with Go to Definition searching the workspace', async () => {
		files({
			'C:\\repo\\main.ts': 'helper();\nconst other = helper;\nzzz\n',
			'C:\\repo\\util.ts': 'export function helper() {\n\treturn 2;\n}\n'
		});
		backend.on('list_files', () => ['main.ts', 'util.ts']);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\main.ts');
		// The cursor sits on the use of `helper` (line 2).
		group.activeView!.dispatch({ selection: { anchor: group.activeView!.state.doc.line(2).from + 'const other = '.length } });

		rightClick(document.querySelector('.cm-content'));
		expect(menuLabels()).toEqual(['Go to Definition', 'Find References', 'Show Call Tree', 'Go Back', 'Go Forward', 'Toggle Bookmark', 'Change All Occurrences', 'Cut', 'Copy', 'Paste', 'Compare with Clipboard', 'Duplicate Selection', 'Toggle Line Comment', 'Toggle Block Comment', 'Format Document', 'Find', 'Command Palette...']);
		expect(menuItem('Go Back')!.classList.contains('disabled')).toBe(true);
		click(menuItem('Go to Definition'));
		await flush();

		expect(texts('.tab .label')).toEqual(['main.ts', 'util.ts']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('util.ts');
		const head = group.activeView!.state.selection.main.head;
		expect(group.activeView!.state.doc.lineAt(head).number).toBe(1);
		// The jump itself is navigable: back returns to main.ts at the line it came from.
		expect(group.canGoBack()).toBe(true);
		group.goBack();
		await flush();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('main.ts');

		// Copy speaks for the cursor's whole line when the selection is empty (the linewise
		// form the native Ctrl+C already has), and for the selection otherwise.
		group.activeView!.dispatch({ selection: { anchor: 0 } });
		rightClick(document.querySelector('.cm-content'));
		expect(menuItem('Copy')!.classList.contains('disabled')).toBe(false);
		click(menuItem('Copy'));
		expect(backend.clipboard).toEqual(['helper();\n']);
		group.activeView!.dispatch({ selection: { anchor: 0, head: 3 } });
		rightClick(document.querySelector('.cm-content'));
		click(menuItem('Copy'));
		expect(backend.clipboard).toEqual(['helper();\n', 'hel']);

		group.activeView!.dispatch({ selection: { anchor: group.activeView!.state.doc.line(3).from } });
		await group.goToDefinition();
		await flush();
		expect(notifications().some((n) => n.includes('No definition found'))).toBe(true);
	});

	it('go to definition prefers the candidate in the current file\'s folder', async () => {
		const contents: Record<string, string> = {
			'C:/repo/src/main.ts': 'helper();\n',
			'C:/repo/src/util.ts': 'export function helper() {\n\treturn 1;\n}\n',
			'C:/repo/lib/util.ts': 'export function helper() {\n\treturn 2;\n}\n'
		};
		// joinPath spells candidate paths with mixed separators; the backend takes both.
		backend.on('read_file', ({ path }) => {
			const text = contents[String(path).replaceAll('\\', '/')];
			if (text === undefined) throw new Error(`${String(path)}: not found`);
			return { contents: text, binary: false, size: text.length };
		});
		backend.on('list_files', () => ['lib/util.ts', 'src/util.ts', 'src/main.ts']);
		backend.on('workspace_symbols', () => []);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\src\\main.ts');
		group.activeView!.dispatch({ selection: { anchor: 1 } }); // the cursor on `helper`
		await group.goToDefinition();
		await flush();
		// Both candidates declare `helper`; the one beside the current file wins the tie.
		const active = group.activeInput;
		expect(active?.kind === 'file' && active.path.replaceAll('\\', '/')).toBe('C:/repo/src/util.ts');
	});

	it('keeps a dirty editor open when the save prompt is dismissed with its close button', async () => {
		files({ 'C:\\repo\\c.txt': 'c' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\c.txt');
		group.activeView!.dispatch({ changes: { from: 0, insert: 'x' } });
		const closing = group.close();
		await flush();
		const buttons = document.querySelectorAll('#notifications .notification .action-btn');
		click(buttons[buttons.length - 1]!);
		await closing;
		expect(texts('.tab .label')).toEqual(['c.txt']);
	});

	it('reopen with encoding: choosing Save saves the dirty buffer, then reopens it', async () => {
		const contents: Record<string, string> = { 'C:\\repo\\r.txt': 'hello\n' };
		backend.on('read_file', ({ path, encoding }) => ({
			contents: encoding === 'utf-16le' ? 'decoded\n' : contents[String(path)],
			binary: false, size: 6, encoding: String(encoding ?? 'utf8'), eol: 'lf'
		}));
		backend.on('write_file', ({ path, contents: text }) => { contents[String(path)] = String(text); return null; });
		backend.on('backup_write', () => null);
		backend.on('backup_clear', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\r.txt');
		group.activeView!.dispatch({ changes: { from: 0, insert: 'edit: ' } });

		const reopening = group.reopenWithEncoding('utf-16le');
		await flush();
		expect(notifications()[0]).toContain('Do you want to save');
		click(notificationButton('Save'));
		await reopening;
		// Save means the buffer is written first, then the file is re-read in the new encoding.
		expect(backend.callsTo('write_file')[0]).toMatchObject({ path: 'C:\\repo\\r.txt', contents: 'edit: hello\n' });
		expect(backend.callsTo('read_file').at(-1)).toEqual({ path: 'C:\\repo\\r.txt', encoding: 'utf-16le' });
		expect(group.activeView!.state.doc.toString()).toBe('decoded\n');
		expect(group.hasDirtyEditors()).toBe(false);
	});

	it('opens the welcome and keyboard shortcuts pages as help tabs', async () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const rendered: string[] = [];
		group.renderHelp = (help, container) => {
			rendered.push(help);
			container.appendChild(el('div', '', [`PAGE:${help}`]));
		};
		group.openHelp('shortcuts');
		group.openHelp('welcome');
		expect(texts('.tab .label')).toEqual(['Keyboard Shortcuts', 'Welcome']);
		// A page without a file path keeps its breadcrumbs hidden — the crumb would only
		// repeat the tab's own title.
		expect(document.querySelector<HTMLElement>('.breadcrumbs')!.hidden).toBe(true);
		expect(texts('.breadcrumbs .crumb')).toEqual([]);
		expect(rendered).toEqual(['shortcuts', 'welcome']);
		// Re-opening activates the existing tab instead of duplicating it.
		group.openHelp('shortcuts');
		expect(texts('.tab .label')).toEqual(['Keyboard Shortcuts', 'Welcome']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('Keyboard Shortcuts');
		expect(await group.closeAll()).toBe(true);
	});

	it('Save As pins the saved baseline before the write: an edit typed mid-write stays dirty', async () => {
		files({ 'C:\\repo\\a.txt': 'a' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		const view = group.activeView!;
		view.dispatch({ changes: { from: 0, insert: 'x' } });
		// The write hangs; the user keeps typing while it runs.
		let release!: (value: unknown) => void;
		backend.on('write_file', () => new Promise((resolve) => { release = resolve; }));
		backend.dialog.saveResult = 'C:\\repo\\renamed.txt';
		rightClick(document.querySelector('.tab.active')!);
		click(menuItem('Save As...'));
		await flush();
		view.dispatch({ changes: { from: 0, insert: 'y' } });
		release(null);
		await flush();
		// The mid-write edit is past what disk holds: the tab must say so, or closing it
		// would silently lose the edit. The baseline is the buffer as the write took it.
		expect(view.state.doc.toString()).toBe('yxa');
		expect(group.hasDirtyEditors()).toBe(true);
		// Closing asks; the edit is deliberately discarded.
		const closing = group.close();
		await flush();
		click(notificationButton("Don't Save"));
		await closing;
	});

	it('a silent reload never enters the undo stack', async () => {
		const contents: Record<string, string | null> = { '/r/reload.txt': 'one' };
		files(contents);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('/r/reload.txt');
		// The watcher's silent reload replaced the whole document: it is the disk's word,
		// not the reader's edit, so Ctrl+Z must not resurrect the stale text as dirty —
		// and a Ctrl+S after it would write that stale text back.
		contents['/r/reload.txt'] = 'disk text';
		await group.reloadIfClean('/r/reload.txt');
		expect(group.activeView!.state.doc.toString()).toBe('disk text');
		group.runEditorCommand('undo');
		expect(group.activeView!.state.doc.toString()).toBe('disk text');
		expect(group.hasDirtyEditors()).toBe(false);
		// The replace still maps the history: a real edit on the reloaded text undoes
		// exactly back to it.
		group.activeView!.dispatch({ changes: { from: 0, insert: 'x' } });
		expect(group.hasDirtyEditors()).toBe(true);
		group.runEditorCommand('undo');
		expect(group.activeView!.state.doc.toString()).toBe('disk text');
		await group.closeAll();
	});

	it('an inactive open of an already-open file does not steal the view', async () => {
		files({ 'C:\\repo\\a.txt': 'a\n', 'C:\\repo\\b.txt': 'b\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
		// The remote mirror syncs the PC's tabs with {inactive: true}: an already-open file
		// takes the open without moving the user's view.
		await group.openFile('C:\\repo\\a.txt', { inactive: true });
		expect(texts('.tab .label')).toEqual(['a.txt', 'b.txt']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('b.txt');
		// The plain reopen still activates, as before.
		await group.openFile('C:\\repo\\a.txt');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt');
		await group.closeAll();
	});

	it('saving a file drops its Go-to-Definition cache entry', async () => {
		files({ 'C:\\repo\\cached.ts': 'let x = 1;\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\cached.ts');
		// The definition search read the file before the save (its whole-text cache).
		workspaceFileCache.set('C:\\repo\\cached.ts', 'let x = 1;\n');
		group.activeView!.dispatch({ changes: { from: 0, insert: 'let y = 2;\n' } });
		await group.save();
		// The write changed what disk holds: the stale text must not serve the next
		// Go to Definition — and the mixed-separator spelling drops with it.
		expect(workspaceFileCache.has('C:\\repo\\cached.ts')).toBe(false);
		workspaceFileCache.set('C:\\repo/cached.ts', 'other spelling');
		group.activeView!.dispatch({ changes: { from: 0, insert: 'let z = 3;\n' } });
		await group.save();
		expect(workspaceFileCache.has('C:\\repo/cached.ts')).toBe(false);
		await group.closeAll();
	});
});

describe('lazy syntax highlighting', () => {
	it('paints the editor before the language support arrives, then adds it in place', async () => {
		files({ 'C:\repo\a.ts': 'const a = 1;\n' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const names: (string | undefined)[] = [];
		group.onActiveChange = (e) => names.push(e?.languageName);
		await group.openFile('C:\repo\a.ts');
		// The editor is up ("Plain Text") without waiting for the language chunk…
		expect(document.querySelector('.cm-editor')).not.toBeNull();
		expect(names.at(-1)).toBe('Plain Text');
		// …which lands in place shortly after. The ceilings are generous on purpose: on a
		// cold CI runner the chunk's first transform+import took past the DEFAULT test
		// timeout, let alone one second — this test pins the arrival, not its latency.
		for (let i = 0; i < 500 && names.at(-1) === 'Plain Text'; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(names.at(-1)).toBe('TypeScript');
	}, 30_000);
});

describe('navigation history across renames', () => {
	it('Back lands on a renamed file under its new path - open or closed', async () => {
		const contents: Record<string, string | null> = { 'C:\\repo\\old.txt': 'line 1\nline 2\n', 'C:\\repo\\other.txt': 'o\n' };
		files(contents);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\old.txt');
		// Leave a mark on the stop: the cursor sits on line 2 when we move on.
		group.activeView!.dispatch({ selection: { anchor: 7 } });
		await group.openFile('C:\\repo\\other.txt');
		expect(group.canGoBack()).toBe(true);

		// The file is renamed while its tab is open: Back activates that tab (still line 2),
		// and never asks the backend for the old path.
		contents['C:\\repo\\new.txt'] = contents['C:\\repo\\old.txt']!;
		delete contents['C:\\repo\\old.txt'];
		group.pathRenamed('C:\\repo\\old.txt', 'C:\\repo\\new.txt');
		backend.calls.length = 0;
		group.goBack();
		await flush();
		expect(group.activeInput).toEqual({ kind: 'file', path: 'C:\\repo\\new.txt' });
		expect(group.activeView!.state.doc.lineAt(group.activeView!.state.selection.main.head).number).toBe(2);
		expect(backend.callsTo('read_file')).toEqual([]);
		expect(texts('.tab .label')).toEqual(['new.txt', 'other.txt']);

		// Closed before the rename: the stop is respelled by path, so Back reopens new.txt
		// rather than failing on old.txt.
		group.goForward();
		await flush();
		await group.close(group.findEditor('file:C:\\repo\\new.txt')!);
		contents['C:\\repo\\newer.txt'] = contents['C:\\repo\\new.txt']!;
		delete contents['C:\\repo\\new.txt'];
		group.pathRenamed('C:\\repo\\new.txt', 'C:\\repo\\newer.txt');
		group.goBack();
		await flush();
		expect(group.activeInput).toEqual({ kind: 'file', path: 'C:\\repo\\newer.txt' });
		expect(backend.callsTo('read_file').at(-1)).toEqual({ path: 'C:\\repo\\newer.txt' });
		expect(notifications()).toEqual([]);
	});
});

describe('extension page tabs (module 12, ggs/2)', () => {
	it('opens each extension page open as its own tab, and closing runs its disposer', async () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		let disposed = 0;
		const mount = (pane: HTMLElement): (() => void) => {
			pane.appendChild(el('iframe', 'ext-page-frame'));
			return () => disposed++;
		};
		await group.openExtPage({ kind: 'extpage', id: 'extpage:a.b:main:1', title: 'Demo', extId: 'a.b', pageId: 'main' }, mount);
		await group.openExtPage({ kind: 'extpage', id: 'extpage:a.b:main:2', title: 'Demo', extId: 'a.b', pageId: 'main', params: { x: 1 } }, mount);
		expect(group.openEditorIds()).toEqual(['extpage:a.b:main:1', 'extpage:a.b:main:2']);
		// Both tabs carry the page's frame (each open is its own instance).
		expect(group['open'].filter((editor: Editor) => editor.input.kind === 'extpage' && editor.pane.querySelector('iframe.ext-page-frame')).length).toBe(2);

		group.close(); // the active tab (the second open) goes, its frame with it
		expect(group.openEditorIds()).toEqual(['extpage:a.b:main:1']);
		expect(disposed).toBe(1);
	});

	it('the extension detail page is a document pane — its own scroll container, one tab per extension', () => {
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const mounted: HTMLElement[] = [];
		const mount = (pane: HTMLElement) => {
			mounted.push(pane);
			pane.appendChild(el('div', 'ext-detail-page'));
		};
		group.openExtDetail({ kind: 'extdetail', id: 'extdetail:a.b', title: 'Demo', extId: 'a.b' }, mount);
		// One tab per extension id: a second open focuses the tab already showing it.
		group.openExtDetail({ kind: 'extdetail', id: 'extdetail:a.b', title: 'Demo', extId: 'a.b' }, mount);
		expect(group.openEditorIds()).toEqual(['extdetail:a.b']);
		expect(mounted.length).toBe(1);
		// The document variant, not the iframe host: this class is what shell.css turns into
		// the page's scroll container, so a long README wheel-scrolls inside the tab and clips
		// at the editor area instead of painting over the status bar.
		expect(mounted[0]!.className).toBe('editor-pane ext-detail-pane');
	});
});
