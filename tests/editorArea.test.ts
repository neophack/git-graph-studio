import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorArea } from '../src/editorArea';
import { tabDrag } from '../src/editor';
import { SETTINGS_EVENT } from '../src/settings';
import { backend } from './tauriMock';
import { click, flush, notificationButton, notifications, texts } from './helpers';

function files(contents: Record<string, string | null>): void {
	backend.on('read_file', ({ path }) => {
		const text = contents[String(path)];
		if (text === undefined) throw new Error(`${path}: not found`);
		return { contents: text, binary: text === null, size: text?.length ?? 0 };
	});
}

function drag(from: Element, to: Element): void {
	from.dispatchEvent(new Event('dragstart', { bubbles: true }));
	to.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
	to.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
	from.dispatchEvent(new Event('dragend', { bubbles: true }));
}

/** Every group's tab labels, one array per group, in visual order (the grid renders groups
 *  depth-first, which is left-to-right, top-to-bottom). */
function groupTabs(): string[][] {
	return Array.from(document.querySelectorAll('.editor-group-box')).map((box) => texts('.tab .label', box));
}

describe('editor area (M3 3.1)', () => {
	beforeEach(() => {
		// Only the editor part is rebuilt: the notifications container the close prompts use
		// (and anything else the shell set up) stays.
		const part = document.getElementById('editorGroup')!;
		part.innerHTML = '';
	});

	it('splits right and down, and focuses groups by index', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		expect(area.groupCount).toBe(1);

		const second = area.split('right');
		await second.openFile('C:\\repo\\b.ts');
		const third = area.split('down');
		await third.openFile('C:\\repo\\c.ts');
		expect(area.groupCount).toBe(3);
		expect(groupTabs()).toEqual([['a.ts'], ['b.ts'], ['c.ts']]);

		// Ctrl+1/2/3 route through focusIndex; the focused group's editor answers the facade.
		area.focusIndex(0);
		expect(area.activeInput?.kind === 'file' && area.activeInput.path.endsWith('a.ts')).toBe(true);
		area.focusIndex(1);
		expect(area.activeInput?.kind === 'file' && area.activeInput.path.endsWith('b.ts')).toBe(true);
		expect(area.focusedIndex).toBe(1);
	});

	it('moves a tab between groups by drag and drop', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		expect(groupTabs()).toEqual([['a.ts'], ['b.ts']]);

		// Drag group 2's tab onto group 1. The empty source group collapses once the target
		// takes the focus, as VS Code's empty groups do.
		const boxes = document.querySelectorAll('.editor-group-box');
		const tab = boxes[1]!.querySelector('.tab')!;
		drag(tab, boxes[0]!);
		expect(tabDrag.editor).toBeNull();
		expect(groupTabs()).toEqual([['a.ts', 'b.ts']]);
		expect(area.groupCount).toBe(1);

		// The moved editor is the source group's no more; the target owns it.
		expect(area.groupAt(0).openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);
	});

	it('collapses a group as soon as its last tab closes, even while it holds the focus', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');

		// Closing the second group's only tab empties it: the layer disappears at once and
		// the focus falls back to the remaining group.
		const boxes = document.querySelectorAll('.editor-group-box');
		click(boxes[1]!.querySelector('.tab .close'));
		await flush();
		expect(area.groupCount).toBe(1);
		expect(area.focusedIndex).toBe(0);
		expect(groupTabs()).toEqual([['a.ts']]);
	});

	it('opens a file in every direction, reusing the neighbouring layer or creating it at the edge', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n', 'C:\\repo\\d.ts': 'd\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');

		// Right creates a second layer beside the first and opens the file there.
		area.openInDirection('C:\\repo\\b.ts', 'right');
		await flush();
		expect(area.groupCount).toBe(2);
		expect(groupTabs()).toEqual([['a.ts'], ['b.ts']]);

		// Left of the focused group is the existing first layer.
		area.openInDirection('C:\\repo\\c.ts', 'left');
		await flush();
		expect(area.groupCount).toBe(2);
		expect(area.groupAt(0).openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\c.ts']);

		// Below creates a stacked layer under the focused one; above the focused group reuses it.
		area.openInDirection('C:\\repo\\d.ts', 'down');
		await flush();
		expect(area.groupCount).toBe(3);
		expect(groupTabs()).toEqual([['a.ts', 'c.ts'], ['d.ts'], ['b.ts']]);
		area.openInDirection('C:\\repo\\a.ts', 'up');
		await flush();
		expect(area.groupCount).toBe(3);
	});

	it('reports the focused group as the area, spanning groups for closeAll and dirty state', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		area.focusIndex(1);
		(right.activeView ?? area.activeView)!.dispatch({ changes: { from: 0, insert: 'x' } });
		expect(area.hasDirtyEditors()).toBe(true);
		expect(area.openFilePaths()).toEqual(['C:\\repo\\a.ts', 'C:\\repo\\b.ts']);

		// Closing all asks about the dirty editor; "Don't Save" lets it close.
		const closing = area.closeAll();
		await flush();
		click(notificationButton("Don't Save"));
		expect(await closing).toBe(true);
		expect(area.openFilePaths()).toEqual([]);
	});

	it('asks once for several dirty files across groups, and Save All writes them all', async () => {
		const contents: Record<string, string> = { 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' };
		files(contents);
		backend.on('write_file', ({ path, contents: text }) => { contents[String(path)] = String(text); return null; });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		area.activeView!.dispatch({ changes: { from: 0, insert: 'x' } });
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		right.activeView!.dispatch({ changes: { from: 0, insert: 'y' } });

		const closing = area.closeAll();
		await flush();
		// One VS Code-style prompt naming both files, not two prompts in a row.
		expect(notifications()).toHaveLength(1);
		expect(notifications()[0]).toContain('the following 2 files? a.ts, b.ts');
		click(notificationButton('Save All'));
		expect(await closing).toBe(true);
		expect(backend.callsTo('write_file').map((c) => c['contents'])).toEqual(['xa\n', 'yb\n']);
		expect(area.openFilePaths()).toEqual([]);
	});

	it('opens files in parallel as inactive tabs and activates a chosen one afterwards', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		const group = area.groupAt(0);
		await group.openFile('C:\\repo\\a.ts');
		await Promise.all([
			group.openFile('C:\\repo\\b.ts', { inactive: true }),
			group.openFile('C:\\repo\\c.ts', { inactive: true })
		]);
		// The shown editor is untouched by the inactive opens; the tabs are all there.
		expect(group.activeInput?.kind === 'file' && group.activeInput.path.endsWith('a.ts')).toBe(true);
		expect(group.openFilePaths().length).toBe(3);
		group.activateLast();
		expect(group.activeInput?.kind === 'file' && !group.activeInput.path.endsWith('a.ts')).toBe(true);
	});

	it('opens the Git Graph tab in a group that was split after the graph host was wired', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		const frame = document.createElement('iframe');
		area.graphElement = frame;
		area.split('right'); // the new group must receive the graph frame too
		area.openGraph();
		expect(area.activeInput?.kind).toBe('graph');
		expect(frame.parentElement).not.toBeNull();
	});

	it('the welcome page belongs to the first group, and a split without files collapses back', async () => {
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.renderWelcome = (container) => container.appendChild(document.createElement('h1'));
		area.split('right');
		// A layer only exists while it holds editors: the welcome split folds back to one
		// pane, and the welcome page stays with it - never duplicated.
		expect(document.querySelectorAll('.editor-group-box')).toHaveLength(1);
		expect(document.querySelectorAll('.welcome h1')).toHaveLength(1);
	});

	it('serialises the grid and rebuilds it as it was, so a 2x2 session reopens as 2x2', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n', 'C:\\repo\\c.ts': 'c\n', 'C:\\repo\\d.ts': 'd\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		area.openInDirection('C:\\repo\\b.ts', 'right');
		await flush();
		area.focusIndex(0);
		area.openInDirection('C:\\repo\\c.ts', 'down');
		await flush();
		area.focusIndex(2);
		area.openInDirection('C:\\repo\\d.ts', 'down');
		await flush();
		expect(area.groupCount).toBe(4);
		// a 2x2: one outer row, each half a stacked column pair.
		expect(document.querySelectorAll('.editor-area-row')).toHaveLength(1);
		expect(document.querySelectorAll('.editor-area-col')).toHaveLength(2);
		expect(groupTabs()).toEqual([['a.ts'], ['c.ts'], ['b.ts'], ['d.ts']]);
		const saved = area.gridLayout();
		expect(saved).toEqual({ axis: 'x', sizes: [0.5, 0.5], children: [
			{ axis: 'y', sizes: [0.5, 0.5], children: [{ group: 0 }, { group: 1 }] },
			{ axis: 'y', sizes: [0.5, 0.5], children: [{ group: 2 }, { group: 3 }] }
		] });

		// Rebuild on a fresh area: same shape, same visual order of the groups.
		document.getElementById('editorGroup')!.innerHTML = '';
		const reopened = new EditorArea(document.getElementById('editorGroup')!);
		reopened.setRoot('C:\\repo');
		// The groups come back in the saved DFS order (a, c, b, d); each cell's files open in it.
		const groups = reopened.applyGridLayout(saved);
		await Promise.all(groups.map((group, index) => group.openFile(`C:\\repo\\${['a', 'c', 'b', 'd'][index]}.ts`, { inactive: true })));
		reopened.restoringLayout = false;
		await flush();
		expect(reopened.groupCount).toBe(4);
		expect(document.querySelectorAll('.editor-area-row')).toHaveLength(1);
		expect(document.querySelectorAll('.editor-area-col')).toHaveLength(2);
		expect(reopened.groups().map((group) => group.openFilePaths()[0])).toEqual([
			'C:\\repo\\a.ts', 'C:\\repo\\c.ts', 'C:\\repo\\b.ts', 'C:\\repo\\d.ts'
		]);
	});

	it('drops empty groups from the snapshot sessions', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		area.split('right'); // an empty second group: nothing to restore from it
		expect(area.groupSessions()).toEqual([{ files: ['C:\\repo\\a.ts'], active: 'C:\\repo\\a.ts' }]);
	});

	it('serialises per-group sessions for the workspace snapshot', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n', 'C:\\repo\\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\a.ts');
		const right = area.split('right');
		await right.openFile('C:\\repo\\b.ts');
		expect(area.groupSessions()).toEqual([
			{ files: ['C:\\repo\\a.ts'], active: 'C:\\repo\\a.ts' },
			{ files: ['C:\\repo\\b.ts'], active: 'C:\\repo\\b.ts' }
		]);
	});

	it('opens the markdown preview to the side without a path argument (Ctrl+K V)', async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		backend.on('read_file', () => ({ contents: '# T\n', binary: false, size: 4, encoding: 'utf8', eol: 'lf' }));
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\README.md');
		// The command passes no path: the active file's path must be taken from the group
		// that is active BEFORE the split, not from the fresh empty group the split focuses.
		await area.openMarkdownPreviewToSide();
		await flush();
		expect(area.groupCount).toBe(2);
		expect(area.groups()[0]!.openEditorIds()).toEqual(['file:C:\\repo\\README.md']);
		expect(area.groups()[1]!.openEditorIds()).toEqual(['markdown:C:\\repo\\README.md']);
	});

	it('opens no empty split when there is no file to preview to the side', async () => {
		const area = new EditorArea(document.getElementById('editorGroup')!);
		await area.openMarkdownPreviewToSide();
		expect(area.groupCount).toBe(1);
	});

	it('the markdown tab\'s preview-to-the-side button opens the preview in a split', async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		backend.on('read_file', () => ({ contents: '# T\n', binary: false, size: 4, encoding: 'utf8', eol: 'lf' }));
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\\repo');
		await area.openFile('C:\\repo\\NOTE.md');
		click(document.querySelector('.markdown-preview-button'));
		await flush();
		expect(area.groupCount).toBe(2);
		expect(area.groups()[1]!.openEditorIds()).toEqual(['markdown:C:\\repo\\NOTE.md']);
	});

	it('detaches a destroyed group\'s settings listener (collapse and grid rebuild)', async () => {
		files({ 'C:\\repo\\a.ts': 'a\n' });
		const removed: string[] = [];
		const original = document.removeEventListener;
		const spy = vi.spyOn(document, 'removeEventListener').mockImplementation((type: string, listener?: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
			removed.push(type);
			original.call(document, type, listener, options);
		});
		try {
			const area = new EditorArea(document.getElementById('editorGroup')!);
			area.setRoot('C:\\repo');
			await area.openFile('C:\\repo\\a.ts');
			area.split('right');
			area.focusIndex(0); // the empty split collapses: its group is destroyed
			expect(area.groupCount).toBe(1);
			expect(removed).toContain(SETTINGS_EVENT);

			removed.length = 0;
			area.applyGridLayout({ axis: 'x', sizes: [0.5, 0.5], children: [{ group: 0 }, { group: 1 }] });
			expect(area.groupCount).toBe(2);
			area.applyGridLayout(null);
			expect(area.groupCount).toBe(1);
			expect(removed).toContain(SETTINGS_EVENT);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('the grid snapshot when a group holds no files', () => {
	it('numbers the cells over the session-bearing groups only, so a restore lands files in their panes', async () => {
		files({ 'C:\repo\a.ts': 'a\n', 'C:\repo\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.graphElement = document.createElement('div');
		area.setRoot('C:\repo');
		await area.openFile('C:\repo\a.ts');
		// Three groups: a.ts | Git Graph (no file - dropped from the sessions) | c.ts.
		const middle = area.split('right');
		middle.openGraph();
		const right = area.split('right');
		await right.openFile('C:\repo\c.ts');
		expect(area.groupCount).toBe(3);
		expect(area.groupSessions()).toEqual([
			{ files: ['C:\repo\a.ts'], active: 'C:\repo\a.ts' },
			{ files: ['C:\repo\c.ts'], active: 'C:\repo\c.ts' }
		]);
		// The cells line up with the sessions: two of them, the graph's pane left out, its
		// share handed to the survivors (proportions still sum to one).
		const saved = area.gridLayout()!;
		expect('axis' in saved && saved.children).toEqual([{ group: 0 }, { group: 1 }]);
		expect('axis' in saved && saved.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);

		// A layout whose only file-bearing group is one of several is a single-group session.
		const single = new EditorArea(document.getElementById('editorGroup')!);
		single.graphElement = document.createElement('div');
		single.setRoot('C:\repo');
		await single.openFile('C:\repo\a.ts');
		single.split('right').openGraph();
		expect(single.groupCount).toBe(2);
		expect(single.gridLayout()).toBeNull();
	});

	it('collapses a split left with one cell into that cell', async () => {
		files({ 'C:\repo\a.ts': 'a\n', 'C:\repo\b.ts': 'b\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.graphElement = document.createElement('div');
		area.setRoot('C:\repo');
		await area.openFile('C:\repo\a.ts');
		// a.ts | (graph over b.ts): the right column's graph pane drops, leaving b.ts alone
		// in it - the column disappears and b.ts becomes the row's second cell directly.
		const rightTop = area.split('right');
		rightTop.openGraph();
		const rightBottom = area.split('down');
		await rightBottom.openFile('C:\repo\b.ts');
		expect(area.groupCount).toBe(3);
		expect(area.gridLayout()).toEqual({ axis: 'x', sizes: [0.5, 0.5], children: [{ group: 0 }, { group: 1 }] });
	});
});

describe('the sash between three groups', () => {
	it('moves a pair\'s shares by the dragged fraction of the split, not of the pair', async () => {
		files({ 'C:\repo\a.ts': 'a\n', 'C:\repo\b.ts': 'b\n', 'C:\repo\c.ts': 'c\n' });
		const area = new EditorArea(document.getElementById('editorGroup')!);
		area.setRoot('C:\repo');
		await area.openFile('C:\repo\a.ts');
		await area.split('right').openFile('C:\repo\b.ts');
		await area.split('right').openFile('C:\repo\c.ts');
		expect(area.gridLayout()).toEqual({ axis: 'x', sizes: [0.5, 0.25, 0.25], children: [{ group: 0 }, { group: 1 }, { group: 2 }] });
		const row = document.querySelector<HTMLElement>('.editor-area-row')!;
		row.getBoundingClientRect = () => ({ width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => undefined });
		// Drag the second sash (between b and c) 100px to the right: a tenth of the row's
		// width moves from c to b - 0.25 -> 0.35 and 0.25 -> 0.15, the first group untouched.
		const sash = document.querySelectorAll<HTMLElement>('.editor-sash')[1]!;
		sash.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 750, clientY: 100 }));
		document.dispatchEvent(new MouseEvent('mousemove', { clientX: 850, clientY: 100 }));
		document.dispatchEvent(new MouseEvent('mouseup', { clientX: 850, clientY: 100 }));
		await flush();
		const sizes = (area.gridLayout() as { sizes: number[] }).sizes;
		expect(sizes[0]).toBeCloseTo(0.5);
		expect(sizes[1]).toBeCloseTo(0.35);
		expect(sizes[2]).toBeCloseTo(0.15);
	});
});
