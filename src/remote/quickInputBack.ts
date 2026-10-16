// The quick input's system-back entry (docs/ggs-remote-plan.md §11.2's overlay rule, beside
// pageBack.ts): on the page-stack shells the quick input (the palette, Go to File, every
// quick pick) draws as a FULL-SCREEN page — the outside click the desktop card closes on can
// never land, and a phone has no Escape key. Until this module the system back key left the
// workbench outright, dropping the session under an overlay the user could not dismiss. An
// open quick input now rides backStack as the TOP closer (it opened last, so one back peels
// it first — any page beneath keeps its own pageBack closer) and closes exactly as Escape
// would, through quickInput's own dismissQuickInput.
//
// The wide forms never arm it: their quick input stays the compact top card the outside
// click dismisses, so the back key keeps its leave-the-workbench meaning there.
import { dismissQuickInput } from '../platform/ui';
import { pushBack } from './backStack';

let release: (() => void) | null = null;
let observer: MutationObserver | null = null;

function pageStackShell(): boolean {
	if (typeof document === 'undefined') return false;
	const root = document.documentElement;
	return root.hasAttribute('data-remote-shell') && root.hasAttribute('data-page-stack');
}

/** Arm or drop the back entry for a quick input on screen. The overlays observer drives it
 *  (a quick input opening arms, its finish — pick, ‹, outside — releases). */
function sync(): void {
	const open = pageStackShell() && document.querySelector('#overlays .quick-input') !== null;
	if (open === Boolean(release)) return;
	if (open) release = pushBack(() => dismissQuickInput());
	else {
		release?.();
		release = null;
	}
}

/** Install the overlays watcher (once per shell, installOnce). A stale entry from a torn-down
 *  DOM (a test, a reload) is dropped first — it must not ride along. */
export function installQuickInputBack(): void {
	resetQuickInputBack();
	if (typeof MutationObserver === 'undefined') return;
	const overlays = document.getElementById('overlays');
	if (!overlays) return;
	observer = new MutationObserver(sync);
	observer.observe(overlays, { childList: true });
	sync();
}

/** Drop the watcher and any armed entry without traversing (tests reset the DOM). */
export function resetQuickInputBack(): void {
	observer?.disconnect();
	observer = null;
	release?.();
	release = null;
}
