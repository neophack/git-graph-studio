// The five device layouts (module 19, docs/remote-client-plan.md §4.2, §5, A2): the layout
// host's frame, one arrangement per device class, the switch process — overlays close, the
// navigation state records and re-applies, the parts MOVE and are never rebuilt — and §5.7's
// key gating (the phone forms stand down from the workbench's global chords).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';

// The remote session's hooks, as boot.ts installs them: the editor suite's phone surfaces
// (the edit lock, the page-stack navigation) read them through platform/hooks lookups.
installRemoteSessionHooks();
import { commands } from '../src/platform/commands';
import { initResponsive } from '../src/remote/responsive';
import { installLayoutHost } from '../src/remote/app/layouts/host';
import { installActionSheet, showActionSheet } from '../src/remote/actionSheet';
import { drawerOpen } from '../src/remote/navDrawer';
import { currentPage } from '../src/remote/pages';
import type { MenuEntry } from '../src/platform/ui';

/** The workbench skeleton remote.html carries, shaped as the booted workbench leaves it. */
function workbenchSkeleton(): void {
	document.title = 'ws - Git Graph Studio';
	document.body.innerHTML = [
		'<div id="titlebar"><div class="titlebar-center"></div></div>',
		'<div id="workbench">',
		'  <div id="activitybar" role="toolbar"><div class="activity-item active" data-view="explorer" title="Files"></div>',
		'    <div class="activity-item" data-view="search" title="Search"></div>',
		'    <div class="activity-item" data-view="scm" title="Changes"><span class="badge">3</span></div></div>',
		'  <div id="sidebar" hidden></div>',
		'  <div id="sidebarSash" class="sash sash-vertical"></div>',
		'  <div id="editorPart"><div id="editorGroup"><div class="editor-group-box focused"><div class="tabs-container"></div></div></div>',
		'    <div id="panelSash" class="sash sash-horizontal" hidden></div>',
		'    <div id="panel" hidden><div class="terminal-instance">bash</div></div></div>',
		'</div>',
		'<div id="statusbar" role="status"><div class="status-left"><div class="status-item" data-item="branch">main</div></div><div class="status-right"></div></div>',
		'<div id="notifications" aria-live="polite"></div>',
		'<div id="overlays"></div>'
	].join('');
}

/** The side-view commands pages.ts reaches the workbench through, mirrored onto the DOM. */
function stubViewCommands(): void {
	const sidebar = document.getElementById('sidebar')!;
	const panel = document.getElementById('panel')!;
	const show = (view: string) => {
		sidebar.hidden = false;
		for (const item of document.querySelectorAll<HTMLElement>('#activitybar .activity-item')) item.classList.toggle('active', item.dataset.view === view);
	};
	commands.register({ id: 'workbench.showExplorer', title: '', run: () => show('explorer') });
	commands.register({ id: 'workbench.showSearch', title: '', run: () => show('search') });
	commands.register({ id: 'workbench.showScm', title: '', run: () => show('scm') });
	commands.register({ id: 'workbench.toggleSidebar', title: '', run: () => { sidebar.hidden = !sidebar.hidden; } });
	commands.register({ id: 'workbench.togglePanel', title: '', run: () => { panel.hidden = !panel.hidden; } });
	commands.register({ id: 'terminal.toggle', title: '', run: () => { sidebar.hidden = true; panel.hidden = false; } });
}

function setWidth(width: number, height: number): void {
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
	Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
	Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
	window.dispatchEvent(new Event('resize'));
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 170));
}

async function become(width: number, height: number, coarse: boolean): Promise<void> {
	vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('coarse'), addEventListener: () => undefined, removeEventListener: () => undefined }));
	setWidth(width, height);
	await settle();
}

function frame(): HTMLElement {
	return document.querySelector('.ggs-layout')!;
}

function arrange(): HTMLElement {
	return frame().querySelector('.ggs-arrange')!;
}

function addTab(strip: HTMLElement, label: string, options: { dirty?: boolean } = {}): HTMLElement {
	const tab = document.createElement('div');
	tab.className = 'tab active' + (options.dirty ? ' dirty' : '');
	tab.title = `C:\\repo\\${label}`;
	tab.dataset.kind = 'file';
	tab.innerHTML = `<span class="icon"></span><span class="label">${label}</span><span class="close"></span>`;
	strip.appendChild(tab);
	return tab;
}

describe('the five layouts', () => {
	let stopResponsive: (() => void) | undefined;
	let stopHost: (() => void) | undefined;

	beforeEach(() => {
		workbenchSkeleton();
		stubViewCommands();
		installActionSheet();
	});

	afterEach(() => {
		stopHost?.();
		stopHost = undefined;
		stopResponsive?.();
		stopResponsive = undefined;
		vi.unstubAllGlobals();
		document.body.replaceChildren();
		delete document.documentElement.dataset['layout'];
		delete document.documentElement.dataset['device'];
		delete document.documentElement.dataset['formFactor'];
		document.documentElement.removeAttribute('data-remote-shell');
		document.documentElement.removeAttribute('data-page-stack');
	});

	it('arranges each device class (§5.1–§5.5)', async () => {
		setWidth(390, 844);
		document.documentElement.setAttribute('data-remote-shell', '');
		stopResponsive = initResponsive();
		stopHost = installLayoutHost();
		const appBar = () => document.querySelector('.ggs-appbar')!;
		const tabs = () => document.querySelector('.ggs-bottom-tabs')!;
		const rail = () => document.querySelector('.ggs-nav-rail')!;

		// Phone portrait: the app bar, the page column, the editing row, the bottom
		// navigation — in order, inside one frame.
		expect(frame().dataset.layout).toBe('phone-portrait');
		expect(arrange().firstElementChild).toBe(appBar());
		expect(document.getElementById('workbench')!.parentElement).toBe(arrange());
		expect(tabs().parentElement).toBe(arrange());
		expect([...arrange().children].indexOf(tabs())).toBeGreaterThan([...arrange().children].indexOf(document.getElementById('workbench')!));

		// Phone landscape: the 56 px rail leads, the column (top bar, stage, editing row)
		// beside it; no bottom navigation in the column.
		await become(844, 390, true);
		expect(frame().dataset.layout).toBe('phone-landscape');
		expect(arrange().firstElementChild).toBe(rail());
		const main = arrange().querySelector('.ggs-arrange-main')!;
		expect(main.contains(appBar())).toBe(true);
		expect(main.contains(document.getElementById('workbench')!)).toBe(true);
		expect(main.contains(tabs())).toBe(false);

		// Tablet portrait: the icon-only rail, the page column beside it.
		await become(744, 1133, true);
		expect(frame().dataset.layout).toBe('tablet-portrait');
		expect(arrange().firstElementChild).toBe(rail());
		expect(arrange().children[1]).toBe(document.getElementById('workbench'));
		expect(document.documentElement.hasAttribute('data-page-stack')).toBe(true);

		// Tablet landscape: the workbench's own three-column frame — the activity bar in
		// VS Code's icon-only shape (the owner's 2026-10-16 direction, 左轨图标不配标题:
		// no label under any icon; the ☰ menu entry still leads the bar), the side bar,
		// the editor — plus the status bar; the phone chrome is parked behind (no ids).
		await become(1133, 744, true);
		expect(frame().dataset.layout).toBe('tablet-landscape');
		expect([...arrange().children].filter((child) => child.id).map((child) => child.id)).toEqual(['titlebar', 'workbench', 'statusbar']);
		expect(document.querySelector('#activitybar .ggs-activity-menu')).not.toBeNull();
		expect(document.querySelectorAll('#activitybar .rail-label')).toHaveLength(0);
		expect(document.documentElement.hasAttribute('data-page-stack')).toBe(false);

		// Desktop browser: the VS Code frame with the remote indicator leading the status
		// bar's left cluster (§5.5).
		await become(1440, 900, false);
		expect(frame().dataset.layout).toBe('desktop');
		const left = document.querySelector('#statusbar .status-left')!;
		expect(left.firstElementChild!.classList.contains('ggs-indicator-remote')).toBe(true);
		expect(left.querySelector('.ggs-indicator-remote .remote-name')!.textContent).toBe('ws');
		// The indicator left with the layout: the tablet landscape that follows has none.
		await become(1133, 744, true);
		expect(document.querySelector('.ggs-indicator-remote')).toBeNull();
	});

	it('switches without rebuilding: the tabs, the dirty marks and the terminal session are the same DOM (§4.2, the A2 acceptance)', async () => {
		setWidth(390, 844);
		document.documentElement.setAttribute('data-remote-shell', '');
		stopResponsive = initResponsive();
		stopHost = installLayoutHost();
		const strip = document.querySelector<HTMLElement>('.editor-group-box .tabs-container')!;
		const tab = addTab(strip, 'a.ts', { dirty: true });
		const terminal = document.querySelector<HTMLElement>('.terminal-instance')!;
		const workbench = document.getElementById('workbench')!;

		for (const [w, h, coarse] of [[844, 390, true], [744, 1133, true], [1133, 744, true], [1440, 900, false], [390, 844, true]] as const) {
			await become(w, h, coarse);
			// The workbench element itself never leaves the document — it MOVES between
			// arrangements; the tab and the terminal ride inside it, alive.
			expect(workbench.isConnected).toBe(true);
			expect(workbench.contains(tab)).toBe(true);
			expect(workbench.contains(terminal)).toBe(true);
			expect(tab.classList.contains('dirty')).toBe(true);
			expect(document.querySelectorAll('.terminal-instance')).toHaveLength(1);
			expect(document.querySelector('.ggs-editor-empty')!.isConnected).toBe(true);
		}
		// One frame, one arrangement: the old layout's root is gone.
		expect(document.querySelectorAll('.ggs-layout')).toHaveLength(1);
		expect(document.querySelectorAll('.ggs-arrange')).toHaveLength(1);
	});

	it('closes the overlays and carries the navigation state across a switch (§4.2, §5.6)', async () => {
		setWidth(390, 844);
		document.documentElement.setAttribute('data-remote-shell', '');
		stopResponsive = initResponsive();
		stopHost = installLayoutHost();
		// The Changes page showing, an action sheet up.
		await commands.execute('workbench.showScm');
		expect(currentPage()).toBe('scm');
		const entry: MenuEntry = { label: 'Stage', run: () => undefined };
		showActionSheet([entry]);
		expect(document.querySelector('.ggs-action-sheet')).not.toBeNull();

		await become(1440, 900, false);
		// The sheet is gone; the desktop form shows the same view beside the editor.
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
		expect(document.getElementById('sidebar')!.hidden).toBe(false);
		expect(currentPage()).toBe('scm');

		// Back onto the phone: the view pages again.
		await become(390, 844, true);
		expect(currentPage()).toBe('scm');
	});

	it('tapping the Editor destination opens the open editors chooser — the phone\'s tab strip (§6.2)', async () => {
		setWidth(390, 844);
		document.documentElement.setAttribute('data-remote-shell', '');
		stopResponsive = initResponsive();
		stopHost = installLayoutHost();
		const strip = document.querySelector<HTMLElement>('.editor-group-box .tabs-container')!;
		const barEditor = () => document.querySelector<HTMLButtonElement>('.ggs-bottom-tabs [data-tab="editor"]')!;
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

		// From the Files page with nothing open: the tap shows the editor page's empty
		// state — a chooser with nothing to choose is not a chooser.
		await commands.execute('workbench.showExplorer');
		expect(currentPage()).toBe('explorer');
		barEditor().click();
		await flush();
		expect(currentPage()).toBe('editor');
		expect(document.querySelector('.ggs-editors-sheet')).toBeNull();

		// Two tabs open (the shape a PC catch-up leaves): the FIRST tap of the Editor
		// opens the chooser listing them — one tap, not a second tap of the page.
		await commands.execute('workbench.showExplorer');
		const a = addTab(strip, 'a.ts');
		const b = addTab(strip, 'b.ts', { dirty: true });
		b.classList.remove('active');
		barEditor().click();
		await flush();
		const sheet = () => document.querySelector<HTMLElement>('.ggs-editors-sheet')!;
		expect(sheet()).not.toBeNull();
		expect([...sheet().querySelectorAll('.ggs-editor-row .name')].map((name) => name.textContent)).toEqual(['a.ts', 'b.ts']);
		expect([...sheet().querySelectorAll('.ggs-editor-row')][0]!.classList.contains('current')).toBe(true);
		// Choosing one closes the chooser and lands on that tab over the editor page.
		[...sheet().querySelectorAll('.ggs-editor-row')][1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(document.querySelector('.ggs-editors-sheet')).toBeNull();
		expect(currentPage()).toBe('editor');

		// The portrait tablet's rail answers the same way — it has no app bar, the rail's
		// Editor item is its only switcher.
		await become(744, 1133, true);
		await commands.execute('workbench.showExplorer');
		document.querySelector<HTMLButtonElement>('.ggs-nav-rail [data-tab="editor"]')!.click();
		await flush();
		expect(document.querySelector('.ggs-editors-sheet')).not.toBeNull();
		expect(document.querySelector('.ggs-editors-sheet .ggs-editor-row .name')!.textContent).toBe('a.ts');
	});

	it('carries a menu entry on the tablet forms — the rail head and the activity rail both open the drawer (the owner\'s 2026-10-16 direction, 平板界面没有菜单入口)', async () => {
		setWidth(744, 1133);
		document.documentElement.setAttribute('data-remote-shell', '');
		stopResponsive = initResponsive();
		stopHost = installLayoutHost();
		expect(frame().dataset.layout).toBe('tablet-portrait');

		// The portrait tablet has no app bar: the ☰ at the rail's head is its menu entry —
		// the drawer with every page, the workspace actions and the application menus.
		const railMenu = () => document.querySelector<HTMLButtonElement>('.ggs-nav-rail .ggs-rail-menu')!;
		expect(railMenu()).not.toBeNull();
		railMenu().click();
		expect(drawerOpen()).toBe(true);
		expect(document.querySelector('.ggs-drawer')).not.toBeNull();
		// The switch process closes the drawer (§4.2's overlays) before the next form; the
		// layout stamp is the settle signal (a loaded suite outpaces the 170 ms settle).
		const lands = async (layout: string, w: number, h: number, coarse: boolean) => {
			await become(w, h, coarse);
			for (let i = 0; i < 20 && frame().dataset.layout !== layout; i++) await new Promise((resolve) => setTimeout(resolve, 50));
			expect(frame().dataset.layout).toBe(layout);
		};
		await lands('tablet-landscape', 1133, 744, true);
		expect(drawerOpen()).toBe(false);

		// The landscape tablet draws no title bar: the ☰ rides the activity rail's head
		// instead — icon-only like every other item (the owner's 2026-10-16 direction) —
		// and leaves with the layout.
		const activityMenu = () => document.querySelector<HTMLButtonElement>('#activitybar .ggs-activity-menu')!;
		expect(activityMenu()).toBe(document.querySelector('#activitybar')!.firstElementChild);
		expect(activityMenu().title).toBe('Menu');
		activityMenu().click();
		expect(drawerOpen()).toBe(true);
		await lands('desktop', 1440, 900, false);
		expect(drawerOpen()).toBe(false);
		expect(document.querySelector('#activitybar .ggs-activity-menu')).toBeNull();
		expect(document.querySelector('#activitybar .rail-label')).toBeNull();
	});

	it('gates the workbench global chords off the phone forms, keeps the editor own keys (§5.7)', async () => {
		setWidth(390, 844);
		document.documentElement.setAttribute('data-remote-shell', '');
		stopResponsive = initResponsive();
		stopHost = installLayoutHost();
		const heard: KeyboardEvent[] = [];
		const listener = (event: KeyboardEvent) => heard.push(event);
		document.addEventListener('keydown', listener);
		try {
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
			expect(heard).toHaveLength(0);
			// A key aimed at a focused editor keeps its meaning.
			const editor = document.createElement('div');
			editor.className = 'cm-editor';
			document.body.appendChild(editor);
			editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
			expect(heard).toHaveLength(1);
			// The desktop form answers the chords again.
			await become(1440, 900, false);
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
			expect(heard).toHaveLength(2);
		} finally {
			document.removeEventListener('keydown', listener);
		}
	});
});
