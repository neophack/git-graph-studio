import { describe, expect, it } from 'vitest';

import { CommandRegistry, matchesKeybinding } from '../src/commands';
import { FS_CHANGED_EVENT, Workbench } from '../src/workbench';
import * as state from '../src/state';
import { StatusBar } from '../src/statusbar';
import { TitleBar } from '../src/titlebar';
import { Panel } from '../src/panel';
import { backend } from './tauriMock';
import { click, flush, hover, menuLabels, texts, type } from './helpers';

describe('command registry', () => {
	it('registers, enables, executes and renders menu items', async () => {
		const registry = new CommandRegistry();
		let ran = 0;
		let enabled = true;
		registry.register({ id: 'a', title: 'Alpha', category: 'Test', keybinding: 'Ctrl+Shift+A', enabled: () => enabled, run: () => { ran++; } });
		registry.register({ id: 'b', title: 'Beta', run: () => { ran += 10; } });
		expect(await registry.execute('a')).toBe(true);
		expect(ran).toBe(1);
		enabled = false;
		expect(await registry.execute('a')).toBe(false);
		expect(registry.menuItem('a').disabled).toBe(true);
		expect(registry.menuItem('a').keybinding).toBe('Ctrl+Shift+A');
		expect(registry.menuItem('missing').disabled).toBe(true);
		enabled = true;
		expect(registry.paletteItems().map((i) => i.label)).toEqual(['Beta', 'Test: Alpha']);
		const item = registry.menuItem('b');
		item.run!();
		expect(ran).toBe(11);
	});

	it('matches keybindings against key events', () => {
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+E')).toBe(true);
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }), 'Ctrl+Shift+E')).toBe(false);
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '`', ctrlKey: true }), 'Ctrl+`')).toBe(true);
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: 'p', metaKey: true }), 'Ctrl+P')).toBe(true);
		const registry = new CommandRegistry();
		// A chord registered first must not swallow the plain key: "Ctrl+K Ctrl+B" is two
		// keystrokes, and a lone Ctrl+B belongs to the sidebar toggle.
		registry.register({ id: 'chord', title: 'Chord', keybinding: 'Ctrl+K Ctrl+B', run: () => undefined });
		registry.register({ id: 'x', title: 'X', keybinding: 'Ctrl+B', run: () => undefined });
		expect(registry.forKeyEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))?.id).toBe('x');
		expect(registry.forKeyEvent(new KeyboardEvent('keydown', { key: 'b' }))).toBeUndefined();
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }), 'Ctrl+K Ctrl+B')).toBe(false);
	});

	it('matches shifted punctuation against the binding\'s unshifted spelling (Ctrl+Shift+`)', () => {
		// On a US layout Ctrl+Shift+` reports the key "~"; the default binding spells it "`".
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '~', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+`')).toBe(true);
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '!', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+1')).toBe(true);
		// A user-recorded binding keeps the shifted glyph and still matches directly.
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '~', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+~')).toBe(true);
		// The modifier check is untouched: shift must be wanted, and wanted shift must be held.
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '~', ctrlKey: true }), 'Ctrl+Shift+`')).toBe(false);
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '~', ctrlKey: true, shiftKey: true }), 'Ctrl+`')).toBe(false);
		// The unshifted key itself still matches directly.
		expect(matchesKeybinding(new KeyboardEvent('keydown', { key: '`', ctrlKey: true }), 'Ctrl+`')).toBe(true);
	});
});

describe('persisted state', () => {
	it('round-trips layout, folders, repo state, settings and code reviews', () => {
		state.layout.sidebarWidth = 333;
		state.saveLayout();
		expect(state.load<{ sidebarWidth: number }>('layout', { sidebarWidth: 0 }).sidebarWidth).toBe(333);

		state.rememberFolder('/a');
		state.rememberFolder('/b');
		state.rememberFolder('/a');
		expect(state.lastFolder()).toBe('/a');
		expect(state.recentFolders()).toEqual(['/a', '/b']);
		state.forgetFolder('/b');
		expect(state.recentFolders()).toEqual(['/a']);

		expect(state.repoState('/a')['commitOrdering']).toBe('default');
		state.saveRepoState('/a', { ...state.repoState('/a'), pinnedBranches: ['main'] });
		expect(state.repoState('/a')['pinnedBranches']).toEqual(['main']);

		state.saveGraphSetting('graph.style', 'angular');
		expect(state.graphSettings()).toEqual({ 'graph.style': 'angular' });
		expect(state.globalViewState()['pushTagSkipRemoteCheck']).toBe(false);

		state.saveCodeReview('/a', { id: 'abc', lastActive: 1, lastViewedFile: null, remainingFiles: ['x'] });
		expect(state.codeReview('/a', 'abc')?.remainingFiles).toEqual(['x']);
		state.saveCodeReview('/a', null, 'abc');
		expect(state.codeReview('/a', 'abc')).toBeNull();
	});
});

describe('the boot layout', () => {
	it('keeps the side bar hidden when the saved layout hides it (Ctrl+B, then a restart)', () => {
		state.layout.sidebarVisible = false;
		try {
			const workbench = new Workbench();
			expect(document.getElementById('sidebar')!.hidden).toBe(true);
			expect(document.getElementById('sidebarSash')!.hidden).toBe(true);
			// The boot must not resurrect (and re-persist) the bar: the saved value stands.
			expect(state.layout.sidebarVisible).toBe(false);
			expect(state.load<{ sidebarVisible: boolean }>('layout', { sidebarVisible: true }).sidebarVisible).toBe(false);
			// The active view is still marked, ready for the bar's next showing.
			expect(workbench.activeSidebarView).toBe('explorer');
			workbench.dispose();
		} finally {
			state.layout.sidebarVisible = true;
		}
	});
});

describe('title bar', () => {
	it('renders the menu bar, opens menus, switches on hover and drives the window controls', async () => {
		const bar = new TitleBar(document.getElementById('titlebar')!);
		let ran = '';
		bar.setMenus([
			{ label: 'File', entries: () => [{ label: 'Open Folder...', keybinding: 'Ctrl+O', run: () => { ran = 'open'; } }] },
			{ label: 'Help', entries: () => [{ label: 'About', run: () => { ran = 'about'; } }] }
		]);
		expect(texts('.menubar-item')).toEqual(['File', 'Help']);
		expect(document.getElementById('titlebar')!.hasAttribute('data-tauri-drag-region')).toBe(true);

		const [file, help] = Array.from(document.querySelectorAll<HTMLElement>('.menubar-item'));
		file!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		expect(menuLabels()).toEqual(['Open Folder...']);
		expect(file!.classList.contains('open')).toBe(true);
		hover(help);
		expect(menuLabels()).toEqual(['About']);
		click(document.querySelector('.context-menu .item'));
		expect(ran).toBe('about');
		expect(bar.openMenu('File')).toBe(true);
		expect(bar.openMenu('Nope')).toBe(false);

		click(document.querySelector('.window-control.minimize'));
		click(document.querySelector('.window-control.close'));
		click(document.querySelector('.window-control.maximize'));
		await flush();
		expect(backend.window).toMatchObject({ minimized: 1, closed: 1, toggled: 1, maximized: true });
		expect(document.querySelector('.window-control.maximize .codicon-chrome-restore')).not.toBeNull();
		expect(document.getElementById('titlebar')!.classList.contains('maximized')).toBe(true);

		let center = 0;
		bar.onCommandCenter = () => center++;
		click(document.querySelector('.command-center'));
		expect(center).toBe(1);

		// The back / forward arrows reflect and drive the navigation history.
		expect(document.querySelector('.titlebar-nav.disabled')).not.toBeNull();
		let went = '';
		bar.onBack = () => { went = 'back'; };
		bar.onForward = () => { went = 'forward'; };
		bar.setNavigation(true, false);
		expect(document.querySelectorAll('.titlebar-nav').length).toBe(2);
		expect(document.querySelector('.titlebar-nav')!.classList.contains('disabled')).toBe(false);
		expect(document.querySelectorAll('.titlebar-nav.disabled').length).toBe(1);
		click(document.querySelector('.titlebar-nav'));
		expect(went).toBe('back');
		click(document.querySelectorAll('.titlebar-nav')[1]);
		expect(went).toBe('forward');
		bar.setFolderName('repo');
		expect(document.querySelector('.command-center .label')!.textContent).toBe('Search repo');
		bar.setFolderName(null);
		expect(document.querySelector('.command-center .label')!.textContent).toBe('Git Graph Studio');
	});
});

describe('status bar', () => {
	it('shows the repo, the branch and the sync counts as separate items, and the editor position', async () => {
		backend.on('repo_head', () => ({ repo: 'git-graph-studio', branch: 'main', shortHash: 'abc1234', ahead: 2, behind: 1, upstream: 'origin/main' }));
		const bar = new StatusBar(document.getElementById('statusbar')!);
		let clicks = '';
		bar.onRepoClick = () => { clicks += 'r'; };
		bar.onBranchClick = () => { clicks += 'b'; };
		bar.onSyncClick = () => { clicks += 's'; };
		bar.onGraphClick = () => { clicks += 'g'; };
		expect(document.body.classList.contains('no-folder')).toBe(true);
		bar.setRepo(true);
		await flush();
		const [repo, branch, sync, graph] = Array.from(document.querySelectorAll<HTMLElement>('.status-left .status-item'));
		// The repository's name is a button of its own, opening Source Control.
		expect(repo!.textContent).toContain('git-graph-studio');
		// The branch shows the name only; both counts ride the sync item.
		expect(branch!.textContent).toContain('main');
		expect(branch!.querySelector('.codicon-arrow-up')).toBeNull();
		expect(sync!.hidden).toBe(false);
		expect(sync!.textContent).toContain('2');
		expect(sync!.textContent).toContain('1');
		expect(sync!.querySelector('.codicon-arrow-up')).not.toBeNull();
		expect(sync!.querySelector('.codicon-arrow-down')).not.toBeNull();
		expect(sync!.title).toBe('Synchronize Changes - pull 1 and push 2 from/to origin/main');
		expect(branch!.title).toBe('main (tracking origin/main) - Checkout Branch/Tag...');
		click(repo);
		click(branch);
		click(sync);
		click(graph);
		expect(clicks).toBe('rbsg');

		bar.setEditor({ kind: 'file', languageName: 'Rust', line: 3, column: 7 });
		expect(texts('.status-right .status-item:not([hidden])')).toEqual(['Ln 3, Col 7', 'Spaces: 4', 'LF', 'UTF-8', 'Rust']);
		// A file's own encoding and line endings show, and each item offers its picker.
		let picks = '';
		bar.onEncodingClick = () => { picks += 'e'; };
		bar.onEolClick = () => { picks += 'l'; };
		bar.setEditor({ kind: 'file', languageName: 'Rust', encoding: 'gb18030', eol: 'crlf', line: 1, column: 1 });
		expect(texts('.status-right .status-item:not([hidden])')).toEqual(['Ln 1, Col 1', 'Spaces: 4', 'CRLF', 'GB18030 (GBK)', 'Rust']);
		click(document.querySelector('.status-right .status-item[title="Select Encoding"]'));
		click(document.querySelector('.status-right .status-item[title="Select End of Line Sequence"]'));
		expect(picks).toBe('el');
		// A diff shows the position and language only.
		bar.setEditor({ kind: 'diff', languageName: 'Rust', line: 2, column: 2 });
		expect(texts('.status-right .status-item:not([hidden])')).toEqual(['Ln 2, Col 2', 'Spaces: 4', 'Rust']);
		// A selection and multiple cursors read as VS Code words them.
		bar.setEditor({ kind: 'file', line: 2, column: 2, selected: 12, selections: 1 });
		expect(texts('.status-right .status-item:not([hidden])')[0]).toBe('Ln 2, Col 2 (12 selected)');
		bar.setEditor({ kind: 'file', line: 2, column: 2, selected: 6, selections: 3 });
		expect(texts('.status-right .status-item:not([hidden])')[0]).toBe('3 selections (6 characters selected)');
		bar.setEditor({ kind: 'graph', line: 1, column: 1 });
		expect(document.querySelectorAll('.status-right .status-item:not([hidden])')).toHaveLength(0);

		// A level branch keeps the sync item (a pull/push against its upstream is exactly what
		// it offers); without an upstream there is nothing to synchronize.
		backend.on('repo_head', () => ({ repo: 'git-graph-studio', branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' }));
		await bar.refreshHead();
		expect(sync!.hidden).toBe(false);
		backend.on('repo_head', () => ({ repo: 'git-graph-studio', branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 2, upstream: null }));
		await bar.refreshHead();
		expect(sync!.hidden).toBe(true);
		expect(branch!.querySelector('.codicon-arrow-up')).toBeNull();

		backend.on('repo_head', () => ({ repo: 'git-graph-studio', branch: null, shortHash: 'deadbee', ahead: 0, behind: 0, upstream: null }));
		await bar.refreshHead();
		expect(branch!.textContent).toContain('deadbee');
		expect(sync!.hidden).toBe(true);
	});

	it('shows the unmerged-path count as a warning item that opens Source Control', () => {
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
		const bar = new StatusBar(document.getElementById('statusbar')!);
		let clicked = 0;
		bar.onConflictsClick = () => { clicked++; };
		bar.setRepo(true);
		const item = document.querySelector<HTMLElement>('.status-left .status-item.warning')!;
		expect(item.hidden).toBe(true);
		bar.setConflicts(3);
		expect(item.hidden).toBe(false);
		expect(item.textContent).toContain('3 conflicts');
		click(item);
		expect(clicked).toBe(1);
		bar.setConflicts(1);
		expect(item.textContent).toContain('1 conflict');
		bar.setConflicts(0);
		expect(item.hidden).toBe(true);
	});
});

describe('file watcher events', () => {
	it('reloads clean tabs of the changed files and refreshes the git views', async () => {
		backend.on('initial_repo', () => null);
		backend.on('ext_list', () => []);
		const workbench = new Workbench();
		let refreshes = 0;
		const reloaded: string[] = [];
		(workbench as unknown as { repoPath: string }).repoPath = 'C:\\repo';
		(workbench as unknown as { repoPaths: string[] }).repoPaths = ['C:\\repo'];
		workbench.scheduleRefresh = () => { refreshes++; };
		workbench.editors.reloadIfClean = async (path) => { reloaded.push(path); };

		backend.emit(FS_CHANGED_EVENT, { root: 'C:\\repo', paths: ['src/a.ts', 'docs/b.md'], truncated: false, gitChanged: false });
		expect(reloaded).toEqual(['C:\\repo\\src\\a.ts', 'C:\\repo\\docs\\b.md']);
		expect(refreshes).toBe(1);

		// A truncated burst (a build, a checkout) skips the per-file reloads: the coalesced
		// refresh reloads the active editor and the views catch up in one go.
		backend.emit(FS_CHANGED_EVENT, { root: 'C:\\repo', paths: ['x'], truncated: true, gitChanged: true });
		expect(reloaded).toHaveLength(2);
		expect(refreshes).toBe(2);

		// A batch from a folder that is no longer open (the old watcher's last burst crossing
		// a folder switch) is dropped: its paths are relative to another root.
		backend.emit(FS_CHANGED_EVENT, { root: 'C:\\old', paths: ['src/a.ts'], truncated: false, gitChanged: false });
		expect(reloaded).toHaveLength(2);
		expect(refreshes).toBe(2);

		// A git-only batch right after a refresh of our own is its echo, not a change: the
		// git commands a refresh runs touch .git/, and reacting to that would loop forever.
		(workbench as unknown as { lastRefreshAt: number }).lastRefreshAt = performance.now();
		backend.emit(FS_CHANGED_EVENT, { root: 'C:\\repo', paths: [], truncated: false, gitChanged: true });
		expect(refreshes).toBe(2);
		// Well after the refresh, the same batch is an external change (a commit in a terminal).
		(workbench as unknown as { lastRefreshAt: number }).lastRefreshAt = performance.now() - 5000;
		backend.emit(FS_CHANGED_EVENT, { root: 'C:\\repo', paths: [], truncated: false, gitChanged: true });
		expect(refreshes).toBe(3);
	});

	it('joins a change batch to the root it came from, not the first root (multi-root)', () => {
		backend.on('initial_repo', () => null);
		backend.on('ext_list', () => []);
		const workbench = new Workbench();
		const reloaded: string[] = [];
		(workbench as unknown as { repoPath: string }).repoPath = 'C:\\one';
		(workbench as unknown as { repoPaths: string[] }).repoPaths = ['C:\\one', 'C:\\two'];
		workbench.scheduleRefresh = () => undefined;
		workbench.editors.reloadIfClean = async (path) => { reloaded.push(path); };

		// An external edit in the workspace's second folder reloads from that folder.
		backend.emit(FS_CHANGED_EVENT, { root: 'C:\\two', paths: ['src/x.ts'], truncated: false, gitChanged: false });
		expect(reloaded).toEqual(['C:\\two\\src\\x.ts']);
		workbench.dispose();
	});
});

describe('panel', () => {
	it('switches between terminal and output, creates shells and shows git output', async () => {
		backend.on('pty_create', () => 'powershell');
		backend.on('pty_write', () => null);
		backend.on('pty_kill', () => null);
		backend.on('git_output_log', () => ['> git status [3ms]']);
		backend.on('git_output_clear', () => null);
		const panel = new Panel(document.getElementById('panel')!);
		const visibility: boolean[] = [];
		panel.onVisibilityChange = (v) => visibility.push(v);

		panel.show('terminal');
		await flush();
		expect(panel.isVisible()).toBe(true);
		expect(visibility).toEqual([true]);
		expect(backend.callsTo('pty_create')).toHaveLength(1);
		expect(panel.terminal.sessionCount()).toBe(1);
		expect(texts('.panel-title.active')).toEqual(['Terminal']);

		await panel.runInTerminal('git status');
		expect(backend.callsTo('pty_write').at(-1)?.['data']).toBe('git status\r');

		await panel.terminal.newTerminal();
		await flush();
		expect(panel.terminal.sessionCount()).toBe(2);
		expect(document.querySelector('.terminal-tabs')!.hidden).toBe(false);
		expect(texts('.terminal-tabs .row .label')).toEqual(['powershell', 'powershell']);
		await panel.terminal.killActive();
		expect(backend.callsTo('pty_kill')).toHaveLength(1);
		expect(panel.terminal.sessionCount()).toBe(1);

		// The backend's exit event marks the shell, and a key closes it (the last one hides the panel).
		const id = backend.callsTo('pty_create')[0]!['id'];
		backend.emit(`studio://pty-exit-${id}`, null);
		expect(texts('.terminal-tabs .row .label').length).toBeLessThanOrEqual(1);

		panel.show('output');
		await flush();
		expect(texts('.panel-title.active')).toEqual(['Output']);
		expect(panel.output.text()).toContain('git status');
		backend.emit('studio://git-output', '> git fetch [10ms]');
		expect(panel.output.text()).toContain('git fetch');
		await panel.output.clear();
		expect(panel.output.text()).toBe('');
		expect(backend.callsTo('git_output_clear')).toHaveLength(1);

		panel.toggle('output');
		expect(panel.isVisible()).toBe(false);
		panel.toggle('output');
		expect(panel.isVisible()).toBe(true);
		click(document.querySelector('.panel-header > .actions .action-btn'));
		expect(document.getElementById('panel')!.classList.contains('maximized')).toBe(true);
		click(document.querySelector('.panel-header > .actions .action-btn:last-child'));
		expect(panel.isVisible()).toBe(false);
	});
});

describe('workbench help pages', () => {
	it('shows the Keyboard Shortcuts page, filtered as you type, and the Welcome tab', () => {
		const workbench = new Workbench();
		workbench.editors.openHelp('shortcuts');
		const rows = () => texts('.editor-pane .shortcuts-list .shortcut');
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('Keyboard Shortcuts');
		expect(rows().length).toBeGreaterThan(5);
		expect(rows().some((row) => row.includes('Toggle Terminal'))).toBe(true);

		const filter = document.querySelector<HTMLInputElement>('.editor-pane .shortcuts-filter')!;
		type(filter, 'terminal');
		expect(rows().length).toBeGreaterThan(0);
		expect(rows().every((row) => row.toLowerCase().includes('terminal'))).toBe(true);
		type(filter, 'zzzz-no-match');
		expect(texts('.editor-pane .shortcuts-list .empty')).toEqual(['No matching commands']);

		workbench.editors.openHelp('welcome');
		expect(texts('.editor-pane:not([hidden]) .welcome-inner h1')).toEqual(['Git Graph Studio']);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('Welcome');
	});
});

describe('sash dragging', () => {
	it('coalesces the drag into one layout per frame and saves the layout on release', async () => {
		const workbench = new Workbench();
		const sidebar = document.getElementById('sidebar')!;
		const sash = document.getElementById('sidebarSash')!;
		const initial = Number.parseInt(sidebar.style.width);
		expect(Number.isFinite(initial)).toBe(true);

		sash.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
		for (const x of [320, 340, 360, 380]) {
			document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 300 }));
		}
		// Within the frame nothing is applied yet; the frame itself applies the latest position.
		expect(sidebar.style.width).toBe(`${initial}px`);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(sidebar.style.width).toBe(`${initial + 80}px`);

		document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
		expect(state.load<{ sidebarWidth: number }>('layout', { sidebarWidth: 0 }).sidebarWidth).toBe(initial + 80);
		expect(document.body.classList.contains('resizing')).toBe(false);
	});
});

describe('terminal resizing', () => {
	it('coalesces a burst of resizes into one backend resize with the final size', async () => {
		backend.on('pty_create', () => 'powershell');
		backend.on('pty_write', () => null);
		backend.on('pty_kill', () => null);
		const panel = new Panel(document.getElementById('panel')!);
		panel.show('terminal');
		await flush();
		const terms = (globalThis as unknown as { __xterms: { triggerResize: (c: number, r: number) => void }[] }).__xterms;
		const term = terms.at(-1)!;
		const id = backend.callsTo('pty_create')[0]!['id'];

		term.triggerResize(100, 30);
		term.triggerResize(110, 30);
		term.triggerResize(120, 40);
		expect(backend.callsTo('pty_resize')).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 160));
		expect(backend.callsTo('pty_resize')).toEqual([{ id, cols: 120, rows: 40 }]);

		// Killing the session drops a resize still waiting, instead of resizing a dead shell.
		term.triggerResize(130, 40);
		await panel.terminal.killActive();
		await new Promise((resolve) => setTimeout(resolve, 160));
		expect(backend.callsTo('pty_resize')).toHaveLength(1);
	});

	it('answers VS Code\'s terminal clipboard keys: Ctrl+Shift+C / Ctrl+C-with-selection copy, Ctrl+Shift+V pastes', async () => {
		backend.on('pty_create', () => 'powershell');
		backend.on('pty_write', () => null);
		backend.on('pty_kill', () => null);
		backend.clipboard.length = 0;
		backend.clipboardText = 'from clipboard';
		const panel = new Panel(document.getElementById('panel')!);
		panel.show('terminal');
		await flush();
		type FakeTerm = { keyHandler: (event: KeyboardEvent) => boolean; selection: string; pasted: string[] };
		const term = (globalThis as unknown as { __xterms: FakeTerm[] }).__xterms.at(-1)!;
		const press = (init: KeyboardEventInit) => term.keyHandler(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

		// Ctrl+C with nothing selected reaches the shell (the interrupt); with a selection it copies.
		expect(press({ key: 'c', ctrlKey: true })).toBe(true);
		term.selection = 'ls -la';
		expect(press({ key: 'c', ctrlKey: true })).toBe(false);
		await flush();
		expect(backend.clipboard).toEqual(['ls -la']);
		expect(press({ key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
		await flush();
		expect(backend.clipboard).toEqual(['ls -la', 'ls -la']);
		// Ctrl+Shift+V pastes the clipboard; plain Ctrl+V stays xterm's own.
		expect(press({ key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
		await flush();
		expect(term.pasted).toEqual(['from clipboard']);
		expect(press({ key: 'v', ctrlKey: true })).toBe(true);
		await panel.terminal.killActive();
	});
});

describe('session snapshot', () => {
	it('restores the file tabs, the active tab and the expanded folders of a folder on reopen', { timeout: 20_000 }, async () => {
		const REPO = 'C:\\repo';
		const files: Record<string, string> = { [`${REPO}\\a.txt`]: 'aaa\n', [`${REPO}\\b.txt`]: 'bbb\n', [`${REPO}\\src\\c.txt`]: 'ccc\n' };
		backend.on('initial_repo', () => null);
		backend.on('open_folder', ({ path }) => ({ root: path, isRepo: true }));
		backend.on('close_folder', () => null);
		backend.on('ext_list', () => []);
		backend.on('ext_read_file', () => { throw 'missing'; });
		backend.on('scm_status', () => []);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
		backend.on('list_files', () => ['a.txt', 'b.txt', 'src/c.txt']);
		backend.on('list_dir', ({ path }) => (path === REPO
			? [{ name: 'src', path: `${REPO}\\src`, isDir: true, size: 0 }, { name: 'a.txt', path: `${REPO}\\a.txt`, isDir: false, size: 4 }, { name: 'b.txt', path: `${REPO}\\b.txt`, isDir: false, size: 4 }]
			: [{ name: 'c.txt', path: `${REPO}\\src\\c.txt`, isDir: false, size: 4 }]));
		backend.on('read_file', ({ path }) => {
			const contents = files[path as string];
			if (contents === undefined) throw `${path}: not found`;
			return { contents, binary: false, size: contents.length };
		});
		backend.on('file_fingerprint', () => '4:1');
		backend.on('boot_stage', () => null);

		// First session: open two files, expand src, make a.txt active, then close the folder.
		const first = new Workbench();
		await first.boot();
		await first.openFolder(REPO);
		await flush(10);
		await first.editors.openFile(`${REPO}\\b.txt`);
		await first.editors.openFile(`${REPO}\\a.txt`);
		click(document.querySelector('#sidebar .row[data-dir="1"]'));
		await flush(10);
		expect(first.explorer.expandedFolders()).toEqual(['src']);
		await first.closeFolder();
		const saved = state.workspaceSnapshot(REPO)!;
		expect(saved.openFiles).toEqual([`${REPO}\\b.txt`, `${REPO}\\a.txt`]);
		expect(saved.activeFile).toBe(`${REPO}\\a.txt`);
		expect(saved.expanded).toEqual(['src']);

		// A vanished file is skipped; the rest comes back in order with the active tab on top.
		delete files[`${REPO}\\b.txt`];
		document.body.querySelector('#editorGroup')!.innerHTML = '';
		const second = new Workbench();
		await second.boot();
		await second.openFolder(REPO);
		await flush(20);
		expect(second.editors.openFilePaths()).toEqual([`${REPO}\\a.txt`]);
		expect(second.editors.activeInput).toEqual({ kind: 'file', path: `${REPO}\\a.txt` });
		expect(second.explorer.expandedFolders()).toEqual(['src']);
		expect(texts('#sidebar .row .label')).toContain('c.txt');
	});
});
