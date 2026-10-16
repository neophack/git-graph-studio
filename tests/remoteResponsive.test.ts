// Remote Access, the responsive shell (module 19, docs/ggs-remote-plan.md §11, §17.3): form
// factor detection, context menus as the phone's action sheet, the phone's page model with
// its app bar, bottom navigation, drawer, open editors sheet and editing row, long-press as
// contextmenu, the terminal key row, the page stack and the edit lock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';
import * as deviceClassModule from '../src/remote/app/deviceClass';
import { formFactorFor, initResponsive, formFactor } from '../src/remote/responsive';

// The remote session's hooks, as boot.ts installs them: the editor suite's phone surfaces
// (the edit lock, the page-stack navigation) read them through platform/hooks lookups.
installRemoteSessionHooks();
import { installActionSheet, closeActionSheet, showActionSheet } from '../src/remote/actionSheet';
import { createBottomTabs } from '../src/remote/bottomTabs';
import { createNavRail } from '../src/remote/navRail';
import { createAppBar, pageHeading, relativeFolder } from '../src/remote/appBar';
import { createEditorEmptyState, editorActionEntries, openEditorsSheet } from '../src/remote/editorSwitcher';
import { ACCESSORY_KEYS, createEditorAccessory } from '../src/remote/editorAccessory';
import { closeDrawer, drawerOpen, openDrawer } from '../src/remote/navDrawer';
import { currentPage, editorPlaceholderShown, resetWorkbenchWatch } from '../src/remote/pages';
import { editableFocused, keyboardOpen } from '../src/remote/responsive';
import { applyContributions, applyExtensionSettings, removeContributions } from '../src/features/extensions';
import { installLongPress, LONG_PRESS_MS } from '../src/remote/gestures';
import { createTerminalKeys } from '../src/remote/terminalKeys';
import { TERMINAL_SEND_EVENT } from '../src/features/terminal';
import { Panel } from '../src/workbench/panel';
import { showContextMenu, showMenuBelow, setMenuPresenter, type MenuEntry, type MenuItem } from '../src/platform/ui';
import { commands } from '../src/platform/commands';
import { EditorGroup } from '../src/features/editor';
import { closeSettingsPage, installPhoneSettingsEntry, openSettingsPage, settingsPageOpen } from '../src/remote/settingsPage';
import { openSettingsPanel } from '../src/workbench/settingsPanel';
import { DEFAULT_SETTINGS, settings } from '../src/platform/settings';
import { extSettings } from '../src/platform/state';
import { setLocale, t } from '../src/platform/i18n';
import { backend } from './tauriMock';
import { click, flush, type } from './helpers';

function setWidth(width: number, height = 800): void {
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
	// The classifier reads the LAYOUT viewport (§4.1), which jsdom reports as 0 — stub it
	// the way the plan's own test direction spells (§14.1).
	Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
	Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
	window.dispatchEvent(new Event('resize'));
}

/** The classifier settles 150 ms after the last resize (§4.2's debounce). */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 170));
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

	it('are written onto <html> and follow resizes', async () => {
		setCoarse(true);
		setWidth(390);
		const stop = initResponsive();
		expect(document.documentElement.dataset.formFactor).toBe('phone');
		expect(document.documentElement.dataset.device).toBe('phone-portrait');
		expect(document.documentElement.dataset.pointer).toBe('coarse');
		expect(document.documentElement.classList.contains('remote-shell')).toBe(true);
		// A touch device grown to 1300×800 is a TABLET landscape, not a desktop (§4.1's
		// own matrix: iPad Pro 13 landscape) — the desktop form needs the fine pointer.
		setWidth(1300);
		await settle();
		expect(document.documentElement.dataset.formFactor).toBe('tablet');
		expect(document.documentElement.dataset.device).toBe('tablet-landscape');
		// The precise pointer at the same size is the desktop browser.
		setCoarse(false);
		setWidth(1300);
		await settle();
		expect(document.documentElement.dataset.formFactor).toBe('desktop');
		expect(formFactor()).toBe('desktop');
		stop();
	});
});

describe('action sheet', () => {
	it('replaces context menus on a touch phone only', async () => {
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
		await settle();
		showContextMenu(10, 10, [{ label: 'Rename', run }]);
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
		expect(document.querySelector('.context-menu')).not.toBeNull();
		stop();
	});

	it('carries the "..." anchor menus onto the sheet too — no floating cascade on a touch phone', async () => {
		document.body.innerHTML = '<div id="overlays"></div><button id="more">…</button>';
		setCoarse(true);
		setWidth(390);
		const stop = initResponsive();
		installActionSheet();
		const ran = vi.fn();
		showMenuBelow(document.getElementById('more')!, [
			{ label: 'Commit', run: ran },
			{ label: 'Branches', submenu: [{ label: 'main', run: ran }] }
		]);
		// The sheet replaced the dropped panel — and its submenu drills in with a back step,
		// it never opens beside anything.
		const sheet = document.querySelector('.ggs-action-sheet')!;
		expect(sheet).not.toBeNull();
		expect(document.querySelector('.context-menu')).toBeNull();
		const rows = [...sheet.querySelectorAll<HTMLButtonElement>('.row')];
		expect(rows.map((row) => row.textContent)).toEqual(['Commit', 'Branches', 'Cancel']);
		rows[1]!.click();
		const inner = document.querySelector('.ggs-action-sheet')!;
		expect([...inner.querySelectorAll<HTMLButtonElement>('.row')].map((row) => row.textContent)).toEqual(['main', 'Cancel']);
		(inner.querySelector('.row') as HTMLButtonElement).click();
		expect(ran).toHaveBeenCalledTimes(1);
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();

		// Off the phone the anchor menu drops as the floating panel it always was.
		setWidth(1300);
		await settle();
		showMenuBelow(document.getElementById('more')!, [{ label: 'Commit', run: ran }]);
		expect(document.querySelector('.context-menu')).not.toBeNull();
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
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
	// The page-stack marker (§5.1–§5.3): what the shell's navigation and edit-lock gates read.
	document.documentElement.setAttribute('data-page-stack', '');
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
	document.documentElement.removeAttribute('data-page-stack');
}

describe('bottom navigation', () => {
	afterEach(leavePhone);

	it('shows its page on every tap — never toggles it away — and a second tap reselects', async () => {
		const { ran, sidebar, group } = phoneWorkbench();
		const reselected: string[] = [];
		const taps: string[] = [];
		const bar = createBottomTabs((page) => void reselected.push(page), (page) => void taps.push(page));
		document.body.appendChild(bar);
		const tab = (id: string) => bar.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)!;
		expect([...bar.querySelectorAll('button')].map((button) => button.dataset.tab)).toEqual(['explorer', 'editor', 'scm', 'panel', 'search']);
		expect(tab('explorer').classList.contains('active')).toBe(true);
		expect(tab('scm').querySelector('.badge')!.textContent).toBe('3');
		tab('scm').click();
		await flushMutations();
		expect(ran).toEqual(['workbench.showScm']);
		expect(taps).toEqual(['scm']);
		expect(tab('scm').classList.contains('active')).toBe(true);
		// The page already showing: a reselect, not a toggle (the old bar hid the side view).
		tab('scm').click();
		expect(reselected).toEqual(['scm']);
		expect(taps).toEqual(['scm', 'scm']);
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
		expect(taps).toEqual(['scm', 'scm', 'editor', 'editor']);
		// Terminal: the panel page; the Editor then takes the page back from it.
		tab('panel').click();
		await flushMutations();
		expect(currentPage()).toBe('panel');
		tab('editor').click();
		await flushMutations();
		expect(document.getElementById('panel')!.hidden).toBe(true);
		expect(currentPage()).toBe('editor');
	});

	it('the Editor tap reports on EVERY tap — the chooser rides it, first tap included (§6.2)', async () => {
		const { group, sidebar } = phoneWorkbench();
		const taps: string[] = [];
		const bar = createBottomTabs(() => undefined, (page) => void taps.push(page));
		document.body.appendChild(bar);
		const tab = (id: string) => bar.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)!;
		// From the Files page, with an editor open: the tap that SHOWS the page reports too.
		addTab(group, 'a.ts', { path: '/home/u/ws/src/a.ts', active: true });
		tab('editor').click();
		await flushMutations();
		expect(taps).toEqual(['editor']);
		expect(sidebar.hidden).toBe(true);
		tab('editor').click();
		expect(taps).toEqual(['editor', 'editor']);
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
		// Shaped as the workbench leaves it: the delayed tooltip strips the native `title`,
		// keeping the container's name as the accessible label.
		container.setAttribute('aria-label', 'Claude Code');
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
		// The container's tab carries its label — not the icon alone — wherever the workbench
		// kept the name (a stripped `title` falls back to the accessible one).
		expect(tab('ext-container:anthropic.claude-code.claude-sidebar').querySelector('.label')!.textContent).toBe('Claude Code');
		expect(pageHeading('ext-container:anthropic.claude-code.claude-sidebar').title).toBe('Claude Code');
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

describe('navigation rail', () => {
	afterEach(leavePhone);

	it('rebuilds its button when a container\'s package image arrives — the codicon stand-in is a stand-in, not a life sentence', async () => {
		phoneWorkbench();
		const container = document.createElement('div');
		container.className = 'activity-item';
		container.dataset.view = 'ext-container:anthropic.claude-code.claude-sidebar';
		container.setAttribute('aria-label', 'Claude Code');
		document.querySelector('#activitybar .activity-spacer')!.before(container);
		const rail = createNavRail();
		document.body.appendChild(rail);
		await flushMutations();
		const key = 'ext-container:anthropic.claude-code.claude-sidebar';
		const button = () => rail.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`)!;
		expect(button().querySelector('img')).toBeNull();
		// The package image lands (applyExtensionViews swaps the activity item's children for
		// the loaded img): the destinations did not change, but the rail's keying carries the
		// images, so the button rebuilds wearing it — before the fix the key ignored them and
		// the rail kept the codicon until the destinations themselves changed.
		const image = document.createElement('img');
		image.src = 'data:image/png;base64,AA==';
		container.replaceChildren(image);
		await flushMutations();
		expect(button().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
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

	/** The phone shell's markers: the remote shell on a page-stack form (responsive.ts
	 *  writes both from the settled device class). */
	function shellForm(): void {
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.dataset['formFactor'] = 'phone';
		document.documentElement.setAttribute('data-page-stack', '');
	}

	afterEach(() => {
		delete document.documentElement.dataset['formFactor'];
		document.documentElement.removeAttribute('data-remote-shell');
		document.documentElement.removeAttribute('data-page-stack');
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
		shellForm();
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
		shellForm();
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
		shellForm();
		files();
		const panel = document.getElementById('panel')!;
		panel.hidden = false;
		commands.register({ id: 'workbench.togglePanel', title: '', run: () => { panel.hidden = !panel.hidden; } });
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\a.txt');
		expect(panel.hidden).toBe(true);
	});

	it('keeps the side bar beside the editor off the page-stack shells (tablet landscape, desktop web, the app)', async () => {
		// §5.3: the PORTRAIT tablet pages like the phone (the page-stack marker); the
		// landscape tablet and the desktop browser keep VS Code's side-by-side frame.
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.dataset['formFactor'] = 'desktop';
		files();
		const sidebar = openSideView();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\repo\\a.txt');
		expect(sidebar.hidden).toBe(false);
	});
});

// The phone's read-only open (editLock.ts): a locked editor refuses input until the app
// bar's lock button unlocks it, and the same button locks it again.
describe('edit lock', () => {
	const files = () => backend.on('read_file', ({ path }) => {
		const text = String(path).endsWith('b.txt') ? 'the second file\n' : 'line one\nline two\n';
		return { contents: text, binary: false, size: text.length };
	});

	afterEach(() => resetWorkbenchWatch());

	it('locks a freshly opened file on the phone shell and toggles it from the app bar', async () => {
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.dataset['formFactor'] = 'phone';
		try {
			files();
			const sidebar = document.getElementById('sidebar');
			if (sidebar) sidebar.hidden = true;
			const bar = createAppBar({ openDrawer: () => undefined, openEditors: () => undefined, editorActions: () => undefined });
			document.body.prepend(bar);
			const lock = () => bar.querySelector<HTMLButtonElement>('.ggs-appbar-btn.edit-lock')!;
			// No editor yet: the button stays out of the bar.
			expect(lock().hidden).toBe(true);
			const group = new EditorGroup(document.getElementById('editorGroup')!);
			await group.openFile('C:\\repo\\a.txt');
			await flushMutations();
			const view = group.activeView!;
			expect(view.state.readOnly).toBe(true);
			// No bar above the editor any more: the lock lives in the app bar.
			expect(document.querySelector('.edit-lock-bar')).toBeNull();
			expect(lock().hidden).toBe(false);
			expect(lock().dataset.state).toBe('locked');
			expect(lock().querySelector('.codicon-lock')).not.toBeNull();
			expect(lock().getAttribute('aria-label')).toBe('Unlock to edit');
			click(lock());
			expect(view.state.readOnly).toBe(false);
			expect(lock().dataset.state).toBe('unlocked');
			expect(lock().querySelector('.codicon-unlock')).not.toBeNull();
			expect(lock().getAttribute('aria-label')).toBe('Lock editing');
			click(lock());
			expect(view.state.readOnly).toBe(true);
			expect(lock().dataset.state).toBe('locked');
			click(lock());
			// A second file opens locked — every fresh open does — while the unlocked tab
			// keeps its grant across a tab switch and back, the button following the tab.
			await group.openFile('C:\\repo\\b.txt');
			await flushMutations();
			expect(group.activeView!.state.readOnly).toBe(true);
			expect(lock().dataset.state).toBe('locked');
			await group.openFile('C:\\repo\\a.txt');
			await flushMutations();
			expect(group.activeView).toBe(view);
			expect(group.activeView!.state.readOnly).toBe(false);
			expect(lock().dataset.state).toBe('unlocked');
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
			expect(document.querySelector('[data-edit-lock]')).toBeNull();
		} finally {
			delete document.documentElement.dataset['formFactor'];
			document.documentElement.removeAttribute('data-remote-shell');
		}
	});
});

// The phone's Settings page (settingsPage.ts): the desktop dialog's two panes cannot fit a
// 390 px screen, so Settings on a phone is a full-screen page — categories as drill-in rows,
// choices as sheets, booleans as row switches, one registry under it all. The phone's back
// button pops one level at a time, the page itself last.
describe('settings page', () => {
	const CATALOG = [
		{ ext: 'blf', recommended: true },
		{ ext: 'md', recommended: false }
	];

	/** A row of the level currently showing, by its label. */
	const row = (label: string) => [...document.querySelectorAll<HTMLElement>('.ggs-settings-page .ggs-settings-level:last-child .ggs-settings-row')]
		.find((candidate) => candidate.querySelector('.label')!.textContent === label)!;
	const levelLabels = () => [...document.querySelectorAll<HTMLElement>('.ggs-settings-page .ggs-settings-level:last-child .ggs-settings-row .label')]
		.map((label) => label.textContent);
	const title = () => document.querySelector<HTMLElement>('.ggs-settings-title')!.textContent;

	beforeEach(() => {
		setLocale('en');
		settings.theme = 'dark-modern';
		settings.wordWrap = false;
		settings.autoSaveDelay = DEFAULT_SETTINGS.autoSaveDelay;
		settings.fileAssociations = [...DEFAULT_SETTINGS.fileAssociations];
		localStorage.clear();
		backend.on('settings_write', () => null);
		backend.on('assoc_list_defaults', () => CATALOG);
		backend.on('assoc_apply', () => ({ messageKey: 'assoc.applied.linux', detail: '' }));
		backend.on('context_menu_apply', () => null);
		commands.register({ id: 'workbench.openSettings', title: 'Settings', category: 'Preferences', run: () => openSettingsPanel() });
	});

	afterEach(() => {
		closeSettingsPage();
		closeActionSheet();
		removeContributions('demo.ext');
		installPhoneSettingsEntry(false);
		leavePhone();
	});

	it('opens from the drawer and lists the categories as drill-in rows', () => {
		phoneWorkbench();
		openDrawer(() => []);
		[...document.querySelectorAll<HTMLButtonElement>('.ggs-drawer-row')]
			.find((candidate) => candidate.querySelector('.label')!.textContent === t('remote.drawer.settings'))!.click();
		expect(drawerOpen()).toBe(false);
		expect(settingsPageOpen()).toBe(true);
		expect(levelLabels()).toEqual(['Remote Access', 'General', 'Appearance', 'Editor', 'Search', 'Extensions']);
		expect(title()).toBe('Settings');
	});

	it('drills in, picks a choice from a sheet, and the phone back pops one level at a time', async () => {
		phoneWorkbench();
		openSettingsPage();
		row('Appearance').click();
		expect(title()).toBe('Appearance');
		expect(levelLabels()).toContain(t('settings.theme'));
		row(t('settings.theme')).click();
		const sheetRows = [...document.querySelectorAll<HTMLElement>('.ggs-action-sheet .row')];
		expect(sheetRows.find((candidate) => candidate.textContent === 'Dark Modern')!.classList.contains('checked')).toBe(true);
		sheetRows.find((candidate) => candidate.textContent === 'Light Modern')!.click();
		await flush();
		expect(settings.theme).toBe('light-modern');
		expect(row(t('settings.theme')).querySelector('.value')!.textContent).toBe('Light Modern');
		expect(row(t('settings.theme')).classList.contains('modified')).toBe(true);
		// The phone's back pops the category level first, then closes the page.
		window.dispatchEvent(new PopStateEvent('popstate'));
		expect(title()).toBe('Settings');
		expect(settingsPageOpen()).toBe(true);
		window.dispatchEvent(new PopStateEvent('popstate'));
		expect(settingsPageOpen()).toBe(false);
	});

	it('a boolean toggles through the registry and a number steps in its sheet', async () => {
		phoneWorkbench();
		openSettingsPage();
		row('Editor').click();
		expect(row(t('settings.wordWrap')).querySelector('.switch')!.classList.contains('on')).toBe(false);
		row(t('settings.wordWrap')).click();
		await flush();
		expect(settings.wordWrap).toBe(true);
		expect(row(t('settings.wordWrap')).querySelector('.switch')!.classList.contains('on')).toBe(true);
		row(t('settings.autoSaveDelay')).click();
		const picker = document.querySelector<HTMLElement>('.ggs-number-picker')!;
		expect(picker.querySelector<HTMLInputElement>('input')!.value).toBe('1000');
		[...picker.querySelectorAll('button')].pop()!.click();
		await flush();
		expect(settings.autoSaveDelay).toBe(1100);
		expect(picker.querySelector<HTMLInputElement>('input')!.value).toBe('1100');
	});

	it('the root search spans every category', () => {
		phoneWorkbench();
		openSettingsPage();
		type(document.querySelector<HTMLInputElement>('.ggs-settings-searchbar input')!, 'theme');
		expect(levelLabels()).toContain(t('settings.theme'));
		expect(levelLabels()).not.toContain('General');
		type(document.querySelector<HTMLInputElement>('.ggs-settings-searchbar input')!, 'zzzz-nothing');
		expect(levelLabels()).toEqual([]);
		expect(document.querySelector('.ggs-settings-level .empty')!.textContent).toBe(t('settings.noMatching'));
	});

	it('routes workbench.openSettings to the page on a phone, back to the dialog off it', async () => {
		phoneWorkbench();
		const overlays = document.createElement('div');
		overlays.id = 'overlays';
		document.body.appendChild(overlays);
		installPhoneSettingsEntry(true);
		await commands.execute('workbench.openSettings');
		expect(settingsPageOpen()).toBe(true);
		closeSettingsPage();
		installPhoneSettingsEntry(false);
		await commands.execute('workbench.openSettings');
		expect(settingsPageOpen()).toBe(false);
		expect(document.querySelector('.settings-overlay')).not.toBeNull();
	});

	it('extension-declared settings ride under Extensions and toggle through the store', async () => {
		phoneWorkbench();
		applyExtensionSettings('demo.ext', { properties: { 'demo.flag': { type: 'boolean', description: 'A demo flag', default: false } } }, {});
		openSettingsPage();
		row('Extensions').click();
		const flag = row('demo.flag');
		expect(flag.querySelector('.desc')!.textContent).toContain('demo.ext');
		flag.click();
		await flush();
		expect(extSettings('demo.ext')['demo.flag']).toBe(true);
	});

	it('the file associations level toggles over the backend catalogue', async () => {
		phoneWorkbench();
		// The apply pass reports through a toast; the notifications host must exist for it.
		const notes = document.createElement('div');
		notes.id = 'notifications';
		document.body.appendChild(notes);
		openSettingsPage();
		row('General').click();
		row(t('settings.fileAssociations')).click();
		expect(title()).toBe(t('settings.fileAssociations'));
		await flush();
		expect(row('.blf').querySelector('.switch.on')).not.toBeNull();
		row('.md').click();
		await flush();
		expect(settings.fileAssociations).toEqual([...DEFAULT_SETTINGS.fileAssociations, 'md']);
	});
});

describe('the device classifier (§4.1)', () => {
	const { classify, settleDeviceClass, withinHysteresis, overrideClass } = deviceClassModule;

	it("covers §4.1's table row by row", () => {
		// iPhone 15 portrait / landscape; Pixel 7 portrait / landscape.
		expect(classify(393, 852, true)).toBe('phone-portrait');
		expect(classify(852, 393, true)).toBe('phone-landscape');
		expect(classify(412, 915, true)).toBe('phone-portrait');
		expect(classify(915, 412, true)).toBe('phone-landscape');
		// A foldable opened out (short edge ~690, touch) is a tablet portrait.
		expect(classify(690, 720, true)).toBe('tablet-portrait');
		// iPad mini portrait / landscape; iPad Pro 13 landscape.
		expect(classify(744, 1133, true)).toBe('tablet-portrait');
		expect(classify(1133, 744, true)).toBe('tablet-landscape');
		expect(classify(1376, 1032, true)).toBe('tablet-landscape');
		// A 13" laptop browser (precise pointer) is a desktop; the same pixels with a
		// touch screen are a tablet — the pointer kind is what separates them at 1100+.
		expect(classify(1440, 800, false)).toBe('desktop');
		expect(classify(1440, 800, true)).toBe('tablet-landscape');
		// A desktop window dragged narrow is a phone portrait (600… is a tablet).
		expect(classify(500, 900, false)).toBe('phone-portrait');
		expect(classify(700, 900, false)).toBe('tablet-portrait');
	});

	it("keeps the current class inside §4.2's hysteresis band", () => {
		// A short edge 24 px either side of a boundary keeps the current class.
		expect(withinHysteresis(null, 512, 900)).toBe(false);
		expect(withinHysteresis('phone-portrait', 512, 900)).toBe(true);
		expect(withinHysteresis('phone-portrait', 476, 900)).toBe(true);
		expect(withinHysteresis('phone-portrait', 470, 900)).toBe(false);
		// The width boundaries ride along (a 1024-wide window flapping at the edge).
		expect(withinHysteresis('desktop', 1010, 800)).toBe(true);
		expect(withinHysteresis('desktop', 990, 800)).toBe(false);
	});

	it("freezes the class under the keyboard: a height change alone never reclassifies", () => {
		// 390×844 phone; the keyboard raises: height falls, width stands — frozen.
		expect(settleDeviceClass('phone-portrait', 390, 400, true, { w: 390, h: 844 }, true, null)).toBe('phone-portrait');
		// A WIDTH change reclassifies even while frozen (a rotate is a real change).
		expect(settleDeviceClass('phone-portrait', 844, 390, true, { w: 390, h: 844 }, true, null)).toBe('phone-landscape');
		// Unfrozen, the same keyboard drop is the tablet/phone boundary's business as usual.
		expect(settleDeviceClass('phone-portrait', 390, 400, true, { w: 390, h: 844 }, false, null)).toBe('phone-portrait');
	});

	it("honours the manual override, aspect-aware", () => {
		expect(overrideClass('phone', 390, 844)).toBe('phone-portrait');
		expect(overrideClass('phone', 844, 390)).toBe('phone-landscape');
		expect(overrideClass('desktop', 390, 844)).toBe('desktop');
		// An unknown value is no override at all.
		expect(overrideClass('nope', 390, 844)).toBeNull();
		expect(settleDeviceClass('phone-portrait', 1440, 800, false, { w: 390, h: 844 }, false, 'phone')).toBe('phone-landscape');
	});
});
