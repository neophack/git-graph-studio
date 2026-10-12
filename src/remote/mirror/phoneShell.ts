// The replica's phone mode, inside the PC's own window (docs/ggs-remote-plan.md §22): while
// a phone watches the hidden window, the window takes the phone's size and wears the phone
// shell — the app bar, the bottom navigation, the drawer, the action sheets (shell.ts, with
// its stylesheet) — so the copy the phone shows is the phone app at 1:1, not a shrunken
// desktop. The pointer counts as coarse: the clicks arrive from a finger. Leaving puts the
// desktop back exactly as it was. Loaded only when a phone first asks for it.

import '../remote.css';
import { initResponsive, setPointerOverride } from '../responsive';
import { installRemoteShell, refreshPhoneChrome } from '../shell';

let stopResponsive: (() => void) | null = null;
let installed = false;

export function enterPhone(): void {
	if (stopResponsive) return;
	setPointerOverride('coarse');
	document.documentElement.setAttribute('data-remote-shell', '');
	stopResponsive = initResponsive();
	if (!installed) {
		installed = true;
		installRemoteShell();
	} else {
		refreshPhoneChrome();
	}
}

export function leavePhone(): void {
	if (!stopResponsive) return;
	stopResponsive();
	stopResponsive = null;
	setPointerOverride(null);
	const root = document.documentElement;
	root.removeAttribute('data-remote-shell');
	delete root.dataset['formFactor'];
	delete root.dataset['pointer'];
	refreshPhoneChrome();
}
