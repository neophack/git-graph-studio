import { describe, expect, it, vi } from 'vitest';

import { EditorGroup, fileIcon, type Editor } from '../src/editor';
import { el } from '../src/ui';
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
		expect(texts('.diff-header > span:not(.diff-stats)')).toEqual(['a/x.ts (Index)', 'a/x.ts (Working Tree)']);
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

	it('hosts the graph frame as a tab and retargets tabs on rename/delete', async () => {
		files({ 'C:\\repo\\old.txt': 'x', 'C:\\repo\\dir\\y.txt': 'y' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const frame = document.createElement('iframe');
		group.graphElement = frame;
		group.openGraph();
		expect(group.isGraphOpen()).toBe(true);
		expect(texts('.tab .label')).toEqual(['Git Graph']);
		expect(document.querySelector('.tab img')!.getAttribute('src')).toBe('/icons/git-graph.svg');
		expect(document.querySelector('.editor-pane iframe')).toBe(frame);
		group.openGraph();
		expect(texts('.tab .label')).toEqual(['Git Graph']);

		await group.openFile('C:\\repo\\old.txt');
		await group.openFile('C:\\repo\\dir\\y.txt');
		group.pathRenamed('C:\\repo\\old.txt', 'C:\\repo\\new.txt');
		expect(texts('.tab .label')).toEqual(['Git Graph', 'new.txt', 'y.txt']);
		await group.pathDeleted('C:\\repo\\dir');
		expect(texts('.tab .label')).toEqual(['Git Graph', 'new.txt']);
		group.activateNext(1);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('Git Graph');
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

	it('offers the VS Code tab context menu', async () => {
		files({ 'C:\\repo\\a.txt': 'a', 'C:\\repo\\b.txt': 'b' });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\a.txt');
		await group.openFile('C:\\repo\\b.txt');

		const firstTab = document.querySelector('.tab')!; // a.txt
		rightClick(firstTab);
		expect(menuLabels()).toEqual(['Close', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All', 'Copy Path', 'Copy Relative Path']);
		click(menuItem('Copy Relative Path'));
		expect(backend.clipboard).toEqual(['a.txt']);

		rightClick(firstTab);
		click(menuItem('Close Others'));
		await flush();
		expect(texts('.tab .label')).toEqual(['a.txt']);
		rightClick(firstTab);
		click(menuItem('Close Saved'));
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
		expect(menuLabels()).toEqual(['Go to Definition', 'Find References', 'Show Call Tree', 'Go Back', 'Go Forward', 'Toggle Bookmark', 'Change All Occurrences', 'Cut', 'Copy', 'Paste', 'Find', 'Command Palette...']);
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

		// Copy works from the menu with a selection; the definition-less case reports it.
		group.activeView!.dispatch({ selection: { anchor: 0 } });
		rightClick(document.querySelector('.cm-content'));
		expect(menuItem('Copy')!.classList.contains('disabled')).toBe(true);
		group.activeView!.dispatch({ selection: { anchor: 0, head: 3 } });
		rightClick(document.querySelector('.cm-content'));
		click(menuItem('Copy'));
		expect(backend.clipboard).toEqual(['hel']);

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
		expect(texts('.breadcrumbs .crumb')).toEqual(['Welcome']);
		expect(rendered).toEqual(['shortcuts', 'welcome']);
		// Re-opening activates the existing tab instead of duplicating it.
		group.openHelp('shortcuts');
		expect(texts('.tab .label')).toEqual(['Keyboard Shortcuts', 'Welcome']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('Keyboard Shortcuts');
		expect(await group.closeAll()).toBe(true);
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
		// …which lands in place shortly after.
		for (let i = 0; i < 50 && names.at(-1) === 'Plain Text'; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(names.at(-1)).toBe('TypeScript');
	});
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
