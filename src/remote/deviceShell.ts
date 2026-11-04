// The desktop window's device mode (the Device Mode setting, `deviceMode`): the remote
// app's phone and tablet layouts worn INSIDE the desktop window — the same Workbench
// core, the same five-form layout host (app/layouts/), the same device classifier
// (responsive.ts) — for the small-screen Windows handhelds. The browser session's own
// surroundings (the WebSocket transport, the session hooks, the browser-back guards) stay
// out: this window keeps its real Tauri seam and its desktop hooks, so nothing here reads
// `data-remote-shell` — the phone-shaped behaviours key on `data-page-stack` alone.
//
// Wiring (main.ts, the composition root — the one non-remote file the import rules let
// name this module): `primeDeviceShell()` runs after the settings load and BEFORE the
// workbench chunk, so the device markers and the shell CSS land first and the booted
// skeleton never flashes the chrome a forced form hides; `installDeviceShell()` runs once
// the workbench's first frame is up and installs the full shell. A setting change applies
// live, both directions, without a restart.
//
// The desktop keeps what a browser session cannot have, and adds what the forced forms
// would otherwise lose:
//   - the window controls (minimize / maximize / close) never disappear: remote.css hides
//     them for a browser (dead art there), so deviceShell.css un-hides them here and each
//     layout seats the cluster into its own chrome — the app bar (the phone forms), the
//     navigation rail's foot (the portrait tablet), the status bar's right cluster (the
//     landscape tablet); back into the title bar when the mode goes away;
//   - the app bar is the window's drag region, exactly like the desktop title bar;
//   - Settings keeps opening the desktop's own dialog — the phone's settings page is the
//     browser session's (navDrawer routes its row accordingly);
//   - the explorer's remote behaviours (paged listings, the transfer rows, no Reveal) and
//     the read-only edit lock stay off: those are session truths, not shell shapes.
import { SETTINGS_EVENT, settings } from '../platform/settings';
import { noteTitleBarMouseDown } from '../platform/windowDrag';
import { initResponsive, onDeviceClassChange, setDeviceOverride, type DeviceOverride } from './responsive';

/** The override a mode spells: `auto` is the classifier's own answer (null). */
function overrideOf(mode: string): DeviceOverride {
	return mode === 'phone' || mode === 'tablet' ? mode : null;
}

/** The shell's current state: what a second activation or a quick toggle must not double. */
let active = false;
/** prime() has run (responsive + markers, before the workbench paints). */
let primed = false;
/** The setting-change listener is bound once. */
let bound = false;
/** The once-only chrome (the pages, the back entries, the pager) outlives deactivation —
 * every piece self-gates on the markers and stands down when they leave. */
let chromeInstalled = false;
/** Guards the async activation against a mode change mid-flight: a stale pass stops. */
let generation = 0;

let stopResponsive: (() => void) | null = null;
let stopLayoutHost: (() => void) | null = null;
let stopLongPress: (() => void) | null = null;
let offDeviceClass: (() => void) | null = null;

/** Early, before the workbench chunk loads: the responsive markers and the shell CSS land
 * first, so a forced form's first paint is already that form. Also binds the setting
 * watch, whatever the boot-time mode is. */
export async function primeDeviceShell(): Promise<void> {
	bindSettingWatch();
	if (primed || settings.deviceMode === 'auto') return;
	primed = true;
	await import('./remote.css');
	const { initResponsive: start } = await import('./responsive');
	stopResponsive = start();
	setDeviceOverride(overrideOf(settings.deviceMode));
}

/** Once the workbench's first frame is up: install the full device shell when the setting
 * asks for one (and nothing, ever, when it says `auto`). */
export async function installDeviceShell(): Promise<void> {
	bindSettingWatch();
	if (settings.deviceMode === 'auto') return;
	await activate();
}

function bindSettingWatch(): void {
	if (bound) return;
	bound = true;
	document.addEventListener(SETTINGS_EVENT, (event) => {
		const detail = (event as CustomEvent<{ key?: string }>).detail;
		if (detail?.key !== 'deviceMode') return;
		void respond();
	});
}

async function respond(): Promise<void> {
	const mode = settings.deviceMode;
	if (mode === 'auto') {
		await deactivate();
		return;
	}
	setDeviceOverride(mode);
	if (!active) await activate();
}
async function activate(): Promise<void> {
	if (active) return;
	active = true;
	const token = ++generation;
	// remote.css first (the page-stack block and the app bar live there), then the pieces
	// whose equal-specificity rules follow it.
	await import('./remote.css');
	const [, , host, files, scm, back, quickBack, swipe, sheets, gesturesMod, pagesMod] = await Promise.all([
		import('./deviceShell.css'),
		import('./app/layouts/layouts.css'),
		import('./app/layouts/host'),
		import('./app/files/filesPage'),
		import('./app/scm/scmPage'),
		import('./pageBack'),
		import('./quickInputBack'),
		import('./swipeNav'),
		import('./actionSheet'),
		import('./gestures'),
		import('./pages')
	]);
	if (token !== generation) return;
	if (!primed) {
		primed = true;
		stopResponsive = initResponsive();
	}
	document.documentElement.dataset['deviceShell'] = '';
	// The override (also the live phone↔tablet switch): overrides win over the classifier
	// outright, portrait/landscape still following the window's aspect.
	setDeviceOverride(overrideOf(settings.deviceMode));
	if (!chromeInstalled) {
		chromeInstalled = true;
		files.installFilesPage();
		scm.installScmPage();
		back.installPageBack();
		quickBack.installQuickInputBack();
		const workbench = document.getElementById('workbench');
		if (workbench) swipe.installSwipeNav(workbench);
		// The page marks the CSS reads (the app bar's page identity, the panel's view) —
		// once, and left in place: without the markers they write data nothing keys on.
		const mark = (): void => {
			document.documentElement.dataset['phonePage'] = pagesMod.currentPage();
			const panelView = document.querySelector('#panel .panel-title.active') as HTMLElement | null;
			document.documentElement.dataset['panelView'] = panelView?.dataset['view'] ?? '';
		};
		mark();
		pagesMod.onWorkbenchChange(mark);
		// The touch affordances a handheld reaches for: menus as bottom sheets and
		// long-press as contextmenu — both inert under a fine pointer.
		sheets.installActionSheet();
	}
	stopLongPress?.();
	stopLongPress = gesturesMod.installLongPress(document);
	// The five forms' arrangements over the booted workbench — installed once the title
	// bar's centre exists (the host adopts #titlebar / #workbench / #statusbar).
	await ready();
	if (token !== generation) return;
	stopLayoutHost?.();
	stopLayoutHost = host.installLayoutHost();
	offDeviceClass?.();
	offDeviceClass = onDeviceClassChange(seatWindowControls);
	seatWindowControls();
}

/** The workbench's first frame (the title bar's centre is filled) — the moment the layout
 * host may adopt the frame's own elements. */
function ready(): Promise<void> {
	if (document.querySelector('#titlebar .titlebar-center')) return Promise.resolve();
	return new Promise((resolve) => {
		const observer = new MutationObserver(() => {
			if (document.querySelector('#titlebar .titlebar-center')) {
				observer.disconnect();
				resolve();
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
	});
}

async function deactivate(): Promise<void> {
	if (!active) return;
	active = false;
	const token = ++generation;
	const ui = await import('../platform/ui');
	if (token !== generation) return;
	setDeviceOverride(null);
	// The parts go home BEFORE the frame goes: the layout host's stop removes the frame
	// root, and with it everything parked inside (index.html's body order).
	const anchor = document.getElementById('notifications');
	for (const id of ['titlebar', 'workbench', 'statusbar']) {
		const part = document.getElementById(id);
		if (part && part.parentElement !== document.body) document.body.insertBefore(part, anchor ?? null);
	}
	// The window controls return to the title bar (whose own rule hides nothing).
	const controls = document.querySelector('.window-controls');
	if (controls) document.getElementById('titlebar')?.append(controls);
	offDeviceClass?.();
	offDeviceClass = null;
	stopLayoutHost?.();
	stopLayoutHost = null;
	stopLongPress?.();
	stopLongPress = null;
	// The bottom-sheet presenter back to the desktop's own menus.
	ui.setMenuPresenter(null);
	stopResponsive?.();
	stopResponsive = null;
	primed = false;
	delete document.documentElement.dataset['deviceShell'];
	// responsive's stop leaves the two collapsed vocabularies; nothing may read a stale one.
	delete document.documentElement.dataset['formFactor'];
	delete document.documentElement.dataset['pointer'];
	window.dispatchEvent(new Event('resize'));
}

/** Seat the window controls and wire the drag surface the active layout offers. The
 * four forced forms all hide the desktop title bar — the native drag region — so each
 * names its own: the phone's app bar (its heading included, see below), the portrait
 * tablet's navigation rail, and the landscape tablet keeps the title bar itself
 * (deviceShell.css un-hides it there — the arrangement already places it first). A
 * device-class change (a rotation, a resize past an edge) re-seats.
 *
 * Tauri's drag script (tauri 2.12's window/scripts/drag.js) walks the mousedown target's
 * ancestors: a `deep` region takes every empty spot of the subtree, while a CLICKABLE
 * element without the attribute — every button, every role="button" — blocks the walk.
 * The app bar's middle is a full-width `<button>` (the page heading), so the bar's `deep`
 * alone leaves nothing to grab: the heading itself carries `deep` too, which per the
 * script turns a clickable element into a drag region (its own subtree drags — the
 * open-editors tap it served stays reachable through the Editor destination, which opens
 * the same list on every tap). */
function seatWindowControls(): void {
	if (!active) return;
	const controls = document.querySelector('.window-controls');
	const layout = document.documentElement.dataset['layout'] ?? '';
	let seat: HTMLElement | null = null;
	if (layout.startsWith('phone')) {
		const appbar = document.querySelector<HTMLElement>('.ggs-layout .ggs-appbar');
		if (appbar && appbar.dataset['dragRegion'] !== '1') {
			appbar.dataset['dragRegion'] = '1';
			wireDragRegion(appbar);
			const heading = appbar.querySelector<HTMLElement>('.ggs-appbar-heading');
			heading?.setAttribute('data-tauri-drag-region', 'deep');
		}
		seat = appbar;
	} else if (layout === 'tablet-portrait') {
		const rail = document.querySelector<HTMLElement>('.ggs-layout .ggs-nav-rail');
		if (rail && rail.dataset['dragRegion'] !== '1') {
			rail.dataset['dragRegion'] = '1';
			wireDragRegion(rail);
		}
		seat = document.querySelector<HTMLElement>('.ggs-layout .ggs-nav-rail .ggs-rail-foot');
	} else if (layout === 'tablet-landscape') {
		// The title bar stays this form's own chrome (deviceShell.css) — the controls and
		// the drag region are its native ones, nothing to wire.
		seat = document.getElementById('titlebar');
	}
	if (controls && seat && controls.parentElement !== seat) seat.append(controls);
}

/** Mark a chrome element as the window's drag region: the attribute Tauri's drag script
 * walks for, plus the mousedown gate that defers the workbench's drag-time refreshes
 * (platform/windowDrag.ts — the same gate the desktop title bar arms). */
function wireDragRegion(element: HTMLElement): void {
	element.setAttribute('data-tauri-drag-region', 'deep');
	element.addEventListener('mousedown', (event) => {
		if (event.button === 0) noteTitleBarMouseDown();
	});
}
