// The phone's page-stack navigation (docs/ggs-remote-plan.md §11.2): on the phone the side
// bar and the panel are full-screen pages laid over the editor (remote.css), so whatever
// opens beneath them — an editor activating, the panel showing — must dismiss them first,
// the way tapping an item in a phone app's list navigates to its detail page. The dismissal
// crosses module boundaries through the command registry (`workbench.toggleSidebar` /
// `workbench.togglePanel`, the same seams the swipe-back gesture and the bottom navigation
// use), never by reaching into the workbench's state. Tablet-web and the desktop app keep VS
// Code's side-by-side behaviour: without the markers responsive.ts keeps on <html>, every
// call is a no-op — the same shape editLock.ts gives the editor suite.
//
// Deliberately dependency-light (commands only): editor.ts and panel.ts import this at their
// top level, and a heavier import here would weigh down the first-paint chunk.
import { commands } from '../platform/commands';

/** Whether this is a page-stack shell (docs/remote-client-plan.md §5.1–§5.3): the phone
 *  orientations and the portrait tablet, whose side bar and panel are full-screen pages
 *  laid over the editor. */
export function phoneShell(): boolean {
	if (typeof document === 'undefined') return false;
	const root = document.documentElement;
	return root.hasAttribute('data-remote-shell') && root.hasAttribute('data-page-stack');
}

/** Whether the phone shell currently shows its full-screen side view. */
export function fullScreenSideViewOpen(): boolean {
	if (!phoneShell()) return false;
	const sidebar = document.getElementById('sidebar');
	return !!sidebar && !sidebar.hidden;
}

/** Whether the phone shell currently shows the panel (terminal, output) as its page. */
export function panelPageOpen(): boolean {
	if (!phoneShell()) return false;
	const panel = document.getElementById('panel');
	return !!panel && !panel.hidden;
}

/** The page holds (the navigation policy's `holdPage`): while one is live, an editor
 *  activation lands in the background — the tab opens, the page showing keeps its place.
 *  A remote-originated operation (the workbench sync applying the PC's tab switch), a
 *  session restore, a panel another frontend created — none of them is this user's act,
 *  and none of them may close the page under them (2026-10-16, the owner's direction:
 *  文件页面会被其他页面顶到最前). */
let pageHolds = 0;

/** Take one hold; the returned function releases it (idempotent). */
export function holdPhonePage(): () => void {
	pageHolds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		pageHolds--;
	};
}

/** Whether a hold keeps the current page in place. */
export function pageHeld(): boolean {
	return pageHolds > 0;
}

/** Close the full-screen side view if the phone shell is showing one. */
export function dismissFullScreenSideView(): void {
	if (fullScreenSideViewOpen()) void commands.execute('workbench.toggleSidebar');
}

/** Bring the editor page forward NOW — the user's own navigation (goTo, the open editors
 *  sheet): the page holds never gate it. */
export function revealEditorPageNow(): void {
	dismissFullScreenSideView();
	if (panelPageOpen()) void commands.execute('workbench.togglePanel');
}

/** Bring the editor page forward because an EDITOR ACTIVATED (the workbench's hook): with
 *  the side view closed, the panel's toggle is a plain hide (panel.ts reveals only a
 *  covered panel). A no-op off the phone — and while a page hold is live, a no-op on it:
 *  the activation that asked is not this user's own act. The user's own navigation goes
 *  through `revealEditorPageNow`, which no hold gates. */
export function revealEditorPage(): void {
	if (pageHolds > 0) return;
	revealEditorPageNow();
}
