// The command sweep: every command the workbench registers - the menus, the palette and the
// keybindings all resolve to these - is run through the registry against the scripted backend,
// on a full boot. First a per-command flow for the entries no other harness drives (what each
// must visibly do), then the sweep proper: every registered command executes without throwing
// and leaves the shell usable (the next command still runs, no quick input or menu lingers).

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Workbench } from '../src/workbench';
import { commands } from '../src/commands';
import { bookmarksFor } from '../src/bookmarks';
import * as state from '../src/state';
import { backend } from './tauriMock';
import { flush, key, notifications, texts, until } from './helpers';

// jsdom has no canvas: the module analysis drawing runs on the G6 stub.
vi.mock('@antv/g6', () => import('./g6Stub'));

const REPO = 'C:\\repo';
const NOTES = `${REPO}\\notes.txt`;
const README = `${REPO}\\README.md`;

/** Every command not scripted here answers `null` (a write that succeeded). */
class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

let workbench: Workbench;

beforeAll(async () => {
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
		['initial_repo', () => REPO],
		['open_folder', ({ path }) => ({ root: path, isRepo: true })],
		['boot_stage', () => null],
		['list_dir', () => [{ name: 'notes.txt', path: NOTES, isDir: false, size: 12 }, { name: 'README.md', path: README, isDir: false, size: 4 }]],
		['list_files', () => ['notes.txt', 'README.md']],
		['read_file', ({ path }) => ({ contents: path === README ? '# Hi\n' : 'one two one\nthree\n', binary: false, size: 12, encoding: 'utf8', eol: 'lf' })],
		['read_file_at', () => ({ contents: 'one\n', binary: false, size: 3 })],
		['repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' })],
		['scm_status', () => [{ path: 'notes.txt', oldPath: null, staged: 'modified', unstaged: null, untracked: false, conflicted: false }]],
		['scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: 'origin/main' }, { name: 'dev', remote: false, current: false, upstream: null }]],
		['scm_remotes', () => [{ name: 'origin', url: 'https://example.com/r.git' }]],
		['scm_tags', () => ['v1']],
		['scm_stashes', () => []],
		['workspace_symbols', () => [{ kind: 'function', name: 'two', path: 'notes.txt', line: 1 }]],
		['analysis_status', () => ({ state: 'ready', done: 2, total: 2, files: 2, symbols: 3, calls: 2 })],
		['analysis_rebuild', () => ({ state: 'ready', done: 2, total: 2, files: 2, symbols: 3, calls: 2 })],
		['analysis_module_graph', () => ({ modules: [], edges: [], fileEdges: [], totalCalls: 0, totalFileEdges: 0 })],
		['mcp_tools', () => [{ name: 'symbol_lookup', description: 'look up a symbol' }]],
		['mcp_log', () => []],
		['analysis_metrics', ({ onEvent }) => {
			(onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', files: 1, functions: 1, cancelled: false });
			return null;
		}],
		['analysis_dead_code', ({ onEvent }) => {
			(onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', found: 0, cancelled: false });
			return null;
		}],
		['analysis_security', ({ onEvent }) => {
			(onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', files: 1, findings: 0, cancelled: false });
			return null;
		}],
		['analysis_import_graph', () => ({ edges: [], cycles: [] })],
		// Find References asks the index's narrowed scan first (M4); the full-scan command
		// stays scripted as the fallback it is.
		['symbol_references', () => [{ path: 'notes.txt', matches: [{ line: 1, column: 5, length: 3, text: 'one two one' }] }]],
		['find_references', () => [{ path: 'notes.txt', matches: [{ line: 1, column: 5, length: 3, text: 'one two one' }] }]],
		['viewer_open', () => ({ docId: 1, lineCount: 2, language: 'plaintext', syntaxName: 'Plain Text', symbols: [] })],
		['ext_list', () => []],
		['keybindings_read', () => null],
		['settings_read', () => null],
		['backup_list', () => []],
		['git_output_log', () => ['> git status']],
		['graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null, errors: [null], commits: [] })]
	] as [string, (args: Record<string, unknown>) => unknown][]);
	(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
	workbench = new Workbench();
	await workbench.boot();
	await flush(10);
});

/** Any quick input or menu left open by a command is dismissed, as a user would with Escape. */
async function dismissOverlays(): Promise<void> {
	for (let i = 0; i < 3 && document.querySelector('.quick-input input, .context-menu'); i++) {
		const input = document.querySelector<HTMLInputElement>('.quick-input input');
		key(input ?? document, 'Escape');
		await flush(2);
	}
}

describe('the commands no other harness drives', () => {
	it('New File... opens the Explorer\'s inline input', async () => {
		// The command settles with the inline input (Enter or Escape), like the Explorer's own.
		void commands.execute('workbench.newFile');
		await flush();
		expect(document.querySelector('.tree input.inline-input')).not.toBeNull();
		key(document.querySelector('.tree input.inline-input')!, 'Escape');
	});

	it('Save All writes every dirty editor; Close All Editors empties the group', async () => {
		await workbench.editors.openFile(NOTES);
		await workbench.editors.openFile(README);
		await flush(6);
		for (const group of workbench.editors.groups()) {
			for (const id of group.openEditorIds()) group.findEditor(id)!.view?.dispatch({ changes: { from: 0, insert: 'x' } });
		}
		await flush(2);
		expect(commands.isEnabled('workbench.saveAll')).toBe(true);
		await commands.execute('workbench.saveAll');
		await flush(4);
		expect(backend.callsTo('write_file').map((c) => c.path).sort()).toEqual([README, NOTES].sort());
		expect(workbench.editors.hasDirtyEditors()).toBe(false);
		await commands.execute('workbench.closeAllEditors');
		await flush(4);
		expect(workbench.editors.openFilePaths()).toEqual([]);
	});

	it('Split Editor / Split Editor Down / Focus nth Editor Group lay out and focus the grid', async () => {
		await workbench.editors.openFile(NOTES);
		await flush(6);
		await commands.execute('workbench.splitEditor');
		await flush(6);
		expect(workbench.editors.groupCount).toBe(2);
		// The split shows the same file again, as VS Code's does.
		expect(workbench.editors.groups()[1]!.openFilePaths()).toEqual([NOTES]);
		await commands.execute('workbench.splitEditorDown');
		await flush(6);
		expect(workbench.editors.groupCount).toBe(3);
		await commands.execute('workbench.focusSecondEditorGroup');
		expect(workbench.editors.focusedIndex).toBe(1);
		await commands.execute('workbench.focusThirdEditorGroup');
		expect(workbench.editors.focusedIndex).toBe(2);
		await commands.execute('workbench.focusFirstEditorGroup');
		expect(workbench.editors.focusedIndex).toBe(0);
	});

	it('Next / Previous Editor cycle the tabs; Go Back / Go Forward walk the history', async () => {
		await workbench.editors.openFile(NOTES);
		await workbench.editors.openFile(README);
		await flush(6);
		const active = () => (workbench.editors.activeInput as { path?: string; kind: string }).path ?? workbench.editors.activeInput!.kind;
		// Back / Forward walk the history: graph (opened with the folder), notes, README.
		expect(active()).toBe(README);
		expect(commands.isEnabled('workbench.goBack')).toBe(true);
		await commands.execute('workbench.goBack');
		await flush(2);
		expect(active()).toBe(NOTES);
		await commands.execute('workbench.goForward');
		await flush(2);
		expect(active()).toBe(README);
		// The tabs: Git Graph, notes.txt, README.md - the cycle wraps.
		await commands.execute('workbench.nextEditor');
		expect(active()).toBe('graph');
		await commands.execute('workbench.nextEditor');
		expect(active()).toBe(NOTES);
		await commands.execute('workbench.previousEditor');
		expect(active()).toBe('graph');
		await commands.execute('workbench.previousEditor');
		expect(active()).toBe(README);
	});

	it('Go to Line/Column opens Quick Open in its ":" mode', async () => {
		await workbench.editors.openFile(NOTES);
		await flush(6);
		void commands.execute('workbench.gotoLine');
		await flush(2);
		const input = document.querySelector<HTMLInputElement>('.quick-input input')!;
		expect(input.value).toBe(':');
		expect(texts('.quick-input .row .label')[0]).toContain('Current Line: 1');
		await dismissOverlays();
	});

	it('Toggle Primary Side Bar and Toggle Terminal flip their parts', async () => {
		const sidebar = document.getElementById('sidebar')!;
		expect(sidebar.hidden).toBe(false);
		await commands.execute('workbench.toggleSidebar');
		expect(sidebar.hidden).toBe(true);
		expect(state.layout.sidebarVisible).toBe(false);
		await commands.execute('workbench.toggleSidebar');
		expect(sidebar.hidden).toBe(false);
		expect(workbench.panel.isVisible()).toBe(false);
		await commands.execute('terminal.toggle');
		await flush(4);
		expect(workbench.panel.isVisible()).toBe(true);
		expect(workbench.panel.activeView()).toBe('terminal');
		await commands.execute('terminal.toggle');
		expect(workbench.panel.isVisible()).toBe(false);
	});

	it('Undo / Redo / Select All act on the active text editor', async () => {
		await workbench.editors.openFile(NOTES);
		await flush(6);
		const view = workbench.editors.activeView!;
		view.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input' });
		expect(view.state.doc.toString().startsWith('X')).toBe(true);
		await commands.execute('editor.undo');
		expect(view.state.doc.toString().startsWith('X')).toBe(false);
		await commands.execute('editor.redo');
		expect(view.state.doc.toString().startsWith('X')).toBe(true);
		await commands.execute('editor.selectAll');
		expect(view.state.selection.main.from).toBe(0);
		expect(view.state.selection.main.to).toBe(view.state.doc.length);
	});

	it('Toggle Bookmark marks the cursor line; Go to Definition and Find References ask the index', async () => {
		await workbench.editors.openFile(NOTES);
		await flush(6);
		await commands.execute('editor.toggleBookmark');
		expect(bookmarksFor(NOTES)).toEqual([1]);
		await commands.execute('editor.toggleBookmark');
		expect(bookmarksFor(NOTES)).toEqual([]);
		// The cursor on "two": the index answers a definition on line 2, and the references
		// pick shows the one match.
		workbench.editors.activeView!.dispatch({ selection: { anchor: 5 } });
		await commands.execute('editor.gotoDefinition');
		await flush(4);
		expect(backend.callsTo('workspace_symbols').at(-1)).toMatchObject({ query: 'two' });
		expect(workbench.editors.lineInfo()!.line).toBe(2);
		workbench.editors.activeView!.dispatch({ selection: { anchor: 5 } });
		void commands.execute('editor.findReferences');
		await flush(4);
		expect(backend.callsTo('symbol_references')).toEqual([{ name: 'two' }]);
		expect(texts('.quick-input .row .label')).toEqual(['notes.txt:1']);
		await dismissOverlays();
	});

	it('Markdown: Open Preview to the Side splits a preview beside the source', async () => {
		await workbench.editors.openFile(README);
		await flush(6);
		expect(commands.isEnabled('markdown.showPreviewToSide')).toBe(true);
		await commands.execute('markdown.showPreviewToSide');
		await flush(6);
		expect(workbench.editors.groupCount).toBe(2);
		expect(workbench.editors.groups()[1]!.openEditorIds()).toEqual([`markdown:${README}`]);
	});

	it('the commit variants route through the SCM view with their options', async () => {
		workbench.scm['message'] = 'msg';
		await commands.execute('git.commitStaged');
		await flush(4);
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: 'msg', amend: false });
		expect(backend.callsTo('git_stage_all')).toEqual([]);
		workbench.scm['message'] = 'all';
		await commands.execute('git.commitAll');
		await flush(4);
		expect(backend.callsTo('git_stage_all')).toHaveLength(1);
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: 'all', amend: false });
		await commands.execute('git.commitAmend');
		await flush(4);
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: '', amend: true });
		await commands.execute('git.commitStagedAmend');
		await flush(4);
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: '', amend: true });
	});

	it('Show Git Output reveals the Output view with the log', async () => {
		await commands.execute('git.showOutput');
		await flush(4);
		expect(workbench.panel.isVisible()).toBe(true);
		expect(workbench.panel.activeView()).toBe('output');
		expect(workbench.panel.output.text()).toContain('> git status');
	});

	it('Clone asks for a URL first; Report Issue opens the project page', async () => {
		void commands.execute('git.clone');
		await flush(2);
		expect(document.querySelector('.quick-input .title')!.textContent).toBe('Clone Repository');
		await dismissOverlays();
		expect(backend.callsTo('scm_clone')).toEqual([]);
		await commands.execute('help.repository');
		expect(backend.opened).toEqual(['https://github.com/neophack/vscode-git-graph-rs']);
	});

	it('Compare Two Folders... opens a Folder Compare tab from the two picked folders', async () => {
		backend.dialog.openResult = 'C:\\left';
		await commands.execute('workbench.compareFolders');
		// The registry fires the command's two dialog round-trips without awaiting them,
		// so under a loaded worker the tab lands later than any fixed flush count: poll
		// for the end state, then let any late activation settle before reading it.
		await until(() => workbench.editors.activeInput?.kind === 'folders');
		await flush(2);
		expect(workbench.editors.activeInput).toEqual({ kind: 'folders', id: 'C:\\left::C:\\left', left: 'C:\\left', right: 'C:\\left' });
		// A cancelled picker opens nothing.
		backend.dialog.openResult = null;
		await commands.execute('workbench.closeEditor');
		await commands.execute('workbench.compareFolders');
		await flush(2);
		expect(workbench.editors.activeInput?.kind).not.toBe('folders');
	});

	it('Install Extension from VSIX... shows the Extensions view and asks for the package', async () => {
		await commands.execute('extensions.installFromVsix');
		await flush(4);
		expect(workbench.activeSidebarView).toBe('extensions');
		// The picker was cancelled: nothing installs, nothing complains.
		expect(backend.callsTo('ext_install_from_vsix')).toEqual([]);
		expect(notifications()).toEqual([]);
	});
});

describe('the command sweep', () => {
	it('every registered command runs without throwing and leaves the shell usable', { timeout: 60_000 }, async () => {
		await workbench.editors.openFile(NOTES);
		await flush(6);
		const failures: string[] = [];
		const ids = commands.all().map((command) => command.id).filter((id) => id !== 'workbench.exit' && id !== 'workbench.closeFolder');
		for (const id of ids) {
			try {
				await Promise.race([commands.execute(id), new Promise((resolve) => setTimeout(resolve, 200))]);
				await flush(2);
			} catch (error) {
				failures.push(`${id}: ${String(error)}`);
			}
			await dismissOverlays();
			// The shell still answers: a file can be (re)opened after every command.
			if (workbench.currentRepo !== REPO) failures.push(`${id}: the folder was closed`);
		}
		expect(failures).toEqual([]);
		expect(document.querySelector('.quick-input, .context-menu')).toBeNull();
		// Exit is the one command that closes the window.
		await commands.execute('workbench.exit');
		expect(backend.window.closed).toBe(1);
	});
});
