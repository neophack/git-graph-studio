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
import { commands } from '../commands';

/** Whether this is the remote shell on its phone form factor. */
export function phoneShell(): boolean {
	if (typeof document === 'undefined') return false;
	const root = document.documentElement;
	return root.hasAttribute('data-remote-shell') && root.dataset['formFactor'] === 'phone';
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

/** Close the full-screen side view if the phone shell is showing one. */
export function dismissFullScreenSideView(): void {
	if (fullScreenSideViewOpen()) void commands.execute('workbench.toggleSidebar');
}

/** Bring the editor page forward: close the side view and the panel page above it. With the
 *  side view closed, the panel's toggle is a plain hide (panel.ts reveals only a covered
 *  panel). A no-op off the phone. */
export function revealEditorPage(): void {
	dismissFullScreenSideView();
	if (panelPageOpen()) void commands.execute('workbench.togglePanel');
}
