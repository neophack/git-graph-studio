// The remote shell's small DOM widgets: the codicon glyph every remote surface stamps
// with aria-hidden (built on platform/ui's icon, which carries the class shape), and the
// on/off switch the drawer's and the settings page's rows share (drawn by the shared
// .ggs-switch rules) — one definition instead of one per file.

import { icon } from '../platform/ui';

/** A codicon glyph, hidden from assistive technology (the label beside it names the row). */
export function codicon(name: string): HTMLElement {
	const span = icon(name);
	span.setAttribute('aria-hidden', 'true');
	return span;
}

/** The on/off switch a settings row carries (drawn by the shared .ggs-switch rules). */
export function toggleSwitch(on: boolean): HTMLElement {
	const track = document.createElement('span');
	track.className = 'switch ggs-switch' + (on ? ' on' : '');
	track.setAttribute('role', 'switch');
	track.setAttribute('aria-checked', on ? 'true' : 'false');
	track.appendChild(document.createElement('i'));
	return track;
}
