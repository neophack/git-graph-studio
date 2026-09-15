import { describe, expect, it } from 'vitest';

import { Explorer } from '../src/explorer';
import { basename } from '../src/ui';
import { backend } from './tauriMock';
import { click, flush, key, menuItem, menuLabels, notificationButton, notifications, rightClick, texts, type } from './helpers';

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

describe('explorer', () => {
	it('shows the welcome view without a folder', () => {
		const explorer = new Explorer(document.getElementById('sidebar')!);
		let opened = 0;
		explorer.onOpenFolder = () => opened++;
		expect(document.querySelector('.welcome-view')!.textContent).toContain('not yet opened a folder');
		click(document.querySelector('.welcome-view .button'));
		expect(opened).toBe(1);
	});

	it('renders the tree lazily, expands folders, opens files and reveals paths', async () => {
		fileSystem({ [ROOT]: ['src/', 'README.md'], [`${ROOT}\\src`]: ['main.ts'] });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		const opened: string[] = [];
		explorer.onFileOpened = (p) => opened.push(p);
		explorer.setRoot(ROOT);
		await flush();
		expect(document.querySelector('.pane-header .label')!.textContent).toBe('repo');
		expect(texts('.tree .row .label')).toEqual(['src', 'README.md']);
		expect(document.querySelector('.tree .row .codicon-folder')).not.toBeNull();
		expect(document.querySelector('.tree .row .codicon-markdown')).not.toBeNull();

		click(document.querySelector('.tree .row'));
		await flush();
		expect(texts('.tree .row .label')).toEqual(['src', 'main.ts', 'README.md']);
		expect(document.querySelector('.tree .row .codicon-folder-opened')).not.toBeNull();
		click(document.querySelectorAll('.tree .row')[1]);
		expect(opened).toEqual([`${ROOT}\\src\\main.ts`]);

		click(document.querySelector('.tree .row'));
		expect(texts('.tree .row .label')).toEqual(['src', 'README.md']);
		await explorer.reveal(`${ROOT}\\src\\main.ts`);
		await flush();
		expect(texts('.tree .row.selected .label')).toEqual(['main.ts']);
		expect(explorer.expandedFolders()).toEqual(['src']);

		// Keyboard: down/up move the selection, Enter opens.
		const body = document.querySelector<HTMLElement>('.pane-body')!;
		key(body, 'ArrowDown');
		expect(texts('.tree .row.selected .label')).toEqual(['README.md']);
		key(body, 'Enter');
		expect(opened.at(-1)).toBe(`${ROOT}\\README.md`);
		click(document.querySelector('.pane-header .codicon-collapse-all')!.parentElement);
		await flush();
		expect(texts('.tree .row .label')).toEqual(['src', 'README.md']);
	});

	it('decorates rows with the git status', async () => {
		fileSystem({ [ROOT]: ['src/', 'README.md', 'new.txt'], [`${ROOT}\\src`]: ['a.ts'] });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot(ROOT);
		await flush();
		explorer.setStatus(new Map([['README.md', 'M'], ['new.txt', 'U'], ['src/a.ts', 'D']]));
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree .row'));
		expect(rows[0]!.classList.contains('git-modified')).toBe(true);
		expect(rows[0]!.querySelector('.decoration')!.textContent).toBe('●');
		expect(rows[1]!.classList.contains('git-modified')).toBe(true);
		expect(rows[1]!.querySelector('.decoration')!.textContent).toBe('M');
		expect(rows[2]!.classList.contains('git-untracked')).toBe(true);
		expect(rows[2]!.querySelector('.decoration')!.textContent).toBe('U');
	});

	it('creates, renames and deletes through inline inputs and the context menu', async () => {
		const tree: Record<string, string[]> = { [ROOT]: ['a.txt'] };
		fileSystem(tree);
		backend.on('create_file', ({ path }) => { tree[ROOT]!.push(String(path).split('\\').pop()!); return null; });
		backend.on('rename_path', ({ from, to }) => { tree[ROOT] = tree[ROOT]!.map((n) => (n === String(from).split('\\').pop() ? String(to).split('\\').pop()! : n)).sort(); return null; });
		backend.on('delete_path', ({ path }) => { tree[ROOT] = tree[ROOT]!.filter((n) => n !== String(path).split('\\').pop()); return null; });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		const renamed: string[] = [];
		const deleted: string[] = [];
		const opened: string[] = [];
		explorer.onPathRenamed = (from, to) => renamed.push(`${from}>${to}`);
		explorer.onPathDeleted = (p) => deleted.push(p);
		explorer.onFileOpened = (p) => opened.push(p);
		explorer.setRoot(ROOT);
		await flush();

		// New file from the title action: an inline input, validated, then created and opened.
		click(document.querySelector('.pane-header .codicon-new-file')!.parentElement);
		await flush();
		const input = document.querySelector<HTMLInputElement>('.tree input.inline-input')!;
		type(input, 'a.txt');
		key(input, 'Enter');
		expect(notifications()[0]).toContain('already exists');
		type(input, 'b.txt');
		key(input, 'Enter');
		await flush();
		expect(backend.callsTo('create_file')[0]).toEqual({ path: `${ROOT}\\b.txt` });
		expect(texts('.tree .row .label')).toEqual(['a.txt', 'b.txt']);
		expect(opened).toEqual([`${ROOT}\\b.txt`]);

		// Rename through the context menu.
		rightClick(document.querySelector('.tree .row'));
		expect(menuLabels()).toEqual(['Open to the Right', 'Open to the Left', 'Open Below', 'Open Above', 'New File...', 'New Folder...', 'Reveal in File Explorer', 'Copy Path', 'Copy Relative Path', 'Rename...', 'Delete']);
		click(menuItem('Copy Relative Path'));
		await flush();
		expect(backend.clipboard).toEqual(['a.txt']);
		rightClick(document.querySelector('.tree .row'));
		click(menuItem('Rename...'));
		await flush();
		const rename = document.querySelector<HTMLInputElement>('.tree input.inline-input')!;
		expect(rename.value).toBe('a.txt');
		type(rename, 'z.txt');
		key(rename, 'Enter');
		await flush();
		expect(renamed).toEqual([`${ROOT}\\a.txt>${ROOT}\\z.txt`]);
		expect(texts('.tree .row .label')).toEqual(['b.txt', 'z.txt']);

		// Delete asks first.
		rightClick(document.querySelectorAll('.tree .row')[1]);
		click(menuItem('Delete'));
		await flush();
		// VS Code's wording: the file goes to the Recycle Bin, where it can be restored.
		expect(notifications().at(-1)).toContain("delete 'z.txt'? You can restore this file from the Recycle Bin");
		click(notificationButton('Move to Recycle Bin'));
		await flush();
		expect(backend.callsTo('delete_path').at(-1)).toEqual({ path: `${ROOT}\\z.txt`, permanent: false });
		expect(deleted).toEqual([`${ROOT}\\z.txt`]);
		expect(texts('.tree .row .label')).toEqual(['b.txt']);

		rightClick(document.querySelector('.tree .row'));
		click(menuItem('Reveal in File Explorer'));
		await flush();
		expect(backend.revealed).toEqual([`${ROOT}\\b.txt`]);

		// Shift+Delete deletes permanently, with the irreversible warning.
		await explorer.reveal(`${ROOT}\\b.txt`);
		document.querySelector<HTMLElement>('.pane-body')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true }));
		await flush();
		expect(notifications().at(-1)).toContain("permanently delete 'b.txt'");
		click(notificationButton('Delete Permanently'));
		await flush();
		expect(backend.callsTo('delete_path').at(-1)).toEqual({ path: `${ROOT}\\b.txt`, permanent: true });
		expect(texts('.tree .row .label')).toEqual([]);
	});

	it('opens folders in the integrated terminal and settles inline inputs cancelled by a refresh', async () => {
		fileSystem({ [ROOT]: ['src/', 'README.md'], [`${ROOT}\\src`]: [] });
		const explorer = new Explorer(document.getElementById('sidebar')!);
		const terminals: string[] = [];
		explorer.onOpenInTerminal = (folder) => terminals.push(folder);
		explorer.setRoot(ROOT);
		await flush();

		rightClick(document.querySelector('.tree .row'));
		expect(menuLabels()).toContain('Open in Integrated Terminal');
		click(menuItem('Open in Integrated Terminal'));
		expect(terminals).toEqual([`${ROOT}\\src`]);
		// Files do not get the entry.
		rightClick(document.querySelectorAll('.tree .row')[1]);
		expect(menuLabels()).not.toContain('Open in Integrated Terminal');

		// A refresh while an inline input is open must settle it as cancelled, not hang.
		const creating = explorer.newFile();
		await flush();
		expect(document.querySelector('.tree input.inline-input')).not.toBeNull();
		await explorer.refresh();
		const settled = await Promise.race([creating.then(() => 'settled'), new Promise((resolve) => setTimeout(() => 'timeout', 500))]);
		expect(settled).toBe('settled');
		expect(backend.callsTo('create_file')).toHaveLength(0);
	});
});

describe('explorer renames and refreshes', () => {
	it('a case-only rename is a rename, not a collision with the entry itself', async () => {
		const tree: Record<string, string[]> = { [ROOT]: ['README.md', 'other.md'] };
		fileSystem(tree);
		backend.on('rename_path', ({ from, to }) => {
			tree[ROOT] = tree[ROOT]!.map((n) => (n === basename(String(from)) ? basename(String(to)) : n));
			return null;
		});
		const explorer = new Explorer(document.getElementById('sidebar')!);
		const renamed: string[] = [];
		explorer.onPathRenamed = (from, to) => renamed.push(`${from}>${to}`);
		explorer.setRoot(ROOT);
		await flush();

		rightClick(document.querySelector('.tree .row'));
		click(menuItem('Rename...'));
		await flush();
		const input = document.querySelector<HTMLInputElement>('.tree input.inline-input')!;
		// Another entry's name, whatever its case, still collides...
		type(input, 'OTHER.md');
		key(input, 'Enter');
		expect(notifications().at(-1)).toContain('already exists');
		// ...but the entry's own name respelled goes through.
		type(input, 'readme.md');
		key(input, 'Enter');
		await flush();
		expect(backend.callsTo('rename_path')).toEqual([{ from: `${ROOT}\\README.md`, to: `${ROOT}\\readme.md` }]);
		expect(renamed).toEqual([`${ROOT}\\README.md>${ROOT}\\readme.md`]);
		expect(texts('.tree .row .label')).toEqual(['readme.md', 'other.md']);
	});

	it('an expanded folder stays expanded across its rename, and a deleted one leaves the expanded set', async () => {
		const tree: Record<string, string[]> = { [ROOT]: ['src/', 'lib/'], [`${ROOT}\\src`]: ['deep/'], [`${ROOT}\\src\\deep`]: ['a.ts'], [`${ROOT}\\lib`]: ['b.ts'] };
		fileSystem(tree);
		backend.on('rename_path', () => {
			tree[ROOT] = ['lib/', 'source/'];
			tree[`${ROOT}\\source`] = tree[`${ROOT}\\src`]!;
			tree[`${ROOT}\\source\\deep`] = tree[`${ROOT}\\src\\deep`]!;
			return null;
		});
		backend.on('delete_path', () => {
			tree[ROOT] = ['source/'];
			return null;
		});
		const explorer = new Explorer(document.getElementById('sidebar')!);
		let expandedChanges = 0;
		explorer.onExpandedChange = () => expandedChanges++;
		explorer.setRoot(ROOT);
		await flush();
		// Expand src and src/deep, and lib.
		click(document.querySelector('.tree .row'));
		await flush();
		click(document.querySelectorAll('.tree .row')[1]);
		await flush();
		click(document.querySelectorAll('.tree .row')[3]);
		await flush();
		expect(texts('.tree .row .label')).toEqual(['src', 'deep', 'a.ts', 'lib', 'b.ts']);
		expect(explorer.expandedFolders().sort()).toEqual(['lib', 'src', 'src/deep']);

		// Rename src -> source: it and its child stay open under the new name; the old
		// spellings are gone from the set (they would be saved into the session forever).
		rightClick(document.querySelector('.tree .row'));
		click(menuItem('Rename...'));
		await flush();
		const input = document.querySelector<HTMLInputElement>('.tree input.inline-input')!;
		type(input, 'source');
		key(input, 'Enter');
		await flush();
		expect(explorer.expandedFolders().sort()).toEqual(['lib', 'source', 'source/deep']);
		expect(texts('.tree .row .label')).toEqual(['lib', 'b.ts', 'source', 'deep', 'a.ts']);
		expect(expandedChanges).toBeGreaterThan(3);

		// Delete lib: its expanded entry goes with it.
		rightClick(document.querySelector('.tree .row'));
		click(menuItem('Delete'));
		await flush();
		click(notificationButton('Move to Recycle Bin'));
		await flush();
		expect(explorer.expandedFolders().sort()).toEqual(['source', 'source/deep']);
		expect(texts('.tree .row .label')).toEqual(['source', 'deep', 'a.ts']);
	});

	it('refresh settles only once every expanded level has been re-listed', async () => {
		const tree: Record<string, string[]> = { [ROOT]: ['src/'], [`${ROOT}\\src`]: ['a.ts'] };
		fileSystem(tree);
		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot(ROOT);
		await flush();
		click(document.querySelector('.tree .row'));
		await flush();
		expect(texts('.tree .row .label')).toEqual(['src', 'a.ts']);

		// The top level is unchanged (the reconciliation's fast path); the nested one gained a
		// file, and its listing lands late - refresh() must still wait for it.
		tree[`${ROOT}\\src`] = ['a.ts', 'b.ts'];
		const listDir = backend.handlers.get('list_dir')!;
		backend.on('list_dir', (args) => {
			const entries = listDir(args);
			return String(args['path']).endsWith('src') ? new Promise((resolve) => setTimeout(() => resolve(entries), 20)) : entries;
		});
		await explorer.refresh();
		expect(texts('.tree .row .label')).toEqual(['src', 'a.ts', 'b.ts']);
	});
});
