// Auto-save and hot exit: an edit is backed up a moment later, auto-save "after delay" writes
// the file (and drops the backup), a save or a discarded close drops the backup, and the
// backups a previous session left behind come back into their editors on boot.

import { beforeEach, describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import { settings, updateSetting } from '../src/settings';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { flush, notifications } from './helpers';

const REPO = 'C:\\repo';
const FILE = `${REPO}\\notes.txt`;

function fileBackend(files: Record<string, string>): void {
	backend.on('read_file', ({ path }) => {
		const contents = files[path as string];
		if (contents === undefined) throw `${path}: not found`;
		return { contents, binary: false, size: contents.length };
	});
	backend.on('write_file', ({ path, contents }) => { files[path as string] = contents as string; return null; });
	backend.on('file_fingerprint', () => '1:1');
	backend.on('backup_write', () => null);
	backend.on('backup_clear', () => null);
}

function editText(group: EditorGroup, text: string): void {
	const view = group.activeView!;
	view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

describe('auto-save and backups', () => {
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	beforeEach(() => {
		updateSetting('autoSave', 'off');
		updateSetting('autoSaveDelay', 150); // the floor the editor enforces is 100 ms
	});

	it('backs an edit up after a moment and drops the backup on save', async () => {
		const files = { [FILE]: 'hello\n' };
		fileBackend(files);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(FILE);
		editText(group, 'more');
		expect(group.hasDirtyEditors()).toBe(true);
		expect(backend.callsTo('backup_write')).toEqual([]);
		await wait(650);
		expect(backend.callsTo('backup_write')).toEqual([{ path: FILE, contents: 'hello\nmore' }]);

		// Auto-save is off: nothing was written to the file.
		await wait(300);
		expect(backend.callsTo('write_file')).toEqual([]);

		await group.save();
		expect(files[FILE]).toBe('hello\nmore');
		expect(backend.callsTo('backup_clear')).toEqual([{ path: FILE }]);
		expect(group.hasDirtyEditors()).toBe(false);
	});

	it('saves after the configured delay when auto-save is on', async () => {
		const files = { [FILE]: 'hello\n' };
		fileBackend(files);
		updateSetting('autoSave', 'afterDelay');
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(FILE);
		editText(group, '1');
		await wait(100);
		editText(group, '2'); // typing again restarts the delay
		await wait(100);
		expect(backend.callsTo('write_file')).toEqual([]);
		await wait(settings.autoSaveDelay + 100);
		expect(backend.callsTo('write_file')).toEqual([{ path: FILE, contents: 'hello\n12', encoding: 'utf8', eol: 'lf' }]);
		expect(group.hasDirtyEditors()).toBe(false);
		expect(backend.callsTo('backup_clear').length).toBeGreaterThanOrEqual(1);
	});

	it('saves every dirty file when the window loses focus with that mode on', async () => {
		const files = { [FILE]: 'a\n', [`${REPO}\\other.txt`]: 'b\n' };
		fileBackend(files);
		updateSetting('autoSave', 'onWindowChange');
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(FILE);
		editText(group, 'x');
		await group.openFile(`${REPO}\\other.txt`);
		editText(group, 'y');
		group.onWindowBlur();
		await flush();
		expect(files[FILE]).toBe('a\nx');
		expect(files[`${REPO}\\other.txt`]).toBe('b\ny');
		expect(group.hasDirtyEditors()).toBe(false);
	});

	it('"on focus change" saves an editor as soon as its text loses focus, as VS Code does', async () => {
		const files = { [FILE]: 'a\n' };
		fileBackend(files);
		updateSetting('autoSave', 'onFocusChange');
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(FILE);
		const view = group.activeView!;
		view.focus();
		editText(group, 'x');
		expect(group.hasDirtyEditors()).toBe(true);
		// Focus moving elsewhere (the sidebar, another tab, the terminal) is the trigger -
		// no window blur needed.
		view.contentDOM.dispatchEvent(new FocusEvent('blur'));
		await flush();
		expect(files[FILE]).toBe('a\nx');
		expect(group.hasDirtyEditors()).toBe(false);
		// The window's blur still saves in this mode too.
		editText(group, 'y');
		group.onWindowBlur();
		await flush();
		expect(files[FILE]).toBe('a\nxy');
	});

	it('recovers the previous session\'s backups into dirty editors on boot', async () => {
		const files = { [FILE]: 'hello\n' };
		fileBackend(files);
		backend.on('initial_repo', () => REPO);
		backend.on('open_folder', ({ path }) => ({ root: path, isRepo: true }));
		backend.on('ext_list', () => []);
		backend.on('ext_read_file', () => { throw 'missing'; });
		backend.on('scm_status', () => []);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
		backend.on('list_files', () => ['notes.txt']);
		backend.on('list_dir', () => [{ name: 'notes.txt', path: FILE, isDir: false, size: 6 }]);
		backend.on('boot_stage', () => null);
		backend.on('backup_list', () => [{ path: FILE, savedAt: 1 }, { path: 'D:\\elsewhere\\x.txt', savedAt: 1 }]);
		backend.on('backup_read', ({ path }) => (path === FILE ? 'hello\nunsaved draft' : 'other'));

		const workbench = new Workbench();
		await workbench.boot();
		await flush(20);
		expect(workbench.editors.openFilePaths()).toEqual([FILE]);
		expect(workbench.editors.hasDirtyEditors()).toBe(true);
		expect(workbench.editors.activeView!.state.doc.toString()).toBe('hello\nunsaved draft');
		// Only the open folder's backups are recovered; the other one stays on disk.
		expect(backend.callsTo('backup_read')).toEqual([{ path: FILE }]);
		expect(notifications().join()).toContain('Recovered 1 unsaved file');
	});
});
