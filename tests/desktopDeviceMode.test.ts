// The desktop window's device mode (module 19's deviceShell.ts, the Device Mode setting):
// the remote app's phone and tablet layouts worn inside the desktop window. Auto never
// touches the shell; a forced form wears the page-stack markers WITHOUT the browser
// session's (`data-remote-shell` stays absent — the explorer's remote behaviours and the
// read-only edit lock are session truths, not shell shapes); the window controls — which
// remote.css hides for a browser — survive by seating into each form's own chrome; and
// back to Auto the frame goes, the workbench's own elements go home in the body's order,
// and every marker leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../src/platform/commands';
import { SETTINGS_EVENT, settings } from '../src/platform/settings';
import { phoneShell } from '../src/remote/nav';
import { pageBackAvailable } from '../src/remote/pageBack';
import { installDeviceShell, primeDeviceShell } from '../src/remote/deviceShell';

/** The workbench skeleton index.html carries, shaped as the booted workbench leaves it
 *  (the window controls ride the title bar's right end). */
function workbenchSkeleton(): void {
	document.title = 'ws - Git Graph Studio';
	document.body.innerHTML = [
		'<div id="titlebar"><div class="titlebar-left"></div><div class="titlebar-center"></div>',
		'  <div class="window-controls"><div class="window-control minimize"></div><div class="window-control maximize"></div><div class="window-control close"></div></div></div>',
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

/** The classifier settles 150 ms after the last resize (§4.2's debounce). */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 170));
}

/** Flip the setting the way the Settings dialog does: the object and the change event. */
async function pickMode(mode: 'auto' | 'phone' | 'tablet'): Promise<void> {
	settings.deviceMode = mode;
	document.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { key: 'deviceMode' } }));
	await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("the desktop window's device mode", () => {
	beforeEach(() => {
		workbenchSkeleton();
		stubViewCommands();
	});

	afterEach(async () => {
		// Whatever the case left active goes back to Auto while the DOM still stands —
		// deactivation re-homes the frame's parts, and it needs them.
		if (document.documentElement.hasAttribute('data-device-shell')) await pickMode('auto');
		settings.deviceMode = 'auto';
		vi.unstubAllGlobals();
		document.body.replaceChildren();
		delete document.documentElement.dataset['layout'];
	});

	it('Auto never touches the shell', async () => {
		setWidth(1280, 800);
		await primeDeviceShell();
		await installDeviceShell();
		expect(document.documentElement.classList.contains('remote-shell')).toBe(false);
		expect(document.querySelector('.ggs-layout')).toBeNull();
		expect(document.getElementById('workbench')!.parentElement).toBe(document.body);
		expect(document.querySelector('#titlebar .window-controls')).toBeTruthy();
	});

	it('phone mode wears the page-stack shell — without the browser session markers', async () => {
		setWidth(390, 844);
		await settle();
		settings.deviceMode = 'phone';
		await installDeviceShell();
		const root = document.documentElement;
		expect(root.classList.contains('remote-shell')).toBe(true);
		expect(root.dataset['device']).toBe('phone-portrait');
		expect(root.dataset['formFactor']).toBe('phone');
		expect(root.hasAttribute('data-page-stack')).toBe(true);
		// The session truths stay desktop: no paged explorer listings, no transfer rows,
		// no read-only edit lock.
		expect(root.hasAttribute('data-remote-shell')).toBe(false);
		// The phone-shaped behaviours key on the page-stack marker alone.
		expect(phoneShell()).toBe(true);

		const frame = document.querySelector<HTMLElement>('.ggs-layout')!;
		expect(frame.dataset['layout']).toBe('phone-portrait');
		expect(frame.querySelector('.ggs-appbar')).toBeTruthy();
		expect(frame.querySelector('.ggs-bottom-tabs')).toBeTruthy();
		// The workbench's own elements were ADOPTED, never rebuilt.
		expect(frame.querySelector('#workbench')).toBe(document.getElementById('workbench'));
		expect(frame.querySelector('#titlebar')).toBe(document.getElementById('titlebar'));

		// The window controls survive (remote.css hides them for a browser): seated on the
		// app bar — which is the window's drag region, heading included (the bar's middle
		// is a full-width button; without the attribute Tauri's drag walk stops at it and
		// the bar has nothing left to grab).
		const appbar = frame.querySelector<HTMLElement>('.ggs-appbar')!;
		expect(appbar.querySelector('.window-controls')).toBeTruthy();
		expect(appbar.getAttribute('data-tauri-drag-region')).toBe('deep');
		expect(appbar.querySelector('.ggs-appbar-heading')!.getAttribute('data-tauri-drag-region')).toBe('deep');
	});

	it('the aspect picks the spelling — a wide window under phone mode is the landscape rail', async () => {
		setWidth(844, 390);
		await settle();
		settings.deviceMode = 'phone';
		await installDeviceShell();
		expect(document.documentElement.dataset['device']).toBe('phone-landscape');
		expect(document.querySelector('.ggs-layout')!.dataset['layout']).toBe('phone-landscape');
		expect(document.querySelector('.ggs-nav-rail')).toBeTruthy();
		// The phone forms keep the app bar — the controls stay seated there.
		expect(document.querySelector('.ggs-appbar .window-controls')).toBeTruthy();
	});

	it('tablet mode seats the controls per form: the title bar (landscape), the rail foot (portrait)', async () => {
		setWidth(1280, 800);
		await settle();
		settings.deviceMode = 'tablet';
		await installDeviceShell();
		expect(document.documentElement.dataset['device']).toBe('tablet-landscape');
		expect(document.querySelector('.ggs-layout')!.dataset['layout']).toBe('tablet-landscape');
		// The landscape tablet keeps the desktop title bar (deviceShell.css un-hides it):
		// the controls stay in their native home, the drag region is the title bar's own.
		expect(document.querySelector('#titlebar .window-controls')).toBeTruthy();
		expect(document.getElementById('titlebar')!.parentElement).toBe(document.querySelector('.ggs-arrange'));

		setWidth(800, 1280);
		await settle();
		expect(document.documentElement.dataset['device']).toBe('tablet-portrait');
		// The portrait tablet's drag surface is the navigation rail (its background and
		// gaps — the buttons and the ‹ stay clickable, the walk stops at them).
		const rail = document.querySelector<HTMLElement>('.ggs-nav-rail')!;
		expect(rail.getAttribute('data-tauri-drag-region')).toBe('deep');
		expect(rail.querySelector('.ggs-rail-foot .window-controls')).toBeTruthy();
		expect(phoneShell()).toBe(true);
	});

	it('a live phone→tablet switch re-seats without a reinstall', async () => {
		setWidth(390, 844);
		await settle();
		settings.deviceMode = 'phone';
		await installDeviceShell();
		const frame = document.querySelector('.ggs-layout')!;
		await pickMode('tablet');
		expect(document.documentElement.dataset['device']).toBe('tablet-portrait');
		expect(frame.dataset['layout']).toBe('tablet-portrait');
		expect(document.querySelector('.ggs-nav-rail')).toBeTruthy();
	});

	it('back to Auto restores the desktop shell', async () => {
		setWidth(390, 844);
		await settle();
		settings.deviceMode = 'phone';
		await installDeviceShell();
		await pickMode('auto');
		const root = document.documentElement;
		expect(document.querySelector('.ggs-layout')).toBeNull();
		expect(root.classList.contains('remote-shell')).toBe(false);
		expect(root.hasAttribute('data-page-stack')).toBe(false);
		expect(root.hasAttribute('data-device-shell')).toBe(false);
		expect(phoneShell()).toBe(false);
		// The frame's parts went home, in the body's own order.
		expect(document.getElementById('titlebar')!.parentElement).toBe(document.body);
		expect(document.getElementById('workbench')!.parentElement).toBe(document.body);
		expect(document.getElementById('statusbar')!.parentElement).toBe(document.body);
		const ids = [...document.body.children].map((child) => child.id).filter(Boolean);
		expect(ids.indexOf('titlebar')).toBeLessThan(ids.indexOf('workbench'));
		expect(ids.indexOf('workbench')).toBeLessThan(ids.indexOf('statusbar'));
		// The window controls are the title bar's again.
		expect(document.querySelector('#titlebar .window-controls')).toBeTruthy();
	});

	it('a page over the editor answers the back affordance on the desktop device shell', async () => {
		setWidth(390, 844);
		await settle();
		settings.deviceMode = 'phone';
		await installDeviceShell();
		expect(pageBackAvailable()).toBe(false);
		await commands.execute('workbench.showExplorer');
		expect(pageBackAvailable()).toBe(true);
	});
});
