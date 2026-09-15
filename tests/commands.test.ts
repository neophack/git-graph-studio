// The functional sweep: every command the workbench registers - the title bar menus, the "..."
// menus, the palette and the keyboard shortcuts all resolve to these - runs against the mocked
// backend with a repository open and a text editor active, and must settle or park on a quick
// input / confirmation (which the sweep dismisses) without throwing. Every menu entry must
// name a registered command, and no two commands may claim the same keybinding. A command
// whose backend call breaks, whose enablement lies, or whose menu entry points nowhere fails
// here before a user finds it.

import { describe, expect, it } from 'vitest';

import { commands } from '../src/commands';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { flush } from './helpers';

const REPO = 'C:\\repo';

/** Plausible answers for every backend command, so any code path can run to its end. */
const DEFAULTS: Record<string, (args: Record<string, unknown>) => unknown> = {
	initial_repo: () => REPO,
	open_folder: ({ path }) => ({ root: path, isRepo: true }),
	close_folder: () => null,
	boot_stage: () => null,
	list_dir: () => [{ name: 'notes.txt', path: `${REPO}\\notes.txt`, isDir: false, size: 12 }],
	list_files: () => ['notes.txt', 'src/main.ts'],
	read_file: () => ({ contents: 'hello world\n', binary: false, size: 12 }),
	read_file_at: () => ({ contents: 'hello\n', binary: false, size: 6 }),
	file_fingerprint: () => '12:1',
	write_file: () => null,
	create_file: () => null,
	create_folder: () => null,
	rename_path: () => null,
	delete_path: () => null,
	session_log_file: () => 'C:\\temp\\session.log',
	repo_head: () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' }),
	scm_status: () => [{ path: 'notes.txt', oldPath: null, staged: null, unstaged: 'modified', untracked: false, conflicted: false }],
	scm_branches: () => [{ name: 'main', current: true, remote: false, upstream: 'origin/main' }, { name: 'origin/main', current: false, remote: true, upstream: null }],
	scm_remotes: () => [{ name: 'origin', url: 'https://example.com/repo.git' }],
	scm_stashes: () => [{ index: 0, selector: 'stash@{0}', message: 'wip' }],
	scm_tags: () => ['v1'],
	git_output_log: () => [],
	git_output_clear: () => null,
	pty_create: () => 1,
	pty_write: () => null,
	pty_resize: () => null,
	pty_kill: () => null,
	viewer_open: () => ({ docId: 1, lineCount: 1, language: 'plaintext', syntaxName: 'Plain Text', symbols: [] }),
	viewer_lines: () => ({ startLine: 0, lineCount: 1, lines: [['hello world', []]] }),
	viewer_symbols: () => [],
	viewer_close: () => null,
	ext_list: () => [],
	ext_read_file: () => { throw 'not installed'; },
	workspace_symbols: () => [{ kind: 'function', name: 'alpha', path: 'src/main.ts', line: 0 }],
	find_references: () => [{ path: 'src/main.ts', matches: [{ line: 1, column: 1, length: 5, text: 'hello' }] }],
	search_workspace: ({ onEvent }) => {
		(onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', scanned: 0, truncated: false, cancelled: false });
		return null;
	},
	search_cancel: () => null,
	compare_dirs: () => [],
	backup_list: () => [],
	scm_blame: () => [{ hash: 'a'.repeat(40), author: 'Ada', time: 1, summary: 'first' }],
	graph_request: () => ({ command: 'loadCommits', error: null, commits: [] })
};

/** Every other backend command answers `null` - a write that succeeded. */
class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? DEFAULTS[command] ?? (() => null);
	}
}

/** Close whatever a command parked on: a quick input (Escape), a confirmation toast (its
 *  Cancel / "Don't Save" button, else the close button), a context menu (Escape). Returns
 *  whether anything was dismissed. */
function dismissOverlays(): boolean {
	let dismissed = false;
	// The Explorer's inline "New File..." name box parks the same way as a quick input.
	for (const input of document.querySelectorAll<HTMLInputElement>('.quick-input input, .inline-input')) {
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		dismissed = true;
	}
	for (const toast of document.querySelectorAll<HTMLElement>('#notifications .notification')) {
		const buttons = Array.from(toast.querySelectorAll<HTMLElement>('.buttons .button'));
		const cancel = buttons.find((b) => /cancel|don't save|no/i.test(b.textContent ?? ''));
		(cancel ?? toast.querySelector<HTMLElement>('.close') ?? buttons[0])?.click();
		toast.remove();
		dismissed = true;
	}
	if (document.querySelector('.context-menu')) {
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		dismissed = true;
	}
	return dismissed;
}

async function bootWithRepo(): Promise<Workbench> {
	backend.handlers = new DefaultingHandlers();
	const workbench = new Workbench();
	await workbench.boot();
	await flush(10);
	await workbench.editors.openFile(`${REPO}\\notes.txt`);
	await flush(10);
	return workbench;
}

describe('every command of the workbench', () => {
	it('runs against the mocked backend without throwing, parking at most on a dismissable overlay', { timeout: 60_000 }, async () => {
		const workbench = await bootWithRepo();
		expect(workbench.currentRepo).toBe(REPO);
		expect(workbench.editors.activeView, 'a text editor is active so editor commands are enabled').not.toBeNull();

		const failures: string[] = [];
		const parked: string[] = [];
		const skipped: string[] = [];
		const errors: string[] = [];
		const onError = (event: ErrorEvent) => errors.push(String(event.error ?? event.message));
		window.addEventListener('error', onError);

		for (const command of commands.all()) {
			if (!commands.isEnabled(command.id)) {
				skipped.push(command.id);
				continue;
			}
			let settled = false;
			const run = commands.execute(command.id).then(() => { settled = true; }, (error) => { settled = true; failures.push(`${command.id}: ${String(error)}`); });
			// Let the command run; whatever it parks on is dismissed, up to a few layers deep.
			for (let round = 0; round < 8 && !settled; round++) {
				await flush(4);
				if (!dismissOverlays()) await flush(4);
			}
			await Promise.race([run, flush(4)]);
			if (!settled) parked.push(command.id);
			dismissOverlays();
			await flush(2);
			// The sweep needs the repository and an editor for the rest of the list.
			if (!workbench.currentRepo) await workbench.openFolder(REPO);
			if (!workbench.editors.activeView) await workbench.editors.openFile(`${REPO}\\notes.txt`);
			await flush(4);
		}
		window.removeEventListener('error', onError);

		expect(failures).toEqual([]);
		expect(errors).toEqual([]);
		expect(parked, 'commands still waiting after their overlays were dismissed').toEqual([]);
		// The sweep must actually cover the workbench: a registry that lost its commands, or an
		// enablement that hides most of them, would make this test meaningless.
		expect(commands.all().length).toBeGreaterThan(80);
		// The baked-in git-graph-rs manifest declares commands the app does not host natively
		// (fetch, addGitRepository, ...): like every extension-declared command without a
		// running handler, they stay disabled - expected skips, not coverage the sweep lost.
		const swept = skipped.filter((id) => !id.startsWith('git-graph-rs.'));
		expect(swept.length, `skipped: ${swept.join(', ')}`).toBeLessThan(6);
	});

	it('menus name registered commands only, and keybindings are unique', async () => {
		const workbench = await bootWithRepo();
		const unknown: string[] = [];
		const walk = (entries: ReturnType<ReturnType<Workbench['menus']>[number]['entries']>, menu: string) => {
			for (const entry of entries) {
				if (entry === 'separator') continue;
				if ('submenu' in entry && entry.submenu) {
					walk(entry.submenu, `${menu} > ${entry.label}`);
					continue;
				}
				// commands.menuItem() renders an unregistered id as its own id, disabled.
				if (/^[a-z]+(\.[a-zA-Z]+)+$/.test(entry.label) && entry.disabled) unknown.push(`${menu} > ${entry.label}`);
				if (!('run' in entry) || typeof entry.run !== 'function') unknown.push(`${menu} > ${entry.label}: no action`);
			}
		};
		for (const menu of workbench.menus()) walk(menu.entries(), menu.label);
		expect(unknown).toEqual([]);

		const byKey = new Map<string, string[]>();
		for (const command of commands.all()) {
			if (!command.keybinding) continue;
			const key = command.keybinding.toLowerCase();
			byKey.set(key, [...(byKey.get(key) ?? []), command.id]);
		}
		const clashes = [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => `${key}: ${ids.join(', ')}`);
		expect(clashes).toEqual([]);
	});
});
