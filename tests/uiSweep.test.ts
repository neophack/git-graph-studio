// The full-UI sweep: the real workbench booted against a rich repository (staged, unstaged,
// untracked, deleted and conflicted files; branches, tags, a stash; a folder tree), then every
// interactive surface driven the way a user drives it - the title bar menus entry by entry,
// every activity bar item, every sidebar title action, every Explorer / SCM / Search row and
// its context menu, every editor kind's chrome (text, diff, Markdown preview, hex, history,
// folder compare, call tree, graph), every tab and text context menu entry, the panel's tabs
// and actions, every status bar item and its picker, the settings dialog's every control, the
// keyboard shortcuts editor, quick open in each of its modes, and every registered keybinding.
//
// A surface fails when any click, key or menu entry throws (synchronously, as a window error,
// or as an unhandled rejection), when an error toast appears, when what it parks on is not a
// dismissable overlay, and on the outcome checks folded into each surface (what a row opens,
// what a control changes, where a key lands). The report (target/studio/ui-sweep-report.md)
// lists what was driven, so a surface that silently lost its controls shows up as a shrinking
// count.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { commands } from '../src/commands';
import { settings, updateSetting } from '../src/settings';
import { Workbench } from '../src/workbench';
import { commonHandlers, type Handler } from './scenarioFixtures';
import { backend } from './tauriMock';
import { click, flush, hover, key, rightClick, type } from './helpers';

// jsdom has no canvas: the module analysis drawing runs on the G6 stub.
vi.mock('@antv/g6', () => import('./g6Stub'));

const REPO = 'C:\\repo';
const NOTES = `${REPO}\\notes.txt`;

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

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The sweep's repository: every kind of change, a folder tree, an image and a binary. */
function richHandlers(): Map<string, Handler> {
	const map = new Map<string, Handler>(commonHandlers());
	map.set('list_dir', ({ path }) => {
		if (String(path).endsWith('src')) return [{ name: 'main.rs', path: `${path}\\main.rs`, isDir: false, size: 10 }];
		return [
			{ name: 'src', path: `${path}\\src`, isDir: true, size: 0 },
			{ name: 'notes.txt', path: `${path}\\notes.txt`, isDir: false, size: 12 },
			{ name: 'README.md', path: `${path}\\README.md`, isDir: false, size: 20 },
			{ name: 'conflicted.txt', path: `${path}\\conflicted.txt`, isDir: false, size: 40 },
			{ name: 'logo.png', path: `${path}\\logo.png`, isDir: false, size: 68 },
			{ name: 'blob.bin', path: `${path}\\blob.bin`, isDir: false, size: 4 }
		];
	});
	map.set('list_files', () => ['notes.txt', 'README.md', 'src/main.rs', 'conflicted.txt']);
	map.set('read_file', ({ path }) => {
		const p = String(path);
		if (p.endsWith('conflicted.txt')) return { contents: 'ours\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature\ncommon\n', binary: false, size: 40 };
		if (p.endsWith('README.md')) return { contents: '# Title\n\nSome *text* and `code`.\n', binary: false, size: 20 };
		if (p.endsWith('blob.bin')) return { contents: null, binary: true, size: 4 };
		if (p.endsWith('main.rs')) return { contents: 'fn alpha() {}\nfn main() { alpha(); }\n', binary: false, size: 10 };
		return { contents: 'one two one\nthree\n', binary: false, size: 18 };
	});
	map.set('file_probe', ({ path }) => ({ size: 10, binary: String(path).endsWith('blob.bin') }));
	map.set('read_file_chunk', () => ({ size: 4, base64: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64') }));
	map.set('read_file_base64', () => ({ base64: PNG, mime: 'image/png', size: 68 }));
	map.set('scm_status', () => [
		{ path: 'src/main.rs', oldPath: null, staged: 'M', unstaged: null, untracked: false },
		{ path: 'notes.txt', oldPath: null, staged: null, unstaged: 'M', untracked: false },
		{ path: 'new.txt', oldPath: null, staged: null, unstaged: null, untracked: true },
		{ path: 'gone.txt', oldPath: null, staged: null, unstaged: 'D', untracked: false },
		{ path: 'conflicted.txt', oldPath: null, staged: null, unstaged: 'U', untracked: false, conflicted: true }
	]);
	map.set('repo_head', () => ({ repo: 'git-graph-studio', branch: 'main', shortHash: '0123456', ahead: 2, behind: 1, upstream: 'origin/main' }));
	map.set('scm_branches', () => [
		{ name: 'main', current: true, remote: false, upstream: 'origin/main' },
		{ name: 'feature/x', current: false, remote: false, upstream: null },
		{ name: 'origin/main', current: false, remote: true, upstream: null }
	]);
	map.set('scm_remotes', () => [{ name: 'origin', url: 'https://example.org/repo.git' }]);
	map.set('scm_tags', () => ['v1.0.0']);
	map.set('scm_stashes', () => [{ index: 0, selector: 'stash@{0}', message: 'wip' }]);
	map.set('scm_blame', () => [{ hash: 'a'.repeat(40), author: 'Ada', time: 1, summary: 'first' }]);
	map.set('file_history', () => [{ hash: 'a'.repeat(40), author: 'Ada', date: 1700000000, message: 'first' }]);
	map.set('workspace_symbols', () => [{ kind: 'function', name: 'alpha', path: 'src/main.rs', line: 0 }]);
	map.set('analysis_status', () => ({ state: 'ready', done: 2, total: 2, files: 2, symbols: 4, calls: 2 }));
	map.set('analysis_rebuild', ({ onEvent }) => {
		const channel = onEvent as { onmessage: (e: unknown) => void };
		channel.onmessage({ kind: 'progress', done: 2, total: 2 });
		channel.onmessage({ kind: 'done', files: 2, symbols: 4, calls: 2, cancelled: false });
		return { state: 'ready', done: 2, total: 2, files: 2, symbols: 4, calls: 2 };
	});
	map.set('analysis_module_graph', () => ({
		modules: [{ name: 'src', files: 1, symbols: 2 }, { name: '', files: 1, symbols: 1 }],
		edges: [
			{ from: 'src', to: '', calls: 2, files: 1 },
			{ from: '', to: 'src', calls: 1, files: 1 }
		],
		fileEdges: [
			{ from: 'src/main.rs', to: 'notes.txt', calls: 2, sites: [
				{ from: 'alpha', to: 'beta', line: 0, column: 12 },
				{ from: 'beta', to: 'gamma', line: 2, column: 8 }
			] },
			{ from: 'notes.txt', to: 'src/main.rs', calls: 1, sites: [{ from: 'gamma', to: 'alpha', line: 1, column: 4 }] }
		],
		totalCalls: 3,
		totalFileEdges: 2
	}));
	map.set('analysis_metrics', ({ onEvent }) => {
		const channel = onEvent as { onmessage: (e: unknown) => void };
		channel.onmessage({ kind: 'batch', rows: [{ path: 'src/main.rs', name: 'alpha', kind: 'function', container: null, line: 0, lines: 1, params: 0, complexity: 4, nesting: 1, refs: 2, hotspot: 8 }] });
		channel.onmessage({ kind: 'done', files: 2, functions: 4, cancelled: false });
		return null;
	});
	map.set('analysis_dead_code', ({ onEvent }) => {
		const channel = onEvent as { onmessage: (e: unknown) => void };
		channel.onmessage({ kind: 'batch', rows: [{ path: 'src/main.rs', name: 'orphan', kind: 'function', container: null, line: 2, exported: false, lines: 3 }] });
		channel.onmessage({ kind: 'done', found: 1, cancelled: false });
		return null;
	});
	map.set('analysis_security', ({ onEvent }) => {
		const channel = onEvent as { onmessage: (e: unknown) => void };
		channel.onmessage({ kind: 'batch', findings: [{ ruleId: 'SEC-003', severity: 'error', message: 'secret-looking literal assigned to a credential variable', path: 'src/main.rs', line: 3, column: 0, cwe: 'CWE-798' }] });
		channel.onmessage({ kind: 'done', files: 2, findings: 1, cancelled: false });
		return null;
	});
	map.set('analysis_import_graph', () => ({ edges: [['src/a.js', 'src/b.js'], ['src/b.js', 'src/a.js']], cycles: [['src/a.js', 'src/b.js']] }));
	map.set('find_references', () => [{ path: 'src/main.rs', matches: [{ line: 2, column: 13, length: 5, text: 'fn main() { alpha(); }' }] }]);
	map.set('search_workspace', ({ onEvent }) => {
		const channel = onEvent as { onmessage: (e: unknown) => void };
		channel.onmessage({ kind: 'batch', files: [{ path: 'notes.txt', matches: [{ line: 1, column: 1, length: 3, text: 'one two one' }, { line: 1, column: 9, length: 3, text: 'one two one' }] }] });
		channel.onmessage({ kind: 'done', scanned: 4, truncated: false, cancelled: false });
		return null;
	});
	map.set('replace_in_files', () => ({ files: 1, replacements: 2 }));
	map.set('compare_dirs', () => [{ path: 'a.txt', status: 'different', leftSize: 1, rightSize: 2 }, { path: 'b.txt', status: 'leftOnly', leftSize: 1, rightSize: 0 }]);
	map.set('viewer_open', () => ({ docId: 1, lineCount: 2, language: 'rust', syntaxName: 'Rust', symbols: [{ kind: 'function', name: 'alpha', line: 0 }] }));
	map.set('viewer_lines', () => ({ startLine: 0, lineCount: 2, lines: [['fn alpha() {}', []], ['fn main() {}', []]] }));
	map.set('encodings', () => [['utf8', 'UTF-8'], ['gb18030', 'GB18030 (GBK)']]);
	map.set('backup_list', () => []);
	return new (class extends Map<string, Handler> {
		override get(command: string) {
			return super.get(command) ?? (() => null);
		}
	})(map);
}

/* ---------- The sweep machinery ---------- */

interface Report {
	surface: string;
	driven: number;
	failures: string[];
}

const report: Report[] = [];
let windowErrors: string[] = [];
let consoleErrors: string[] = [];
/** The error toasts the sweep dismissed (each one a broken action, unless expected). */
let errorToasts: string[] = [];
let workbench: Workbench;

/** Close whatever a click parked on: quick inputs and inline name boxes (Escape), toasts
 *  (their Cancel-like button, else the close), context menus (Escape), the settings dialog. */
function dismissOverlays(): boolean {
	let dismissed = false;
	for (const input of document.querySelectorAll<HTMLInputElement>('.quick-input input, .inline-input')) {
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		dismissed = true;
	}
	for (const toast of document.querySelectorAll<HTMLElement>('#notifications .notification')) {
		// An error toast is a failure in its own right: something the click asked for broke.
		if (toast.querySelector('.codicon-error')) errorToasts.push(toast.querySelector('.message')?.textContent ?? '(no message)');
		const buttons = Array.from(toast.querySelectorAll<HTMLElement>('.buttons .button'));
		const cancel = buttons.find((b) => /cancel|don't save|^no$/i.test(b.textContent ?? ''));
		(cancel ?? toast.querySelector<HTMLElement>('.close') ?? buttons[0])?.click();
		toast.remove();
		dismissed = true;
	}
	if (document.querySelector('.context-menu')) {
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		dismissed = true;
	}
	const settingsClose = document.querySelector<HTMLElement>('.settings-close');
	if (settingsClose) {
		settingsClose.click();
		dismissed = true;
	}
	return dismissed;
}

/** Put the workbench back where the sweep needs it: the repository open, the Explorer
 *  showing, a text editor active, no overlays. */
async function recover(): Promise<void> {
	for (let round = 0; round < 6 && dismissOverlays(); round++) await flush(3);
	if (!workbench.currentRepo) {
		await workbench.openFolder(REPO);
		await flush(8);
	}
	if (workbench.editors.activeView === null) {
		await workbench.editors.openFile(NOTES);
		await flush(6);
	}
	await flush(3);
}

/** Is the element part of the UI a user could reach right now? */
function reachable(element: Element): boolean {
	if (!element.isConnected) return false;
	if (element.closest('[hidden]')) return false;
	if (element.classList.contains('disabled') || (element as HTMLButtonElement).disabled) return false;
	for (let node: Element | null = element; node; node = node.parentElement) {
		if ((node as HTMLElement).style?.display === 'none') return false;
	}
	return true;
}

/** Run one surface's driver, collecting what it drove and every error it caused. */
async function surface(name: string, drive: (count: () => void) => Promise<void>): Promise<void> {
	const entry: Report = { surface: name, driven: 0, failures: [] };
	report.push(entry);
	const before = { window: windowErrors.length, console: consoleErrors.length, toasts: errorToasts.length };
	const started = Date.now();
	try {
		await drive(() => { entry.driven++; });
	} catch (error) {
		entry.failures.push(`threw: ${String(error)}`);
	}
	await recover();
	for (const message of windowErrors.slice(before.window)) entry.failures.push(`window error: ${message}`);
	for (const message of consoleErrors.slice(before.console)) entry.failures.push(`console.error: ${message}`);
	for (const message of errorToasts.slice(before.toasts)) entry.failures.push(`error toast: ${message}`);
}

/** Click every reachable control below `root` matching `selector`, one at a time, dismissing
 *  what each parks on. The list is snapshotted first; controls the earlier clicks removed are
 *  skipped rather than re-found (a close button closes once). */
async function clickAll(root: ParentNode, selector: string, count: () => void, options: { after?: () => Promise<void>; limit?: number } = {}): Promise<void> {
	const targets = Array.from(root.querySelectorAll<HTMLElement>(selector)).slice(0, options.limit ?? 200);
	for (const target of targets) {
		if (!reachable(target)) continue;
		click(target);
		count();
		await flush(4);
		for (let round = 0; round < 4 && dismissOverlays(); round++) await flush(3);
		await options.after?.();
	}
}

/** Drive every entry of the open context menu (the innermost one), re-opening the menu
 *  through `open` for each entry, and walking one level of submenus. */
async function driveMenu(open: () => void, count: () => void, label: string): Promise<void> {
	open();
	await flush(2);
	const menu = document.querySelector('.context-menu');
	if (!menu) throw new Error(`${label}: no menu opened`);
	const total = menu.querySelectorAll('.item').length;
	for (let index = 0; index < total; index++) {
		dismissOverlays();
		await flush(2);
		open();
		await flush(2);
		const item = document.querySelectorAll<HTMLElement>('.context-menu')[0]?.querySelectorAll<HTMLElement>('.item')[index];
		if (!item || !reachable(item)) continue;
		if (item.querySelector('.submenu-indicator')) {
			hover(item);
			await flush(2);
			const submenu = document.querySelectorAll<HTMLElement>('.context-menu')[1];
			const subTotal = submenu?.querySelectorAll('.item').length ?? 0;
			for (let sub = 0; sub < subTotal; sub++) {
				dismissOverlays();
				await flush(2);
				open();
				await flush(2);
				const parent = document.querySelectorAll<HTMLElement>('.context-menu')[0]?.querySelectorAll<HTMLElement>('.item')[index];
				if (!parent) break;
				hover(parent);
				await flush(2);
				const subItem = document.querySelectorAll<HTMLElement>('.context-menu')[1]?.querySelectorAll<HTMLElement>('.item')[sub];
				if (!subItem || !reachable(subItem)) continue;
				click(subItem);
				count();
				await flush(4);
				for (let round = 0; round < 4 && dismissOverlays(); round++) await flush(3);
				await recover();
			}
			continue;
		}
		click(item);
		count();
		await flush(4);
		for (let round = 0; round < 4 && dismissOverlays(); round++) await flush(3);
		await recover();
	}
	dismissOverlays();
}

/** The sidebar view elements, in activity-bar order (explorer, search, scm, extensions). */
function view(index: number): HTMLElement {
	return document.querySelectorAll<HTMLElement>('#sidebar .view')[index]!;
}

async function showView(id: 'explorer' | 'search' | 'scm' | 'extensions' | 'analysis'): Promise<void> {
	await commands.execute({ explorer: 'workbench.showExplorer', search: 'workbench.showSearch', scm: 'workbench.showScm', extensions: 'workbench.showExtensions', analysis: 'workbench.showAnalysis' }[id]);
	await flush(6);
}

/** Dispatch a keybinding ("Ctrl+Shift+P", or a chord "Ctrl+K Ctrl+S") as keydown events. */
function press(binding: string, target: Element | Document = document): void {
	for (const stroke of binding.split(' ')) {
		const parts = stroke.split('+');
		const name = parts[parts.length - 1]!;
		const named: Record<string, string> = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Space: ' ' };
		key(target, named[name] ?? (name.length === 1 ? name.toLowerCase() : name), {
			ctrlKey: parts.includes('Ctrl'),
			shiftKey: parts.includes('Shift'),
			altKey: parts.includes('Alt')
		});
	}
}

beforeAll(async () => {
	await import('../src/textEditor');
	window.addEventListener('error', (event) => windowErrors.push(String(event.error ?? event.message)));
	const originalError = console.error;
	console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); originalError(...args); };
});

// The global beforeEach (setup.ts) resets the backend and the shell per test, so the boot
// belongs to the test itself.
beforeEach(async () => {
	workbench?.dispose();
	shell();
	// jsdom loads no vendor script: a tiny markdown-it stand-in renders the previews.
	(window as unknown as { markdownit: unknown }).markdownit = {
		render: (text: string) => text.split('\n').map((line) => `<p>${line}</p>`).join(''),
		renderer: { rules: {} }
	};
	backend.handlers = richHandlers();
	workbench = new Workbench();
	await workbench.boot();
	await flush(12);
	await recover();
});

describe('the full UI sweep', () => {
	it('boots against the rich repository', () => {
		expect(workbench.currentRepo).toBe(REPO);
	});

	it('title bar menus', { timeout: 120_000 }, async () => {
		await surface('title bar menus', async (count) => {
			const items = Array.from(document.querySelectorAll<HTMLElement>('.menubar-item'));
			expect(items.length).toBeGreaterThan(5);
			for (const item of items) {
				await driveMenu(() => click(item), count, `menu ${item.textContent}`);
			}
			// The window controls and the navigation arrows.
			await clickAll(document.getElementById('titlebar')!, '.titlebar-nav, .command-center, .window-control:not(.close)', count);
		});
	});

	it('activity bar', { timeout: 120_000 }, async () => {
		await surface('activity bar', async (count) => {
			await clickAll(document.getElementById('activitybar')!, '.activity-item', count, { after: async () => { await flush(4); } });
			// A second click on the showing view toggles the sidebar away and back.
			const explorer = document.querySelector<HTMLElement>('.activity-item')!;
			click(explorer); count();
			click(explorer); count();
			await flush(4);
			await showView('explorer');
		});
	});

	it('explorer', { timeout: 120_000 }, async () => {
		await surface('explorer', async (count) => {
			await showView('explorer');
			const explorer = view(0);
			await clickAll(explorer, '.sidebar-title .action-btn, .pane-header .action-btn', count);
			// Expand the folder, then click every row (files open, folders toggle).
			const folder = Array.from(explorer.querySelectorAll<HTMLElement>('.tree .row')).find((r) => r.dataset['dir'] === '1');
			if (folder) { click(folder); count(); await flush(6); }
			await clickAll(explorer, '.tree .row', count, { after: async () => { await flush(4); } });
			// Outcomes: a file row opens (and activates) its tab; F2 offers the name for editing.
			const notesRow = Array.from(explorer.querySelectorAll<HTMLElement>('.tree .row')).find((r) => r.textContent!.includes('notes.txt'))!;
			// The last-clicked row (blob.bin) opens a hex view whose async load re-activates
			// its tab when it lands; let that settle before the click that must win.
			await flush(12);
			click(notesRow); count();
			await flush(6);
			expect(document.querySelector('.editor-group-box.focused .tab.active .label, .tab.active .label')!.textContent).toBe('notes.txt');
			key(explorer.querySelector<HTMLElement>('.pane-body')!, 'F2'); count();
			await flush(2);
			const renameBox = explorer.querySelector<HTMLInputElement>('.inline-input');
			expect(renameBox?.value).toBe('notes.txt');
			expect([renameBox?.selectionStart, renameBox?.selectionEnd]).toEqual([0, 5]); // the stem, as VS Code selects it
			key(renameBox!, 'Escape');
			await flush(2);
			expect(explorer.querySelector('.inline-input')).toBeNull();
			// Keyboard: the tree walks with the arrows, Enter opens, F2 renames, Delete asks.
			const body = explorer.querySelector<HTMLElement>('.pane-body')!;
			click(explorer.querySelector('.tree .row')!);
			for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', 'F2', 'Escape', 'Delete']) {
				key(body, k);
				count();
				await flush(3);
				dismissOverlays();
			}
			// Outcome: the arrow keys expand a collapsed folder and step into it, as VS Code's tree does.
			const srcRow = () => Array.from(explorer.querySelectorAll<HTMLElement>('.tree .row')).find((r) => r.querySelector('.label')?.textContent === 'src')!;
			if (explorer.querySelector('.children[data-parent$="src"]')) { click(srcRow()); await flush(4); } // collapse first
			click(srcRow()); await flush(4); // the click toggles it open...
			click(srcRow()); await flush(4); // ...and closed again, leaving it selected
			key(body, 'ArrowRight'); count(); await flush(6);
			expect(Array.from(explorer.querySelectorAll('.tree .row .label')).map((l) => l.textContent)).toContain('main.rs');
			key(body, 'ArrowRight'); count(); await flush(2);
			expect(explorer.querySelector('.tree .row.selected .label')?.textContent).toBe('main.rs');
			key(body, 'ArrowLeft'); count(); await flush(2);
			expect(explorer.querySelector('.tree .row.selected .label')?.textContent).toBe('src');
			// Every row's context menu, entry by entry.
			for (const row of Array.from(explorer.querySelectorAll<HTMLElement>('.tree .row')).slice(0, 4)) {
				if (!reachable(row)) continue;
				await driveMenu(() => rightClick(row), count, `explorer row ${row.textContent}`);
			}
			// The empty area's menu (the root's).
			await driveMenu(() => rightClick(explorer.querySelector('.pane-body')!), count, 'explorer background');
			// The header collapses and re-expands the tree.
			const header = explorer.querySelector<HTMLElement>('.pane-header')!;
			click(header); count(); await flush(2);
			click(header); count(); await flush(4);
		});
	});

	it('source control', { timeout: 120_000 }, async () => {
		await surface('source control', async (count) => {
			await showView('scm');
			const scm = view(2);
			expect(scm.querySelectorAll('.scm-list .row').length).toBeGreaterThan(3);
			await clickAll(scm, '.scm-main-header .action-btn', count);
			// The "..." menu and its submenus.
			await driveMenu(() => click(scm.querySelector('.scm-main-header .action-btn:last-child')!), count, 'scm more');
			// Group headers (collapse / expand) and their inline actions.
			await clickAll(scm, '.scm-list .pane-header', count);
			await clickAll(scm, '.scm-list .pane-header', count);
			await clickAll(scm, '.scm-list .pane-header .action-btn', count);
			// Every file row opens its diff / file; its inline actions; its context menu.
			await clickAll(scm, '.scm-list .row', count, { after: async () => { await flush(6); } });
			// Outcomes: each kind of row opens what VS Code opens for it (in the flat list, the
			// title toggle above may have left the view as a tree with folders collapsed).
			workbench.scm.setViewMode('list');
			await flush(4);
			const rowNamed = (name: string) => {
				const row = Array.from(scm.querySelectorAll<HTMLElement>('.scm-list .row')).find((r) => r.querySelector('.label')?.textContent === name);
				const listed = Array.from(scm.querySelectorAll('.scm-list .label')).map((l) => l.textContent).join(', ');
				expect(row, `the ${name} row is listed (rows: ${listed})`).toBeDefined();
				return row!;
			};
			const activeTab = () => document.querySelector('.editor-group-box.focused .tab.active .label, .tab.active .label')!.textContent;
			click(rowNamed('main.rs')); await flush(8);
			expect(activeTab()).toBe('main.rs (Index)'); // staged: HEAD vs index
			click(rowNamed('notes.txt')); await flush(8);
			expect(activeTab()).toBe('notes.txt (Working Tree)'); // unstaged: index vs working tree
			click(rowNamed('gone.txt')); await flush(8);
			expect(activeTab()).toBe('gone.txt (Working Tree)'); // deleted: the diff with an empty right side
			click(rowNamed('new.txt')); await flush(8);
			expect(activeTab()).toBe('new.txt'); // untracked: the file itself
			click(rowNamed('conflicted.txt')); await flush(10);
			expect(activeTab()).toBe('conflicted.txt'); // conflicted: the file, with the conflict toolbar
			expect(document.querySelector('.editor-pane:not([hidden]) .merge-bar:not([hidden])')).not.toBeNull();
			count();
			await clickAll(scm, '.scm-list .row .action-btn', count, { after: async () => { await flush(6); } });
			for (const row of Array.from(scm.querySelectorAll<HTMLElement>('.scm-list .row')).slice(0, 5)) {
				if (!reachable(row)) continue;
				await driveMenu(() => rightClick(row), count, `scm row ${row.textContent}`);
			}
			// The commit box: a message, Ctrl+Enter, the Commit button, the "more" dropdown.
			const input = scm.querySelector<HTMLTextAreaElement>('textarea')!;
			type(input, 'sweep commit');
			key(input, 'Enter', { ctrlKey: true }); count();
			await flush(6);
			dismissOverlays();
			type(scm.querySelector<HTMLTextAreaElement>('textarea')!, 'sweep commit');
			await clickAll(scm, '.commit-row .button:not(.more)', count);
			await driveMenu(() => click(scm.querySelector('.commit-row .more')!), count, 'commit actions');
			// Tree view mode: folders collapse and expand.
			await commands.execute('workbench.showScm');
			workbench.scm.setViewMode('tree');
			await flush(4);
			await clickAll(scm, '.scm-folder', count);
			await clickAll(scm, '.scm-folder', count);
			workbench.scm.setViewMode('list');
			await flush(4);
		});
	});

	it('search', { timeout: 120_000 }, async () => {
		await surface('search', async (count) => {
			await showView('search');
			const search = view(1);
			await clickAll(search, '.sidebar-title .action-btn', count);
			const query = search.querySelector<HTMLInputElement>('.query-row input')!;
			type(query, 'one'); count();
			key(query, 'Enter'); count();
			await flush(8);
			expect(search.querySelectorAll('.search-file-group').length).toBeGreaterThan(0);
			// Toggles (with the keyboard too), the replace row, the filter fields.
			await clickAll(search, '.search-toggles .action-btn', count, { after: async () => { await flush(6); } });
			await clickAll(search, '.search-toggles .action-btn', count, { after: async () => { await flush(6); } });
			for (const k of ['c', 'w', 'r']) { key(query, k, { altKey: true }); count(); await flush(6); key(query, k, { altKey: true }); await flush(6); }
			await clickAll(search, '.search-replace-toggle, .search-filters-toggle', count);
			type(search.querySelector<HTMLInputElement>('.replace-row input')!, 'uno'); count();
			for (const input of search.querySelectorAll<HTMLInputElement>('.search-filter-rows input')) { type(input, '*.txt'); count(); await flush(6); type(input, ''); await flush(6); }
			await commands.execute('workbench.showSearch');
			await commands.execute('workbench.replaceInFiles');
			await flush(4);
			// Results: file heads fold, match rows open the file at the match.
			await clickAll(search, '.search-file-head', count);
			await clickAll(search, '.search-file-head', count);
			await clickAll(search, '.search-match', count, { after: async () => { await flush(6); } });
			// Outcome: the second match row lands the cursor at its column.
			const secondMatch = search.querySelectorAll<HTMLElement>('.search-match')[1];
			if (secondMatch) {
				click(secondMatch); await flush(8);
				const view = workbench.editors.activeView!;
				const head = view.state.selection.main.head;
				expect(view.state.doc.lineAt(head).number).toBe(1);
				expect(head - view.state.doc.lineAt(head).from + 1).toBe(9);
				count();
			}
			await clickAll(search, '.sidebar-title .action-btn', count);
			// Replace All asks, then runs.
			type(search.querySelector<HTMLInputElement>('.query-row input')!, 'one');
			await flush(8);
			await clickAll(search, '.replace-row .action-btn', count);
			// An invalid regex reports, an empty query clears.
			await clickAll(search, '.search-toggles .action-btn:last-child', count);
			type(search.querySelector<HTMLInputElement>('.query-row input')!, '(');
			key(search.querySelector<HTMLInputElement>('.query-row input')!, 'Enter');
			await flush(8);
			expect(search.querySelector('.search-error')).not.toBeNull();
			await clickAll(search, '.search-toggles .action-btn:last-child', count);
			type(search.querySelector<HTMLInputElement>('.query-row input')!, '');
			await flush(8);
		});
	});

	it('extensions', { timeout: 120_000 }, async () => {
		await surface('extensions', async (count) => {
			await showView('extensions');
			const extensions = view(3);
			await clickAll(extensions, '.sidebar-title .action-btn, button, .row', count);
			await showView('explorer');
		});
	});

	it('analysis sidebar and pages', { timeout: 120_000 }, async () => {
		await surface('analysis sidebar and pages', async (count) => {
			await showView('analysis');
			const analysis = view(4);
			// The rebuild action and every tool row: each row opens a result page in the
			// editor area, whose report commands are all scripted above.
			await clickAll(analysis, '.pane-header .action-btn, .an-tool', count, { after: async () => { await flush(6); } });
			// The five pages are tabs now; drive every control they own.
			const pages = document.querySelectorAll<HTMLElement>('.an-page');
			for (const page of pages) {
				await clickAll(page, '.an-header .action-btn, .an-toggle, .an-row, .an-cycle', count);
				const filter = page.querySelector<HTMLInputElement>('.an-filter');
				if (filter) type(filter, 'al');
				const checkbox = page.querySelector<HTMLInputElement>('.an-option input');
				if (checkbox) {
					checkbox.checked = true;
					checkbox.dispatchEvent(new Event('change', { bubbles: true }));
					count();
					await flush(4);
				}
				// The module drawing's layout picker rebuilds the G6 graph.
				const layout = page.querySelector<HTMLSelectElement>('.an-layout');
				if (layout) {
					layout.value = 'circular';
					layout.dispatchEvent(new Event('change', { bubbles: true }));
					count();
					await flush(4);
				}
			}
			await showView('explorer');
		});
	});

	it('editor tabs and text menus', { timeout: 120_000 }, async () => {
		await surface('editor tabs and text menus', async (count) => {
			await workbench.editors.openFile(NOTES);
			await workbench.editors.openFile(`${REPO}\\src\\main.rs`);
			await flush(6);
			for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab')).slice(0, 3)) {
				if (!reachable(tab)) continue;
				await driveMenu(() => rightClick(tab), count, `tab ${tab.textContent}`);
			}
			await workbench.editors.openFile(NOTES);
			await flush(4);
			const content = document.querySelector<HTMLElement>('.editor-group-box.focused .cm-content, .cm-content')!;
			await driveMenu(() => rightClick(content), count, 'text context menu');
			await clickAll(document.getElementById('editorGroup')!, '.breadcrumbs .crumb', count);
			await clickAll(document.getElementById('editorGroup')!, '.tab', count);
			// Ctrl+click on the text is Go to Definition.
			click(document.querySelector('.cm-content')!, { ctrlKey: true, button: 0 }); count();
			await flush(6);
			// Tab strip: middle click closes, the wheel scrolls.
			document.querySelector('.tabs-container')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true })); count();
		});
	});

	it('diff editors', { timeout: 120_000 }, async () => {
		await surface('diff editors', async (count) => {
			await showView('scm');
			const rows = Array.from(view(2).querySelectorAll<HTMLElement>('.scm-list .row'));
			// A staged row (HEAD vs index) and an unstaged one (index vs working tree).
			for (const row of rows.slice(0, 3)) { if (reachable(row)) { click(row); await flush(8); } }
			const header = document.querySelector<HTMLElement>('.diff-header');
			expect(header).not.toBeNull();
			// Outcome: the header counts the changes and walks them.
			expect(header!.textContent).toMatch(/\d+ changes?|No changes/);
			await clickAll(document.getElementById('editorGroup')!, '.diff-header .action-btn, .diff-header button', count, { after: async () => { await flush(6); } });
			// F7 / Shift+F7 walk the changes; the layout toggle flips split/inline.
			const pane = document.querySelector<HTMLElement>('.editor-pane:not([hidden]) .cm-content');
			if (pane) { key(pane, 'F7'); count(); key(pane, 'F7', { shiftKey: true }); count(); }
			await flush(4);
			// A commit comparison from the graph's host.
			await workbench.editors.openCompare({ kind: 'compare', id: 'cmp', title: 'Commit 0123456', fromHash: '0123456789abcdef0123456789abcdef01234567', toHash: '0123456789abcdef0123456789abcdef01234567', singleCommit: true });
			await flush(8);
			count();
		});
	});

	it('markdown, image, hex, history, folder compare, call tree, graph', { timeout: 120_000 }, async () => {
		await surface('markdown, image, hex, history, folder compare, call tree, graph', async (count) => {
			await workbench.editors.openFile(`${REPO}\\README.md`);
			await flush(6);
			await clickAll(document.getElementById('editorGroup')!, '.markdown-preview-button', count, { after: async () => { await flush(8); } });
			await commands.execute('markdown.showPreview'); count();
			await flush(8);
			await clickAll(document.getElementById('editorGroup')!, '.markdown-preview-body a, .markdown-preview-body button', count, { limit: 5 });
			// The image preview and its zoom toolbar.
			await workbench.editors.openFile(`${REPO}\\logo.png`);
			await flush(8);
			await clickAll(document.getElementById('editorGroup')!, '.image-preview-toolbar button, .image-preview-toolbar .action-btn', count);
			// The hex viewer: toolbar, a cell, the address box, keys.
			await workbench.editors.openFile(`${REPO}\\blob.bin`);
			await flush(8);
			const hex = document.querySelector<HTMLElement>('.hex-view');
			expect(hex).not.toBeNull();
			await clickAll(hex!, 'button, .action-btn, input[type=checkbox]', count, { after: async () => { await flush(4); } });
			const cell = hex!.querySelector<HTMLElement>('.hex-byte, td, .hex-cell');
			if (cell) { click(cell); count(); await flush(2); }
			for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Tab', 'Escape']) { key(hex!, k); count(); }
			key(hex!, 'g', { ctrlKey: true }); count();
			await flush(3);
			await commands.execute('workbench.openHexViewer'); count();
			await flush(6);
			// File history, blame.
			await workbench.editors.openFile(NOTES);
			await flush(4);
			await commands.execute('git.openFileHistory'); count();
			await flush(8);
			await clickAll(document.getElementById('editorGroup')!, '.file-history .row, .file-history button, .file-history .action-btn', count, { limit: 6, after: async () => { await flush(6); } });
			await workbench.editors.openFile(NOTES);
			await flush(4);
			await commands.execute('git.toggleBlame'); count();
			await flush(8);
			await commands.execute('git.toggleBlame'); count();
			await flush(4);
			// Folder compare and its rows' menus.
			await workbench.editors.openFolderCompare({ kind: 'folders', id: 'fc', left: REPO, right: `${REPO}\\src` });
			await flush(10);
			const compare = document.querySelector<HTMLElement>('.folder-compare');
			expect(compare).not.toBeNull();
			await clickAll(compare!, 'button, .action-btn, .row', count, { limit: 10, after: async () => { await flush(6); } });
			for (const row of Array.from(compare!.querySelectorAll<HTMLElement>('.row')).slice(0, 2)) {
				if (reachable(row)) await driveMenu(() => rightClick(row), count, 'folder compare row');
			}
			// The call tree.
			await workbench.editors.openFile(`${REPO}\\src\\main.rs`);
			await flush(4);
			await commands.execute('editor.callTree'); count();
			await flush(8);
			await clickAll(document.getElementById('editorGroup')!, '.call-tree .row, .call-tree button, .call-tree .action-btn, .call-tree .twistie', count, { limit: 8, after: async () => { await flush(4); } });
			// The Git Graph tab, then every kind's tab closed through its close button.
			await commands.execute('workbench.showGraph'); count();
			await flush(6);
			await clickAll(document.getElementById('editorGroup')!, '.tab .close', count, { after: async () => { await flush(4); } });
		});
	});

	it('panel: terminal and output', { timeout: 120_000 }, async () => {
		await surface('panel: terminal and output', async (count) => {
			await commands.execute('workbench.togglePanel');
			await flush(6);
			const panel = document.getElementById('panel')!;
			await commands.execute('workbench.showOutput');
			await flush(4);
			expect(panel.hidden).toBe(false);
			await clickAll(panel, '.panel-title', count, { after: async () => { await flush(4); } });
			await clickAll(panel, '.panel-title', count, { after: async () => { await flush(4); } });
			await clickAll(panel, '.actions .action-btn:not([title^="Hide"])', count, { after: async () => { await flush(4); } });
			await clickAll(panel, '.terminal-tabs .row', count);
			// Maximize twice (there and back), then hide.
			await clickAll(panel, '.actions .action-btn[title*="Panel Size"]', count);
			await clickAll(panel, '.actions .action-btn[title*="Panel Size"]', count);
			await commands.execute('terminal.new'); count();
			await flush(6);
			expect(workbench.panel.terminal.sessionCount()).toBe(2);
			await commands.execute('terminal.kill'); count();
			await flush(4);
			await clickAll(panel, '.actions .action-btn[title^="Hide"]', count);
			await flush(4);
			expect(panel.hidden).toBe(true);
		});
	});

	it('status bar', { timeout: 120_000 }, async () => {
		await surface('status bar', async (count) => {
			await workbench.editors.openFile(NOTES);
			await flush(4);
			const bar = document.getElementById('statusbar')!;
			expect(bar.querySelectorAll('.status-item:not([hidden])').length).toBeGreaterThan(5);
			// Outcomes: the repo name, the branch and the sync item are three separate
			// buttons, then the Git Graph entry; the counts live on the sync item alone.
			const left = Array.from(bar.querySelectorAll<HTMLElement>('.status-left .status-item'));
			expect(left[0]!.textContent).toContain('git-graph-studio');
			expect(left[1]!.textContent).toContain('main');
			expect(left[1]!.textContent).not.toContain('2');
			expect(left[2]!.hidden).toBe(false);
			expect(left[2]!.textContent).toContain('2');
			expect(left[2]!.textContent).toContain('1');
			expect(left[3]!.textContent).toContain('Git Graph');
			expect(bar.textContent).toContain('1 conflict');
			// Every item's picker opens and is dismissed; each picker's first row is chosen once.
			for (const item of Array.from(bar.querySelectorAll<HTMLElement>('.status-item'))) {
				if (!reachable(item)) continue;
				click(item); count();
				await flush(4);
				const row = document.querySelector<HTMLElement>('.quick-input .row');
				if (row) { click(row); count(); await flush(6); }
				await recover();
			}
			// The notification centre: a toast, the bell, the clear-all.
			await commands.execute('help.about'); count();
			await flush(2);
			await clickAll(bar, '.status-item[title="Notifications"]', count);
			await clickAll(document.body, '.notification-center .action-btn, .notification-center button, .notification-center .close', count, { limit: 6 });
			await clickAll(bar, '.status-item[title="Notifications"]', count);
		});
	});

	it('settings dialog', { timeout: 120_000 }, async () => {
		await surface('settings dialog', async (count) => {
			const before = { ...settings };
			await commands.execute('workbench.openSettings');
			await flush(4);
			// Every change re-renders the dialog's rows, so controls are re-found by position.
			const dialog = () => document.querySelector<HTMLElement>('.settings-dialog')!;
			expect(dialog()).not.toBeNull();
			const navs = () => Array.from(dialog().querySelectorAll<HTMLElement>('.settings-nav-item'));
			const label = (control: Element) => control.closest('.settings-row')?.querySelector('.settings-row-label')?.textContent ?? '?';
			for (let n = 0; n < navs().length; n++) {
				click(navs()[n]!); count();
				await flush(2);
				expect(dialog(), 'the dialog stays open across categories').not.toBeNull();
				// Workbench settings live in the one settings object, so a control's effect is
				// asserted against it. The Extensions category's rows are extension-declared
				// settings, persisted per extension under their own store (state.extSettings);
				// their controls are asserted by the control state itself flipping, which holds
				// regardless of how the store spells the written-back default.
				const isExtensions = navs()[n]!.textContent === 'Extensions';
				const snapshot = () => isExtensions
					? JSON.stringify(Array.from(dialog().querySelectorAll<HTMLInputElement>('.settings-checkbox')).map((box) => box.checked))
					: JSON.stringify(settings);
				// Outcome: a checkbox flips a setting, and flips it back.
				const boxes = () => Array.from(dialog().querySelectorAll<HTMLInputElement>('.settings-checkbox'));
				for (let i = 0; i < boxes().length; i++) {
					const snap = snapshot();
					const name = label(boxes()[i]!);
					click(boxes()[i]!); count(); await flush(3);
					expect(snapshot(), `checkbox ${name} changes a setting`).not.toBe(snap);
					click(boxes()[i]!); count(); await flush(3);
					expect(snapshot(), `checkbox ${name} flips back`).toBe(snap);
				}
				// Outcome: every option of a select changes a setting; the original is restored.
				const selects = () => Array.from(dialog().querySelectorAll<HTMLSelectElement>('.settings-select'));
				for (let i = 0; i < selects().length; i++) {
					const original = selects()[i]!.value;
					const name = label(selects()[i]!);
					for (const value of Array.from(selects()[i]!.options).map((o) => o.value)) {
						if (value === selects()[i]!.value) continue;
						const snap = snapshot();
						const select = selects()[i]!;
						select.value = value;
						select.dispatchEvent(new Event('change', { bubbles: true })); count();
						await flush(6);
						if (!isExtensions) expect(snapshot(), `select ${name} = ${value} changes a setting`).not.toBe(snap);
						expect(selects()[i]!.value, `select ${name} took the option`).toBe(value);
					}
					const select = selects()[i]!;
					select.value = original;
					select.dispatchEvent(new Event('change', { bubbles: true }));
					await flush(6);
					expect(selects()[i]!.value, `select ${name} shows the restored value`).toBe(original);
				}
				// Outcome: a number input steps its setting and is clamped to its bounds.
				const inputs = () => Array.from(dialog().querySelectorAll<HTMLInputElement>('.settings-input'));
				for (let i = 0; i < inputs().length; i++) {
					const input = inputs()[i]!;
					const original = input.value;
					const name = label(input);
					if (input.type !== 'number') continue;
					const snap = snapshot();
					type(input, String(Number(input.min || 0) + Number(input.step || 1))); count();
					input.dispatchEvent(new Event('change', { bubbles: true }));
					await flush(3);
					if (!isExtensions) expect(snapshot(), `number ${name} changes a setting`).not.toBe(snap);
					type(inputs()[i]!, String(Number(input.max || 0) + 1000));
					inputs()[i]!.dispatchEvent(new Event('change', { bubbles: true }));
					await flush(3);
					// Extension-declared settings may not spell a maximum; only a declared one clamps.
					if (input.max) expect(inputs()[i]!.value, `number ${name} is clamped to its maximum`).toBe(input.max);
					type(inputs()[i]!, original);
					inputs()[i]!.dispatchEvent(new Event('change', { bubbles: true }));
					await flush(3);
				}
			}
			// The search box filters across categories.
			const search = dialog().querySelector<HTMLInputElement>('.settings-header input');
			if (search) {
				type(search, 'auto'); count(); await flush(3);
				expect(dialog().querySelectorAll('.settings-row').length).toBeGreaterThan(0);
				type(search, ''); await flush(3);
			}
			click(dialog().querySelector('.settings-close')!); count();
			await flush(2);
			expect(document.querySelector('.settings-dialog')).toBeNull();
			expect(JSON.stringify(settings), 'every control was put back').toBe(JSON.stringify(before));
			await flush(4);
		});
	});

	it('keyboard shortcuts editor and welcome page', { timeout: 120_000 }, async () => {
		await surface('keyboard shortcuts editor and welcome page', async (count) => {
			await commands.execute('help.shortcuts');
			await flush(6);
			const list = document.querySelector<HTMLElement>('.shortcuts-list');
			expect(list).not.toBeNull();
			type(document.querySelector<HTMLInputElement>('.shortcuts-filter')!, 'save'); count();
			await flush(2);
			// Record a key for the first row, then reset it.
			const cell = list!.querySelector<HTMLElement>('kbd');
			if (cell) {
				click(cell); count();
				key(document.querySelector('.editor-pane:not([hidden])')!, 'F9');
				await flush(4);
				await clickAll(list!, '.kb-actions .action-btn', count);
			}
			type(document.querySelector<HTMLInputElement>('.shortcuts-filter')!, '');
			await flush(2);
			await commands.execute('help.welcome');
			await flush(6);
			await clickAll(document.getElementById('editorGroup')!, '.welcome button, .welcome a, .welcome .row, .welcome-inner button, .welcome-inner .row', count, { limit: 12, after: async () => { await flush(4); } });
		});
	});

	it('quick open modes and pickers', { timeout: 120_000 }, async () => {
		await surface('quick open modes and pickers', async (count) => {
			for (const initial of ['', 'not', '>', '>git', ':', ':2', ':1:3', '@']) {
				await workbench.editors.openFile(NOTES);
				await flush(2);
				void workbench.quickOpen(initial); count();
				await flush(8);
				const input = document.querySelector<HTMLInputElement>('.quick-input input');
				expect(input, `quick open "${initial}"`).not.toBeNull();
				key(input!, 'ArrowDown'); key(input!, 'ArrowUp'); key(input!, 'Enter'); count();
				await flush(6);
				await recover();
			}
			// The symbol pickers.
			await workbench.editors.openFile(`${REPO}\\src\\main.rs`);
			await flush(4);
			for (const id of ['workbench.gotoSymbolInFile', 'workbench.gotoSymbolInWorkspace', 'editor.listBookmarks', 'git.checkout']) {
				void commands.execute(id); count();
				await flush(8);
				const row = document.querySelector<HTMLElement>('.quick-input .row');
				if (row) { click(row); count(); await flush(6); }
				await recover();
			}
		});
	});

	it('every keybinding', { timeout: 120_000 }, async () => {
		await surface('every keybinding', async (count) => {
			for (const command of commands.all()) {
				const binding = command.keybinding;
				if (!binding) continue;
				if (command.id === 'workbench.exit' || command.id === 'workbench.closeFolder') continue;
				await workbench.editors.openFile(NOTES);
				await flush(2);
				press(binding, document.querySelector('.cm-content') ?? document); count();
				await flush(6);
				await recover();
			}
			// The editor's own keys, on the text.
			await workbench.editors.openFile(NOTES);
			await flush(2);
			const content = document.querySelector<HTMLElement>('.cm-content')!;
			for (const binding of ['Ctrl+D', 'Ctrl+Shift+L', 'Ctrl+L', 'Ctrl+F2', 'Ctrl+H', 'Ctrl+Shift+Enter', 'Ctrl+Enter', 'Alt+Up', 'Alt+Down', 'Shift+Alt+Down', 'Ctrl+Shift+K', 'Ctrl+/', 'Ctrl+]', 'Ctrl+[', 'F3', 'Shift+F3', 'Escape', 'Tab', 'Ctrl+Z', 'Ctrl+Y']) {
				press(binding, content); count();
				await flush(3);
				dismissOverlays();
			}
			await recover();
		});
	});

	it('sidebar and panel sashes, window resize', { timeout: 120_000 }, async () => {
		await surface('sidebar and panel sashes, window resize', async (count) => {
			for (const sash of ['sidebarSash', 'panelSash']) {
				const element = document.getElementById(sash)!;
				element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 300 })); count();
				document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 260, clientY: 260 }));
				document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 260, clientY: 260 }));
				await flush(2);
			}
			window.dispatchEvent(new Event('resize')); count();
			window.dispatchEvent(new Event('blur')); count();
			window.dispatchEvent(new Event('focus')); count();
			await flush(6);
		});
	});

	it('folder lifecycle', { timeout: 120_000 }, async () => {
		await surface('folder lifecycle', async (count) => {
			await commands.execute('workbench.closeFolder'); count();
			await flush(6);
			expect(workbench.currentRepo).toBeNull();
			// The empty-state surfaces: the Explorer's Open Folder button, the welcome page.
			await clickAll(document.getElementById('sidebar')!, '.welcome-view button', count);
			await clickAll(document.getElementById('editorGroup')!, '.welcome button, .welcome .row', count, { limit: 8, after: async () => { await flush(4); } });
			await workbench.openFolder(REPO); count();
			await flush(10);
			expect(workbench.currentRepo).toBe(REPO);
		});
	});

	it('reports every surface and finds no failure', () => {
		// The report: every surface, what it drove, what broke.
		const lines = ['# UI sweep report', '', '| Surface | Driven | Failures |', '| --- | ---: | --- |'];
		for (const entry of report) lines.push(`| ${entry.surface} | ${entry.driven} | ${entry.failures.length === 0 ? '-' : entry.failures.join('<br>')} |`);
		const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'target', 'studio', 'ui-sweep-report.md');
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, lines.join('\n') + '\n');

		const failures = report.flatMap((entry) => entry.failures.map((failure) => `${entry.surface}: ${failure}`));
		expect(failures).toEqual([]);
		expect(report.reduce((sum, entry) => sum + entry.driven, 0)).toBeGreaterThan(300);
		expect(windowErrors).toEqual([]);
	});
});
