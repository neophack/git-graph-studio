// Beyond Compare-style selection compare: Ctrl/Shift multi-select in the Explorer, the
// "Compare Two Files/Folders" menu entry on a matching pair, and where each lands - a local
// text diff of the two files, the Folder Compare view for two folders.

import { describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import { Explorer } from '../src/explorer';
import { backend } from './tauriMock';
import { click, flush, menuItem, menuLabels, rightClick, texts } from './helpers';

const ROOT = 'C:\\repo';

function fileSystem(tree: Record<string, string[]>): void {
	backend.on('list_dir', ({ path }) => {
		const entries = tree[String(path)];
		if (!entries) throw new Error(`${path}: no such directory`);
		return entries.map((name) => {
			const isDir = name.endsWith('/');
			const clean = isDir ? name.slice(0, -1) : name;
			return { name: clean, path: `${path}\\${clean}`, isDir, size: 0 };
		});
	});
}

/** Resolve once `ready` holds (polled), failing the test after `ms`. */
async function waitFor(ready: () => boolean, ms = 3000): Promise<void> {
	const step = async (): Promise<void> => {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return step();
	};
	await Promise.race([step(), new Promise((_, reject) => setTimeout(() => reject(new Error('condition not met in time')), ms))]);
}

describe('explorer multi-selection compare', () => {
	it('Ctrl+click picks two files, shows the compare menu and reports them in order', async () => {
		fileSystem({ [ROOT]: ['a.txt', 'b.txt', 'c.txt'] });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		const opened: string[] = [];
		let compared: [string, string, boolean] | null = null;
		explorer.onFileOpened = (p) => opened.push(p);
		explorer.onCompare = (left, right, isDir) => compared = [left, right, isDir];
		explorer.setRoot(ROOT);
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree .row'));

		// Ctrl+click selects without opening the file (a compare pair must be pickable).
		click(rows[2], { ctrlKey: true });
		click(rows[0], { ctrlKey: true });
		expect(opened).toEqual([]);
		expect(explorer.selectedPaths).toEqual([`${ROOT}\\c.txt`, `${ROOT}\\a.txt`]);
		expect(texts('.tree .row.selected .label')).toEqual(['a.txt', 'c.txt']);

		// The menu of either of the two offers the compare; the first-selected side is the left.
		rightClick(rows[0]);
		expect(menuLabels()[0]).toBe('Compare Two Files');
		click(menuItem('Compare Two Files'));
		expect(compared).toEqual([`${ROOT}\\c.txt`, `${ROOT}\\a.txt`, false]);

		// Ctrl+clicking a selected entry again drops it from the selection.
		click(rows[0], { ctrlKey: true });
		expect(explorer.selectedPaths).toEqual([`${ROOT}\\c.txt`]);
		rightClick(rows[0]);
		expect(menuLabels()).not.toContain('Compare Two Files');
	});

	it('compares two selected folders', async () => {
		fileSystem({ [ROOT]: ['left/', 'right/', 'a.txt'] });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		let compared: [string, string, boolean] | null = null;
		explorer.onCompare = (left, right, isDir) => compared = [left, right, isDir];
		explorer.setRoot(ROOT);
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree .row'));
		click(rows[0]);
		click(rows[1], { ctrlKey: true });
		rightClick(rows[1]);
		expect(menuLabels()[0]).toBe('Compare Two Folders');
		click(menuItem('Compare Two Folders'));
		expect(compared).toEqual([`${ROOT}\\left`, `${ROOT}\\right`, true]);
	});

	it('Shift+click selects a tree-ordered range, and a mixed or oversized selection gets no compare entry', async () => {
		fileSystem({ [ROOT]: ['a.txt', 'b.txt', 'c.txt', 'sub/'] });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot(ROOT);
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree .row'));

		// The range runs between the anchor and the clicked row in tree order.
		click(rows[0]);
		click(rows[2], { shiftKey: true });
		expect(explorer.selectedPaths).toEqual([`${ROOT}\\a.txt`, `${ROOT}\\b.txt`, `${ROOT}\\c.txt`]);
		rightClick(rows[1]);
		expect(menuLabels()).not.toContain('Compare Two Files');

		// A file and a folder cannot compare; right-clicking outside the selection collapses it.
		click(rows[0]);
		click(rows[3], { ctrlKey: true });
		rightClick(rows[0]);
		expect(menuLabels()).not.toContain('Compare Two Files');
		rightClick(rows[1]);
		expect(explorer.selectedPaths).toEqual([`${ROOT}\\b.txt`]);
	});

	it('renders a local two-file compare as a text diff of both files on disk', async () => {
		fileSystem({ [ROOT]: ['a.txt', 'b.txt'] });
		backend.on('read_file', ({ path }) => ({
			contents: String(path).endsWith('a.txt') ? 'one\ntwo\n' : 'one\nTWO\n',
			binary: false,
			size: 8
		}));
		const explorer = new Explorer(document.getElementById('sidebar')!);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(ROOT);
		explorer.onCompare = (left, right) => void group.openDiff({
			kind: 'diff', id: `paths:${left}::${right}`, title: 'a.txt ↔ b.txt',
			left: { revision: '*', path: left, label: left, exists: true, local: true },
			right: { revision: '*', path: right, label: right, exists: true, local: true }
		});
		explorer.setRoot(ROOT);
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree .row'));
		click(rows[0]);
		click(rows[1], { ctrlKey: true });
		rightClick(rows[1]);
		click(menuItem('Compare Two Files'));
		// The merge view arrives with the async text-editor/merge chunks; the first load's
		// timing varies, so poll for it instead of sleeping a fixed time.
		await waitFor(() => document.querySelectorAll('.cm-mergeView .cm-editor').length === 2);

		// Both sides read straight off the disk (read_file), never as a git revision.
		expect(backend.callsTo('read_file').map((c) => c['path'])).toEqual([`${ROOT}\\a.txt`, `${ROOT}\\b.txt`]);
		expect(backend.callsTo('read_file_at')).toHaveLength(0);
		expect(document.querySelectorAll('.cm-mergeView .cm-editor')).toHaveLength(2);
		// A local side's label is its path, shown once - not "path (path)".
		expect(texts('.diff-header > span:not(.diff-stats)')).toEqual([`${ROOT}\\a.txt`, `${ROOT}\\b.txt`]);
		expect(document.querySelector('.diff-stats')!.textContent).toMatch(/^\+1−1/);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.txt ↔ b.txt');
	});

	it('opens a two-folder compare in the Folder Compare view', async () => {
		fileSystem({ [ROOT]: ['left/', 'right/'], [`${ROOT}\\left`]: ['shared.txt'], [`${ROOT}\\right`]: ['shared.txt'] });
		backend.on('compare_dirs', () => [{ path: 'shared.txt', status: 'different', leftSize: 3, rightSize: 4 }]);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(ROOT);
		group.openFolderCompare({ kind: 'folders', id: `${ROOT}\\left::${ROOT}\\right`, left: `${ROOT}\\left`, right: `${ROOT}\\right` });
		await flush();
		expect(backend.callsTo('compare_dirs')[0]).toMatchObject({ left: `${ROOT}\\left`, right: `${ROOT}\\right` });
		expect(document.querySelector('.folder-compare')).not.toBeNull();
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('Folder Compare');
	});
});
