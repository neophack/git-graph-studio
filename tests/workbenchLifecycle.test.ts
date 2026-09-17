// The full-boot lifecycle: switching folders (or to a single file) with dirty editors,
// closing the window, and tearing the workbench down - the flows where a session snapshot is
// lost or a global listener leaks, exercised against the scripted backend like
// uiHarness.test.ts does.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ExtensionHost } from '../src/extHost';
import * as state from '../src/state';
import { FS_CHANGED_EVENT, Workbench } from '../src/workbench';
import { backend, windowApi } from './tauriMock';
import { click, flush, key, notificationButton, texts } from './helpers';

const REPO_A = 'C:\\repo-a';
const REPO_B = 'C:\\repo-b';
const STANDALONE = 'C:\\docs\\notes.md';

/** Every command not scripted here answers `null` (a write that succeeded). */
class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

let workbench: Workbench;
/** The onCloseRequested handler of the live workbench, kept by the patched window mock so the
 *  window-close flow can be fired by hand (the stock mock discards it). */
let closeHandlers: ((event: { preventDefault(): void }) => Promise<void>)[];

const baseWindow = windowApi.getCurrentWindow;

beforeAll(async () => {
	// The editor widget lives in an async chunk; pay its one-time transform before the flows.
	await import('../src/textEditor');
});

beforeEach(async () => {
	localStorage.clear();
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
		['initial_repo', () => REPO_A],
		['open_folder', ({ path }) => ({ root: path, isRepo: true })],
		['open_workspace', () => ({ roots: [{ root: `${REPO_A}\\one`, isRepo: true }, { root: `${REPO_A}\\two`, isRepo: true }] })],
		['open_single_file', () => null],
		['close_folder', () => null],
		['boot_stage', () => null],
		['list_dir', () => []],
		['list_files', () => ['a.txt', 'b.txt']],
		['read_file', ({ path }) => ({ contents: `contents of ${String(path)}\n`, binary: false, size: 12 })],
		['read_file_at', () => ({ contents: 'one\n', binary: false, size: 3 })],
		['write_file', () => null],
		['file_fingerprint', () => '12:1'],
		['repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' })],
		['scm_status', () => []],
		['scm_branches', () => []],
		['scm_remotes', () => []],
		['scm_tags', () => []],
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

	closeHandlers = [];
	windowApi.getCurrentWindow = () => ({
		...baseWindow(),
		onCloseRequested: async (handler: (event: { preventDefault(): void }) => Promise<void>) => {
			closeHandlers.push(handler);
			return () => {
				const index = closeHandlers.indexOf(handler);
				if (index !== -1) closeHandlers.splice(index, 1);
			};
		}
	});

	workbench = new Workbench();
	await workbench.boot();
	await flush(10);
});

/** Open two tabs in the open folder and dirty the active one, as a user about to switch away. */
async function openAndDirty(files: string[]): Promise<void> {
	for (const file of files) await workbench.editors.openFile(file);
	await flush(8);
	workbench.editors.activeView!.dispatch({ changes: { from: 0, insert: 'dirty ' } });
	await flush(2);
	expect(workbench.editors.hasDirtyEditors()).toBe(true);
}

describe('the session snapshot across a folder switch', () => {
	it('switching folders with a dirty editor keeps the old folder\'s session', async () => {
		await openAndDirty([`${REPO_A}\\a.txt`, `${REPO_A}\\b.txt`]);

		const switching = workbench.openFolder(REPO_B);
		await flush(4);
		click(notificationButton("Don't Save"));
		await switching;
		await flush(8);

		expect(workbench.currentRepo).toBe(REPO_B);
		// Settling the dirty editor closed the tabs; the snapshot must predate that.
		expect(state.workspaceSnapshot(REPO_A)!.openFiles).toEqual([`${REPO_A}\\a.txt`, `${REPO_A}\\b.txt`]);
	});

	it('switching to a multi-root workspace with a dirty editor keeps the old folder\'s session', async () => {
		await openAndDirty([`${REPO_A}\\a.txt`]);

		const switching = workbench.openWorkspace('C:\\team.ggs-workspace');
		await flush(4);
		click(notificationButton("Don't Save"));
		await switching;
		await flush(8);

		expect(workbench.currentRepo).toBe(`${REPO_A}\\one`);
		expect(state.workspaceSnapshot(REPO_A)!.openFiles).toEqual([`${REPO_A}\\a.txt`]);
	});

	it('a one-folder workspace keeps the old folder\'s session too (no double settle)', async () => {
		backend.handlers.set('open_workspace', () => ({ roots: [{ root: REPO_B, isRepo: true }] }));
		await openAndDirty([`${REPO_A}\\a.txt`]);

		const switching = workbench.openWorkspace('C:\\one.ggs-workspace');
		await flush(4);
		click(notificationButton("Don't Save"));
		await switching;
		await flush(8);

		// The single root delegates to the plain-folder path - which must not snapshot the
		// already-emptied editor area over the session saved before the settle.
		expect(workbench.currentRepo).toBe(REPO_B);
		expect(state.workspaceSnapshot(REPO_A)!.openFiles).toEqual([`${REPO_A}\\a.txt`]);
	});

	it('Open File... (single-file mode) keeps the old folder\'s session', async () => {
		await openAndDirty([`${REPO_A}\\a.txt`]);

		const switching = workbench.openFileStandalone(STANDALONE);
		await flush(4);
		click(notificationButton("Don't Save"));
		await switching;
		await flush(8);

		expect(workbench.currentRepo).toBeNull();
		expect(state.workspaceSnapshot(REPO_A)!.openFiles).toEqual([`${REPO_A}\\a.txt`]);
	});

	it('closing the window saves the session before settling dirty editors', async () => {
		await openAndDirty([`${REPO_A}\\a.txt`]);
		// Anything persisted earlier is stale: the close handler's own save must rewrite it
		// (the window dies long before the debounced save would fire).
		state.saveWorkspaceSnapshot(REPO_A, { openFiles: [], activeFile: null, expanded: [] });

		expect(closeHandlers).toHaveLength(1);
		let prevented = false;
		const closing = closeHandlers[0]!({ preventDefault: () => { prevented = true; } });
		await flush(4);
		click(notificationButton("Don't Save"));
		await closing;
		await flush(2);

		expect(prevented).toBe(false); // "Don't Save" lets the close through
		expect(state.workspaceSnapshot(REPO_A)!.openFiles).toEqual([`${REPO_A}\\a.txt`]);
	});
});

describe('single-file mode', () => {
	it('Open File... clears the workspace folders the extension host sees', async () => {
		expect(ExtensionHost.workspaceFolders).toEqual([REPO_A]); // the boot's applyRoots
		await workbench.openFileStandalone(STANDALONE);
		await flush(8);
		expect(workbench.currentRepo).toBeNull();
		expect(ExtensionHost.workspaceFolders).toEqual([]);
	});
});

describe('the keyboard routing', () => {
	it('a keydown targeted at the document itself is not treated as editor focus', async () => {
		await workbench.editors.openFile(`${REPO_A}\\a.txt`);
		await flush(8);
		const ran: string[] = [];
		const inner = workbench.editors.runEditorCommand;
		workbench.editors.runEditorCommand = (command) => { ran.push(command); inner(command); };

		// Nothing focused: the event's target is the document, which has no closest() - and is
		// not an editor, so the workbench's own undo command answers the key.
		key(document, 'z', { ctrlKey: true });
		expect(ran).toEqual(['undo']);

		// A real input keeps its own Ctrl+Z, though.
		const input = document.createElement('input');
		document.body.appendChild(input);
		key(input, 'z', { ctrlKey: true });
		expect(ran).toEqual(['undo']);
	});
});

describe('dispose', () => {
	it('unwires every listener the workbench registered', async () => {
		await flush(2);
		const scmCallsBefore = backend.callsTo('scm_status').length;
		const fsListenersBefore = (backend.listeners.get(FS_CHANGED_EVENT) ?? []).length;
		expect(closeHandlers).toHaveLength(1);

		const reloaded: string[] = [];
		workbench.editors.reloadIfClean = async (path) => { reloaded.push(path); };
		let blurred = 0;
		workbench.editors.onWindowBlur = () => { blurred++; };

		workbench.dispose();

		// The backend event and the window-close handler are unlistened.
		expect((backend.listeners.get(FS_CHANGED_EVENT) ?? []).length).toBe(fsListenersBefore - 1);
		expect(closeHandlers).toHaveLength(0);
		backend.emit(FS_CHANGED_EVENT, { root: REPO_A, paths: ['a.txt'], truncated: false, gitChanged: false });
		expect(reloaded).toEqual([]);
		// The window focus/blur listeners are gone: no refresh, no editor blur.
		window.dispatchEvent(new Event('blur'));
		expect(blurred).toBe(0);
		window.dispatchEvent(new Event('focus'));
		await flush(5);
		expect(backend.callsTo('scm_status')).toHaveLength(scmCallsBefore);
	});
});

describe('a stale session restore', () => {
	it('leaves the new folder\'s editor layout and the restore flags alone', async () => {
		await workbench.editors.openFile(`${REPO_A}\\a.txt`);
		await flush(8);
		const groupsBefore = workbench.editors.groupCount;
		let gridApplied = 0;
		const applyGridLayout = workbench.editors.applyGridLayout.bind(workbench.editors);
		workbench.editors.applyGridLayout = (cell) => { gridApplied++; return applyGridLayout(cell); };

		// The restore scheduled by folder A fires when folder B is already open.
		const w = workbench as unknown as { restoreSnapshot(root: string, snapshot: state.WorkspaceSnapshot): Promise<void>; restoring: boolean };
		await w.restoreSnapshot(REPO_B, { openFiles: [`${REPO_B}\\b.txt`], activeFile: `${REPO_B}\\b.txt`, expanded: [] });

		expect(gridApplied).toBe(0);
		expect(workbench.editors.groupCount).toBe(groupsBefore);
		expect(workbench.editors.openFilePaths()).toEqual([`${REPO_A}\\a.txt`]);
		expect(w.restoring).toBe(false);
	});
});

describe('external changes the watcher could not list in full', () => {
	it('reloads every clean tab under the root, not just the active one', async () => {
		await workbench.editors.openFile(`${REPO_A}\\a.txt`);
		await workbench.editors.openFile(`${REPO_A}\\b.txt`);
		await flush(8);
		const reloaded: string[] = [];
		workbench.editors.reloadIfClean = async (path) => { reloaded.push(path); };

		// A truncated batch (a checkout touched more files than it lists): every open file of
		// that root re-reads itself - the inactive a.txt included - so switching to it later
		// never shows the pre-checkout contents.
		backend.emit(FS_CHANGED_EVENT, { root: REPO_A, paths: ['x.txt'], truncated: true, gitChanged: true });
		expect(reloaded.sort()).toEqual([`${REPO_A}\\a.txt`, `${REPO_A}\\b.txt`]);

		// A complete batch reloads exactly what it names.
		reloaded.length = 0;
		backend.emit(FS_CHANGED_EVENT, { root: REPO_A, paths: ['a.txt'], truncated: false, gitChanged: false });
		expect(reloaded).toEqual([`${REPO_A}\\a.txt`]);

		// A batch from another root (a folder that was just closed) is ignored altogether.
		reloaded.length = 0;
		backend.emit(FS_CHANGED_EVENT, { root: REPO_B, paths: ['a.txt'], truncated: true, gitChanged: false });
		expect(reloaded).toEqual([]);
	});
});

describe('chords', () => {
	it('spells the second key like a binding, with every modifier, and Escape cancels', async () => {
		const ran: string[] = [];
		const { commands } = await import('../src/commands');
		commands.register({ id: 'test.chordArrow', title: 'Chord Arrow', keybinding: 'Ctrl+K Alt+Left', run: () => { ran.push('arrow'); } });
		commands.register({ id: 'test.chordEnter', title: 'Chord Enter', keybinding: 'Ctrl+K Enter', run: () => { ran.push('enter'); } });
		commands.register({ id: 'test.chordTilde', title: 'Chord Tilde', keybinding: 'Ctrl+K Ctrl+Shift+`', run: () => { ran.push('tilde'); } });

		// "Ctrl+K Alt+Left": the arrow arrives as ArrowLeft, the Alt must count.
		key(document, 'k', { ctrlKey: true });
		key(document, 'ArrowLeft', { altKey: true });
		await flush();
		expect(ran).toEqual(['arrow']);

		// A named key keeps its spelling; a shifted glyph resolves to the unshifted key.
		key(document, 'k', { ctrlKey: true });
		key(document, 'Enter');
		key(document, 'k', { ctrlKey: true });
		key(document, '~', { ctrlKey: true, shiftKey: true });
		await flush();
		expect(ran).toEqual(['arrow', 'enter', 'tilde']);

		// Escape drops the pending chord: the next Enter is a plain Enter, not "Ctrl+K Enter".
		key(document, 'k', { ctrlKey: true });
		key(document, 'Escape');
		key(document, 'Enter');
		await flush();
		expect(ran).toEqual(['arrow', 'enter', 'tilde']);

		// The stock chord still works after all that.
		let shortcuts = 0;
		workbench.editors.openHelp = (help) => { if (help === 'shortcuts') shortcuts++; };
		key(document, 'k', { ctrlKey: true });
		key(document, 's', { ctrlKey: true });
		await flush();
		expect(shortcuts).toBe(1);
	});
});

describe('the About box', () => {
	it('reports the version package.json carries, not a stale literal', async () => {
		const { commands } = await import('../src/commands');
		const pkg = await import('../package.json');
		await commands.execute('help.about');
		const message = document.querySelector('#notifications .message')!.textContent!;
		expect(message).toContain(`Git Graph Studio ${pkg.version}`);
		expect(message).not.toContain('0.1.0 -');
	});
});

describe('the integrated terminal\'s cd', () => {
	it('quotes paths the way PowerShell and POSIX shells both read literally', async () => {
		const { quoteShellPath } = await import('../src/workbench');
		expect(quoteShellPath('C:\\repo\\src')).toBe('C:\\repo\\src');
		expect(quoteShellPath('/home/me/repo')).toBe('/home/me/repo');
		// A space needs quoting; single quotes stop PowerShell from expanding `$` and backticks.
		expect(quoteShellPath('C:\\My Projects\\$repo`x')).toBe("'C:\\My Projects\\$repo`x'");
		// A quote in the name: doubled for PowerShell, closed-escaped-reopened for POSIX.
		expect(quoteShellPath("C:\\it's here")).toBe("'C:\\it''s here'");
		expect(quoteShellPath("/home/it's here")).toBe("'/home/it'\\''s here'");
		// The Explorer's "Open in Integrated Terminal" types exactly that.
		const typed: string[] = [];
		workbench.panel.runInTerminal = async (command) => { typed.push(command); };
		workbench.explorer.onOpenInTerminal!('C:\\My Projects\\repo');
		expect(typed).toEqual(["cd 'C:\\My Projects\\repo'"]);
	});
});

describe('files dragged onto the window', () => {
	it('opens each dropped file like "Open File..." would', async () => {
		expect(backend.dropHandlers).toHaveLength(1);
		backend.dropHandlers[0]!({ payload: { type: 'over', position: { x: 10, y: 10 } } });
		backend.dropHandlers[0]!({ payload: { type: 'drop', paths: [`${REPO_A}\\a.txt`, 'C:\\outside\\readme.md'] } });
		await flush(8);
		expect(workbench.editors.openFilePaths()).toEqual([`${REPO_A}\\a.txt`, 'C:\\outside\\readme.md']);
	});

	it('ignores the hover and leave phases', async () => {
		backend.dropHandlers[0]!({ payload: { type: 'enter', paths: [`${REPO_A}\\a.txt`] } });
		backend.dropHandlers[0]!({ payload: { type: 'leave' } });
		await flush(4);
		expect(workbench.editors.openFilePaths()).toEqual([]);
	});
});

describe('Quick Open in a multi-root workspace', () => {
	it('lists every root\'s files, not just the first root the backend scorer knows', async () => {
		// The backend scorer only ever sees the first root's list (relative paths).
		backend.handlers.set('fuzzy_files', () => [{ path: 'one.txt', label: 'one.txt', ranges: [] }]);
		backend.handlers.set('list_files', ({ repo }) => (String(repo).endsWith('two') ? ['two.txt'] : ['one.txt']));
		await workbench.openWorkspace('C:\\team.ggs-workspace');
		await flush(8);
		expect(workbench.currentRepo).toBe(`${REPO_A}\\one`);

		void workbench.quickOpen('');
		await flush(8);
		const labels = texts('.quick-input .row .label');
		expect(labels).toContain('one.txt');
		expect(labels).toContain('two.txt');
		// The rows carry absolute paths, so the second root's file opens from its own root.
		const input = document.querySelector('.quick-input input') as HTMLInputElement;
		input.value = 'two';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await flush(8);
		click(Array.from(document.querySelectorAll('.quick-input .row')).find((row) => row.textContent!.includes('two.txt')));
		await flush(8);
		expect(workbench.editors.openFilePaths()).toEqual([`${REPO_A}\\two\\two.txt`]);
		expect(backend.callsTo('fuzzy_files')).toEqual([]);
	});
});

describe('command-line launch actions', () => {
	/** The `read_file_raw` framing: 8-byte little-endian metadata length, the JSON metadata,
	 *  then the UTF-8 text (the raw channel's contract, editor.ts readFileRaw). */
	const framed = (text: string): Uint8Array => {
		const encode = new TextEncoder();
		const meta = encode.encode(JSON.stringify({ binary: false, size: text.length, encoding: 'utf8', eol: 'lf' }));
		const bytes = new Uint8Array(8 + meta.length + encode.encode(text).length);
		new DataView(bytes.buffer).setBigUint64(0, BigInt(meta.length), true);
		bytes.set(meta, 8);
		bytes.set(encode.encode(text), 8 + meta.length);
		return bytes;
	};

	/** Re-boot the workbench as a `ggs <subcommand> ...` launch would: the actions the backend
	 *  parsed answer `initial_actions`, and the backend commands the comparison views read are
	 *  scripted (the raw text channel, the hex slabs, the folder comparison). */
	const bootWithActions = async (action: Record<string, unknown>): Promise<void> => {
		workbench.dispose();
		backend.handlers.set('initial_actions', () => [action]);
		backend.handlers.set('read_file_raw', () => framed('the left text\n'));
		backend.handlers.set('read_file_chunk', () => ({ size: 2, base64: 'aGk=' }));
		backend.handlers.set('compare_dirs', () => []);
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
	};

	it('compare opens the two-file diff as the window\'s first tab, over no folder', async () => {
		await bootWithActions({ type: 'compareFiles', left: 'C:\l.txt', right: 'C:\r.txt' });
		expect(workbench.editors.activeInput).toMatchObject({ kind: 'diff', id: 'paths:C:\l.txt::C:\r.txt' });
		// The launch opened its comparison instead of a folder: the repo view never booted.
		expect(document.querySelector('.graph-host iframe')).toBeNull();
	});

	it('hex-compare opens the hex comparison tab', async () => {
		await bootWithActions({ type: 'hexCompare', left: 'C:\l.bin', right: 'C:\r.bin' });
		expect(workbench.editors.activeInput).toMatchObject({ kind: 'diff', id: 'paths:C:\l.bin::C:\r.bin' });
		expect(document.querySelector('.hex-view.hex-compare')).not.toBeNull();
	});

	it('hex opens the hex viewer tab', async () => {
		await bootWithActions({ type: 'hexView', path: 'C:\data.bin' });
		expect(workbench.editors.activeInput).toMatchObject({ kind: 'hex', path: 'C:\data.bin' });
	});

	it('folder-compare opens the Folder Compare tab', async () => {
		await bootWithActions({ type: 'folderCompare', left: 'C:\left', right: 'C:\right' });
		expect(workbench.editors.activeInput).toMatchObject({ kind: 'folders', id: 'C:\left::C:\right' });
	});

	it('a launch without actions boots the folder as before', async () => {
		workbench.dispose();
		backend.handlers.set('initial_actions', () => []);
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
		expect(workbench.editors.activeInput).toMatchObject({ kind: 'graph' });
	});
});
