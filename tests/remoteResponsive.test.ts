// Remote Access, the responsive shell (module 19, docs/ggs-remote-plan.md §11, §17.3): form
// factor detection, context menus as the phone's action sheet, the phone's page model with
// its app bar, bottom navigation, drawer, open editors sheet and editing row, long-press as
// contextmenu, the terminal key row, the page stack and the edit lock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formFactorFor, initResponsive, formFactor } from '../src/remote/responsive';
import { installActionSheet, closeActionSheet, showActionSheet } from '../src/remote/actionSheet';
import { createBottomTabs } from '../src/remote/bottomTabs';
import { createAppBar, pageHeading, relativeFolder } from '../src/remote/appBar';
import { createEditorEmptyState, editorActionEntries, openEditorsSheet } from '../src/remote/editorSwitcher';
import { ACCESSORY_KEYS, createEditorAccessory } from '../src/remote/editorAccessory';
import { closeDrawer, drawerOpen, openDrawer } from '../src/remote/navDrawer';
import { currentPage, editorPlaceholderShown, resetWorkbenchWatch } from '../src/remote/pages';
import { editableFocused, keyboardOpen } from '../src/remote/responsive';
import { applyContributions, removeContributions } from '../src/contributions';
import { installLongPress, LONG_PRESS_MS } from '../src/remote/gestures';
import { createTerminalKeys } from '../src/remote/terminalKeys';
import { TERMINAL_SEND_EVENT } from '../src/terminal';
import { Panel } from '../src/panel';
import { showContextMenu, setMenuPresenter, type MenuEntry, type MenuItem } from '../src/ui';
import { commands } from '../src/commands';
import { EditorGroup } from '../src/editor';
import { backend } from './tauriMock';
import { click } from './helpers';

function setWidth(width: number): void {
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
	window.dispatchEvent(new Event('resize'));
}

function setCoarse(coarse: boolean): void {
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('coarse'), addEventListener: () => undefined, removeEventListener: () => undefined }));
}

afterEach(() => {
	setMenuPresenter(null);
	closeActionSheet();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe('form factors', () => {
	it('follow the width breakpoints', () => {
		expect(formFactorFor(390)).toBe('phone');
		expect(formFactorFor(820)).toBe('tablet');
		expect(formFactorFor(1440)).toBe('desktop');
	});

	it('are written onto <html> and follow resizes', () => {
		setCoarse(true);
		setWidth(390);
		const stop = initResponsive();
		expect(document.documentElement.dataset.formFactor).toBe('phone');
		expect(document.documentElement.dataset.pointer).toBe('coarse');
		expect(document.documentElement.classList.contains('remote-shell')).toBe(true);
		setWidth(1300);
		expect(document.documentElement.dataset.formFactor).toBe('desktop');
		expect(formFactor()).toBe('desktop');
		stop();
	});
});

describe('action sheet', () => {
	it('replaces context menus on a touch phone only', () => {
		document.body.innerHTML = '<div id="overlays"></div>';
		setCoarse(true);
		setWidth(390);
		const stop = initResponsive();
		installActionSheet();
		const run = vi.fn();
		showContextMenu(10, 10, [{ label: 'Rename', run }, 'separator', { label: 'Delete', disabled: true }]);
		const sheet = document.querySelector('.ggs-action-sheet')!;
		expect(sheet).not.toBeNull();
		expect(document.querySelector('.context-menu')).toBeNull();
		const rows = [...sheet.querySelectorAll<HTMLButtonElement>('.row')];
		expect(rows.map((r) => r.textContent)).toEqual(['Rename', 'Delete', 'Cancel']);
		expect(rows[1].disabled).toBe(true);
		rows[0].click();
		expect(run).toHaveBeenCalled();
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();

		setWidth(1300);
		showContextMenu(10, 10, [{ label: 'Rename', run }]);
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
		expect(document.querySelector('.context-menu')).not.toBeNull();
		stop();
	});
});

// The phone's page model (pages.ts) over a stand-in workbench: the side bar, the panel, the
// activity bar the navigation mirrors and one editor group, with the workbench's own view
// commands mirrored onto that DOM — the shell reaches the workbench only through the command
// registry, so the stand-ins prove the end states.
function phoneWorkbench(): { ran: string[]; sidebar: HTMLElement; panel: HTMLElement; group: HTMLElement } {
	document.documentElement.setAttribute('data-remote-shell', '');
	document.documentElement.dataset['formFactor'] = 'phone';
	document.title = 'ws - Git Graph Studio';
	document.body.innerHTML = [
		'<div id="titlebar"></div>',
		'<div id="activitybar"><div class="activity-item active" data-view="explorer"></div><div class="activity-item" data-view="search"></div>',
		'<div class="activity-item" data-view="scm"><span class="badge">3</span></div><div class="activity-spacer"></div></div>',
		'<div id="sidebar"></div>',
		'<div id="editorPart"><div id="editorGroup"><div class="editor-group-box focused"><div class="tabs-container"></div></div></div><div id="panel" hidden></div></div>',
		'<div id="statusbar"><div class="status-item" data-item="branch">main</div></div>'
	].join('');
	const ran: string[] = [];
	const sidebar = document.getElementById('sidebar')!;
	const panel = document.getElementById('panel')!;
	const show = (view: string) => {
		sidebar.hidden = false;
		for (const item of document.querySelectorAll<HTMLElement>('#activitybar .activity-item')) item.classList.toggle('active', item.dataset.view === view);
	};
	const stub = (id: string, run: () => void) => commands.register({ id, title: id, run: () => { ran.push(id); run(); } });
	stub('workbench.showExplorer', () => show('explorer'));
	stub('workbench.showSearch', () => show('search'));
	stub('workbench.showScm', () => show('scm'));
	stub('workbench.toggleSidebar', () => { sidebar.hidden = !sidebar.hidden; });
	stub('workbench.togglePanel', () => { panel.hidden = !panel.hidden; });
	stub('terminal.toggle', () => { sidebar.hidden = true; panel.hidden = false; });
	return { ran, sidebar, panel, group: document.querySelector<HTMLElement>('.editor-group-box .tabs-container')! };
}

/** One tab in the stand-in strip, shaped as editor.ts renders it. */
function addTab(strip: HTMLElement, label: string, options: { path?: string; active?: boolean; dirty?: boolean; ext?: string } = {}): HTMLElement {
	const tab = document.createElement('div');
	tab.className = 'tab' + (options.active ? ' active' : '') + (options.dirty ? ' dirty' : '');
	tab.title = options.path ?? label;
	tab.dataset.kind = options.ext ? 'extpage' : 'file';
	if (options.ext) tab.dataset.ext = options.ext;
	tab.innerHTML = `<span class="icon"></span><span class="label">${label}</span><span class="close"></span>`;
	tab.addEventListener('click', () => {
		for (const other of strip.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
		document.getElementById('sidebar')!.hidden = true;
		document.getElementById('panel')!.hidden = true;
	});
	strip.appendChild(tab);
	return tab;
}

function leavePhone(): void {
	resetWorkbenchWatch();
	removeContributions('preview.graph');
	delete document.documentElement.dataset['formFactor'];
	document.documentElement.removeAttribute('data-remote-shell');
}

describe('bottom navigation', () => {
	afterEach(leavePhone);

	it('shows its page on every tap — never toggles it away — and a second tap reselects', async () => {
		const { ran, sidebar, group } = phoneWorkbench();
		const reselected: string[] = [];
		const bar = createBottomTabs((page) => void reselected.push(page));
		document.body.appendChild(bar);
		const tab = (id: string) => bar.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)!;
		expect([...bar.querySelectorAll('button')].map((button) => button.dataset.tab)).toEqual(['explorer', 'editor', 'scm', 'panel', 'search']);
		expect(tab('explorer').classList.contains('active')).toBe(true);
		expect(tab('scm').querySelector('.badge')!.textContent).toBe('3');
		tab('scm').click();
		await flushMutations();
		expect(ran).toEqual(['workbench.showScm']);
		expect(tab('scm').classList.contains('active')).toBe(true);
		// The page already showing: a reselect, not a toggle (the old bar hid the side view).
		tab('scm').click();
		expect(reselected).toEqual(['scm']);
		expect(sidebar.hidden).toBe(false);
		// The Editor: the side view gives way; a file open counts on the badge, its unsaved
		// state colours it.
		addTab(group, 'a.ts', { path: '/home/u/ws/src/a.ts', active: true, dirty: true });
		tab('editor').click();
		await flushMutations();
		expect(sidebar.hidden).toBe(true);
		expect(tab('editor').classList.contains('active')).toBe(true);
		expect(tab('editor').querySelector('.badge')!.textContent).toBe('1');
		expect(tab('editor').querySelector('.badge')!.classList.contains('dirty')).toBe(true);
		tab('editor').click();
		expect(reselected).toEqual(['scm', 'editor']);
		// Terminal: the panel page; the Editor then takes the page back from it.
		tab('panel').click();
		await flushMutations();
		expect(currentPage()).toBe('panel');
		tab('editor').click();
		await flushMutations();
		expect(document.getElementById('panel')!.hidden).toBe(true);
		expect(currentPage()).toBe('editor');
	});

	it('carries the extensions\' pages — a scm/title launcher and a views container — in place of Terminal and Search', async () => {
		const { group } = phoneWorkbench();
		let launched = 0;
		applyContributions('preview.graph', {
			commands: [{ command: 'preview.graph.view', title: 'View Git Graph (git log)', icon: '$(git-merge)' }],
			menus: { 'scm/title': [{ command: 'preview.graph.view', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		// After the manifest: applying it registers the command as the extension's dispatch.
		commands.register({
			id: 'preview.graph.view',
			title: 'View Graph',
			run: () => {
				launched++;
				addTab(group, 'Git Graph', { ext: 'preview.graph' }).click();
			}
		});
		const container = document.createElement('div');
		container.className = 'activity-item';
		container.dataset.view = 'ext-container:anthropic.claude-code.claude-sidebar';
		container.title = 'Claude Code';
		let containerClicks = 0;
		container.addEventListener('click', () => {
			containerClicks++;
			document.getElementById('sidebar')!.hidden = false;
			for (const item of document.querySelectorAll<HTMLElement>('#activitybar .activity-item')) item.classList.toggle('active', item === container);
		});
		document.querySelector('#activitybar .activity-spacer')!.before(container);
		const bar = createBottomTabs();
		document.body.appendChild(bar);
		await flushMutations();
		expect([...bar.querySelectorAll('button')].map((button) => button.dataset.tab)).toEqual(['explorer', 'editor', 'scm', 'launch:preview.graph.view', 'ext-container:anthropic.claude-code.claude-sidebar']);
		const tab = (id: string) => bar.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)!;
		expect(tab('launch:preview.graph.view').textContent).toBe('Git Graph');
		tab('ext-container:anthropic.claude-code.claude-sidebar').click();
		tab('ext-container:anthropic.claude-code.claude-sidebar').click();
		// The container's activity item toggles, so the page showing is never clicked again.
		expect(containerClicks).toBe(1);
		// The launcher runs once; its open page is then revealed, not relaunched.
		tab('launch:preview.graph.view').click();
		await flushMutations();
		expect(launched).toBe(1);
		expect(currentPage()).toBe('launch:preview.graph.view');
		tab('explorer').click();
		await flushMutations();
		tab('launch:preview.graph.view').click();
		await flushMutations();
		expect(launched).toBe(1);
		expect(currentPage()).toBe('launch:preview.graph.view');
		// The Editor over an extension page with no file open: the empty state, not the graph.
		tab('editor').click();
		await flushMutations();
		expect(currentPage()).toBe('editor');
		expect(editorPlaceholderShown()).toBe(true);
		const empty = createEditorEmptyState();
		document.body.appendChild(empty);
		expect(empty.hidden).toBe(false);
		// …which lists what is open, one tap from it.
		expect([...empty.querySelectorAll('.ggs-editor-row .name')].map((name) => name.textContent)).toEqual(['Git Graph']);
	});
});

describe('app bar', () => {
	afterEach(leavePhone);

	it('names the page: the file and its folder, the branch and its changes', () => {
		const { group } = phoneWorkbench();
		expect(pageHeading('scm')).toEqual({ title: 'Source Control', subtitle: 'main · 3 changes' });
		expect(pageHeading('explorer')).toEqual({ title: 'Files', subtitle: 'ws' });
		addTab(group, 'a.ts', { path: '/home/u/ws/src/remote/a.ts', active: true, dirty: true });
		expect(pageHeading('editor')).toEqual({ title: 'a.ts', subtitle: 'src/remote', dirty: true, switcher: true });
		expect(relativeFolder('C:\\work\\ws\\README.md', 'ws')).toBe('');
		expect(relativeFolder('/elsewhere/lib/x.ts', 'ws')).toBe('lib');
	});

	it('opens the drawer and, on the Editor only, the open editors list', async () => {
		const { group } = phoneWorkbench();
		const opened: string[] = [];
		const bar = createAppBar({ openDrawer: () => void opened.push('drawer'), openEditors: () => void opened.push('editors'), editorActions: () => void opened.push('actions') });
		document.body.prepend(bar);
		const heading = bar.querySelector<HTMLElement>('.ggs-appbar-heading')!;
		expect(heading.querySelector('.text')!.textContent).toBe('Files');
		heading.click();
		expect(opened).toEqual([]);
		bar.querySelector<HTMLElement>('.ggs-appbar-btn.leading')!.click();
		addTab(group, 'a.ts', { path: '/home/u/ws/a.ts', active: true });
		document.getElementById('sidebar')!.hidden = true;
		await flushMutations();
		expect(heading.querySelector('.text')!.textContent).toBe('a.ts');
		expect(bar.dataset.page).toBe('editor');
		heading.click();
		[...bar.querySelectorAll<HTMLElement>('.ggs-appbar-actions .ggs-appbar-btn')].pop()!.click();
		expect(opened).toEqual(['drawer', 'editors', 'actions']);
	});
});

describe('open editors sheet', () => {
	afterEach(leavePhone);

	it('lists every tab, switches on a tap and closes through the tab\'s own button', () => {
		const { group } = phoneWorkbench();
		const a = addTab(group, 'a.ts', { path: '/home/u/ws/src/a.ts', active: true });
		const b = addTab(group, 'b.ts', { path: '/home/u/ws/b.ts', dirty: true });
		let closed = 0;
		b.querySelector('.close')!.addEventListener('click', () => closed++);
		openEditorsSheet();
		const rows = () => [...document.querySelectorAll<HTMLElement>('.ggs-editors-sheet .ggs-editor-row')];
		expect(rows().map((row) => row.querySelector('.name')!.textContent)).toEqual(['a.ts', 'b.ts']);
		expect(rows()[0]!.classList.contains('current')).toBe(true);
		expect(rows()[1]!.querySelector('.dirty-dot')).not.toBeNull();
		expect(rows()[0]!.querySelector('.folder')!.textContent).toBe('src');
		rows()[1]!.querySelector<HTMLElement>('.ggs-sheet-btn')!.click();
		expect(closed).toBe(1);
		rows()[1]!.click();
		expect(b.classList.contains('active')).toBe(true);
		expect(a.classList.contains('active')).toBe(false);
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
	});

	it('offers the editor\'s actions with their live enablement', () => {
		const { group } = phoneWorkbench();
		addTab(group, 'a.md', { path: '/home/u/ws/a.md', active: true });
		commands.register({ id: 'workbench.save', title: 'Save', enabled: () => false, run: () => undefined });
		const items = editorActionEntries().filter((entry): entry is MenuItem => entry !== 'separator');
		expect(items.find((entry) => entry.label === 'Save')!.disabled).toBe(true);
		expect(items.map((entry) => entry.label)).toContain('Open Preview');
		expect(items.map((entry) => entry.label)).toContain('More Tab Actions…');
	});
});

/** MutationObserver callbacks run as microtasks. */
async function flushMutations(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('long press', () => {
	it('becomes a contextmenu at the finger, and swallows the click that ends it', () => {
		vi.useFakeTimers();
		const row = document.createElement('div');
		document.body.appendChild(row);
		const menu = vi.fn();
		const click = vi.fn();
		row.addEventListener('contextmenu', (e) => menu((e as MouseEvent).clientX));
		row.addEventListener('click', click);
		const stop = installLongPress(document);
		const pointer = (type: string, x = 40) => {
			const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 20 }) as MouseEvent & { pointerType: string };
			Object.defineProperty(event, 'pointerType', { value: 'touch' });
			row.dispatchEvent(event);
		};
		pointer('pointerdown');
		vi.advanceTimersByTime(LONG_PRESS_MS + 10);
		pointer('pointerup');
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(menu).toHaveBeenCalledWith(40);
		expect(click).not.toHaveBeenCalled();
		// A moving finger is a scroll, not a press.
		pointer('pointerdown');
		pointer('pointermove', 80);
		vi.advanceTimersByTime(LONG_PRESS_MS + 10);
		expect(menu).toHaveBeenCalledTimes(1);
		stop();
		vi.useRealTimers();
	});
});

describe('terminal key row', () => {
	it('sends keys, with a sticky Ctrl', () => {
		const sent: string[] = [];
		const listener = (e: Event) => sent.push((e as CustomEvent<string>).detail);
		window.addEventListener(TERMINAL_SEND_EVENT, listener);
		const row = createTerminalKeys();
		document.body.appendChild(row);
		const key = (label: string) => [...row.querySelectorAll('button')].find((b) => b.textContent === label)!;
		key('Tab').click();
		key('Ctrl').click();
		expect(key('Ctrl').classList.contains('on')).toBe(true);
		key('|').click();
		key('↑').click();
		window.removeEventListener(TERMINAL_SEND_EVENT, listener);
		expect(sent).toEqual(['\t', String.fromCharCode('|'.charCodeAt(0)), `${String.fromCharCode(27)}[A`]);
		expect(key('Ctrl').classList.contains('on')).toBe(false);
	});
});

// The drawer (navDrawer.ts): every page, the workspace actions, and the full menus — the menu
// bar is hidden on a phone, so its menus open here as sheets, enablement computed at open.
describe('navigation drawer', () => {
	afterEach(() => {
		closeDrawer();
		closeActionSheet();
		leavePhone();
	});

	it('goes to any page and serves the menus as sheets', async () => {
		const { ran } = phoneWorkbench();
		const menuRan: string[] = [];
		const menus = () => [
			{ label: 'File', entries: (): MenuEntry[] => [{ label: 'New File', run: () => void menuRan.push('new') }, 'separator', { label: 'Never', disabled: true, run: () => void menuRan.push('never') }] }
		];
		openDrawer(menus);
		const drawer = document.querySelector('.ggs-drawer')!;
		expect(drawer.querySelector('.workspace')!.textContent).toBe('ws');
		expect(drawer.querySelector('.meta')!.textContent).toContain('main');
		const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.ggs-drawer-row')].find((candidate) => candidate.querySelector('.label')!.textContent === label)!;
		expect(row('Files').classList.contains('active')).toBe(true);
		expect(row('Source Control').querySelector('.count')!.textContent).toBe('3');
		row('File').click();
		expect(drawerOpen()).toBe(false);
		const entries = [...document.querySelectorAll<HTMLButtonElement>('.ggs-action-sheet .row')];
		expect(entries.map((entry) => entry.textContent)).toEqual(['New File', 'Never', 'Cancel']);
		expect(entries[1]!.disabled).toBe(true);
		entries[0]!.click();
		expect(menuRan).toEqual(['new']);
		openDrawer(menus);
		row('Search').click();
		await flushMutations();
		expect(ran).toEqual(['workbench.showSearch']);
	});

	it('closes on the phone\'s back, like every sheet', () => {
		phoneWorkbench();
		openDrawer(() => []);
		expect(drawerOpen()).toBe(true);
		window.dispatchEvent(new PopStateEvent('popstate'));
		expect(drawerOpen()).toBe(false);
		showActionSheet([{ label: 'One', run: () => undefined }]);
		expect(document.querySelector('.ggs-action-sheet')).not.toBeNull();
		window.dispatchEvent(new PopStateEvent('popstate'));
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
	});
});

describe('keyboard and the editing row', () => {
	afterEach(leavePhone);

	it('reads a raised keyboard off the viewport and the focus', () => {
		expect(keyboardOpen(420, 844, true)).toBe(true);
		expect(keyboardOpen(800, 844, true)).toBe(false);
		expect(keyboardOpen(420, 844, false)).toBe(false);
		document.body.innerHTML = '<input id="t"><input id="c" type="checkbox"><textarea id="a" readonly></textarea>';
		expect(editableFocused(document.getElementById('t'))).toBe(true);
		expect(editableFocused(document.getElementById('c'))).toBe(false);
		expect(editableFocused(document.getElementById('a'))).toBe(false);
	});

	it('runs its command keys and sends the editor its own key events', () => {
		phoneWorkbench();
		const ran: string[] = [];
		commands.register({ id: 'editor.undo', title: 'Undo', run: () => void ran.push('undo') });
		const row = createEditorAccessory();
		document.body.appendChild(row);
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		const content = document.createElement('div');
		content.tabIndex = 0;
		// jsdom computes no isContentEditable; the browser does for CodeMirror's content.
		Object.defineProperty(content, 'isContentEditable', { value: true });
		editor.appendChild(content);
		document.body.appendChild(editor);
		content.focus();
		const keys: string[] = [];
		content.addEventListener('keydown', (event) => {
			keys.push(event.key);
			event.preventDefault();
		});
		row.querySelector<HTMLButtonElement>('[data-key="undo"]')!.click();
		row.querySelector<HTMLButtonElement>('[data-key="left"]')!.click();
		row.querySelector<HTMLButtonElement>('[data-key="tab"]')!.click();
		expect(ran).toEqual(['undo']);
		expect(keys).toEqual(['ArrowLeft', 'Tab']);
		row.querySelector<HTMLButtonElement>('[data-key="done"]')!.click();
		expect(document.activeElement).not.toBe(content);
		expect(ACCESSORY_KEYS.every((key) => key.label().length > 0)).toBe(true);
	});
});

// The phone's page stack (§11.2): the side bar is a full-screen page laid over the
// workbench, so whatever opens beneath it — an editor activating, the panel showing —
// dismisses it, the way tapping an item in a phone app's list navigates to its detail page.
describe('phone page stack', () => {
	const files = () => backend.on('read_file', ({ path }) => {
		const text = String(path).endsWith('b.txt') ? 'the second file\n' : 'line one\nline two\n';
		return { contents: text, binary: false, size: text.length };
	});

	function shellForm(factor: 'phone' | 'tablet'): void {
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.dataset['formFactor'] = factor;
	}

	afterEach(() => {
		delete document.documentElement.dataset['formFactor'];
		document.documentElement.removeAttribute('data-remote-shell');
	});

	/** The workbench's own toggle mirrored onto the test DOM: the dismissal crosses the
	 *  module boundary through the command registry, so the stand-in proves the end state. */
	function openSideView(): HTMLElement {
		const sidebar = document.getElementById('sidebar')!;
		sidebar.hidden = false;
		commands.register({ id: 'workbench.toggleSidebar', title: '', run: () => { sidebar.hidden = !sidebar.hidden; } });
		return sidebar;
	}

	it('an editor opening dismisses the full-screen side view, and so does re-opening its tab', async () => {
		shellForm('phone');
		files();
		const sidebar = openSideView();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\a.txt');
		expect(sidebar.hidden).toBe(true);
		// The already-open tab: tapping it in the explorer is still a navigation.
		sidebar.hidden = false;
		await group.openFile('C:\\repo\\a.txt');
		expect(sidebar.hidden).toBe(true);
	});

	it('the panel showing dismisses the side view, and a covered panel is revealed, not toggled away', () => {
		shellForm('phone');
		const sidebar = openSideView();
		backend.on('pty_create', () => 'ggs-bash');
		const panel = new Panel(document.getElementById('panel')!);
		panel.show('output');
		expect(sidebar.hidden).toBe(true);
		// The side view over an already-visible panel: the toggle reveals it — the user has
		// never seen it, so hiding it would read as "the terminal button does nothing".
		sidebar.hidden = false;
		panel.toggle('terminal');
		expect(sidebar.hidden).toBe(true);
		expect(panel.isVisible()).toBe(true);
		// Uncovered, the toggle hides as on the desktop.
		panel.toggle('terminal');
		expect(panel.isVisible()).toBe(false);
	});

	it('an editor opening closes the Terminal page above it too', async () => {
		shellForm('phone');
		files();
		const panel = document.getElementById('panel')!;
		panel.hidden = false;
		commands.register({ id: 'workbench.togglePanel', title: '', run: () => { panel.hidden = !panel.hidden; } });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\a.txt');
		expect(panel.hidden).toBe(true);
	});

	it('keeps the side bar beside the editor off the phone (tablet web, the app)', async () => {
		shellForm('tablet');
		files();
		const sidebar = openSideView();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\a.txt');
		expect(sidebar.hidden).toBe(false);
	});
});

// The phone's read-only open (editLock.ts): a locked editor refuses input until its bar's
// unlock reconfigures it in place.
describe('edit lock', () => {
	const files = () => backend.on('read_file', ({ path }) => {
		const text = String(path).endsWith('b.txt') ? 'the second file\n' : 'line one\nline two\n';
		return { contents: text, binary: false, size: text.length };
	});

	it('locks a freshly opened file on the phone shell and unlocks it for good', async () => {
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.dataset['formFactor'] = 'phone';
		try {
			files();
			const group = new EditorGroup(document.getElementById('editorGroup')!);
			await group.openFile('C:\\repo\\a.txt');
			const view = group.activeView!;
			expect(view.state.readOnly).toBe(true);
			const bar = document.querySelector<HTMLElement>('.edit-lock-bar')!;
			expect(bar).not.toBeNull();
			expect(bar.textContent).toContain('Read-only');
			click(bar.querySelector('button')!);
			expect(view.state.readOnly).toBe(false);
			expect(view.dom.closest('.editor-pane')?.querySelector('.edit-lock-bar') ?? null).toBeNull();
			// A second file opens locked — every fresh open does — while the unlocked tab
			// keeps its grant across a tab switch and back.
			await group.openFile('C:\\repo\\b.txt');
			expect(group.activeView!.state.readOnly).toBe(true);
			await group.openFile('C:\\repo\\a.txt');
			expect(group.activeView).toBe(view);
			expect(group.activeView!.state.readOnly).toBe(false);
		} finally {
			delete document.documentElement.dataset['formFactor'];
			document.documentElement.removeAttribute('data-remote-shell');
		}
	});

	it('stays directly editable off the phone (desktop web, tablet, the app)', async () => {
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.dataset['formFactor'] = 'tablet';
		try {
			files();
			const group = new EditorGroup(document.getElementById('editorGroup')!);
			await group.openFile('C:\\repo\\a.txt');
			expect(group.activeView!.state.readOnly).toBe(false);
			expect(document.querySelector('.edit-lock-bar')).toBeNull();
		} finally {
			delete document.documentElement.dataset['formFactor'];
			document.documentElement.removeAttribute('data-remote-shell');
		}
	});
});
