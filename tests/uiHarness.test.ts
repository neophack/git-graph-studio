// The UI harness: the real Workbench (the real editor area, settings dialog, status bar,
// find widget, keybindings editor, notification centre) booted against a scripted backend,
// driven through DOM events the way a user drives the app - clicks, keystrokes, typing. One
// flow per interaction surface, asserting what becomes visible, not internal state.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Workbench } from '../src/workbench';
import { commands } from '../src/commands';
import { effectiveKeybinding } from '../src/keybindings';
import { settings } from '../src/settings';
import { backend } from './tauriMock';
import { click, flush, key, notificationButton, notifications, texts, type } from './helpers';

const REPO = 'C:\\repo';
const NOTES = `${REPO}\\notes.txt`;

/** Every command not scripted here answers `null` (a write that succeeded). */
class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

let workbench: Workbench;

// The editor widget lives in an async chunk; pay its one-time transform before the flows, so
// a file open inside a test is ticks, not wall-clock.
beforeAll(async () => {
	await import('../src/textEditor');
});

beforeEach(async () => {
	localStorage.clear();
	document.body.innerHTML = '';
	// The shell's DOM skeleton (index.html in the app, setup.ts in the tests).
	document.body.innerHTML = `
		<div id="titlebar"></div>
		<div id="workbench">
			<div id="activitybar"></div>
			<div id="sidebar"></div>
			<div id="sidebarSash"></div>
			<div id="editorPart"><div id="editorGroup"></div><div id="panelSash" hidden></div><div id="panel" hidden></div></div>
		</div>
		<div id="statusbar"></div>
		<div id="notifications"></div>
		<div id="overlays"></div>`;
	workbench?.dispose();
	backend.reset();
	backend.handlers = new DefaultingHandlers([
		['initial_repo', () => REPO],
		['open_folder', ({ path }) => ({ root: path, isRepo: true })],
		['boot_stage', () => null],
		['list_dir', () => [{ name: 'notes.txt', path: NOTES, isDir: false, size: 12 }]],
		['list_files', () => ['notes.txt']],
		['read_file', () => ({ contents: 'one two one\n', binary: false, size: 12 })],
		['write_file', () => null],
		['read_file_at', () => ({ contents: 'one\n', binary: false, size: 3 })],
		['repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' })],
		['scm_status', () => [{ path: 'notes.txt', oldPath: null, staged: null, unstaged: 'M', untracked: false, conflicted: false }]],
		['scm_branches', () => [{ name: 'main', current: true, remote: false, upstream: 'origin/main' }]],
		['scm_remotes', () => [{ name: 'origin', url: 'https://example.org/repo.git' }]],
		['scm_tags', () => []],
		['search_workspace', ({ onEvent }) => {
			(onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', scanned: 0, truncated: false, cancelled: false });
			return null;
		}],
		['viewer_open', () => ({ docId: 1, lineCount: 1, language: 'plaintext', syntaxName: 'Plain Text', symbols: [] })],
		['viewer_close', () => null],
		['ext_list', () => []],
		['keybindings_read', () => null],
		['keybindings_write', () => null],
		['settings_read', () => null],
		['settings_write', () => null],
		['backup_list', () => []],
		['git_output_log', () => []],
		['graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null, commits: [] })]
	] as [string, (args: Record<string, unknown>) => unknown][]);

	workbench = new Workbench();
	await workbench.boot();
	await flush(10);
});

describe('the UI harness flows', () => {
	it('opens a file from the Explorer, edits, saves with Ctrl+S, and closes with the middle click', async () => {
		click(document.querySelector('.tree .row')!); // the Explorer's notes.txt row
		await flush(12);
		expect(texts('.tab .label')).toContain('notes.txt');
		const notesTab = () => Array.from(document.querySelectorAll('.tab')).find((t) => t.textContent!.includes('notes.txt'))!;
		const view = workbench.editors.activeView!;
		view.dispatch({ changes: { from: 0, insert: 'typed ' } });
		await flush();
		expect(notesTab().classList.contains('dirty')).toBe(true);
		key(document, 's', { ctrlKey: true });
		await flush();
		expect(backend.callsTo('write_file')).toHaveLength(1);
		expect(notesTab().classList.contains('dirty')).toBe(false);
		notesTab().dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
		await flush();
		expect(texts('.tab .label')).toEqual(['Git Graph']);
	});

	it('opens a file to the side, and the emptied layer collapses when its last tab closes', async () => {
		workbench.editors.openInDirection(NOTES, 'right');
		await flush();
		expect(document.querySelectorAll('.editor-group-box')).toHaveLength(2);
		expect(workbench.editors.groupSessions()).toEqual([{ files: [NOTES], active: NOTES }]);
		// Close the only tab of the side group: the layer disappears again.
		const tab = document.querySelectorAll('.editor-group-box')[1]!.querySelector('.tab')!;
		tab.querySelector<HTMLElement>('.close')!.click();
		await flush();
		expect(document.querySelectorAll('.editor-group-box')).toHaveLength(1);
		// Ctrl+1 focuses the remaining group.
		await commands.execute('workbench.focusFirstEditorGroup');
		expect(workbench.editors.focusedIndex).toBe(0);
	});

	it('finds in the file: the widget counts, and Escape closes', async () => {
		click(document.querySelector('.tree .row')!);
		await flush();
		await commands.execute('editor.find');
		const widget = document.querySelector('.cm-find-widget') as HTMLElement;
		expect(widget).not.toBeNull();
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		type(input, 'one');
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await flush();
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 2');
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await flush();
		expect(document.querySelector('.cm-find-widget')).toBeNull();
	});

	it('searches the settings dialog, flips a setting, and the editor follows live', async () => {
		await commands.execute('workbench.openSettings');
		const search = document.querySelector('.settings-search') as HTMLInputElement;
		type(search, 'word wrap');
		expect(texts('.settings-row-label')).toEqual(['Word Wrap']);
		const box = document.querySelector('.settings-row .settings-checkbox') as HTMLInputElement;
		click(box);
		await flush();
		expect(settings.wordWrap).toBe(true);
		expect(backend.callsTo('settings_write')).toHaveLength(1);
		// An editor opened afterwards starts wrapped.
		click(document.querySelector('.settings-close')!);
		click(document.querySelector('.tree .row')!);
		await flush();
		expect(workbench.editors.activeView!.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
	});

	it('notifications land in the centre, the bell counts them, and Clear All empties it', async () => {
		await commands.execute('help.about'); // an info toast
		await flush();
		expect(notifications()).toHaveLength(1);
		const bell = document.querySelector('.status-right .status-item:last-child') as HTMLElement;
		expect(bell.querySelector('.bell-badge')!.textContent).toBe('1');
		// The toast's own close button parks it in the centre (it stays listed).
		click(document.querySelector('#notifications .notification [title="Clear Notification"]')!);
		await flush();
		expect(notifications()).toHaveLength(0);
		click(bell);
		expect(texts('.notification-centre-row .message').length).toBe(1);
		click(document.querySelector('.notification-centre-header .button')!);
		expect(texts('.notification-centre-empty')).toEqual(['No notifications']);
		click(bell); // close the panel: an empty centre hides the bell
		expect(bell.hidden).toBe(true);
	});

	it('the status bar pickers open: EOL offers the sequences', async () => {
		click(document.querySelector('.tree .row')!);
		await flush();
		const items = texts('.status-right .status-item:not([hidden])');
		expect(items).toContain('Ln 1, Col 1');
		const eol = Array.from(document.querySelectorAll<HTMLElement>('.status-right .status-item')).find((item) => item.textContent === 'LF')!;
		click(eol);
		await flush();
		const options = texts('.quick-input .row .label');
		expect(options).toEqual(['LF', 'CRLF']);
		// Choosing LF finishes the pick and closes it.
		click(Array.from(document.querySelectorAll('.quick-input .row')).find((row) => (row.textContent ?? '').startsWith('LF'))!);
		await flush();
		expect(document.querySelector('.quick-input')).toBeNull();
	});

	it('the keybindings editor records a binding that the workbench answers to', async () => {
		await commands.execute('help.shortcuts');
		await flush();
		const rows = Array.from(document.querySelectorAll('.kb-row'));
		expect(rows.length).toBeGreaterThan(10);
		// Find the Save row, click its key cell, press F9.
		const saveRow = rows.find((row) => row.textContent!.includes('workbench.save'))!;
		const cell = saveRow.querySelector('kbd')!;
		click(cell);
		expect(cell.classList.contains('recording')).toBe(true);
		const pane = document.querySelector('.editor-pane .welcome') ?? document.querySelector('.editor-pane')!;
		pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true, cancelable: true }));
		await flush();
		expect(effectiveKeybinding('workbench.save')).toBe('F9');
		const writes = backend.callsTo('keybindings_write');
		expect(writes[writes.length - 1]!.contents).toContain('"key": "F9"');
		// A dirty editor now saves through the new binding.
		click(document.querySelector('.settings-close') ?? document.body); // nothing open
		await commands.execute('workbench.closeEditor').catch(() => undefined);
		click(document.querySelector('.tree .row')!);
		await flush();
		const view = workbench.editors.activeView!;
		view.dispatch({ changes: { from: 0, insert: 'x' } });
		key(document, 'F9');
		await flush();
		console.log('DBG writes', JSON.stringify(backend.callsTo('write_file').map((c) => c.path)));
		expect(backend.callsTo('write_file')).toHaveLength(1);
	});

	it('quick open lists the backend files and opens the chosen one', async () => {
		void workbench.quickOpen('');
		await flush();
		const input = document.querySelector('.quick-input input') as HTMLInputElement;
		expect(input).not.toBeNull();
		// fuzzy_files is not scripted here, so the TS fallback runs over list_files.
		await flush();
		const labels = texts('.quick-input .row .label');
		expect(labels).toContain('notes.txt');
		input.value = 'notes';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await flush(8);
		const item = Array.from(document.querySelectorAll('.quick-input .row')).find((row) => row.textContent!.includes('notes.txt'))!;
		click(item);
		await flush();
		expect(texts('.tab .label')).toContain('notes.txt');
	});

	it('Ctrl+G / a ":" prefix is VS Code\'s Go to Line, narrated by the picker row', async () => {
		click(document.querySelector('.tree .row')!);
		await flush();
		const view = workbench.editors.activeView!;
		const lines = view.state.doc.lines;
		key(document, 'g', { ctrlKey: true });
		await flush();
		const input = document.querySelector('.quick-input input') as HTMLInputElement;
		expect(input.value).toBe(':');
		expect(texts('.quick-input .row .label')[0]).toBe(`Current Line: 1, Character: 1. Type a line number between 1 and ${lines} to navigate to.`);
		input.value = `:${lines}:2`;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await flush(4);
		expect(texts('.quick-input .row .label')[0]).toBe(`Go to line ${lines} and character 2.`);
		key(input, 'Enter');
		await flush();
		expect(document.querySelector('.quick-input')).toBeNull();
		expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(lines);
	});
});
