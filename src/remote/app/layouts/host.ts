// The layout host (docs/remote-client-plan.md §4.2, §5.6): the one frame root the five
// layouts rotate inside. A device-class change (a rotation, a window dragged across a
// breakpoint — the phone orientations flip here too, not just the three-way factor) runs
// the plan's switch process:
//   1. the temporary overlays close (the drawer, the action sheet, the settings page);
//   2. the navigation state is recorded — one vocabulary, pages.ts's page id, which is the
//      phone's current page, the tablet's nav item and the desktop's side view alike;
//   3. the old arrangement unmounts, the new one ADOPTS the same part elements (moved,
//      never rebuilt — the open tabs, the dirty buffers and the terminal sessions are the
//      same DOM, so they survive by construction);
//   4. the recorded page re-applies (§5.6: a side view pages on the phone, sits beside the
//      editor on the tablet landscape and the desktop);
//   5. a resize event nudges CodeMirror and the terminals to re-measure.
//
// §5.7's key gating rides along: the PHONE forms do not answer the workbench's global
// chords (Ctrl+P, Ctrl+S, …) — a phone's modifiers belong to the browser (Ctrl+T, native
// share) and the editor keeps its own in-editor keys. The tablet and desktop forms keep
// VS Code's shortcuts.
import { closeActionSheet } from '../../actionSheet';
import { currentPage, goTo } from '../../pages';
import { closeDrawer } from '../../navDrawer';
import { closeSettingsPage } from '../../settingsPage';
import { currentDeviceClass, onDeviceClassChange } from '../../responsive';
import type { DeviceClass } from '../deviceClass';
import { buildDesktop } from './desktop';
import { buildPhoneLandscape } from './phoneLandscape';
import { buildPhonePortrait } from './phonePortrait';
import { buildTabletLandscape } from './tabletLandscape';
import { buildTabletPortrait } from './tabletPortrait';
import { collectLayoutParts, refreshLayoutParts } from './parts';
import type { LayoutInstance, LayoutParts } from './shared';

const BUILDERS: Record<DeviceClass, (parts: LayoutParts) => LayoutInstance> = {
	'phone-portrait': buildPhonePortrait,
	'phone-landscape': buildPhoneLandscape,
	'tablet-portrait': buildTabletPortrait,
	'tablet-landscape': buildTabletLandscape,
	desktop: buildDesktop
};

/** The temporary overlays §4.2 closes before a switch: menus and quick input close on
 *  their own outside interactions; these three outlive a click elsewhere. */
function closeOverlays(): void {
	closeDrawer();
	closeActionSheet();
	closeSettingsPage();
}

/** §5.7: on the phone forms the workbench's global key dispatch stands down. Keys aimed at
 *  a focused editor / input keep their meaning (the editor suite handles them itself);
 *  page-level modifier chords fall through to the browser untouched. */
function gatePhoneKeys(): (event: KeyboardEvent) => void {
	return (event) => {
		const layout = document.documentElement.dataset['layout'] ?? '';
		if (!layout.startsWith('phone')) return;
		if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (target?.closest('.cm-editor, input, textarea, select, [contenteditable="true"]')) return;
		event.stopImmediatePropagation();
	};
}

/** Install the host against a booted workbench (its skeleton elements exist). The returned
 *  stop detaches the watch (tests). */
export function installLayoutHost(): () => void {
	const parts = collectLayoutParts();
	const frame = document.createElement('div');
	frame.className = 'ggs-layout';
	document.body.insertBefore(frame, document.getElementById('notifications') ?? null);
	let current: LayoutInstance | null = null;
	const apply = (device: DeviceClass): void => {
		closeOverlays();
		const page = currentPage();
		current?.dispose();
		current?.root.remove();
		current = BUILDERS[device](parts);
		frame.replaceChildren(current.root);
		frame.dataset.layout = device;
		// The root-level stamp mirrors the frame's (remote.css keys page-stack behaviour on
		// <html>; a rule that must reach outside the frame keys on this).
		document.documentElement.dataset['layout'] = device;
		refreshLayoutParts(parts);
		// §5.6's mapping is goTo itself: the same page id shows as a full-screen page on
		// the page-stack shells and as a side view beside the editor on the wide forms.
		void goTo(page).catch(() => undefined);
		// The re-measure pass (§4.2): CodeMirror listens through ResizeObserver, the
		// terminals through the window resize — this nudge covers both.
		window.dispatchEvent(new Event('resize'));
	};
	const initial = currentDeviceClass();
	if (initial) apply(initial);
	const keyGate = gatePhoneKeys();
	document.addEventListener('keydown', keyGate, true);
	const offDevice = onDeviceClassChange(apply);
	return () => {
		offDevice();
		document.removeEventListener('keydown', keyGate, true);
		current?.dispose();
		current?.root.remove();
		current = null;
		frame.remove();
	};
}
