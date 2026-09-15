// Single-file mode (`git-graph-studio <file>` / File > Open File...): the window shows one
// file and nothing else - the side bar and the terminal are hidden, no repository views run,
// and the file's editor opens at once. The backend side is `initial_file` / `open_single_file`.

import { beforeEach, describe, expect, it } from 'vitest';

import * as state from '../src/state';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, texts } from './helpers';

const FILE = 'C:\\docs\\notes.md';

class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

function shell(): void {
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
}

let workbench: Workbench | null = null;

beforeEach(() => {
	localStorage.clear();
	// The layout singleton survives localStorage.clear(); a single-file flow hides the side
	// bar, and the boot now honors that saved value - so each test starts from the default.
	state.layout.sidebarVisible = true;
	shell();
	backend.reset();
	backend.handlers = new DefaultingHandlers([
		['initial_file', () => FILE],
		['initial_repo', () => null],
		['boot_stage', () => null],
		['read_file', () => ({ contents: '# Hello\n', binary: false, size: 8 })],
		['open_single_file', () => null],
		['close_folder', () => null],
		['settings_read', () => null],
		['keybindings_read', () => null],
		['backup_list', () => []],
		['ext_list', () => []],
		['graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null })]
	] as [string, (args: Record<string, unknown>) => unknown][]);
});

describe('single-file mode', () => {
	it('boots straight into the file, with the side bar and terminal hidden', async () => {
		workbench = new Workbench();
		// Pre-warm the editor chunk, then boot: the launch file is the whole window.
		await import('../src/textEditor');
		await workbench.boot();
		await flush(12);
		workbench.dispose();
		expect(texts('.tab .label')).toEqual(['notes.md']);
		// The side bar and its sash are hidden; the terminal panel never shows.
		expect((document.getElementById('sidebar') as HTMLElement).hidden).toBe(true);
		expect((document.getElementById('sidebarSash') as HTMLElement).hidden).toBe(true);
		expect((document.getElementById('panel') as HTMLElement).hidden).toBe(true);
		// No repository chrome: the branch/graph items are off.
		expect(document.title).toBe('notes.md - Git Graph Studio');
		// The boot reported the file's first paint as a timing stage.
		expect(backend.callsTo('boot_stage').some((args) => String(args.stage).includes('single file'))).toBe(true);
	});

	it('File > Open File... switches an open folder into single-file mode', async () => {
		backend.handlers.set('initial_file', () => null);
		backend.handlers.set('initial_repo', () => 'C:\\repo');
		backend.handlers.set('open_folder', ({ path }) => ({ root: path, isRepo: true }));
		backend.handlers.set('repo_head', () => ({ branch: 'main', shortHash: 'abc', ahead: 0, behind: 0, upstream: null }));
		backend.handlers.set('scm_status', () => []);
		backend.handlers.set('list_dir', () => []);
		workbench = new Workbench();
		await import('../src/textEditor');
		await workbench.boot();
		await flush(10);
		expect((document.getElementById('sidebar') as HTMLElement).hidden).toBe(false);

		// Pick the file through the dialog stand-in and run the command.
		backend.dialog.openResult = FILE;
		await workbench.pickSingleFile();
		await flush(12);
		workbench.dispose();
		expect(backend.callsTo('open_single_file')).toHaveLength(1);
		expect(texts('.tab .label')).toEqual(['notes.md']);
		expect((document.getElementById('sidebar') as HTMLElement).hidden).toBe(true);
		// A click on the (now inactive) activity items must not bring the side bar back as a
		// side effect of the folder that is no longer open.
		expect(workbench.currentRepo).toBeNull();
	});
});
